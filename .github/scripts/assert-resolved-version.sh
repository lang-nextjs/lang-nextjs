#!/usr/bin/env bash
#
# assert-resolved-version.sh <spec> <package> <dir> [dir...]
#
# Assert that a matrix cell actually INSTALLED the version it claims to test.
#
# WHY THIS EXISTS
# A version matrix pins a dependency and then builds. Nothing in that sequence
# proves the pin took effect. If the pin silently resolves elsewhere — a root
# pnpm override, a `continue-on-error` step that swallowed a failed install, a
# spec that matches nothing — the cell still runs, still goes green, and still
# reports a verdict about a version it never ran. A green cell of that kind is
# worse than a red one, because nobody investigates green.
#
# FAILURE MODES DELIBERATELY CLOSED (each is proven by the self-test):
#   * ABSENT SUBJECT   — a missing package.json is a HARD FAILURE, never "fine".
#                        "I could not look" must not read as "I looked and it matched".
#   * ZERO SUBJECTS    — invoked with no directories is a HARD FAILURE. A check
#                        with no subject has no meaning and would pass trivially.
#   * UNPARSEABLE SPEC — a spec with no major version ('latest', '*') is a HARD
#                        FAILURE rather than a comparison against an empty string.
#
# Compares MAJOR version only: the matrix pins ranges (^15.5.0), so the patch
# level is whatever the registry served that day and must not be asserted.
set -euo pipefail

spec="${1:-}"; pkg="${2:-}"
[ -n "$spec" ] && [ -n "$pkg" ] || { echo "usage: $0 <spec> <package> <dir>..."; exit 1; }
shift 2

expected_major="$(printf '%s' "$spec" | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
case "$expected_major" in
  ''|*[!0-9]*) echo "ERROR: no major version could be parsed from spec '$spec'"; exit 1 ;;
esac

[ "$#" -gt 0 ] || { echo "ERROR: no directories given — a check with no subject has no meaning"; exit 1; }

fail=0
for dir in "$@"; do
  manifest="$dir/node_modules/$pkg/package.json"
  if [ ! -f "$manifest" ]; then
    echo "ERROR: $manifest is missing — cannot confirm which $pkg this cell ran"
    fail=1; continue
  fi
  actual="$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")"
  if [ "${actual%%.*}" != "$expected_major" ]; then
    echo "ERROR: $dir resolved $pkg@$actual, but this cell claims to be testing $spec"
    fail=1
  else
    echo "  ok  $dir -> $pkg@$actual"
  fi
done

[ "$fail" -eq 0 ]
