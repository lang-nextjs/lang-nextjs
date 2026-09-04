#!/usr/bin/env bash
#
# ONE COMMAND. Everything up, secrets read where they already are.
#
#   pnpm dev
#
# Starts, in dependency order, and PROBES each one before moving on:
#
#   :8001  fastapi backend (docker)   the model — reads the repo-root .env
#   :8002  django runtime (docker)    only with --with-django
#   :8003  node runtime (docker)      only with --with-node
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
#   --with-django    also start the django runtime on :8002 and offer it
#                    in the runtime selector
#   --with-node      also start the node runtime on :8003 and offer it
#                    in the runtime selector
#   --no-build       skip the workspace package build (faster; only safe
#                    when packages/*/dist is already current)
#   --down           stop everything this script starts, then exit
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

WITH_EXAMPLE=0
NO_BACKEND=0
NO_BUILD=0
WITH_DJANGO=0
WITH_NODE=0
WE_STARTED_DJANGO=0
WE_STARTED_NODE=0
DOWN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --with-example) WITH_EXAMPLE=1 ;;
    --no-backend)   NO_BACKEND=1 ;;
    --no-build)     NO_BUILD=1 ;;
    --with-django)  WITH_DJANGO=1 ;;
    --with-node)    WITH_NODE=1 ;;
    --down)         DOWN_ONLY=1 ;;
    # Derived from the header block, not a line range. The range was '2,20p',
    # which stopped one line short of --down and never showed it; adding a flag
    # silently truncated the help further. A magic number that has to be kept in
    # step with a comment block is a documentation bug waiting to be reintroduced.
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

AGENT_PORT="${AGENT_PORT:-8100}"
APP_PORT="${PORT:-3001}"
# WHERE THE APP ACTUALLY IS, as opposed to where we asked it to be. These
# diverge whenever a dev server was already up on another port, and the
# summary at the end used to print the REQUESTED one — so the run told you,
# four lines apart, that your app is on :7146 and that it is on :3001. The
# readiness probe read the requested port too, found nothing, and reported
# "could not read /api/config" about a healthy app.
APP_URL="http://localhost:${APP_PORT}"
EXAMPLE_PORT="${EXAMPLE_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8001}"
DJANGO_PORT="${DJANGO_PORT:-8002}"
NODE_PORT="${NODE_PORT:-8003}"

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
  # SAY NOTHING IF THERE IS NOTHING TO SAY.
  #
  # This used to announce "shutting down what this script started…" on every
  # exit, including exits where it had started NOTHING — a failed launch printed
  # a shutdown notice for zero processes, then "left the backend running" about a
  # backend it never touched. Two lines of ceremony after a real error, both
  # false, both standing between the reader and the message that mattered.
  local __started=""
  for pid in "$APP_PID" "$EXAMPLE_PID" "$AGENT_PID"; do
    [ -n "$pid" ] && __started="yes"
  done
  [ "$WE_STARTED_BACKEND" = "1" ] && __started="yes"
  [ -z "$__started" ] && return 0

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
  # THE OTHER TWO PLANES WERE NEVER TORN DOWN, and the header promises they are.
  #
  # `--down` says "stop everything this script starts". Until now it stopped the fastapi
  # container and nothing else, so `--with-django` left a database, a redis and an app
  # container running after the script said it had shut down — and the person reading that
  # line has no reason to go looking. Adding a third plane without fixing this would have
  # made it three.
  #
  # Only what THIS RUN started: a plane that was already up when we arrived is someone
  # else's, and stopping it is the mirror-image defect.
  if [ "$WE_STARTED_DJANGO" = "1" ]; then
    (cd "$ROOT/apps/django-backend" && docker compose down >/dev/null 2>&1)
    say "django containers stopped"
  fi
  if [ "$WE_STARTED_NODE" = "1" ]; then
    (cd "$ROOT/apps/node-backend" && docker compose down >/dev/null 2>&1)
    say "node container stopped"
  fi
}
trap cleanup EXIT INT TERM

up() { curl -sf -o /dev/null --max-time 2 "$1" 2>/dev/null; }

