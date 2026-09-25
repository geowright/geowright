#!/bin/bash
# Stops THIS repo's `vite preview` (so the next test run rebuilds the demo) — and nothing else.
# Scoped on purpose: by port AND by working directory. Never `pkill -f "vite preview"`: that
# matches every preview server of every project this user runs on the machine.
set -euo pipefail
PORT=${GEOWRIGHT_PORT:-4173}
WILD_PORT=${GEOWRIGHT_WILD_PORT:-$((PORT + 1))}   # wild/serve.mjs
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
for PORT in "$PORT" "$WILD_PORT"; do
for pid in $(lsof -ti "TCP:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  # Ours = its working directory is inside THIS checkout's working tree. Not a path prefix: that also matched a
  # worktree nested in this checkout (.claude/worktrees/…) and a sibling directory such as "$REPO-other".
  top=$( [ -d "$cwd" ] && git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
  [ -z "$top" ] || top=$(cd "$top" && pwd -P)
  if [ -n "$top" ] && [ "$top" = "$REPO" ]; then
    kill "$pid" && echo "stopped server pid $pid (port $PORT, cwd $cwd)"
  else
    echo "port $PORT is held by pid $pid in $cwd — not ours, left alone" >&2
  fi
done
done
