#!/bin/bash
# 双击这个文件即可启动「AI 文生图提示词工作台」
# 如果双击没反应，多半是文件丢了可执行权限（从 ZIP 解压时会丢）：
#   chmod +x 启动.command

cd "$(dirname "$0")" || exit 1

echo "正在启动 AI 文生图提示词工作台..."
echo

# macOS 自带的 /usr/bin/python3 在没装 Xcode 命令行工具时只是个占位程序：
# 一运行就弹「安装命令行开发者工具」的对话框，用户会以为软件坏了。
# 所以先看 CLT 装没装，没装就跳过它。
CLT_OK=0
if xcode-select -p >/dev/null 2>&1; then CLT_OK=1; fi

PY=""
REASON=""

for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  [ -n "$resolved" ] || continue

  # 指向 CLT 占位程序的，没装命令行工具就别碰
  case "$resolved" in
    /usr/bin/python3) [ "$CLT_OK" = "1" ] || continue ;;
  esac

  "$resolved" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 2)' >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    PY="$resolved"
    break
  elif [ "$rc" -eq 2 ]; then
    REASON="old"
  elif [ -z "$REASON" ]; then
    REASON="missing"
  fi
done

if [ -z "$PY" ]; then
  echo "❌ 没有找到可用的 python3。"
  echo
  if [ "$REASON" = "old" ]; then
    echo "   找到了 Python，但版本低于 3.8，请升级："
  elif [ "$CLT_OK" = "0" ]; then
    echo "   系统自带的 python3 需要先安装「命令行开发者工具」："
    echo "     xcode-select --install"
    echo "   装完后重新双击本文件；或者直接安装新版 Python："
  else
    echo "   请先安装 Python 3.8 或更高版本："
  fi
  echo "     https://www.python.org/downloads/"
  echo
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

if [ ! -f "server.py" ]; then
  echo "❌ 当前目录下没有 server.py，请确认整个文件夹都解压出来了。"
  echo "   当前位置：$(pwd)"
  echo
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

"$PY" server.py
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo
  echo "❌ 服务异常退出（代码 $STATUS）。"
  read -r -p "按回车键关闭窗口..."
fi
