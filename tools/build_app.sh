#!/bin/bash
# 兼容旧入口：实际逻辑都在 tools/build.py（跨平台）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${APS_BUILD_PYTHON:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3}"
[ -x "$PY" ] || PY="$(command -v python3)"
exec "$PY" "$HERE/build.py" "$@"
