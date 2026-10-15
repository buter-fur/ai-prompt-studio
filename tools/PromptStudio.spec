# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 配置：只负责产出「本地服务 + 静态资源」的可执行目录。

.app 外壳由 tools/build_app.sh 手工组装（Swift 原生窗口 + 图标 + Info.plist），
这样能完全控制 Info.plist、签名顺序和 Frameworks 布局。
"""

import os

ROOT = os.path.dirname(os.path.abspath(SPECPATH))
EXEC_NAME = "PromptStudio"

a = Analysis(
    [os.path.join(ROOT, "server.py")],
    pathex=[ROOT],
    binaries=[],
    datas=[
        # 只打包只读资源；data/ 是用户数据，绝不进包
        (os.path.join(ROOT, "app"), "app"),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 界面跑在 Swift 的原生窗口里，不需要 tkinter / Tcl / Tk
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
    console=False,              # 不带终端窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name=EXEC_NAME,
)
