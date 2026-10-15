# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 配置（Windows / Linux）。

macOS 走 PromptStudio.spec + Swift 外壳，不用这个。
这里会把 pywebview 一起打进去，让 exe 双击后弹原生窗口而不是浏览器。
"""

import os

from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.dirname(os.path.abspath(SPECPATH))
BUILD = os.path.join(ROOT, "build")
EXEC_NAME = "PromptStudio"

def _importable(name):
    """PyInstaller 会把「找不到的 hidden import」当硬错误中止，
    所以只列当前环境里真正能导入的模块。"""
    try:
        __import__(name)
        return True
    except Exception:
        return False


# pywebview 的后端是按平台动态导入的，静态分析抓不到，得手动收一遍。
# android / gtk / qt 这些后端在本平台装不上，用 on_error="ignore" 静默跳过。
hidden = list(collect_submodules("webview", on_error="ignore"))

# 注意：pythonnet 是 pip 包名，导入名是 clr —— 写 'pythonnet' 会直接让构建失败。
# 这几个按平台差异很大（clr 只在 Windows 有），所以逐个探测。
for extra in ("clr", "pythonnet", "clr_loader", "proxy_tools", "bottle",
              "typing_extensions", "importlib_resources"):
    if _importable(extra):
        hidden.append(extra)

a = Analysis(
    [os.path.join(ROOT, "server.py")],
    pathex=[ROOT, os.path.join(BUILD, "pylibs")],
    binaries=[],
    datas=[
        # 只打包只读资源；data/ 是用户数据，绝不进包
        (os.path.join(ROOT, "app"), "app"),
    ],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 界面跑在 pywebview 的原生窗口里，不需要 tkinter / Tcl / Tk
        "tkinter", "_tkinter", "Tkinter", "turtle", "turtledemo", "idlelib",
        "numpy", "pandas", "matplotlib", "PIL", "lxml", "openpyxl",
        "pptx", "docx", "scipy", "pytest",
        # 注意：不要排除 setuptools / pip / distutils。
        # Python 3.12 起 distutils 已从标准库移除，只由 setuptools._distutils 提供，
        # PyInstaller 的 hook-distutils 会做 setuptools._distutils → distutils 的别名，
        # 一旦 distutils 被 exclude，就会抛
        # ValueError: Target module "distutils" already imported as "ExcludedModule(...)"
        "unittest", "pydoc", "doctest",
    ],
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=EXEC_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                      # 不带黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(BUILD, "AppIcon.ico") if os.path.exists(os.path.join(BUILD, "AppIcon.ico")) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="AI-Prompt-Studio",            # 外层文件夹用 ASCII：中文名在 zip 里容易乱码
)
