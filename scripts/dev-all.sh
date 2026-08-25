#!/usr/bin/env bash
#
# ONE COMMAND. Everything up, secrets read where they already are.
#
#   pnpm dev
#
# Starts, in dependency order, and PROBES each one before moving on:
#
#   :8001  fastapi backend (docker)   the model — reads the repo-root .env
#   :8100  open-swe queue agent       rung 4's run backend
#   :3001  open-swe app               the main app
#   :3000  example app                only with --with-example
#
# SECRETS ARE NOT COPIED. The repo-root .env is the single source; the backend's
# compose file reads it directly via an `env_file` entry, so there is no second
# copy to drift. Nothing here ever prints a value — only whether a NAME is set.
#
# Flags:
#   --with-example   also start the legacy :3000 demo
#   --no-backend     skip docker; use an already-running :8001 (or none)
#   --down           stop everything this script starts, then exit
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

WITH_EXAMPLE=0
NO_BACKEND=0
DOWN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --with-example) WITH_EXAMPLE=1 ;;
    --no-backend)   NO_BACKEND=1 ;;
    --down)         DOWN_ONLY=1 ;;
    -h|--help)      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

AGENT_PORT="${AGENT_PORT:-8100}"
APP_PORT="${PORT:-3001}"
EXAMPLE_PORT="${EXAMPLE_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8001}"

# WHERE THE PORT CAME FROM, said out loud.
#
# Honouring an inherited $PORT is correct — that is how a preview harness or a
# container tells us where to bind. Doing it SILENTLY is not: the app comes up
# on a port nobody typed, every doc and bookmark says :3001, and the natural
# conclusion is that the app is broken rather than relocated. A dev-preview
# proxy set PORT here and the app landed on :7669 while its operator was looking
# at :3001, which is the whole failure in one line.
PORT_SOURCE="default"
[ -n "${PORT:-}" ] && PORT_SOURCE="inherited from \$PORT in your environment"

# Track ONLY what we start. Tearing down a service the user was already running
# is the kind of helpfulness that costs somebody their afternoon — a live dev
# server got killed that way earlier in this project's history.
AGENT_PID=""; APP_PID=""; EXAMPLE_PID=""; WE_STARTED_BACKEND=0

# EVERY SERVICE'S OUTPUT IS KEPT. The first version of this script sent all of
# it to /dev/null, and when the app failed to answer in time the error said only
# "did not answer after 120s" — which cannot distinguish a slow cold start from
# a crash on boot. That is the same defect this repo has spent days removing,
# in the tool meant to make starting up easy: a failure whose cause is discarded
# at the moment it happens.
LOGDIR="$ROOT/.dev-logs"
mkdir -p "$LOGDIR"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

cleanup() {
  echo
  say "shutting down what this script started…"
  for pid in "$APP_PID" "$EXAMPLE_PID" "$AGENT_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  if [ "$WE_STARTED_BACKEND" = "1" ]; then
    (cd "$ROOT/apps/fastapi-backend" && docker compose down >/dev/null 2>&1)
    say "backend container stopped"
  else
    [ "$NO_BACKEND" = "0" ] && say "left the backend running — it was up before this script"
  fi
}
trap cleanup EXIT INT TERM

up() { curl -sf -o /dev/null --max-time 2 "$1" 2>/dev/null; }

# Wait for a URL, and FAIL LOUDLY if it never answers. A backgrounded launch
# whose status is discarded turns a dead server into a confusing error somewhere
# else, sixty seconds later.
wait_for() { # url, seconds, label
  local url="$1" secs="$2" label="$3" i=0
  local logf="${LOGDIR}/${label// /-}.log"
  while [ "$i" -lt $((secs * 2)) ]; do
    up "$url" && { [ "$i" -gt 20 ] && printf '\n'; return 0; }

    # STOP WAITING ON A FATAL. Waiting the full timeout for a process that has
    # already exited turns a five-second answer into a five-minute one, and the
    # message you finally get is "did not answer", which points at the wrong
    # thing entirely.
    #
    # The case that taught this: Next 16 refuses a second `next dev` FOR THE
    # SAME DIRECTORY regardless of port. The port was free, so the
    # already-running check passed — it was watching the port while Next's
    # constraint is the directory. Two different subjects, and the check could
    # not see the one that mattered.
    if [ -s "$logf" ] && grep -qE "Another .*dev server is already running|EADDRINUSE|ELIFECYCLE|Cannot find module" "$logf" 2>/dev/null; then
      bad "$label failed to start — see below (waited only $((i / 2))s; the log already said so)"
      tail -n 14 "$logf" | sed 's/^/      /'
      return 1
    fi
    # A silent two-minute wait is indistinguishable from a hang. Tick every 15s.
    [ $((i % 30)) -eq 0 ] && [ "$i" -gt 0 ] && printf '    …still waiting for %s (%ss)\n' "$label" "$((i / 2))"
    i=$((i + 1)); sleep 0.5
  done
  bad "$label did not answer on $url after ${secs}s"
  # Name the log and show its tail. "It timed out" is not a diagnosis, and the
  # answer is almost always in the last few lines.
  local logf="${LOGDIR}/${label// /-}.log"
  if [ -s "$logf" ]; then
    say "last lines of ${logf}:"
    tail -n 12 "$logf" | sed 's/^/      /'
  else
    say "no output was captured in ${logf} — the process may not have started at all"
  fi
  return 1
}