# Read Next's own dev-server lock: prints "<pid>\t<appUrl>", empty if unreadable.
# ONE reader with two callers — the pre-flight check and the already-running
# recovery below both need it, and a second copy is how they end up disagreeing.
read_dev_lock() { # lockfile
  [ -f "$1" ] || return 0
  node "$ROOT/scripts/read-dev-lock.cjs" "$1" 2>/dev/null || true
}

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
    # ALREADY RUNNING IS NOT A FAILURE — IT IS THE GOAL, ALREADY MET.
    #
    # This script's job is "make the dev environment be up". If Next reports a
    # dev server already running for this directory, the desired state HOLDS and
    # the only honest exit code is 0. Treating it as fatal made `pnpm dev` a
    # command you could not run twice, which is the wrong shape for a
    # start-everything script: re-running it should be the normal way to CHECK
    # that things are up, not an error.
    #
    # Returns 2 rather than 0 so the caller can distinguish "I started it" from
    # "it was already there". A distinct code beats a bare 0 for the same reason
    # `unknown` is not `ready` elsewhere in this repo.
    if [ -s "$logf" ] && grep -qE "Another .*dev server is already running" "$logf" 2>/dev/null; then
      return 2
    fi
    if [ -s "$logf" ] && grep -qE "EADDRINUSE|ELIFECYCLE|Cannot find module" "$logf" 2>/dev/null; then
      bad "$label failed to start — see below (waited only $((i / 2))s; the log already said so)"
      # Strip pnpm's own lifecycle epitaph. " ELIFECYCLE Command failed with exit
      # code 1" says only that the thing which failed failed — the line above
      # already said that WITH a diagnosis. Echoing it back puts noise between
      # the reader and the cause.
      tail -n 14 "$logf" | grep -vE "ELIFECYCLE|^[[:space:]]*$" | sed 's/^/      /'
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
    # Strip pnpm's own lifecycle epitaph. " ELIFECYCLE Command failed with exit
    # code 1" says only that the thing which failed failed — the line above
    # already said that WITH a diagnosis. Echoing it back puts noise between
    # the reader and the cause.
    tail -n 12 "$logf" | grep -vE "ELIFECYCLE|^[[:space:]]*$" | sed 's/^/      /'
  else
    say "no output was captured in ${logf} — the process may not have started at all"
  fi
  return 1
}

if [ "$DOWN_ONLY" = "1" ]; then
  # ALL THREE PLANES, because the header says "everything this script starts" and for as long
  # as this stopped only fastapi that sentence was false: `--with-django` left three containers
  # up behind a line that said it was done. `docker compose down` on a project that is not
  # running is a no-op, so naming all three costs nothing and makes the claim true.
  #
  # A separate run cannot know what an earlier one started, which is why this is unconditional
  # here and conditional in the EXIT trap above.
  for __plane in "fastapi-backend:fastapi" "django-backend:django" "node-backend:node"; do
    __dir="${__plane%%:*}"; __name="${__plane##*:}"
    [ -f "$ROOT/apps/$__dir/docker-compose.yml" ] || continue
    say "stopping the $__name container(s)…"
    (cd "$ROOT/apps/$__dir" && docker compose down 2>&1 | sed 's/^/  /')
  done
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

# ── workspace packages ─────────────────────────────────────────────────────
# THE APPS IMPORT THE PACKAGES' BUILT OUTPUT, NOT THEIR SOURCE.
#
# So a fresh clone, a pull that touches a package, or a switched branch starts
# the apps against a dist/ that does not match the src/ you were just handed.
# The failure surfaces inside the app, as a missing export, naming a file that
# is perfectly correct:
#
#   Export getBrowserOwnerKey doesn't exist in target module
#   ./apps/open-swe/app/chat/page.tsx (38:1)
#
# It names the IMPORTER, so it reads as a bug in the app — and the app is fine.
# The same cause also shows up as `Module not found: Can't resolve
# "@deepagents-nextjs/rungs"`, which reads as a missing dependency, and it is
# not that either. One cause, two error messages, neither of which mentions the
# package whose dist is stale.
#
# Building here removes the whole class rather than the two symptoms. turbo
# caches per-package on input hashes, so when nothing changed this is a cache
# lookup — measured at 90ms for 8/8 cached — not a build. That is cheap enough
# that making it conditional would cost more in surprise than it saves in time.
if [ "$NO_BUILD" = "1" ]; then
  warn "skipping the package build (--no-build). A stale packages/*/dist shows up"
  warn "as a missing export inside an app, not as a build error here."
