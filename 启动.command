#!/bin/bash
# 双击这个文件即可启动「AI 文生图提示词工作台」
cd "$(dirname "$0")" || exit 1

echo "正在启动 AI 文生图提示词工作台..."
echo

PY=""
for candidate in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done

if [ -z "$PY" ]; then
  echo "❌ 没有找到 python3。"
  echo "   请先安装 Python 3：https://www.python.org/downloads/"
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
