#!/bin/bash
# Stops THIS repo's `vite preview` (so the next test run rebuilds the demo) — and nothing else.
# Scoped on purpose: by port AND by working directory. Never `pkill -f "vite preview"`: that
# matches every preview server of every project this user runs on the machine.
set -euo pipefail
PORT=${GEOWRIGHT_PORT:-4173}
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
for pid in $(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd" in
    "$REPO"*) kill "$pid" && echo "stopped preview pid $pid (port $PORT, cwd $cwd)" ;;
    *) echo "port $PORT is held by pid $pid in $cwd — not ours, left alone" >&2 ;;
  esac
done