else
  __blog="$(mktemp -t devall-build)"
  say "building workspace packages (cached — fast when nothing changed)…"
  if pnpm build --filter='./packages/*' >"$__blog" 2>&1; then
    # Report what actually happened. "cached" and "rebuilt" are different facts
    # and the difference is exactly what you want to know when an app then
    # misbehaves — a full-cache line means the dist you are about to run is the
    # one turbo already had, not one this run produced.
    __sum="$(sed 's/\x1b\[[0-9;]*m//g' "$__blog" | grep -aE '^ *Cached:' | tail -1 | sed 's/^ *//')"
    ok "packages built${__sum:+ — $__sum}"
  else
    warn "the workspace packages failed to build. The apps below import their"
    warn "built output, so they will start against whatever dist/ already exists"
    warn "— which is how a stale export becomes an error inside an app."
    echo
    sed 's/^/    /' "$__blog" | tail -25
    echo
    rm -f "$__blog"
    exit 1
  fi
  rm -f "$__blog"
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
  # IF THE LANGFUSE FIXTURE IS UP, USE IT.
  #
  # Reported as: "are we running langsmith or langfuse locally, how come I
  # don't see" — with the settings panel showing Langfuse `not configured`
  # while the fixture had been running, healthy, for thirty-three hours.
  #
  # The panel was right. This line was a bare `docker compose up -d`, which
  # never includes scripts/langfuse-local/backend-override.yml — the file that
  # injects the keys AND joins the fixture's network. So the backend had no
  # LANGFUSE_* variables at all, honestly reported `configured: false`, and the
  # fixture sat there collecting nothing.
  #
  # The override stays a separate file for the reason written in it: tracing is
  # opt-in, and a backend hard-coding a tracing host "would fail closed for
  # every forker who does not run the fixture". So this DETECTS rather than
  # assumes — if the fixture's network is absent, nothing changes.
  COMPOSE_FILES=(-f docker-compose.yml)
  # The decision lives in its own script so it can be tested against a stubbed
  # `docker` — see scripts/langfuse-wiring.selftest.sh. A branch inside a script
  # that boots real services is a branch nothing checks.
  while IFS= read -r arg; do
    [ -n "$arg" ] && COMPOSE_FILES+=("$arg")
  done < <(bash "$ROOT/scripts/langfuse-override-args.sh" "$ROOT" 2>/dev/null)

  if [ "${#COMPOSE_FILES[@]}" -gt 2 ]; then
    ok "langfuse fixture detected — the backend will trace to it"
  else
    say "no langfuse fixture running; tracing stays off. To collect traces:"
    say "  docker compose -f scripts/langfuse-local/docker-compose.yml up -d --wait"
    say "  then re-run pnpm dev — the backend is wired to it automatically."
  fi

  say "starting fastapi backend on :$BACKEND_PORT (docker)…"
  # --build, AND THE COST IS MEASURED RATHER THAN ASSUMED (#639).
  #
  # `docker compose up` runs whatever image exists. It does not notice that the source moved,
  # so `pnpm dev` can run code that is not in your tree — and the failure BLAMES THE WRONG
  # THING. A cached image predating #360 exits 1 with "Anthropic API key not found" at
  # dist/common/llm.js, while the source already catches per-backend warmup errors. Someone
  # hitting that goes looking at their environment, where nothing is wrong; #360's whole
  # property is that the plane boots WITHOUT a key.
  #
  # Measured on this repo, warm cache, load 3.8-5.6, second and third runs (the first after
  # any source change or base-image pull is not a warm run):
  #
  #     fastapi   590ms, 541ms      django   701ms, 532ms      6 cached layers each
  #     after a REAL source edit    2037ms                     the worst realistic case
  #
  # So roughly half a second added to `pnpm dev`, two seconds when you actually changed
  # something — which is the run where you WANT the rebuild. The claim "a cache-hit rebuild is
  # nearly free" holds here; it is recorded because the next person to weigh this should not
  # have to take it on trust, and because the number would change if this image grew a
  # non-cacheable layer.
  if ! (cd "$ROOT/apps/fastapi-backend" && docker compose "${COMPOSE_FILES[@]}" up -d --build 2>&1 | sed 's/^/    /'); then
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

