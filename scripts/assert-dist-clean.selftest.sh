#!/usr/bin/env bash
#
# assert-dist-clean.selftest.sh — prove that assert-dist-clean.sh CAN FAIL.
#
# WHY THIS EXISTS.
# A checker that has never been observed to fail is indistinguishable from one that cannot.
# The four checks this replaced were green for their whole life and none of them was ever
# able to detect a violation. Replacing them with a new checker that is merely *believed*
# correct would add a fifth member to that family, not remove one.
#
# So: every negative case below asserts a NON-ZERO exit, and every positive case asserts
# zero. CI runs this in the same job immediately before the real checks, so any run that
# reports the dist checks passing has, in that same run, watched them fail on poisoned and
# on absent input.
#
# The "NONEXISTENT subject" case in Group D is the direct regression test for the defect this
# replaced: `grep` exits 2 on a missing file, and the old `&& ... || echo Clean` form routed
# that straight into its success path. Reintroduce that shape and Group D goes red.
#
# Usage: scripts/assert-dist-clean.selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/assert-dist-clean.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

# expect_fail NAME -- ARGS...  : the checker must exit non-zero
expect_fail() {
  local name="$1"; shift; [[ "$1" == "--" ]] && shift
  local out rc
  out="$("$SUT" "$@" 2>&1)"; rc=$?
  if [[ $rc -ne 0 ]]; then
    printf '  ok   %-52s (exit %d, correctly rejected)\n' "$name" "$rc"; pass=$((pass + 1))
  else
    printf '  FAIL %-52s expected non-zero, got 0\n' "$name" >&2
    printf '       checker output: %s\n' "$out" >&2; fail=$((fail + 1))
  fi
}

# expect_pass NAME -- ARGS...  : the checker must exit zero
expect_pass() {
  local name="$1"; shift; [[ "$1" == "--" ]] && shift
  local out rc
  out="$("$SUT" "$@" 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    printf '  ok   %-52s (exit 0, correctly accepted)\n' "$name"; pass=$((pass + 1))
  else
    printf '  FAIL %-52s expected 0, got %d\n' "$name" "$rc" >&2
    printf '       checker output: %s\n' "$out" >&2; fail=$((fail + 1))
  fi
}

echo "assert-dist-clean.sh self-test — proving the checker can fail"
echo

# --- Group A: violations the OLD check could detect (double-quoted CJS only) ---------------
printf 'var r = require("react");\n'                    > "$TMP/cjs-dq.js"
expect_fail "CJS require, double quote"        -- --label t --forbid-module 'react|next' -- "$TMP/cjs-dq.js"

# --- Group B: violations the OLD check MISSED. Each of these shipped undetectable. ----------
# tsup preserves source quote style; every specifier this repo emits is single-quoted.
printf "var r = require('react');\n"                    > "$TMP/cjs-sq.js"
expect_fail "CJS require, SINGLE quote (old: missed)" -- --label t --forbid-module 'react|next' -- "$TMP/cjs-sq.js"

printf "import { x } from 'react';\n"                   > "$TMP/esm-sq.mjs"
expect_fail "ESM import, SINGLE quote (old: missed)" -- --label t --forbid-module 'react|next' -- "$TMP/esm-sq.mjs"

printf 'import { x } from "react";\n'                   > "$TMP/esm-dq.mjs"
expect_fail "ESM import, double quote (old: missed)" -- --label t --forbid-module 'react|next' -- "$TMP/esm-dq.mjs"

printf 'import{a,b}from"react";\n'                      > "$TMP/esm-min.mjs"
expect_fail "ESM minified, no space (old: missed)"  -- --label t --forbid-module 'react|next' -- "$TMP/esm-min.mjs"

printf 'const m = await import("react");\n'             > "$TMP/dyn.mjs"
expect_fail "dynamic import() (old: missed)"        -- --label t --forbid-module 'react|next' -- "$TMP/dyn.mjs"

printf "import 'react';\n"                              > "$TMP/side.mjs"
expect_fail "side-effect import (old: missed)"      -- --label t --forbid-module 'react|next' -- "$TMP/side.mjs"

printf 'from "react";\n'                                > "$TMP/bol.mjs"
expect_fail "specifier at start of line (^ branch)" -- --label t --forbid-module 'react|next' -- "$TMP/bol.mjs"

printf 'export { x } from "react";\n'                   > "$TMP/reexport.mjs"
expect_fail "export-from re-export (old: missed)"   -- --label t --forbid-module 'react|next' -- "$TMP/reexport.mjs"