if [ "$DOWN_ONLY" = "1" ]; then
  say "stopping the backend container…"
  (cd "$ROOT/apps/fastapi-backend" && docker compose down 2>&1 | sed 's/^/  /')
  trap - EXIT
  ok "done. Node processes started by a previous run exit with their terminal."
  exit 0
fi

echo
echo "▸ lang-nextjs — starting everything"
echo

# ── secrets ────────────────────────────────────────────────────────────────
# Reported BY NAME. A value is never printed, and length is not printed either
# — it is a small leak and it is never the thing you needed to know.
say "secrets (from $ROOT/.env — read in place, never copied):"
KEYFOUND=0
if [ -f "$ROOT/.env" ]; then
  for k in NVIDIA_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
    if grep -qE "^${k}=.+" "$ROOT/.env" 2>/dev/null; then ok "$k is set"; KEYFOUND=1; fi
  done
  for k in LANGFUSE_PUBLIC_KEY LANGSMITH_API_KEY DJANGO_URL BLAZING_API_URL; do
    grep -qE "^${k}=.+" "$ROOT/.env" 2>/dev/null && say "  $k is set (optional)"
  done
  [ "$KEYFOUND" = "0" ] && warn "no model key found. The app will start and report 'not ready' rather than pretending."
else
  warn "no .env at the repo root. Copy .env.example and add a free key from build.nvidia.com"
fi
echo

# ── 1. backend ─────────────────────────────────────────────────────────────
if [ "$NO_BACKEND" = "1" ]; then
  say "skipping docker (--no-backend)"
elif up "http://localhost:$BACKEND_PORT/health"; then
  ok "backend already running on :$BACKEND_PORT — leaving it alone"
else
  if ! docker info >/dev/null 2>&1; then
    bad "Docker is not running, so the model backend cannot start."
    say "Start Docker Desktop, or re-run with --no-backend to use the app without a model."
    exit 1
  fi
  say "starting fastapi backend on :$BACKEND_PORT (docker)…"
  if ! (cd "$ROOT/apps/fastapi-backend" && docker compose up -d 2>&1 | sed 's/^/    /'); then
    bad "docker compose failed"; exit 1
  fi
  WE_STARTED_BACKEND=1
  wait_for "http://localhost:$BACKEND_PORT/health" 90 "backend" || {
    say "logs: (cd apps/fastapi-backend && docker compose logs --tail=40)"; exit 1; }
  ok "backend ready on :$BACKEND_PORT"
fi