# ── 1b. django runtime (opt-in) ────────────────────────────────────────────
# THE RUNTIME SELECTOR IS ONLY HONEST IF THE RUNTIME IS REACHABLE. `/api/config`
# reports django as available when DJANGO_URL is set, and the UI disables the
# button when it is not — which is correct, and is why the selector showed only
# fastapi: nothing had ever started django or named its URL.
#
# EXPORTED RATHER THAN WRITTEN TO .env, deliberately. The repo-root .env is the
# single source for SECRETS; DJANGO_URL is a local topology fact, and on at
# least one machine that file is root-owned and not writable by the person
# running this script. Exporting it here means `pnpm dev --with-django` is
# self-contained and leaves no edit behind to undo.
#
# OPT-IN because it is a second database, a second redis and a second app
# container. Someone working on rung 1-3 does not need any of it.
if [ "$WITH_DJANGO" = "1" ]; then
  if up "http://localhost:$DJANGO_PORT/health/"; then
    ok "django runtime already running on :$DJANGO_PORT — leaving it alone"
  elif [ "$NO_BACKEND" = "1" ]; then
    warn "--no-backend also skips django"
  else
    say "starting django runtime on :$DJANGO_PORT (docker: db + redis + backend)…"
    # --build for the same reason as the fastapi plane above, where the measurement lives.
    # db and redis are pulled images with no build: directive, so this rebuilds only `backend`.
    if ! (cd "$ROOT/apps/django-backend" && docker compose up -d --build --wait db redis backend 2>&1 | sed 's/^/    /'); then
      bad "django compose failed"; exit 1
    fi
    WE_STARTED_DJANGO=1
    wait_for "http://localhost:$DJANGO_PORT/health/" 120 "django runtime" || {
      say "logs: (cd apps/django-backend && docker compose logs --tail=40 backend)"; exit 1; }
    ok "django runtime ready on :$DJANGO_PORT"
  fi
  # The trailing slash matters: django routes are api/chat/stream/<ai_backend>/
  # and buildBackendUrl appends one segment plus a slash for this runtime.
  export DJANGO_URL="${DJANGO_URL:-http://localhost:$DJANGO_PORT/api/chat/stream/}"
  say "DJANGO_URL → $DJANGO_URL"
  echo
fi

# ── 1c. node runtime (opt-in) ──────────────────────────────────────────────
# THE THIRD PLANE EXISTED AND THIS SCRIPT COULD NOT START IT (#633).
#
# apps/node-backend has had a dev script, a compose file publishing :8003 and a
# /health endpoint; `grep -c node-backend scripts/dev-all.sh` was 0, and so was
# `grep -c 8003`. So the runtime selector could never offer node from a normal
# `pnpm dev`, and the repo's own sentence — "the same framework across THREE
# runtimes" — was one more runtime than anyone could actually bring up.
#
# WHAT MAKES THIS DANGEROUS TO ADD CARELESSLY. /api/config decides node's
# availability from `!!process.env.NODE_URL` and nothing else — it never probes
# the port. Exporting NODE_URL up front would therefore light up the selector
# for a plane that may not be listening, and the failure would land on whoever
# picked node in the UI, as a stream that never starts. So NODE_URL is exported
# only AFTER /health answers, which is the same order the django block uses.
#
# OPT-IN, matching --with-django, though the reason is weaker: node is one
# container with no database and no redis behind it, so the cost argument for
# django does not apply. It is opt-in because turning it on by default changes
# what every `pnpm dev` in the repo binds, and that is a decision to take
# deliberately rather than as a side effect of making it possible at all.
#
# NO TRAILING SLASH. Django's URLconf requires one; FastAPI and Node 404 on it
# (see apps/open-swe/app/api/chat/stream/route.ts). The route this URL is the
# prefix of is `POST /api/chat/stream` in apps/node-backend/src/server.ts.
if [ "$WITH_NODE" = "1" ]; then
  if up "http://localhost:$NODE_PORT/health"; then
    ok "node runtime already running on :$NODE_PORT — leaving it alone"
  elif [ "$NO_BACKEND" = "1" ]; then
    warn "--no-backend also skips node"
  else
    # --build, AND THAT IS NOT BELT-AND-BRACES. `docker compose up` runs whatever image
    # already exists; it does not notice that the source moved. Measured here: `up -d --wait`
    # started a cached image built before #360 and the container EXITED 1 —
    # "Anthropic API key not found", thrown at import time by a warmAll() that the current
    # source catches. Adding --build, the same command reports Healthy and /health answers with
    # llm.configured:false, which is #360's actual property: node boots without a model key.
    #
    # So without this the flag would appear to work, fail on a machine with an old image, and
    # blame a missing key that is not the problem. A dev script exists to run THE TREE IN FRONT
    # OF YOU; an image is not that tree unless it was built from it.
    #
    # NOTE FOR THE OTHER TWO PLANES: fastapi and django use `up -d` without --build and carry
    # the same latent staleness. I have not changed them — that is a timing change to the
    # default `pnpm dev` path for everyone, and it is not mine to make as a side effect of
    # adding a third runtime. Reported separately.
    say "starting node runtime on :$NODE_PORT (docker)…"
    if ! (cd "$ROOT/apps/node-backend" && docker compose up -d --build --wait 2>&1 | sed 's/^/    /'); then
      bad "node compose failed"; exit 1
    fi
    WE_STARTED_NODE=1
    wait_for "http://localhost:$NODE_PORT/health" 90 "node runtime" || {
      say "logs: (cd apps/node-backend && docker compose logs --tail=40)"; exit 1; }
    ok "node runtime ready on :$NODE_PORT"
  fi
  # Set only once the plane has answered — see the note above on /api/config.
  export NODE_URL="${NODE_URL:-http://localhost:$NODE_PORT/api/chat/stream}"
  say "NODE_URL → $NODE_URL"
  echo
