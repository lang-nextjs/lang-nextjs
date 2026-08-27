#!/usr/bin/env bash
# Proves dev-all.sh does not destroy the backend it just started.
#
# THE BUG THIS EXISTS TO KILL. `pnpm dev` with the app and queue agent already
# running would start the fastapi container, print "Ctrl-C stops everything
# this script started", and then immediately print "backend container stopped"
# — without anyone pressing anything.
#
#   the guard      exit early only if NOTHING was started
#   the reality    only the container was started, so it fell through
#   `wait`         no background jobs -> returns instantly
#   the EXIT trap  docker compose down
#
# Every case below is a PAIR, because the failure is asymmetric: holding when
# there is nothing to hold wastes a terminal, while exiting when there ARE
# background jobs kills the app and the agent. Only one of those is recoverable
# by pressing up-arrow.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok()  { printf '  ok   %-54s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  FAIL %-54s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
decide() { bash "$ROOT/scripts/dev-hold-decision.sh" "$1" "$2" 2>/dev/null; }

check() { # name  pids  started_backend  expected
  local got; got="$(decide "$2" "$3")"
  [ "$got" = "$4" ] && ok "$1" "($got)" || bad "$1" "expected '$4', got '$got'"
}

# ── the reported case ──────────────────────────────────────────────────────
check "ONLY the backend started -> exit, leave it running" "" 1 "exit-backend-running"

# ── the pair: background jobs must still hold the terminal ─────────────────
check "an app was started -> hold, so Ctrl-C can stop it"  "9001" 1 "hold"
check "an agent was started, no backend -> hold"           "9002" 0 "hold"

# ── the pre-existing case, unchanged ──────────────────────────────────────
check "nothing at all started -> exit, say so"             "" 0 "exit-nothing-started"

# ── whitespace is not a PID ───────────────────────────────────────────────
# `AGENT_PID$APP_PID$EXAMPLE_PID` is a concatenation, and an unset PID can
# leave whitespace behind. Treating that as "something is running" would hold
# a terminal forever on a script that started nothing.
check "whitespace-only PIDs are treated as none"           "   " 1 "exit-backend-running"

# ── and the wiring is reachable ───────────────────────────────────────────
if grep -q 'dev-hold-decision.sh' "$ROOT/scripts/dev-all.sh"; then
  ok "dev-all.sh calls the decision" "(not dead code)"
else
  bad "dev-all.sh calls the decision" "helper is unused"
fi

# ── the exit paths must clear the trap, or the fix is undone ──────────────
# Exiting without `trap - EXIT` runs cleanup(), which is exactly the teardown
# this fix exists to avoid. Asserted structurally because the alternative is
# booting docker inside a unit test.
after="$(sed -n '/exit-backend-running/,/^fi/p' "$ROOT/scripts/dev-all.sh")"
if printf '%s' "$after" | grep -q 'trap - EXIT'; then
  ok "the backend-running exit clears the EXIT trap" "(no teardown)"
else
  bad "the backend-running exit clears the EXIT trap" "cleanup would still run"
fi

# ── the promise must only be made when it is true ────────────────────────
# THE CONTRADICTION THE REPORT SHOWED, in four lines:
#
#   Ctrl-C stops everything this script started.
#
#     shutting down what this script started…
#     backend container stopped
#
# The line is a promise about a keypress, and it was printed immediately before
# an exit nobody asked for. It must therefore be unreachable unless `wait` has
# something to block on — otherwise the script promises an interaction it will
# never be present for.
#
# Asserted by position: every exit path must appear BEFORE the promise, so the
# only way to reach it is to have fallen past all of them.
#
# MATCHED ON THE STATEMENT, NOT THE PHRASE. The first version grepped for the
# words and found them in the COMMENTS above — which quote the promise while
# explaining the bug — so it reported an exit "after" a promise that was really
# a paragraph about the promise. Third time in this repo a checker has matched
# its own documentation: a JSDoc block closed early on `*/` inside a glob, and
# a comment naming @ts-expect-error was read as one.
promise_line="$(grep -n 'say "Ctrl-C stops everything' "$ROOT/scripts/dev-all.sh" | head -1 | cut -d: -f1)"
wait_line="$(grep -n '^wait$' "$ROOT/scripts/dev-all.sh" | tail -1 | cut -d: -f1)"
last_exit="$(grep -n '^  exit 0$' "$ROOT/scripts/dev-all.sh" | tail -1 | cut -d: -f1)"

if [ -n "$promise_line" ] && [ -n "$wait_line" ] && [ "$promise_line" -lt "$wait_line" ]; then
  ok "the Ctrl-C promise is immediately followed by wait" "(lines $promise_line -> $wait_line)"
else
  bad "the Ctrl-C promise is immediately followed by wait" "promise=$promise_line wait=$wait_line"
fi

if [ -n "$last_exit" ] && [ -n "$promise_line" ] && [ "$last_exit" -lt "$promise_line" ]; then
  ok "every early exit precedes the promise" "(no exit can follow it)"
else
  bad "every early exit precedes the promise" "an exit at $last_exit follows the promise at $promise_line"
fi

if bash -n "$ROOT/scripts/dev-all.sh" 2>/dev/null; then
  ok "dev-all.sh still parses" "(bash -n)"
else
  bad "dev-all.sh still parses" "syntax error"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "PASS: $PASS/$PASS. Hold and exit were both watched, so neither is vacuous."
  exit 0
fi
echo "FAIL: $FAIL failed, $PASS passed."
exit 1
