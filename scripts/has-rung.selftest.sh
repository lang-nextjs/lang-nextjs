#!/usr/bin/env bash
#
# has-rung.selftest.sh — prove the guard answers correctly AND fails loudly.
#
# This file exists because the guard shipped without one and was the exact defect it was written
# to prevent. The script's exit codes were right; every CALLER discarded them:
#
#     if [ "$(node scripts/has-rung.mjs open-swe)" != "yes" ]; then skip; fi
#
# `$( )` in a `[ ]` comparison yields stdout; the `if` takes its status from `[`, never from the
# substitution. So a missing argument or an unreadable manifest produced empty stdout, took the
# "absent" branch, SKIPPED the guarded step, and left the job green. The step it guards starts the
# open-swe dev server — a silent skip runs the open-swe E2E specs against nothing.
#
# So this asserts BOTH halves, and the caller contract is a case in its own right: a checker that
# is correct in isolation and misused everywhere is not a working check.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/has-rung.mjs"
pass=0; fail=0

ok()   { printf '  ok   %-54s %s\n' "$1" "$2"; pass=$((pass+1)); }
bad()  { printf '  FAIL %-54s %s\n' "$1" "$2" >&2; fail=$((fail+1)); }

# --- answers ---------------------------------------------------------------------------------
out=$(node "$SUT" langchain 2>/dev/null); rc=$?
[ "$out" = "yes" ] && [ $rc -eq 0 ] && ok "a declared rung answers yes" "(exit 0)" \
  || bad "a declared rung answers yes" "got '$out' exit=$rc"

out=$(node "$SUT" not-a-real-rung 2>/dev/null); rc=$?
[ "$out" = "no" ] && [ $rc -eq 0 ] && ok "an undeclared rung answers no" "(exit 0)" \
  || bad "an undeclared rung answers no" "got '$out' exit=$rc"

# --- failures must be DISTINGUISHABLE from "no" ----------------------------------------------
# The whole hazard: if an error is reported the same way as absence, a broken guard is a silent
# skip. Both must exit non-zero AND print nothing on stdout.
out=$(node "$SUT" 2>/dev/null); rc=$?
[ $rc -ne 0 ] && [ -z "$out" ] && ok "no argument exits non-zero, stdout empty" "(exit $rc)" \
  || bad "no argument" "got '$out' exit=$rc"

out=$(RUNGS_MANIFEST=/nonexistent-manifest node "$SUT" langchain 2>/dev/null); rc=$?
[ $rc -ne 0 ] && [ -z "$out" ] && ok "unreadable manifest exits non-zero" "(exit $rc)" \
  || bad "unreadable manifest" "got '$out' exit=$rc"

# --- THE CALLER CONTRACT, which is where this actually broke ----------------------------------
# A checker correct in isolation and misused at every call site is not a working check.
if ! __r=$(node "$SUT" 2>/dev/null); then
  ok "the documented caller form catches a failure" "(if ! var=\$(...))"
else
  bad "the documented caller form catches a failure" "it did not"
fi

# And the form that shipped must be shown to MISS it, or the fix has no subject.
if [ "$(node "$SUT" 2>/dev/null)" != "yes" ]; then
  ok "the ORIGINAL caller form silently skips (regression pin)" "— why callers check \$?"
else
  bad "the original caller form" "expected it to take the skip branch"
fi

# --- positive: a correct caller still runs the step -------------------------------------------
if __r=$(node "$SUT" langchain 2>/dev/null) && [ "$__r" = "yes" ]; then
  ok "a correct caller proceeds on a present rung" "(not merely 'exit 1' in a costume)"
else
  bad "a correct caller proceeds" "did not"
fi

EXPECTED=7
total=$((pass+fail))
echo
[ "$total" -eq "$EXPECTED" ] || { echo "FAIL: ran $total cases, expected $EXPECTED — harness broken." >&2; exit 1; }
[ "$fail" -eq 0 ] || { echo "FAIL: $fail/$total wrong. has-rung.mjs is NOT trustworthy." >&2; exit 1; }
echo "PASS: $pass/$total. The guard answers correctly, fails distinguishably from 'no', and the"
echo "      documented caller form catches what the original one silently skipped."
