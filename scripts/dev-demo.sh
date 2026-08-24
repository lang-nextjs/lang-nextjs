#!/usr/bin/env bash
#
# One-command launcher for the Lang-Next.js demo.
#
# Boots what the demo needs and then runs the app in the foreground:
#   1. Chat backend  — FastAPI (Docker) on :8030  → powers /chat (rungs 1–3:
#                      LangChain / LangGraph / DeepAgents via OpenRouter)
#   2. Agent backend — the bundled local agent on :8100 → powers / (rung 4 queue)
#   3. Lang-Next.js  — the Next.js app on :3001
#
# Ctrl+C stops the app and tears down everything this script started.
#
# Config (env overrides):
#   CHAT_PORT      chat backend port             (default: 8030)
#   AGENT_PORT     rung-4 agent backend port     (default: 8100)
#   APP_PORT       app port                      (default: 3001)
#   OPEN_SWE_DIR   external open-swe clone       (optional — see "External
#                  LangGraph" below; unset by default)
#   LG_PORT        langgraph dev port            (default: 2024, external path only)
#   SKIP_CHAT=1    run without the chat backend  (rung 4 only)
#   SKIP_QUEUE=1   run without the agent backend (chat only)
#
# ── Why this script no longer needs an external clone ────────────────────────
# It used to start rung 4 by running `uv run langgraph dev` inside a SEPARATE
# clone of the upstream open-swe project, defaulting to ~/code/open-swe. If that
# clone was absent it warned and continued, and the app came up pointing at
# nothing — a dashboard that loads and then shows "Failed to fetch runs: 502"
# with no indication why. It also never exported LANGGRAPH_PLATFORM_URL at all,
# so even *with* the clone present the app was not wired to it.
#
# apps/open-swe/agent/ now ships a local agent backend serving the same
# endpoints with no external dependency, so that is the default path here. It is
# the same backend `pnpm --filter open-swe dev:local` starts.
#
# ── External LangGraph (opt-in) ──────────────────────────────────────────────
# Set OPEN_SWE_DIR=/path/to/open-swe to run the real upstream agent via
# `uv run langgraph dev` instead of the bundled one. Both paths export
# LANGGRAPH_PLATFORM_URL so the app is actually wired to whichever is running.
#
# ── Failure policy ───────────────────────────────────────────────────────────
# This script REFUSES rather than half-starts. A demo that comes up with a dead
# backend teaches the reader that the repo is broken, when the truth is that one
# prerequisite was missing. Every prerequisite failure below exits non-zero and
# says what to do; use SKIP_CHAT=1 / SKIP_QUEUE=1 to opt out deliberately.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAT_PORT="${CHAT_PORT:-8030}"
AGENT_PORT="${AGENT_PORT:-8100}"
APP_PORT="${APP_PORT:-3001}"
LG_PORT="${LG_PORT:-2024}"
OPEN_SWE_DIR="${OPEN_SWE_DIR:-}"

C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
log()  { printf '%s▸ %s%s\n' "$C_GREEN"  "$1" "$C_RST"; }
warn() { printf '%s⚠ %s%s\n' "$C_YELLOW" "$1" "$C_RST"; }
die()  { printf '%s✖ %s%s\n' "$C_RED"    "$1" "$C_RST" >&2; }

STARTED_CHAT=0
AGENT_PID=""
LG_PID=""

cleanup() {
  echo
  log "shutting down…"
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
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
  return 1
}

# ── 1. Chat backend (rungs 1–3: FastAPI, Docker) ─────────────────────────────
if [ "${SKIP_CHAT:-0}" = "1" ]; then
  warn "SKIP_CHAT=1 — /chat (rungs 1–3) will 502. Rung 4 queue still runs."
elif curl -sf -m 3 "http://localhost:$CHAT_PORT/health" >/dev/null 2>&1; then
  log "chat backend already up on :$CHAT_PORT"
else
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    die "Docker is not available, and /chat (rungs 1–3) needs the FastAPI backend."
    die "  Start Docker, or re-run chat-free:  SKIP_CHAT=1 pnpm demo"
    exit 1
  fi
  if ! docker image inspect fastapi-backend-backend:latest >/dev/null 2>&1; then
    die "Docker image fastapi-backend-backend:latest not found."
    die "  Build it:  (cd apps/fastapi-backend && docker compose build)"
    die "  Or re-run chat-free:  SKIP_CHAT=1 pnpm demo"
    exit 1
  fi
  if [ ! -f "$REPO/apps/fastapi-backend/.env.local" ]; then
    die "apps/fastapi-backend/.env.local is missing — the backend needs OPENROUTER_API_KEY."
    die "  cp apps/fastapi-backend/.env.local.example apps/fastapi-backend/.env.local"
    die "  Or re-run chat-free:  SKIP_CHAT=1 pnpm demo"
    exit 1
  fi
  log "starting chat backend on :$CHAT_PORT (Docker)…"
  docker rm -f chat-backend >/dev/null 2>&1
  docker run -d -p "$CHAT_PORT:8001" \
    --env-file "$REPO/apps/fastapi-backend/.env.local" \
    --name chat-backend fastapi-backend-backend:latest >/dev/null && STARTED_CHAT=1
  if ! wait_for "http://localhost:$CHAT_PORT/health" "chat backend" 30; then
    die "chat backend never became reachable on :$CHAT_PORT"
    die "  Logs:  docker logs chat-backend"
    exit 1
  fi
