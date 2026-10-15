#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
跨平台打包脚本。

    python3 tools/build.py            # 自动识别当前平台
    python3 tools/build.py --clean    # 重新生成图标再打包

产物：
    macOS    build/dist/AI提示词工作台.app     Swift 原生窗口 + WKWebView，免装 Python
    Windows  build/dist/AI提示词工作台/        PromptStudio.exe，免装 Python
    Linux    build/dist/PromptStudio/          可执行文件（窗口用 pywebview，无则开浏览器）

macOS 的 .app 需要 Xcode 命令行工具（swiftc / sips / iconutil / codesign）；
Windows / Linux 只需要 Python 3.8+ 和 pip。

注意：PyInstaller 不能跨平台编译 —— 造 .exe 必须在 Windows 上跑本脚本。
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(ROOT, "build")
DIST = os.path.join(BUILD, "dist")
PYLIBS = os.path.join(BUILD, "pyinstaller")
RUNTIME_LIBS = os.path.join(BUILD, "pylibs")

SYSTEM = platform.system()          # Darwin | Windows | Linux
IS_MAC = SYSTEM == "Darwin"
IS_WIN = SYSTEM == "Windows"

APP_TITLE = "AI提示词工作台"
EXEC_NAME = "PromptStudio"
APP_NAME = "AI提示词工作台"

# Windows 上要打进包里的运行时依赖（原生窗口）
WIN_RUNTIME_DEPS = ["pywebview>=5.0"]
MAC_RUNTIME_DEPS = []               # macOS 用 Swift 外壳，不需要 pywebview
LINUX_RUNTIME_DEPS = ["pywebview>=5.0"]


def run(cmd, **kwargs):
    print("   $", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, **kwargs)


def step(text):
    print("\n\033[1m%s\033[0m" % text)


