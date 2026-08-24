#!/usr/bin/env bash
#
# One command for rung 4: local agent backend + the Next.js app, wired together.
#
#   pnpm --filter open-swe dev:local
#
# Ports (override by env):
#   AGENT_PORT  local agent backend   (default 8100 — 8000 collides with rung 5 DynamoDB Local)
#   PORT        the Next.js app       (default 3001 — the repo's open-swe port)
#
# The agent backend is started here rather than expected to already exist,
# because "clone and run" is the whole point of this rung. Nothing outside
# apps/open-swe/ is touched, so `pnpm eject langchain` still removes the rung
# cleanly.
set -uo pipefail

AGENT_PORT="${AGENT_PORT:-8100}"
APP_PORT="${PORT:-3001}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT_PID=""
cleanup() { [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "▸ starting local agent backend on :$AGENT_PORT"
node "$HERE/server.mjs" --port "$AGENT_PORT" &
AGENT_PID=$!

# Wait for it, and FAIL LOUDLY if it never comes up. A backgrounded launch
# whose exit status is discarded is how a dead server turns into a confusing
# error 60 seconds later somewhere else.
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$AGENT_PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf "http://localhost:$AGENT_PORT/health" >/dev/null 2>&1; then
  echo "✖ agent backend did not become reachable on :$AGENT_PORT" >&2
  echo "  Is something else already using that port? Try: AGENT_PORT=8010 pnpm --filter open-swe dev:local" >&2
  exit 1
fi
echo "▸ agent backend ready"

# LANGGRAPH_PLATFORM_URL points at the local backend we just started. Any value
# already in the environment wins, so pointing at a real Platform still works.
export LANGGRAPH_PLATFORM_URL="${LANGGRAPH_PLATFORM_URL:-http://localhost:$AGENT_PORT}"
export PORT="$APP_PORT"

echo "▸ open-swe on http://localhost:$APP_PORT  (backend: $LANGGRAPH_PLATFORM_URL)"
cd "$HERE/.." && exec pnpm exec next dev --turbopack --port "$APP_PORT"
