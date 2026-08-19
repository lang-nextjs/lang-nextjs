#!/usr/bin/env bash
#
# One-command launcher for the Lang-Next.js demo.
#
# Boots the three pieces the demo needs and then runs the app in the foreground:
#   1. Chat backend   — FastAPI (Docker) on :8030  → powers /chat (LangGraph /
#                       LangChain / DeepAgents via OpenRouter)
#   2. langgraph dev  — the OpenSWE agent on :2024  → powers / (the queue)
#   3. Lang-Next.js   — the Next.js app on :3000
#
# Ctrl+C stops the app and tears down everything this script started.
#
# Config (env overrides):
#   OPEN_SWE_DIR   path to the open-swe clone   (default: $HOME/code/open-swe)
#   CHAT_PORT      chat backend port            (default: 8030)
#   APP_PORT       app port                     (default: 3000)
#   LG_PORT        langgraph dev port           (default: 2024)
#   SKIP_QUEUE=1   don't start langgraph dev (chat-only demo)
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPEN_SWE_DIR="${OPEN_SWE_DIR:-$HOME/code/open-swe}"
CHAT_PORT="${CHAT_PORT:-8030}"
APP_PORT="${APP_PORT:-3000}"
LG_PORT="${LG_PORT:-2024}"

C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
log()  { printf '%s▸ %s%s\n' "$C_GREEN" "$1" "$C_RST"; }
warn() { printf '%s⚠ %s%s\n' "$C_YELLOW" "$1" "$C_RST"; }

STARTED_CHAT=0
LG_PID=""

cleanup() {
  echo
  log "shutting down…"
  [ -n "$LG_PID" ] && kill "$LG_PID" 2>/dev/null
  pkill -f "langgraph dev.*--port $LG_PORT" 2>/dev/null
  [ "$STARTED_CHAT" = "1" ] && docker stop chat-backend >/dev/null 2>&1
  log "done."
}
trap cleanup EXIT INT TERM

wait_for() { # url, label, tries
  local url="$1" label="$2" tries="${3:-30}"
  for ((i=1; i<=tries; i++)); do
    curl -sf -m 3 "$url" >/dev/null 2>&1 && { log "$label ready"; return 0; }
    sleep 2
  done
  warn "$label did not become ready at $url (continuing anyway)"
  return 1
}

# ── 1. Chat backend (FastAPI, Docker) ────────────────────────────────────────
if curl -sf -m 3 "http://localhost:$CHAT_PORT/health" >/dev/null 2>&1; then
  log "chat backend already up on :$CHAT_PORT"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker image inspect fastapi-backend-backend:latest >/dev/null 2>&1; then
    log "starting chat backend on :$CHAT_PORT (Docker)…"
    docker rm -f chat-backend >/dev/null 2>&1
    docker run -d -p "$CHAT_PORT:8001" \
      --env-file "$REPO/apps/fastapi-backend/.env.local" \
      --name chat-backend fastapi-backend-backend:latest >/dev/null \
      && STARTED_CHAT=1
    wait_for "http://localhost:$CHAT_PORT/health" "chat backend" 30
  else
    warn "fastapi-backend-backend image not found — build it first:"
    warn "  (cd apps/fastapi-backend && docker compose build)"
    warn "/chat will return 502 until the backend is up."
  fi
else
  warn "Docker not available — /chat needs the FastAPI backend. Skipping it."
fi

# ── 2. langgraph dev (OpenSWE agent) ─────────────────────────────────────────
if [ "${SKIP_QUEUE:-0}" = "1" ]; then
  warn "SKIP_QUEUE=1 — not starting langgraph dev (queue backend)."
elif curl -sf -m 3 "http://localhost:$LG_PORT/ok" >/dev/null 2>&1; then
  log "langgraph dev already up on :$LG_PORT"
elif [ -d "$OPEN_SWE_DIR" ] && command -v uv >/dev/null 2>&1; then
  log "starting langgraph dev on :$LG_PORT (from $OPEN_SWE_DIR)…"
  ( cd "$OPEN_SWE_DIR" && exec uv run langgraph dev --no-browser --no-reload --port "$LG_PORT" ) \
    > /tmp/langgraph-dev.log 2>&1 &
  LG_PID=$!
  printf '%s  logs: /tmp/langgraph-dev.log%s\n' "$C_DIM" "$C_RST"
  wait_for "http://localhost:$LG_PORT/ok" "langgraph dev" 40
else
  warn "OPEN_SWE_DIR ($OPEN_SWE_DIR) or uv not found — the queue (/) backend"
  warn "won't start. Set OPEN_SWE_DIR=/path/to/open-swe, or use SKIP_QUEUE=1."
fi

# ── 3. The app (foreground) ──────────────────────────────────────────────────
echo
log "starting Lang-Next.js on http://localhost:$APP_PORT"
printf '%s  💬 chat:  http://localhost:%s/chat\n  ⚙  queue: http://localhost:%s/%s\n\n' \
  "$C_DIM" "$APP_PORT" "$APP_PORT" "$C_RST"
cd "$REPO"
exec pnpm --filter open-swe dev