fi

# ── 2. queue agent ─────────────────────────────────────────────────────────
# THE RUNG-4 SERVICES ONLY EXIST IN A FULL-LADDER TREE.
#
# `pnpm eject langchain` deletes apps/open-swe, and this script is shared — so
# hardcoding its paths made a retained file reference a deleted app. eject's
# guard caught it, correctly, and that is why #150 was red rather than because
# of anything about the script's behaviour.
#
# GUARDED VIA has-rung.mjs, NOT `[ -d ... ]`. The directory test was correct
# reasoning in a spelling eject cannot read. eject's coherence check scans each
# retained file for `apps/<deleted-app>` and exempts a reference only when a
# 25-line window above it matches `has-rung.mjs <app>` — a literal text search.
# So `[ -d "$ROOT/apps/open-swe" ]` guarded the RUNTIME correctly and still made
# eject refuse, because the checker saw an unguarded reference. That is what kept
# #150 red, and the previous comment here asserted the problem was already fixed.
#
# Asking the manifest is also the better question. A directory can survive a
# partial operation while the rung is not declared; `has-rung.mjs` answers what
# the tree CLAIMS to be, which is what decides whether these services exist.
#
# Exit code checked, not just stdout: `$( )` inside `[ ]` discards it, so an
# unreadable manifest or a typo'd rung id would silently take the "absent"
# branch and skip the services on a full-ladder tree. dev-demo.sh does the same.
# ── URLs, BEFORE anything that reads them ─────────────────────────────────
#
# These are why bare `next dev` 502s on the queue and errors on chat: the app
# reads them at request time and names the missing one rather than guessing.
#
# THE POSITION IS LOAD-BEARING, and it was wrong. These two exports lived ten
# lines BELOW the `node .../agent/server.mjs` launch, so the queue agent was
# started with no FASTAPI_URL in its environment. `MODEL_BACKEND` resolves from
# `OPENSWE_MODEL_URL ?? FASTAPI_URL ?? ""` at module load, so it was always the
# empty string and EVERY queue run was scripted — not intermittently, not
# depending on a key, always.
#
# It survived three rounds of diagnosis because nothing said so out loud: the
# banner reported the config-level guess ("a model API key is set, the model did
# not answer") while the agent had never had an address to ask. #705 made the
# agent name its own reason, which is what finally printed `no-model-backend`
# and pointed here.
#
# A child process inherits the environment as it was AT FORK. Anything started
# below this line gets these; anything above does not. That is the whole rule,
# and `assert-dev-env-order.selftest.sh` now holds it, because a comment saying
# "keep this above the agent" is exactly the kind of constraint that expires
# unnoticed the next time somebody reorders this file.
export LANGGRAPH_PLATFORM_URL="${LANGGRAPH_PLATFORM_URL:-http://localhost:$AGENT_PORT}"
export FASTAPI_URL="${FASTAPI_URL:-http://localhost:$BACKEND_PORT/api/chat/stream}"

if ! __openswe=$(node "$ROOT/scripts/has-rung.mjs" open-swe); then
  say "cannot determine whether the open-swe rung is present"; exit 1
fi
HAS_OPENSWE=0
[ "$__openswe" = "yes" ] && HAS_OPENSWE=1

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

