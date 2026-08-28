#!/usr/bin/env bash
#
# Compile a dev server's routes BEFORE any timed assertion depends on them.
#
# THE DEFECT THIS REMOVES (#114). `E2E — Mocked` failed ~15% of completed runs,
# on main as well as PRs. The workflow starts each Next dev server and then
# waits for `/` only — but Turbopack compiles routes ON DEMAND, so the first
# test to touch any OTHER route pays that route's compile cost inside its own
# assertion budget.
#
# Measured from the CI artifact of a failing run (33122518899), the trace for
# `cross-tab isolation`:
#
#   200 /hitl-demo       wait=124ms  receive=54ms      <- page fine
#   200 /api/hitl-demo   wait=35ms   receive=-1        <- headers in 35ms, then nothing
#
# and the page at failure read:
#
#   Status: streaming
#   Conversation: "You: List the files in /tmp   Agent:"     <- ZERO frames arrived
#
# So the proxy answered immediately and then produced nothing for 15s. It could
# not: `/api/hitl-demo` fetches `/api/hitl-demo/backend` — ITSELF, on the same
# dev server — and that route had never been compiled. The self-fetch is
# server-to-server, so it never appears in the browser's network log, which is
# why the symptom looked like a hung stream rather than a cold route.
#
# The cross-tab tests lose this race most often because they open two fresh
# contexts and click both at once, doubling the demand at the exact moment of
# first compile, on a 2-core runner already building four other dev servers.
#
# WHY WARMING AND NOT A BIGGER TIMEOUT. Raising the timeout would hide the next
# genuine regression behind the same number. Warming removes the variable: after
# this script, every route a timed assertion depends on is already compiled, so
# the assertion measures the application and nothing else.
#
# Failures here are NOT fatal, deliberately. This is a latency-shaping step, not
# a gate — a route that 500s under warmup will still fail its own test, loudly
# and in the right place. A warm step that can fail the build would convert a
# test signal into an infrastructure one.

set -uo pipefail

BASE="${1:?usage: warm-routes.sh BASE_URL [--with-hitl]}"
WITH_HITL="${2:-}"

warm_get() {
  local path="$1"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "${BASE}${path}" || echo "---")"
  echo "  GET  ${path} -> ${code}"
}

warm_stream() {
  # A streaming route is held open by design (the HITL proxy waits up to 60s for
  # a human), so this deliberately ABORTS after a few seconds. Compilation is
  # triggered by the request arriving, not by reading the body to completion —
  # and the server log confirms the self-fetched backend route compiles too.
  local path="$1"
  curl -s -o /dev/null --max-time 8 -X POST "${BASE}${path}" \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"warm"}]}]}' \
    >/dev/null 2>&1
  echo "  POST ${path} -> warmed (aborted; the route is held open by design)"
}

echo "Warming routes on ${BASE}"
warm_get "/"

if [ "${WITH_HITL}" = "--with-hitl" ]; then
  warm_get "/hitl-demo"
  warm_get "/concurrent-test"
  warm_get "/reconnect-test"
  warm_get "/dashboard"
  # Each of these proxies to a sibling backend route on this same server; the
  # POST compiles both halves of the pair.
  #
  # CONCURRENTLY, because each one is an abort-after-timeout and running them in
  # sequence spent the whole budget waiting: 25s measured, against 8s here. It
  # also exercises the concurrent shape the failing tests actually use.
  for path in /api/hitl-demo /api/hitl-demo-multi /api/hitl-demo-timeout; do
    warm_stream "${path}" &
  done
  wait
fi

echo "Warm-up complete."
