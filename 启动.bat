@echo off
chcp 65001 >nul
title AI 文生图提示词工作台
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    python server.py
    goto end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py
    goto end
)

echo.
echo [错误] 没有找到 Python。请先安装 Python 3: https://www.python.org/downloads/
echo        安装时请勾选 "Add Python to PATH"。
echo.

:end
pause