# ── DOES THE AGENT ACTUALLY HAVE A MODEL TO CALL? ─────────────────────────
#
# Asked of the RUNNING PROCESS, not of this script's variables. The two are
# different questions and the gap between them is where the bug lived: this
# script exported FASTAPI_URL correctly and the agent had already been forked
# without it, so every check written against `$FASTAPI_URL` here would have
# said yes about a process that had nothing.
#
# It matters most in the branch ABOVE that says "already running — leaving it
# alone", which is the right default (a hand-started agent should survive
# `pnpm dev`) and also means a mis-wired agent from an earlier run cannot be
# cleared by restarting. That is what happened: three relaunches, same scripted
# runs, and the script reported success each time.
#
# THREE OUTCOMES, NOT TWO. A field that is absent is an agent older than this
# check, and reporting that as "no backend" would send someone to fix a script
# that is fine. Saying "could not ask" is the honest third answer.
if [ "$HAS_OPENSWE" = "1" ]; then
  __health="$(curl -sf --max-time 3 "http://localhost:$AGENT_PORT/health" 2>/dev/null || true)"
  if [ -z "$__health" ]; then
    warn "queue agent on :$AGENT_PORT did not answer /health — cannot tell whether it has a model backend"
  elif printf '%s' "$__health" | grep -q '"modelBackend":true'; then
    ok "queue agent has a model backend — runs will be live when the model answers"
  elif printf '%s' "$__health" | grep -q '"modelBackend"'; then
    warn "queue agent on :$AGENT_PORT has NO model backend — every run will be scripted."
    warn "  It was started without FASTAPI_URL. Stop it and re-run: kill \$(lsof -ti tcp:$AGENT_PORT) && pnpm dev"
  else
    say "queue agent predates the modelBackend health field — restart it to get this check"
  fi
fi

# WHERE A PERSON OPENS LANGFUSE, which is not where the backend sends spans.
#
# Reported as: the settings panel says "tracing — Langfuse accepted our
# credentials" and then "no host was reported, so there is no console address
# to offer". The backend traces to `http://langfuse:3000`, the in-network alias
# — correct for a sibling container, unopenable in any browser. The panel
# already declines to link an unreachable address; it had nothing else to link.
#
# Set HERE rather than in the backend-start branch above, because that branch
# is skipped when a backend is already running, and this value is the FRONTEND's
# — it is needed whether or not this script started anything.
LANGFUSE_CONSOLE="$(bash "$ROOT/scripts/langfuse-console-url.sh" 2>/dev/null || true)"
if [ -n "$LANGFUSE_CONSOLE" ]; then
  export LANGFUSE_CONSOLE_URL="$LANGFUSE_CONSOLE"
  ok "langfuse console: $LANGFUSE_CONSOLE_URL"
fi
echo

# ── 3. apps ────────────────────────────────────────────────────────────────
# Same already-running rule as the backend and agent. Without this the script
# races a dev server you already had open — Next would bind a different port and
# you would end up reading a stale tab while a second copy served the real one.
# ASKED AGAIN, deliberately. eject reads this file in 25-LINE WINDOWS, so a
# reference must be guarded near where it appears; the call above is ~35 lines
# up, which is correct at runtime and invisible to the checker. Re-asking is
# cheap, makes this block independently safe, and is what dev-demo.sh does for
# the same reason. Not a decorative line to satisfy a regex — it branches.
if ! __openswe_app=$(node "$ROOT/scripts/has-rung.mjs" open-swe); then
  say "cannot determine whether the open-swe rung is present"; exit 1
