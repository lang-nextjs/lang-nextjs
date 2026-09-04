#!/usr/bin/env bash
# A CHILD INHERITS THE ENVIRONMENT AS IT WAS AT FORK.
#
# dev-all.sh started the open-swe queue agent on one line and exported
# FASTAPI_URL ten lines later. The agent resolves
#
#   MODEL_BACKEND = OPENSWE_MODEL_URL ?? FASTAPI_URL ?? ""
#
# at module load, so it was always the empty string and EVERY queue run was
# scripted — always, regardless of key, model or backend. Three rounds of
# diagnosis went past it, and `pnpm dev` reported success each time.
#
# WHY THIS IS A TEST AND NOT A COMMENT. The fix is one line in one place, and
# the constraint that keeps it fixed ("these exports stay above the launch") is
# exactly the shape that expires unnoticed the next time somebody reorders this
# file: nothing breaks visibly, the script still starts everything, and the only
# symptom is a queue that quietly never calls a model.
#
# EXIT CODES follow the repo convention:
#   0  the property holds
#   1  the property is violated
#   2  the question could not be asked (an anchor is gone — this check has lost
#      its subject and must be repaired rather than believed)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/scripts/dev-all.sh"
PASS=0; FAIL=0
ok()  { printf '  ok   %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL+1)); }

# Real command lines only. A `#` line mentioning `agent/server.mjs` is prose —
# and this check was written after a grep for it matched the very comment
# explaining the bug, which read as the launch being in the right place.
line_of() { # file, extended-regex
  grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}

# `VAR=x cmd` on the launch line itself would also be correct, and would make
# the ordering question moot. Checked so a future fix of that shape is not
# reported as a violation.
launch_carries_env() { # file
  grep -nE 'agent/server\.mjs' "$1" | grep -vE '^[0-9]+:[[:space:]]*#' \
    | grep -qE '(FASTAPI_URL|OPENSWE_MODEL_URL)='
}

# The property, asked of any candidate file, so the control arm below can ask it
# of a deliberately-broken copy.
check_file() { # file -> 0 holds / 1 violated / 2 unaskable
  local f="$1" launch export_fastapi export_lg
  launch="$(line_of "$f" 'agent/server\.mjs')"
  export_fastapi="$(line_of "$f" 'export FASTAPI_URL=')"
  export_lg="$(line_of "$f" 'export LANGGRAPH_PLATFORM_URL=')"
  [ -n "$launch" ] && [ -n "$export_fastapi" ] && [ -n "$export_lg" ] || return 2
  launch_carries_env "$f" && return 0
  [ "$export_fastapi" -lt "$launch" ] && [ "$export_lg" -lt "$launch" ] && return 0
  return 1
}

printf '\n  dev-all.sh exports the agent'"'"'s URLs before forking the agent\n\n'

# ── the property, on the real script ──────────────────────────────────────
check_file "$TARGET"; rc=$?
case "$rc" in
  0) ok "FASTAPI_URL and LANGGRAPH_PLATFORM_URL are exported above the launch" ;;
  1) bad "the agent is forked before its URLs are exported — every queue run will be scripted" ;;
  2) printf '  \033[33mCANNOT ASK\033[0m: an anchor is missing from dev-all.sh.\n'
     printf '  This check has lost its subject. Repair the pattern; do not delete the check.\n\n'
     exit 2 ;;
esac

# ── THE POSITIVE CONTROL ──────────────────────────────────────────────────
#
# Without this the whole file is a check that names a property and cannot fail:
# rename the launch line and `check_file` returns 2, or loosen a pattern and it
# returns 0 for anything. So the same function is run against a copy with the
# exports deliberately moved BELOW the launch — the exact pre-fix arrangement —
# and it must come back violated.
# Only meaningful against a file that HOLDS the property: the mutation below
# assumes there is a correct arrangement to break. Running it on an already-
# broken script produces a third arrangement and a verdict about nothing.
if [ "$rc" != "0" ]; then
  printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
  exit 1
fi

BROKEN="$(mktemp)"; trap 'rm -f "$BROKEN"' EXIT
awk '
  /^export (FASTAPI_URL|LANGGRAPH_PLATFORM_URL)=/ { held = held $0 "\n"; next }
  { print }
  /agent\/server\.mjs/ && !/^[[:space:]]*#/ && held { printf "%s", held; held = "" }
' "$TARGET" > "$BROKEN"

# The mutation has to have actually happened. An awk that matched nothing would
# leave a byte-identical copy, the control would pass for the wrong reason, and
# "the check can fail" would be asserted by a file that was never broken.
if cmp -s "$TARGET" "$BROKEN"; then
  bad "control arm did not mutate anything — it proves nothing about this check"
else
  check_file "$BROKEN"; brc=$?
  [ "$brc" = "1" ] \
    && ok "and it detects the pre-fix arrangement (control: exports moved below the launch)" \
    || bad "control: the pre-fix arrangement returned $brc, expected 1 — this check cannot fail"
fi

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
