// AI 文生图提示词工作台 —— 原生窗口外壳
//
// 这是一个真正的 macOS App：自己拥有 Dock 图标、菜单栏和一个 WKWebView 窗口。
// 启动时把内置的本地服务（PromptStudio）作为子进程拉起来，探测到端口后
// 直接把界面加载进窗口——用户看到的就是一个 App，不再是浏览器里的回环地址。
//
// 编译：xcrun swiftc -O -module-cache-path <cache> -o AppWindow AppWindow.swift

import Cocoa
import UniformTypeIdentifiers
import WebKit

private let appTitle = "AI 文生图提示词工作台"
private let portRange = 8765...8794

private let dataDirURL: URL = {
    let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/AI-Prompt-Studio")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}()

private let formatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "MM-dd HH:mm:ss"
    return f
}()

/// 原生外壳自己的日志，写到数据目录下的 native.log（Python 那份是 app.log）
func log(_ message: String) {
    NSLog("%@", message)
    let line = "[\(formatter.string(from: Date()))] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    let url = dataDirURL.appendingPathComponent("native.log")
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: url)
    }
}

// MARK: - JS 桥：把「导出文件」交给原生保存对话框

final class SaveBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let filename = body["filename"] as? String,
              let content = body["content"] as? String else {
            reply(ok: false, info: "参数不完整")
            return
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false

        panel.begin { response in
            guard response == .OK, let target = panel.url else {
                self.reply(ok: false, info: "cancelled")
                return
            }
            do {
                try content.write(to: target, atomically: true, encoding: .utf8)
                self.reply(ok: true, info: target.path)
            } catch {
                self.reply(ok: false, info: error.localizedDescription)
            }
        }
    }

    private func reply(ok: Bool, info: String) {
        guard let webView = webView else { return }
        let js = "window.__nativeSaveResult && window.__nativeSaveResult(\(ok ? "true" : "false"), \(Self.jsLiteral(info)));"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    static func jsLiteral(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let bridge = SaveBridge()
    private var serverProcess: Process?
    private var signalSources: [DispatchSourceSignal] = []

    private var dataDir: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AI-Prompt-Studio").path
    }

    // ---------- 生命周期 ----------

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installSignalHandlers()
        buildMenu()
        makeWindow()

        startServerIfNeeded()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            if let port = self.waitForServer() {
                DispatchQueue.main.async {
                    self.load(urlString: "http://127.0.0.1:\(port)/")
                    self.window.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                }
            } else {
                DispatchQueue.main.async { self.showFailure() }
            }
        }
    }

    /// 被 pkill / 关机信号打断时也要把子进程带走，别留孤儿占着端口
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }

    private func stopServer() {
        guard let process = serverProcess, process.isRunning else { return }
        process.terminate()
        // 给它 1.5 秒优雅退出，超时就强杀，别留孤儿
        let deadline = Date().addingTimeInterval(1.5)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
        serverProcess = nil
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    // ---------- 窗口 ----------

    private func makeWindow() {
        let config = WKWebViewConfiguration()

        let controller = WKUserContentController()
        controller.add(bridge, name: "saveFile")
        controller.addUserScript(WKUserScript(
            source: "window.__NATIVE_APP__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.userContentController = controller
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        // 不设 uiDelegate 的话：<input type="file"> 点了没反应，
        // window.confirm() 直接返回 false —— 删除分类/分组会静默失效。
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        bridge.webView = webView

        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        let rect = NSRect(x: 0, y: 0, width: 1420, height: 900)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered,
                          defer: false)
        window.title = appTitle
        window.minSize = NSSize(width: 1040, height: 700)
        window.delegate = self

        // 关键：contentView 必须是独立的容器，不能直接把 webView 当 contentView。
        // 否则下面那些约束会退化成 webView.leading == webView.leading 的自引用，
        // 再配上 translatesAutoresizingMaskIntoConstraints = false，
        // WebView 就完全没有尺寸信息，会渲染成 0×0 —— 页面能加载但什么都看不见。
        let container = NSView(frame: rect)
        container.autoresizingMask = [.width, .height]
        window.contentView = container

        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        window.setFrameAutosaveName("MainWindow")
        // 万一上次存的窗口尺寸异常（被缩到 0 或者跑到屏幕外），回到默认值
        let restored = window.frame
        let onScreen = NSScreen.screens.contains { $0.visibleFrame.intersects(restored) }
        if restored.width < window.minSize.width || restored.height < window.minSize.height || !onScreen {
            window.setFrame(rect, display: false)
            window.center()
            log("窗口位置异常，已重置为默认 1420×900")
        }
        window.makeKeyAndOrderFront(nil)

        loadSplash()
        container.layoutSubtreeIfNeeded()
        log("窗口已创建 window=\(fmt(window.frame)) container=\(fmt(container.frame)) webView=\(fmt(webView.frame))")
    }

    // ---------- 渲染自检 ----------

    private func checkDOM(_ webView: WKWebView, tag: String) {
        let js = """
        JSON.stringify({
          w: window.innerWidth, h: window.innerHeight,
          cats: document.querySelectorAll('.cat-item').length,
          tags: document.querySelectorAll('.tag').length,
          html: document.body.innerHTML.length,
          bg: getComputedStyle(document.body).backgroundColor,
          title: document.title
        })
        """
        webView.evaluateJavaScript(js) { [weak self] result, error in
            guard let self = self else { return }
            if let error = error {
                log("[\(tag)] DOM 自检失败: \(error.localizedDescription)")
            } else {
                log("[\(tag)] DOM 自检: \(result ?? "nil") | webView=\(self.fmt(webView.frame))")
            }
        }
    }

    private func fmt(_ rect: NSRect) -> String {
        String(format: "%.0f×%.0f@%.0f,%.0f", rect.width, rect.height, rect.origin.x, rect.origin.y)
    }

    // ---------- WKNavigationDelegate ----------

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("页面加载完成: \(webView.url?.absoluteString ?? "-")")
        checkDOM(webView, tag: "刚加载完")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.checkDOM(webView, tag: "2.5 秒后")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("页面加载失败: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        log("页面连接失败: \(error.localizedDescription)")
    }

    private func load(urlString: String) {
        guard let url = URL(string: urlString) else { return }
        webView.load(URLRequest(url: url))
    }

    private func loadSplash() {
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:#14171f;color:#e6e9f0;
          font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
        .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
        .mark{width:64px;height:64px;border-radius:16px;
          background:linear-gradient(135deg,#6c8cff,#8f6cff);
          box-shadow:0 10px 30px rgba(108,140,255,.35);
          display:flex;align-items:center;justify-content:center;
          font-size:30px;color:#fff;animation:pulse 1.4s ease-in-out infinite}
        @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.92);opacity:.75}}
        h1{font-size:17px;font-weight:600;margin:0}
        p{margin:0;color:#8b94a7;font-size:13px}
        </style></head><body><div class="wrap">
        <div class="mark">&#10022;</div>
        <h1>AI 文生图提示词工作台</h1>
        <p>正在启动本地服务…</p>
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showFailure() {
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:#14171f;color:#e6e9f0;
          font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
        .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:40px}
        h1{font-size:17px;margin:0;color:#f87171}
        p{margin:0;color:#8b94a7;font-size:13px;line-height:1.8}
        code{background:#252b3a;padding:2px 7px;border-radius:5px;font-size:12px}
        </style></head><body><div class="wrap">
        <h1>本地服务启动失败</h1>
        <p>请查看日志：<code>~/Library/Application Support/AI-Prompt-Studio/app.log</code><br>
        端口 8765–8794 可能都被占用了。</p>
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // ---------- 子进程：本地服务 ----------

    private func serverExecutable() -> URL? {
        let bundle = Bundle.main.bundleURL
        let candidates = [
            bundle.appendingPathComponent("Contents/Frameworks/PromptStudio"),
            bundle.appendingPathComponent("Contents/Resources/PromptStudio"),
            bundle.appendingPathComponent("Contents/MacOS/PromptStudio"),
        ]
        if let override = ProcessInfo.processInfo.environment["PROMPT_STUDIO_SERVER"] {
            return URL(fileURLWithPath: override)
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private func startServerIfNeeded() {
        // 已经有实例在跑就不重复拉
        if probeAnyPort() != nil { return }

        guard let exe = serverExecutable() else { return }

        let process = Process()
        process.executableURL = exe
        var env = ProcessInfo.processInfo.environment
        env["APS_NO_BROWSER"] = "1"     // 界面在原生窗口里，不要另开浏览器
        env["APS_NO_WINDOW"] = "1"      // 不用 Python 那个 tkinter 状态窗口
        process.environment = env

        // 子进程的输出丢弃即可（Python 自己会写 app.log），
        // 但必须持续读走，否则管道写满会卡住子进程
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            NSLog("启动本地服务失败: \(error)")
        }
    }

    private func probeAnyPort() -> Int? {
        for port in portRange where probe(port: port) { return port }
        return nil
    }

    private func probe(port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.6
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data = data, let text = String(data: data, encoding: .utf8),
               text.contains("AIPromptStudio") {
                healthy = true
            }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        return healthy
    }

    /// 并行探测一圈端口，等本地服务起来（最多约 20 秒）
    private func waitForServer() -> Int? {
        for _ in 0..<50 {
            let group = DispatchGroup()
            let lock = NSLock()
            var found: Int?

            for port in portRange {
                group.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    if self.probe(port: port) {
                        lock.lock()
                        if found == nil { found = port }
                        lock.unlock()
                    }
                    group.leave()
                }
            }
            _ = group.wait(timeout: .now() + 2.0)
            if let port = found { return port }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return nil
    }

    // ---------- 菜单 ----------

    @objc private func reloadPage() { webView.reload() }

    @objc private func openDataDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: dataDir))
    }

    @objc private func openLog() {
        let log = (dataDir as NSString).appendingPathComponent("app.log")
        if FileManager.default.fileExists(atPath: log) {
            NSWorkspace.shared.open(URL(fileURLWithPath: log))
        } else {
            openDataDir()
        }
    }

    private func buildMenu() {
        let main = NSMenu()

        // 应用菜单
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 \(appTitle)",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 \(appTitle)",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(appTitle)",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // 编辑菜单：没有它，输入框里的 ⌘C/⌘V/⌘A 是不生效的
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        // 注意：故意不加「撤销/重做」，把 ⌘Z 留给网页里的提示词撤销栈
        editItem.submenu = editMenu

        // 视图菜单
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        viewMenu.addItem(withTitle: "重新载入", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "实际大小", action: #selector(zoomReset), keyEquivalent: "0")
        viewMenu.addItem(withTitle: "放大", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        viewItem.submenu = viewMenu

        // 帮助菜单
        let helpItem = NSMenuItem()
        main.addItem(helpItem)
        let helpMenu = NSMenu(title: "帮助")
        helpMenu.addItem(withTitle: "打开数据目录", action: #selector(openDataDir), keyEquivalent: "")
        helpMenu.addItem(withTitle: "查看运行日志", action: #selector(openLog), keyEquivalent: "")
        helpItem.submenu = helpMenu

        NSApp.mainMenu = main
    }

    private var zoom: CGFloat = 1.0

    @objc private func zoomIn() {
        zoom = min(2.0, zoom + 0.1)
        webView.pageZoom = zoom
    }

    @objc private func zoomOut() {
        zoom = max(0.6, zoom - 0.1)
        webView.pageZoom = zoom
    }

    @objc private func zoomReset() {
        zoom = 1.0
        webView.pageZoom = 1.0
    }
}

// MARK: - JS 原生面板：文件选择 / alert / confirm / prompt
//
// WKWebView 和 Safari 不同：这些面板必须由宿主自己弹，否则一律静默失败。

extension AppDelegate {
    /// <input type="file"> —— 图片反推的「选择图片」按钮走这里
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "选择图片"
        panel.message = "挑一张图片，AI 会帮你反推出提示词"
        panel.prompt = "选择"
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canCreateDirectories = false
        // 前端是 accept="image/*"，这里按图片类型过滤
        panel.allowedContentTypes = [.image]

        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// window.confirm() —— 删除分类 / 删除分组 / 恢复内置标签库都要用它
    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = appTitle
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = alert.buttons.first
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    /// window.alert()
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = appTitle
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.runModal()
        completionHandler()
    }

    /// window.prompt()
    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = appTitle
        alert.informativeText = prompt
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
