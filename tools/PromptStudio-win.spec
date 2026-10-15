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

hidden = []
# pywebview 的后端是按平台动态导入的，静态分析抓不到，得手动收一遍
hidden += collect_submodules("webview")
hidden += ["clr", "pythonnet", "proxy_tools", "bottle"]

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
        "pptx", "docx", "scipy", "pytest", "setuptools", "pip",
        "unittest", "pydoc", "doctest", "distutils",
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
    name="AI提示词工作台",              # 外层文件夹用中文名，双击进去就是 exe
)
