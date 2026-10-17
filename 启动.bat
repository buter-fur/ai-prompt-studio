@echo off
chcp 65001 >nul
title AI 文生图提示词工作台
cd /d "%~dp0"

rem =====================================================================
rem  找一个能用的 Python（要求 3.8 或更高版本）
rem
rem  不能只看 where python：微软商店的 python.exe 只是个占位程序
rem  （在 WindowsApps 目录下），where 能找到它，但真去跑会返回 9009
rem  并弹出应用商店，服务根本起不来。所以这里必须真跑一次 -c 来判断。
rem =====================================================================
set "PY="
set "REASON="

python -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 2)" >nul 2>nul
call :judge %errorlevel% python
if defined PY goto run

py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 2)" >nul 2>nul
call :judge %errorlevel% "py -3"
if defined PY goto run

if "%REASON%"=="old" goto oldpython
goto nopython

rem ---------------------------------------------------------------------
rem  %1 = 上一条命令的退出码, %2 = 可用的命令名
rem  0    = 可用
rem  2    = 我们自己约定的「版本过低」
rem  其它 = 装不上 / 只是个商店占位程序 / 根本不存在
rem ---------------------------------------------------------------------
:judge
if "%~1"=="0" (
    set "PY=%~2"
    goto :eof
)
if "%~1"=="2" (
    set "REASON=old"
) else (
    set "REASON=missing"
)
goto :eof

:run
if not exist "server.py" (
    echo.
    echo [错误] 当前目录下没有 server.py，请确认整个文件夹都解压出来了。
    echo        当前位置：%CD%
    echo.
    goto end
)
echo 正在启动 AI 文生图提示词工作台...
echo.
%PY% server.py
goto end

:nopython
echo.
echo [错误] 没有找到可用的 Python。
echo.
echo        请先安装 Python 3.8 或更高版本：
echo          https://www.python.org/downloads/
echo        安装时请勾选 "Add Python to PATH"。
echo.
echo        如果你已经在微软商店里点过"获取"，那装的是个占位程序，
echo        还需要去上面的官网下载真正的安装包。
echo.
goto end

:oldpython
echo.
echo [错误] 当前 Python 版本过低，需要 3.8 或更高版本。
echo.
%PY% --version 2^>nul
echo        请升级后重试：https://www.python.org/downloads/
echo.
goto end

:end
echo.
echo 窗口将在按键后关闭...
pause >nul