fi
# ASK NEXT'S QUESTION, NOT A PORT QUESTION.
#
# This used to be `up http://localhost:$APP_PORT/` — "is something on MY port".
# Next's own guard is DIRECTORY-scoped: it refuses a second dev server for the
# same app dir on ANY port. So when PORT differs from the running server's, the
# two disagree and each is locally right:
#
#     script: nothing on :7146, so start one
#     next  : "Another next dev server is already running"  (:3001, pid 58516)
#
# A check whose subject is not the thing that decides. Next records the answer in
# .next/dev/lock, so ask it there instead of inferring from a port.
#
# THE LOCK IS A CLAIM, NOT A FACT. A crashed server leaves one behind, and
# refusing to start over a dead lock would be a worse failure than the one being
# fixed — so the pid is checked for liveness and a stale lock is stepped over,
# out loud.
__lock="$ROOT/apps/open-swe/.next/dev/lock"
__lock_pid=""; __lock_url=""
if [ "$__openswe_app" = "yes" ] && [ -f "$__lock" ]; then
  # readFileSync + JSON.parse, NOT require(). The file is named `lock` with no
  # extension, so require() cannot resolve it and throws — and the first version
  # of this swallowed that in a bare catch{}, returning "" and reporting "no lock"
  # over a lock that was sitting right there. The error is printed on the way past
  # rather than discarded, because an empty result is exactly the signal here.
  __lock_json=$(node -e 'const fs=require("node:fs");try{const l=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(`${l.pid ?? ""}\t${l.appUrl ?? ""}`)}catch(e){process.stderr.write(`dev-all: unreadable dev lock: ${e.message}\n`)}' "$__lock" || true)
  __lock_pid=${__lock_json%%$'\t'*}
  __lock_url=${__lock_json#*$'\t'}
  [ "$__lock_url" = "$__lock_json" ] && __lock_url=""
  if [ -n "$__lock_pid" ] && ! kill -0 "$__lock_pid" 2>/dev/null; then
    say "stale dev lock (pid $__lock_pid is gone) — ignoring it and starting fresh."
    __lock_pid=""; __lock_url=""
  fi
fi

if [ "$__openswe_app" != "yes" ]; then
  : # nothing to start; the notice above already said so
elif [ -n "$__lock_pid" ]; then
  [ -n "$__lock_url" ] && APP_URL="$__lock_url"
  ok "open-swe already running at ${__lock_url:-:$APP_PORT} (pid $__lock_pid) — leaving it alone"
  if [ -n "$__lock_url" ] && [ "$__lock_url" != "http://localhost:$APP_PORT" ]; then
    warn "your PORT asked for :$APP_PORT, but Next allows ONE dev server per app"
    warn "directory and one is already up. Use $__lock_url, or: kill $__lock_pid"
  fi
  warn "it will NOT have this script's LANGGRAPH_PLATFORM_URL / FASTAPI_URL."
  warn "If the queue 502s or chat says not ready, stop that server and re-run."
elif up "http://localhost:$APP_PORT/"; then
  # No lock, but something answers — a server started outside this mechanism.
  ok "open-swe already running on :$APP_PORT — leaving it alone"
  warn "it will NOT have this script's LANGGRAPH_PLATFORM_URL / FASTAPI_URL."
  warn "If the queue 502s or chat says not ready, stop that server and re-run."
elif up "http://localhost:$APP_PORT/"; then
  ok "open-swe already running on :$APP_PORT — leaving it alone"
  warn "it will NOT have this script's LANGGRAPH_PLATFORM_URL / FASTAPI_URL."
  warn "If the queue 502s or chat says not ready, stop that server and re-run."
else
  # ASKED A THIRD TIME, and the reason is mechanical rather than stylistic.
  # eject reads this file in 25-LINE WINDOWS, and the comment block above pushed
  # the `cd apps/open-swe` below out of range of the guard at the top of this
  # section — 60 lines, not 25. eject refused, correctly, on a PR that only
  # changed a liveness check. Writing more explanation moved a reference out of
  # its guard's reach, which is a failure mode worth knowing about: the window is
  # measured in LINES, so prose costs distance.
  if ! __openswe_start=$(node "$ROOT/scripts/has-rung.mjs" open-swe); then
    warn "cannot determine whether the open-swe rung is present"; exit 1
  fi
  if [ "$__openswe_start" != "yes" ]; then
    warn "the open-swe rung vanished between the check above and this one"; exit 1
  fi
  [ "$PORT_SOURCE" != "default" ] && warn "PORT is set in your environment — using :$APP_PORT, not the usual :3001"
  say "starting open-swe app on :${APP_PORT}…"
  (cd "$ROOT/apps/open-swe" && PORT="$APP_PORT" pnpm dev >"$LOGDIR/open-swe-app.log" 2>&1) &
  APP_PID=$!
  wait_for "http://localhost:$APP_PORT/" 300 "open-swe app"; __rc=$?
  if [ "$__rc" = "2" ]; then
    __now=$(read_dev_lock "$ROOT/apps/open-swe/.next/dev/lock")
    __now_url=${__now#*$'\t'}
    [ "$__now_url" = "$__now" ] && __now_url=""
    [ -n "$__now_url" ] && APP_URL="$__now_url"
    ok "open-swe was already running${__now_url:+ at $__now_url} — nothing to do"
    if [ -n "$__now_url" ] && [ "$__now_url" != "http://localhost:$APP_PORT" ]; then
      warn "your PORT asked for :$APP_PORT; Next allows one dev server per app directory"
    fi
  elif [ "$__rc" != "0" ]; then
    exit 1
  else
    ok "open-swe ready on :$APP_PORT"
  fi
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
llm=$(curl -sf --max-time 3 "$APP_URL/api/config" 2>/dev/null \
  | python3 -c "import json,sys
try:
    c=json.load(sys.stdin)
    print(f\"{c.get('activeLlm') or 'none'} (via {c.get('llmSource') or '?'})\")
except Exception: print('could not read /api/config')" 2>/dev/null)

echo "  ────────────────────────────────────────────────────────"
printf '   %-26s %s\n' "open-swe (main app)" "$APP_URL"
[ "$PORT_SOURCE" != "default" ] && printf '   %-26s %s\n' "  ^ port" "$PORT_SOURCE — not the usual :3001"
[ "$WITH_EXAMPLE" = "1" ] && printf '   %-26s %s\n' "example (legacy demo)" "http://localhost:$EXAMPLE_PORT"
printf '   %-26s %s\n' "model backend" "http://localhost:$BACKEND_PORT/health"
printf '   %-26s %s\n' "queue agent" "http://localhost:$AGENT_PORT/health"
echo "  ────────────────────────────────────────────────────────"
printf '   %-26s %s\n' "active model" "$llm"
echo "  ────────────────────────────────────────────────────────"
echo
# WHICH PATH, because this said the wrong one and cost a user an evening (#700).
#
# It read: "the queue serves a CANNED run until LANGGRAPH_PLATFORM_URL points at
# a real LangGraph deployment. A model key does not change that." True of the
# LangGraph PLATFORM path and false of the one the queue actually uses, which
# talks to the model backend above and needs no platform URL at all.
#
# It was false for a second reason until #701: the queue's request omitted
# `approvalPolicy` and `sessionId`, so the backend 400'd every attempt and NO
# configuration could have produced a live run. The sentence described a
# permanent state as if it were a setting.
if [ -n "${LANGGRAPH_PLATFORM_URL:-}" ]; then
  say "LANGGRAPH_PLATFORM_URL is set — the Platform path is available too."
else
  say "Runs go to the model backend above. LANGGRAPH_PLATFORM_URL is unset, so the"
  say "separate LangGraph Platform path is not available — that is a different"
  say "surface, and it does not stop a run here from reaching the model."
fi
echo

# NOTHING TO HOLD OPEN IS A DIFFERENT OUTCOME FROM EVERYTHING-STARTED, and it
# must not print the same closing line. If every service was already up, `wait`
# returns immediately and the script exits — which, under a message saying
# "Ctrl-C stops everything", reads as a crash. Say what actually happened.
#
# THE CONDITION USED TO INCLUDE `WE_STARTED_BACKEND = 0`, and that was the bug.
# Starting only the docker backend — which happens whenever the app and agent
# are already up — fell through to `wait`. `wait` with no background jobs
# RETURNS IMMEDIATELY, the script exited, and the EXIT trap tore the container
# straight back down, one line after promising "Ctrl-C stops everything".
#
# A docker container is not a shell job. It is a detached daemon that outlives
# this process and `wait` cannot hold it, so the decision is about background
# PIDs alone; the backend only changes what we say on the way out. The decision
# lives in its own script so it can be tested — see dev-hold.selftest.sh.
HOLD="$(bash "$ROOT/scripts/dev-hold-decision.sh" \
  "$AGENT_PID$APP_PID$EXAMPLE_PID" "$WE_STARTED_BACKEND")"

if [ "$HOLD" = "exit-backend-running" ]; then
  ok "backend container is running, and will KEEP running."
  say "This script has nothing to hold open — the app and queue agent were"
  say "already up, and a container does not need this terminal."
  say "Use 'pnpm dev:down' to stop it."
  echo
  trap - EXIT   # the container is meant to survive; do not tear it down
  exit 0
fi

if [ "$HOLD" = "exit-nothing-started" ]; then
  say "Everything was ALREADY RUNNING — this script started nothing and will now exit."
  say "Your services keep running. Use 'pnpm dev:down' to stop the backend container."
  echo
  trap - EXIT   # nothing of ours to clean up; do not print a teardown notice
  exit 0
fi

say "Ctrl-C stops everything this script started."
echo

wait