def find_python():
    """挑一个合适的 Python 来打包。

    优先用环境变量指定的，其次找 DSH 捆绑运行时（PyInstaller 对它签得最干净），
    再退到 Homebrew / 系统 Python。用 Xcode 自带的那个 3.9 会打出来签不过。
    """
    override = os.environ.get("APS_BUILD_PYTHON")
    if override and os.path.exists(override):
        return override

    candidates = [
        os.path.expanduser(
            "~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3"),
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    # 正在跑的没被 Xcode 拦下来的话，优先用正在跑的这个
    if sys.executable and "Xcode.app" not in sys.executable:
        candidates.insert(0, sys.executable)

    for path in candidates:
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path
    return sys.executable


def ensure_pip_target(py, packages, target):
    """把依赖装到项目内的目录，不污染系统环境。"""
    if not packages:
        return False
    marker = os.path.join(target, ".installed")
    if os.path.isdir(target) and os.path.exists(marker):
        return True
    os.makedirs(target, exist_ok=True)
    run([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
         "--target", target] + packages)
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write("\n".join(packages))
    return True


# --------------------------------------------------------------------------
# 图标
# --------------------------------------------------------------------------

def ensure_png(py, clean):
    png = os.path.join(BUILD, "icon.png")
    source = os.path.join(ROOT, "assets", "icon-source.png")
    if clean or not os.path.exists(png):
        step("① 生成图标 PNG")
        if os.path.exists(source):
            # 仓库里带了正式图标源图就用它，保证各处打出来的图标一致
            run([py, os.path.join(HERE, "import_icon.py"), source, "--content", "900"])
        else:
            run([py, os.path.join(HERE, "make_icon.py")])
    else:
        print("① 图标 PNG 已存在")
    # 没有满版方图时，用带边距的那张顶上
    square = os.path.join(BUILD, "icon-square.png")
    if not os.path.exists(square):
        shutil.copyfile(png, square)
    return png


def ensure_icns(png):
    icns = os.path.join(BUILD, "AppIcon.icns")
    if os.path.exists(icns) and os.path.getmtime(icns) >= os.path.getmtime(png):
        print("② .icns 已是最新")
        return icns
    step("② 生成 macOS .icns")
    iconset = os.path.join(BUILD, "icon.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset, exist_ok=True)
    for px, name in [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
                     (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
                     (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")]:
        run(["sips", "-z", str(px), str(px), png, "--out",
             os.path.join(iconset, "icon_%s.png" % name)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(["iconutil", "-c", "icns", iconset, "-o", icns])
    return icns


def ensure_ico(py):
    ico = os.path.join(BUILD, "AppIcon.ico")
    square = os.path.join(BUILD, "icon-square.png")
    if os.path.exists(ico) and os.path.getmtime(ico) >= os.path.getmtime(square):
        print("② .ico 已是最新")
        return ico
    step("② 生成 Windows .ico（满版，7 档尺寸）")
    code = (
        "from PIL import Image; import sys;"
        "im = Image.open(sys.argv[1]).convert('RGBA');"
        "im.save(sys.argv[2], sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
    )
    run([py, "-c", code, square, ico])
    return ico


# --------------------------------------------------------------------------
# PyInstaller
# --------------------------------------------------------------------------

def ensure_pyinstaller(py):
    probe = subprocess.run(
        [py, "-m", "PyInstaller", "--version"],
        capture_output=True, text=True,
        env=dict(os.environ, PYTHONPATH=PYLIBS),
    )
    if probe.returncode == 0:
        print("③ PyInstaller 就绪 (%s)" % probe.stdout.strip())
        return
    step("③ 安装 PyInstaller 到 build/pyinstaller")
    os.makedirs(PYLIBS, exist_ok=True)
    run([py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
         "--target", PYLIBS, "pyinstaller>=6.6"])


def run_pyinstaller(py, spec_name):
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([PYLIBS, RUNTIME_LIBS])
    # PyInstaller 默认往用户目录写缓存，这里挪进项目，既干净又能在受限环境里跑
    env["PYINSTALLER_CONFIG_DIR"] = os.path.join(BUILD, "pyinstaller-cache")
    os.makedirs(env["PYINSTALLER_CONFIG_DIR"], exist_ok=True)
    shutil.rmtree(os.path.join(BUILD, "work"), ignore_errors=True)
    run([py, "-m", "PyInstaller", "--noconfirm", "--clean", "--log-level", "WARN",
         "--distpath", DIST, "--workpath", os.path.join(BUILD, "work"),
         os.path.join(HERE, spec_name)],
        cwd=ROOT, env=env)


# --------------------------------------------------------------------------
# macOS：Swift 外壳 + .app
# --------------------------------------------------------------------------

def build_macos(py, icns):
    step("④ 编译原生窗口外壳 (Swift + WKWebView)")
    swiftc = subprocess.run(["xcrun", "--find", "swiftc"], capture_output=True, text=True)
    if swiftc.returncode != 0:
        sys.exit("找不到 swiftc，请先安装 Xcode 命令行工具：xcode-select --install")
    sdk = subprocess.run(["xcrun", "--show-sdk-path"], capture_output=True, text=True).stdout.strip()
    machine = platform.machine()
    target = ("arm64" if machine == "arm64" else "x86_64") + "-apple-macos12.0"
    cache = os.path.join(BUILD, "swift-cache")
    os.makedirs(cache, exist_ok=True)
    binary = os.path.join(BUILD, "AppWindow")
    run([swiftc.stdout.strip(), "-O", "-sdk", sdk, "-target", target,
         "-module-cache-path", cache, "-o", binary, os.path.join(HERE, "AppWindow.swift")])

    step("⑤ 打包本地服务")
    run_pyinstaller(py, "PromptStudio.spec")

    step("⑥ 组装 .app")
    app = os.path.join(DIST, "%s.app" % APP_NAME)
    shutil.rmtree(app, ignore_errors=True)
    os.makedirs(os.path.join(app, "Contents", "MacOS"))
    os.makedirs(os.path.join(app, "Contents", "Frameworks"))
    os.makedirs(os.path.join(app, "Contents", "Resources"))

    src = os.path.join(DIST, EXEC_NAME)
    for item in os.listdir(src):
        s = os.path.join(src, item)
        d = os.path.join(app, "Contents", "Frameworks", item)
        shutil.copytree(s, d) if os.path.isdir(s) else shutil.copy2(s, d)
    shutil.rmtree(src, ignore_errors=True)

    shutil.copy2(binary, os.path.join(app, "Contents", "MacOS", "PromptStudioApp"))
    os.chmod(os.path.join(app, "Contents", "MacOS", "PromptStudioApp"), 0o755)
    shutil.copy2(icns, os.path.join(app, "Contents", "Resources", "AppIcon.icns"))
    shutil.copy2(os.path.join(HERE, "Info.plist"), os.path.join(app, "Contents", "Info.plist"))
    with open(os.path.join(app, "Contents", "PkgInfo"), "w") as fh:
        fh.write("APPL????")

    step("⑦ ad-hoc 签名")
    r = subprocess.run(["codesign", "--force", "--deep", "--sign", "-", "--timestamp=none", app],
                       capture_output=True, text=True)
    verify = subprocess.run(["codesign", "--verify", app], capture_output=True, text=True)
    if verify.returncode == 0:
        print("   ✓ 签名校验通过")
    else:
        print("   ⚠ 签名有警告（本地运行通常不受影响）")
        if r.stderr:
            print("     " + r.stderr.strip().splitlines()[-1])
    subprocess.run(["xattr", "-cr", app], capture_output=True)
    return app


# --------------------------------------------------------------------------
# Windows / Linux：PyInstaller 直接出可执行文件
# --------------------------------------------------------------------------

def build_windows(py, ico):
    step("④ 打包（PyInstaller，含原生窗口 pywebview）")
    ensure_pip_target(py, WIN_RUNTIME_DEPS, RUNTIME_LIBS)
    run_pyinstaller(py, "PromptStudio-win.spec")
    out = os.path.join(DIST, APP_NAME)
    if not os.path.isdir(out):
        out = os.path.join(DIST, EXEC_NAME)
    return out


def build_linux(py):
    step("④ 打包（PyInstaller）")
    ensure_pip_target(py, LINUX_RUNTIME_DEPS, RUNTIME_LIBS)
    run_pyinstaller(py, "PromptStudio-win.spec")
    return os.path.join(DIST, APP_NAME)


def make_zip(folder):
    """Windows 产物打成 zip，方便分发。"""
    zip_path = folder.rstrip("\\/") + ".zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for base, _dirs, files in os.walk(folder):
            for name in files:
                full = os.path.join(base, name)
                zf.write(full, os.path.relpath(full, os.path.dirname(folder)))
    return zip_path


# --------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="打包 AI 文生图提示词工作台")
    parser.add_argument("--clean", action="store_true", help="重新生成图标")
    args = parser.parse_args()

    py = find_python()
    ver = subprocess.run([py, "-c", "import sys;print(sys.version.split()[0])"],
                         capture_output=True, text=True).stdout.strip()
    if IS_MAC and "Xcode.app" in py:
        print("⚠ 正在用 Xcode 自带的 Python（%s），打出来的 .app 可能签不过。" % ver)
        print("  建议： APS_BUILD_PYTHON=/path/to/python3 python3 tools/build.py")
    print("=" * 62)
    print("  打包 AI 文生图提示词工作台")
    print("  平台    : %s %s" % (SYSTEM, platform.machine()))
    print("  Python  : %s  (%s)" % (py, ver))
    print("  项目目录: %s" % ROOT)
    print("=" * 62)

    os.makedirs(BUILD, exist_ok=True)
    png = ensure_png(py, args.clean)

    if IS_MAC:
        icns = ensure_icns(png)
        ensure_pyinstaller(py)
        out = build_macos(py, icns)
    elif IS_WIN:
        ico = ensure_ico(py)
        ensure_pyinstaller(py)
        out = build_windows(py, ico)
        out = make_zip(out) if os.path.isdir(out) else out
    else:
        ensure_pyinstaller(py)
        out = build_linux(py)

    size = 0
    if os.path.isdir(out):
        for base, _d, files in os.walk(out):
            size += sum(os.path.getsize(os.path.join(base, f)) for f in files)
    else:
        size = os.path.getsize(out)

    print()
    print("=" * 62)
    print("  ✅ 打包完成")
    print("  产物: %s" % out)
    print("  体积: %.1f MB" % (size / 1024 / 1024))
    print("=" * 62)
    if IS_MAC:
        print("\n安装：拖进 /Applications。首次打开：右键 →「打开」。")
    elif IS_WIN:
        print("\n解压后双击 %s.exe 即可。" % EXEC_NAME)
    return 0


if __name__ == "__main__":
    sys.exit(main())
