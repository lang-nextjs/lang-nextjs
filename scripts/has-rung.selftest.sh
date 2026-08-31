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

# --- THE DOMAIN CONTRACT: exit code checked, VALUE unchecked ----------------------------------
# The caller contract above fixed callers that discarded the EXIT CODE. This is the same defect
# one step over, and it is STILL LIVE in all four call sites as of this commit: a caller that
# checks `$?` and then compares the value to "yes" collapses ANY unexpected stdout into the
# "absent" branch. has-rung's stdout domain is exactly {yes, no}; add a diagnostic line to it and
# cross-version silently stops pinning open-swe while e2e silently stops running its specs — four
# steps disabled on a green board, because "not yes" and "no" are indistinguishable to `= "yes"`.
#
# WHAT THIS FILE DOES AND DOES NOT CLAIM. These two cases are properties of two shell FORMS,
# exercised against a planted stub. They do NOT read the workflows, and nothing here asserts that
# the repo's four call sites have been hardened — they have not. Hardening them edits workflow
# files and travels with that change; this pins the shape of the fix so it cannot land as
# something weaker, and records the hazard where the next reader of has-rung.mjs will meet it.
#
# (An earlier draft labelled the second case "the deployed form". It was not, and would have
# asserted of the tree something true only on an unmerged branch — the same mistake this repo
# logged when a doc table listed a proof that was not in the tree.)
#
# PLANTED, not borrowed: a stub that exits 0 with an out-of-domain value. Borrowing would tie
# this case to a defect someone may fix, which is how an earlier REJECT case of mine broke.
STUB_DIR=$(mktemp -d); trap 'rm -rf "$STUB_DIR"' EXIT
printf '#!/bin/sh\nprintf "note: manifest reloaded\\nyes\\n"\nexit 0\n' > "$STUB_DIR/stub"
chmod +x "$STUB_DIR/stub"

# The form that ships TODAY must be shown to MISS it, or the hardening has no subject.
if __r=$("$STUB_DIR/stub") && [ "$__r" = "yes" ]; then
  bad "the exit-code-only caller form" "expected it to be fooled by out-of-domain stdout"
else
  ok "exit-code-only caller silently skips (regression pin)" "— \$? checked, value is not"
fi

# And the domain-asserting form must CATCH it. This pinned the fix's shape before it was
# deployed; the case below now holds every real call site to it.
if __r=$("$STUB_DIR/stub") && case "$__r" in yes|no) true ;; *) false ;; esac; then
  bad "the domain-asserting caller form" "accepted a value outside {yes, no}"
else
  ok "domain-asserting caller rejects out-of-domain stdout" "(the shape the fix must take)"
fi

# --- the callers, as they are actually written ----------------------------------------------
# THE CASES ABOVE PROVE A FORM. This one proves the TREE USES IT, and the two are different
# claims: the exit-code contract was documented, correct and universally ignored for as long as
# this guard existed. A proof that only ever exercises a snippet it wrote itself cannot tell the
# difference between "the callers are right" and "I never looked at them".
WF="$HERE/../.github/workflows"
sites=0; unguarded=""
if [ -d "$WF" ]; then
  while IFS=: read -r file line _; do
    sites=$((sites+1))
    # The domain assert must be the NEXT thing the caller does with the value. 12 lines is the
    # comment block plus the case; beyond that something else has already read $__rung.
    # Captured, then matched with `case`. NOT `... | grep -q`: grep -q exits on the first
    # match, tail/head take SIGPIPE, and under `set -o pipefail` the pipeline reports 141 —
    # so a site that IS guarded reads as unguarded, and only sometimes, depending on which
    # side of the pipe wins the race. This check flagged 10 of 14 correct sites that way.
    window=$(tail -n +"$line" "$file" | head -12)
    case "$window" in
      *'yes|no)'*) ;;
      *) unguarded="$unguarded $(basename "$file"):$line" ;;
    esac
  done <<EOF
$(grep -rn 'node scripts/has-rung.mjs' "$WF" 2>/dev/null || true)
EOF
fi
# Non-vacuity: a walk that finds nothing would report every call site compliant.
if [ "$sites" -lt 3 ]; then
  bad "call-site walk found $sites sites" "under the floor — the walk is broken, not the tree"
elif [ -n "$unguarded" ]; then
  bad "every call site asserts the {yes,no} domain" "unguarded:$unguarded"
else
  ok "every call site asserts the {yes,no} domain" "($sites sites, none reads a raw value)"
fi

EXPECTED=10
total=$((pass+fail))
echo
[ "$total" -eq "$EXPECTED" ] || { echo "FAIL: ran $total cases, expected $EXPECTED — harness broken." >&2; exit 1; }
[ "$fail" -eq 0 ] || { echo "FAIL: $fail/$total wrong. has-rung.mjs is NOT trustworthy." >&2; exit 1; }
echo "PASS: $pass/$total. The guard answers correctly, fails distinguishably from 'no', the"
echo "      documented caller form catches what the original one silently skipped, and every"
echo "      call site in .github/workflows asserts the domain rather than trusting the value."
