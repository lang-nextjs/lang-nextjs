#!/usr/bin/env bash
#
# assert-dist-clean.sh — assert that a built artifact does NOT import a forbidden module.
#
# This replaces four hand-rolled `grep ... && exit 1 || echo Clean` checks in ci.yml, each of
# which was incapable of failing. The rule this script exists to enforce:
#
#     No check may assert a property of a build output without first asserting
#     that the build output exists.
#
# THE FOUR WAYS THE OLD CHECKS COULD NOT FAIL, and where each is closed:
#
#   1. ABSENT SUBJECT. `grep` exits 2 (not 1) when a file is missing. Both old forms treated
#      any non-zero exit as "no match":
#          grep -rE '<pat>' <missing> && echo FAIL && exit 1 || echo Clean   # -> "Clean", exit 0
#          if grep -rE '<pat>' <missing> 2>/dev/null; then ...; else echo Clean; fi  # -> same
#      The first form even prints grep's own "No such file or directory" to stderr and reports
#      Clean anyway. "I could not look" and "I looked and it was clean" were the same answer.
#      >>> CLOSED by require_subjects() below: a missing or empty subject is a HARD FAILURE.
#
#      NOTE: `set -euo pipefail` does NOT fix this. POSIX exempts commands on the left of
#      `&&`/`||` and the condition of an `if` from `-e` — which is precisely both old forms.
#      The fix is to read $? and branch on three outcomes; `set -e` is hygiene around it.
#      >>> CLOSED by the three-way `case` below, which is independent of the existence gate,
#          so the hole stays shut even if a subject slips through.
#
#   2. WRONG QUOTE STYLE. The old patterns hardcoded `require\("` — double quotes only. tsup
#      preserves the source's quote style, and every specifier this repo actually emits is
#      SINGLE-quoted (`require('svelte/store')`, `from 'react'`). The checks could not match
#      their own build output.
#      >>> CLOSED by build_module_regex(), which accepts both quote styles.
#
#   3. CJS-ONLY PATTERN ON AN ESM FILE. `require("x")` never appears in ESM output.
#      packages/sveltekit/dist/index.mjs and packages/edge/dist/index.js are both ESM, so a
#      `require(`-anchored pattern is structurally unable to fire on them.
#      >>> CLOSED by build_module_regex(), which covers static/dynamic/side-effect import,
#          export-from, and require.
#
#   4. NO SUBJECTS AT ALL. A check invoked with an empty file list greps nothing and passes.
#      >>> CLOSED: zero subjects is a HARD FAILURE. A check with no subject has no meaning.
#
# This script is itself proven to fail by scripts/assert-dist-clean.selftest.sh, which CI runs
# in the same job immediately before the real checks. A checker never observed to fail is
# indistinguishable from one that cannot; do not remove that step.
#
# USAGE
#   assert-dist-clean.sh --label TEXT --forbid-module 'a|b|c' [--allow-subpath] -- FILE...
#
# EXIT
#   0  every subject verified present, non-empty, and free of the forbidden modules
#   1  violation found, subject missing/empty, no subjects given, grep errored, or bad usage

set -euo pipefail

die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

label=""
forbid=""
subjects=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)          label="${2:?--label needs a value}"; shift 2 ;;
    --forbid-module)  forbid="${2:?--forbid-module needs a value}"; shift 2 ;;
    --)               shift; subjects=("$@"); break ;;
    *)                die "unknown argument: $1" ;;
  esac
done

[[ -n "$label"  ]] || die "--label is required"
[[ -n "$forbid" ]] || die "--forbid-module is required"

# ---------------------------------------------------------------------------
# Gate 1 — there must BE subjects. Closes way (4).
# ---------------------------------------------------------------------------
if [[ ${#subjects[@]} -eq 0 ]]; then
  die "[$label] no subjects given — this check would be vacuous"
fi

# ---------------------------------------------------------------------------
# Gate 2 — every named subject must exist and be non-empty. Closes way (1).
#
# Non-emptiness matters as much as existence: a zero-byte dist is what a soft build failure
# leaves behind, and grepping it is just as meaningless as grepping nothing.
# ---------------------------------------------------------------------------
require_subjects() {
  local f
  for f in "${subjects[@]}"; do
    [[ -e "$f" ]] || die "[$label] subject missing: $f — not built, renamed, filtered, or ejected?"
    [[ -f "$f" ]] || die "[$label] subject is not a regular file: $f"
    [[ -s "$f" ]] || die "[$label] subject is empty: $f — build produced a zero-byte artifact"
  done
}
require_subjects

# ---------------------------------------------------------------------------
# The pattern. Closes ways (2) and (3).
#
# Matches a module specifier in every form a bundler emits, either quote style:
#     require('x')   require("x")   require ( 'x' )
#     import('x')    import("x")                      (dynamic)
#     import'x'      import "x"                       (side-effect, incl. minified)
#     from'x'        from "x"                         (static import, export-from, re-export)
# and allows an optional `node:` prefix (`node:fs`) and any subpath (`react/jsx-runtime`).
#
# Deliberately biased toward FALSE POSITIVES: a bare string literal "react" in the bundle
# would not match (it is not preceded by from/import/require), but a borderline construct
# that does match gets investigated. A false positive is loud and costs someone ten minutes;
# a false negative is the bug this whole script exists to remove.
#
# PORTABILITY: this uses only POSIX ERE. In particular it does NOT use `\b`, which is a
# GNU/BSD extension that POSIX does not define — CI runs GNU grep, developers run BSD grep
# or ugrep, and a word-boundary that silently means something else on one of them would be
# a new way for the check to stop matching. The leading `(^|[^A-Za-z0-9_$.])` is the
# portable equivalent: it requires the keyword to start a word, and excluding `.` keeps
# property access (`obj.from"x"`) from counting as an import.
# ---------------------------------------------------------------------------
build_module_regex() {
  local mods="$1"
  printf '(^|[^A-Za-z0-9_$.])(from|require[[:space:]]*\\(|import[[:space:]]*\\(|import)[[:space:]]*['"'"'"](node:)?(%s)(/[^'"'"'"]*)?['"'"'"]' "$mods"
}
pattern="$(build_module_regex "$forbid")"

# ---------------------------------------------------------------------------
# The three-way branch. Closes way (1) structurally, independent of Gate 2.
#
# `set +e` around grep is required: with `set -e` active, grep's exit 1 (the PASS case) would
# abort the script. Restore `set -e` immediately after capturing $?.
# ---------------------------------------------------------------------------
# LC_ALL=C keeps the POSIX character classes byte-deterministic across the GNU grep on CI
# and whatever a developer's machine provides.
set +e
hits="$(LC_ALL=C grep -nE "$pattern" "${subjects[@]}" 2>&1)"
rc=$?
set -e

case "$rc" in
  0)
    printf 'FAIL: [%s] forbidden module import found in dist:\n' "$label" >&2
    printf '%s\n' "$hits" >&2
    exit 1
    ;;
  1)
    printf 'PASS: [%s] — %d subject(s) verified present and clean:\n' "$label" "${#subjects[@]}"
    printf '        %s\n' "${subjects[@]}"
    ;;
  *)
    # grep itself failed (missing file, unreadable, bad regex, I/O error). We did not
    # successfully look, so we cannot report clean. This is the branch the old checks
    # silently routed into their success path.
    printf 'FAIL: [%s] grep exited %d — could not complete the check, so it cannot pass:\n' \
      "$label" "$rc" >&2
    printf '%s\n' "$hits" >&2
    exit 1
    ;;
esac