fi

# ── 2. Rung 4 agent backend ──────────────────────────────────────────────────
# LANGGRAPH_PLATFORM_URL is exported in every branch that starts a backend.
# Without it the app has no idea where its agent lives, which is precisely the
# defect this script used to ship.
if [ "${SKIP_QUEUE:-0}" = "1" ]; then
  warn "SKIP_QUEUE=1 — the rung-4 queue (/) will 502. /chat still runs."
elif curl -sf -m 3 "http://localhost:$AGENT_PORT/health" >/dev/null 2>&1; then
  log "agent backend already up on :$AGENT_PORT"
  export LANGGRAPH_PLATFORM_URL="${LANGGRAPH_PLATFORM_URL:-http://localhost:$AGENT_PORT}"
elif [ -n "$OPEN_SWE_DIR" ]; then
  # Opt-in: the real upstream agent from an external clone.
  if [ ! -d "$OPEN_SWE_DIR" ]; then
    die "OPEN_SWE_DIR is set to '$OPEN_SWE_DIR' but that directory does not exist."
    die "  Unset OPEN_SWE_DIR to use the bundled agent instead (no clone required)."
    exit 1
  fi
  if ! command -v uv >/dev/null 2>&1; then
    die "OPEN_SWE_DIR is set but 'uv' is not installed — it is needed to run langgraph dev."
    die "  Install uv, or unset OPEN_SWE_DIR to use the bundled agent instead."
    exit 1
  fi
  log "starting langgraph dev on :$LG_PORT (from $OPEN_SWE_DIR)…"
  ( cd "$OPEN_SWE_DIR" && exec uv run langgraph dev --no-browser --no-reload --port "$LG_PORT" ) \
    > /tmp/langgraph-dev.log 2>&1 &
  LG_PID=$!
  printf '%s  logs: /tmp/langgraph-dev.log%s\n' "$C_DIM" "$C_RST"
  if ! wait_for "http://localhost:$LG_PORT/ok" "langgraph dev" 40; then
    die "langgraph dev never became reachable on :$LG_PORT"
    die "  Logs:  /tmp/langgraph-dev.log"
    die "  Or unset OPEN_SWE_DIR to use the bundled agent instead."
    exit 1
  fi
  export LANGGRAPH_PLATFORM_URL="http://localhost:$LG_PORT"
else
  # Default: the bundled local agent. Same backend as `dev:local`.
  log "starting bundled agent backend on :${AGENT_PORT}…"
  node "$REPO/apps/open-swe/agent/server.mjs" --port "$AGENT_PORT" &
  AGENT_PID=$!
  # If the agent died on startup (EADDRINUSE is the common one), say so now
  # rather than polling a port it was never going to answer on for 60s. A slow
  # timeout reports "never became reachable" when the truth is "exited at once".
  sleep 1
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    die "bundled agent backend exited immediately on startup (:$AGENT_PORT)."
    die "  Most likely that port is already in use. Try:  AGENT_PORT=8110 pnpm demo"
    exit 1
  fi
  if ! wait_for "http://localhost:$AGENT_PORT/health" "agent backend" 30; then
    die "bundled agent backend never became reachable on :$AGENT_PORT"
    die "  Is something else on that port?  AGENT_PORT=8110 pnpm demo"
    exit 1
  fi
  export LANGGRAPH_PLATFORM_URL="http://localhost:$AGENT_PORT"
fi

# ── 3. The app (foreground) ──────────────────────────────────────────────────
echo
log "starting Lang-Next.js on http://localhost:$APP_PORT"
if [ "${SKIP_QUEUE:-0}" != "1" ]; then
  printf '%s  agent backend: %s%s\n' "$C_DIM" "${LANGGRAPH_PLATFORM_URL:-<unset>}" "$C_RST"
fi
printf '%s  💬 chat:  http://localhost:%s/chat\n  ⚙  queue: http://localhost:%s/%s\n\n' \
  "$C_DIM" "$APP_PORT" "$APP_PORT" "$C_RST"
cd "$REPO"
# PORT must be passed explicitly: apps/open-swe's dev script binds
# `--port ${PORT:-3001}` and never reads APP_PORT. Without this line an
# APP_PORT override would be advertised in the messages above and then quietly
# ignored — the same silent-override trap this repo fixed in CI, where
# `PORT: 3001` lost to a hardcoded `--port 3000`.
#
# LANGGRAPH_PLATFORM_URL is exported above rather than left to
# apps/open-swe/.env.local. A real environment variable wins over .env files in
# Next.js, so the value the script actually started is the value the app uses —
# a stale .env.local cannot silently repoint the app at a dead port.
# Guarded on the manifest. `pnpm demo` is the command a forker runs first, so it must not end
# in a pnpm error about a workspace their fork legitimately does not contain.
if [ "$(node "$REPO/scripts/has-rung.mjs" open-swe)" != "yes" ]; then
  echo
  echo "This tree does not declare the open-swe rung, so there is no dashboard to start."
  echo "The backend above is running; point your own client at it, or eject to a rung that"
  echo "includes open-swe."
  exit 0
fi

exec env PORT="$APP_PORT" pnpm --filter open-swe dev