# What the backend says about itself, rather than what we assume it loaded.
if up "http://localhost:$BACKEND_PORT/health"; then
  prov=$(curl -sf --max-time 3 "http://localhost:$BACKEND_PORT/health" 2>/dev/null \
    | python3 -c "import json,sys
try:
    h=json.load(sys.stdin); l=h.get('llm') or {}
    print(('configured: '+str(l.get('provider'))) if l.get('configured') else 'NO MODEL KEY VISIBLE TO THE BACKEND')
except Exception: print('unreadable /health payload')" 2>/dev/null)
  say "backend reports llm → $prov"
fi
echo

# ── 2. queue agent ─────────────────────────────────────────────────────────
# THE RUNG-4 SERVICES ONLY EXIST IN A FULL-LADDER TREE.
#
# `pnpm eject langchain` deletes apps/open-swe, and this script is shared — so
# hardcoding its paths made a retained file reference a deleted app. eject's
# guard caught it, correctly, and that is why #150 was red rather than because
# of anything about the script's behaviour.
#
# Guarded on the directory rather than on a rung name: the check is then a fact
# about the tree in front of us, not a restatement of the manifest that could
# drift from it.
HAS_OPENSWE=0
[ -d "$ROOT/apps/open-swe" ] && HAS_OPENSWE=1

if [ "$HAS_OPENSWE" = "0" ]; then
  say "no apps/open-swe in this tree — skipping the queue agent and the app."
  say "That is expected in a fork ejected below rung 4."
elif up "http://localhost:$AGENT_PORT/health"; then
  ok "queue agent already running on :$AGENT_PORT — leaving it alone"
else
  say "starting open-swe queue agent on :${AGENT_PORT}…"
  node "$ROOT/apps/open-swe/agent/server.mjs" --port "$AGENT_PORT" >"$LOGDIR/queue-agent.log" 2>&1 &
  AGENT_PID=$!
  wait_for "http://localhost:$AGENT_PORT/health" 30 "queue agent" || {
    say "Something else on :${AGENT_PORT}? Try AGENT_PORT=8010 pnpm dev"; exit 1; }
  ok "queue agent ready on :$AGENT_PORT"
fi

# These are why bare `next dev` 502s on the queue and errors on chat: the app
# reads them at request time and names the missing one rather than guessing.
export LANGGRAPH_PLATFORM_URL="${LANGGRAPH_PLATFORM_URL:-http://localhost:$AGENT_PORT}"
export FASTAPI_URL="${FASTAPI_URL:-http://localhost:$BACKEND_PORT/api/chat/stream}"
echo

# ── 3. apps ────────────────────────────────────────────────────────────────
# Same already-running rule as the backend and agent. Without this the script
# races a dev server you already had open — Next would bind a different port and
# you would end up reading a stale tab while a second copy served the real one.
if [ "$HAS_OPENSWE" = "0" ]; then
  : # nothing to start; the notice above already said so
elif up "http://localhost:$APP_PORT/"; then
  ok "open-swe already running on :$APP_PORT — leaving it alone"
  warn "it will NOT have this script's LANGGRAPH_PLATFORM_URL / FASTAPI_URL."
  warn "If the queue 502s or chat says not ready, stop that server and re-run."
else
  [ "$PORT_SOURCE" != "default" ] && warn "PORT is set in your environment — using :$APP_PORT, not the usual :3001"
  say "starting open-swe app on :${APP_PORT}…"
  (cd "$ROOT/apps/open-swe" && PORT="$APP_PORT" pnpm dev >"$LOGDIR/open-swe-app.log" 2>&1) &
  APP_PID=$!
  wait_for "http://localhost:$APP_PORT/" 300 "open-swe app" || exit 1
  ok "open-swe ready on :$APP_PORT"
fi

if [ "$WITH_EXAMPLE" = "1" ]; then
  if up "http://localhost:$EXAMPLE_PORT/"; then
    ok "example already running on :$EXAMPLE_PORT — leaving it alone"
  else
    say "starting example app on :${EXAMPLE_PORT}…"
    (cd "$ROOT/apps/example" && PORT="$EXAMPLE_PORT" pnpm dev >"$LOGDIR/example-app.log" 2>&1) &
    EXAMPLE_PID=$!
    wait_for "http://localhost:$EXAMPLE_PORT/" 300 "example app" || exit 1
    ok "example ready on :$EXAMPLE_PORT"
  fi
fi
echo

# ── readiness, probed not assumed ──────────────────────────────────────────
llm=$(curl -sf --max-time 3 "http://localhost:$APP_PORT/api/config" 2>/dev/null \
  | python3 -c "import json,sys
try:
    c=json.load(sys.stdin)
    print(f\"{c.get('activeLlm') or 'none'} (via {c.get('llmSource') or '?'})\")
except Exception: print('could not read /api/config')" 2>/dev/null)

echo "  ────────────────────────────────────────────────────────"
printf '   %-26s %s\n' "open-swe (main app)" "http://localhost:$APP_PORT"
[ "$PORT_SOURCE" != "default" ] && printf '   %-26s %s\n' "  ^ port" "$PORT_SOURCE — not the usual :3001"
[ "$WITH_EXAMPLE" = "1" ] && printf '   %-26s %s\n' "example (legacy demo)" "http://localhost:$EXAMPLE_PORT"
printf '   %-26s %s\n' "model backend" "http://localhost:$BACKEND_PORT/health"
printf '   %-26s %s\n' "queue agent" "http://localhost:$AGENT_PORT/health"
echo "  ────────────────────────────────────────────────────────"
printf '   %-26s %s\n' "active model" "$llm"
echo "  ────────────────────────────────────────────────────────"
echo
say "The queue serves a CANNED run (mode=canned) until LANGGRAPH_PLATFORM_URL"
say "points at a real LangGraph deployment. A model key does not change that."
echo

# NOTHING TO HOLD OPEN IS A DIFFERENT OUTCOME FROM EVERYTHING-STARTED, and it
# must not print the same closing line. If every service was already up, `wait`
# returns immediately and the script exits — which, under a message saying
# "Ctrl-C stops everything", reads as a crash. Say what actually happened.
if [ -z "$AGENT_PID$APP_PID$EXAMPLE_PID" ] && [ "$WE_STARTED_BACKEND" = "0" ]; then
  say "Everything was ALREADY RUNNING — this script started nothing and will now exit."
  say "Your services keep running. Use 'pnpm dev:down' to stop the backend container."
  echo
  trap - EXIT   # nothing of ours to clean up; do not print a teardown notice
  exit 0
fi

say "Ctrl-C stops everything this script started."
echo

wait