printf 'import x from "react/jsx-runtime";\n'           > "$TMP/subpath.mjs"
expect_fail "subpath import (old: missed)"          -- --label t --forbid-module 'react|next' -- "$TMP/subpath.mjs"

printf 'import { readFile } from "node:fs";\n'          > "$TMP/nodeprefix.mjs"
expect_fail "node: prefixed builtin (old: missed)"  -- --label t --forbid-module 'fs|path' -- "$TMP/nodeprefix.mjs"

# --- Group C: a violation in ANY subject fails, even if earlier subjects are clean ----------
printf "export const ok = 1;\n"                         > "$TMP/clean-a.mjs"
expect_fail "violation in 2nd of 2 subjects"        -- --label t --forbid-module 'react|next' -- "$TMP/clean-a.mjs" "$TMP/esm-sq.mjs"

# --- Group D: THE DEFECT THIS REPLACED. Absent/empty/no subject must be HARD failures. ------
#
# grep exits 2 on a missing file, and the old `&& ... || echo Clean` form reported "Clean",
# exit 0, while printing grep's own "No such file or directory" to stderr.
expect_fail "NONEXISTENT subject (the defect)"      -- --label t --forbid-module 'react|next' -- "$TMP/does-not-exist.js"
expect_fail "one present + one nonexistent subject" -- --label t --forbid-module 'react|next' -- "$TMP/clean-a.mjs" "$TMP/nope.mjs"

: > "$TMP/empty.js"
expect_fail "EMPTY subject (soft build failure)"    -- --label t --forbid-module 'react|next' -- "$TMP/empty.js"

expect_fail "ZERO subjects (vacuous check)"         -- --label t --forbid-module 'react|next' --

mkdir -p "$TMP/adir"
expect_fail "subject is a directory, not a file"    -- --label t --forbid-module 'react|next' -- "$TMP/adir"

# --- Group E: usage errors must fail closed, never pass ------------------------------------
expect_fail "missing --forbid-module"               -- --label t -- "$TMP/clean-a.mjs"
expect_fail "missing --label"                       -- --forbid-module 'react' -- "$TMP/clean-a.mjs"

# --- Group F: positives. A correct checker must also ACCEPT clean input, or it is just
#              `exit 1` wearing a costume and would fail the whole build forever. -----------
expect_pass "clean ESM file"                        -- --label t --forbid-module 'react|next' -- "$TMP/clean-a.mjs"

printf "import { writable } from 'svelte/store';\n"     > "$TMP/svelte.mjs"
expect_pass "real sveltekit-shaped import is clean"  -- --label t --forbid-module 'react|next' -- "$TMP/svelte.mjs"

printf 'const msg = "react is not imported here";\n'    > "$TMP/bare-string.mjs"
expect_pass "bare string mentioning react (no FP)"   -- --label t --forbid-module 'react|next' -- "$TMP/bare-string.mjs"

printf "import x from 'preact';\n"                      > "$TMP/preact.mjs"
expect_pass "'preact' does not match 'react'"        -- --label t --forbid-module 'react|next' -- "$TMP/preact.mjs"

printf "import x from 'nextish-thing';\n"               > "$TMP/nextish.mjs"
expect_pass "'nextish-thing' does not match 'next'"  -- --label t --forbid-module 'react|next' -- "$TMP/nextish.mjs"

expect_pass "multiple clean subjects"                -- --label t --forbid-module 'react|next' -- "$TMP/clean-a.mjs" "$TMP/svelte.mjs"

# --- Non-vacuity of the SELF-TEST itself ---------------------------------------------------
# Same device as packages/server/src/severability.test.ts's "guards against the walk silently
# matching nothing": if a refactor breaks the harness so no case runs, the counts catch it
# instead of the suite reporting a serene green over zero assertions.
EXPECTED_CASES=25
total=$((pass + fail))
echo
if [[ $total -ne $EXPECTED_CASES ]]; then
  printf 'FAIL: self-test ran %d cases, expected %d — the harness itself is broken.\n' \
    "$total" "$EXPECTED_CASES" >&2
  printf '      (If you added or removed a case on purpose, update EXPECTED_CASES.)\n' >&2
  exit 1
fi

if [[ $fail -ne 0 ]]; then
  printf 'FAIL: %d/%d self-test cases failed — assert-dist-clean.sh is NOT trustworthy.\n' \
    "$fail" "$total" >&2
  exit 1
fi

printf 'PASS: %d/%d cases. assert-dist-clean.sh has been observed to fail on poisoned and\n' \
  "$pass" "$total"
printf '      on absent input, and to accept clean input. The dist checks below mean something.\n'
