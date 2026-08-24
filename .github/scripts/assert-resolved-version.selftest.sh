#!/usr/bin/env bash
#
# Proves assert-resolved-version.sh returns non-zero on a false claim, on an
# absent subject, on zero subjects and on an unparseable spec — and zero on a
# truthful claim.
#
# CI runs this immediately BEFORE the real assertions. A checker never observed
# to fail is indistinguishable from one that cannot fail; do not remove this step.
# (Same reasoning, and same shape, as scripts/assert-dist-clean.selftest.sh.)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/assert-resolved-version.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

mk() { mkdir -p "$TMP/$1/node_modules/$2"; printf '{"version":"%s"}' "$3" > "$TMP/$1/node_modules/$2/package.json"; }
mk app16 next 16.2.7
mk app15 next 15.5.23
mk empty next 0.0.0

pass=0; total=0
expect() { # expect <want-exit> <label> -- cmd...
  local want="$1" label="$2"; shift 3
  total=$((total+1))
  ( cd "$TMP" && "$@" ) >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass+1)); printf '  ok   %-46s (exit %d)\n' "$label" "$got"
  else printf '  FAIL %-46s (exit %d, wanted %d)\n' "$label" "$got" "$want"; fi
}

expect 0 "truthful claim"                    -- "$SUT" '^16.0.0' next app16
expect 1 "FALSE claim (16 installed, 15 claimed)" -- "$SUT" '^15.5.0' next app16
expect 1 "FALSE claim (15 installed, 16 claimed)" -- "$SUT" '^16.0.0' next app15
expect 1 "one truthful + one false subject"   -- "$SUT" '^16.0.0' next app16 app15
expect 1 "ABSENT subject (the defect)"        -- "$SUT" '^16.0.0' next nosuchdir
expect 1 "one present + one absent subject"   -- "$SUT" '^16.0.0' next app16 nosuchdir
expect 1 "ZERO subjects (vacuous check)"      -- "$SUT" '^16.0.0' next
expect 1 "unparseable spec 'latest'"          -- "$SUT" 'latest' next app16
expect 1 "unparseable spec '*'"               -- "$SUT" '*' next app16
expect 1 "missing package argument"           -- "$SUT" '^16.0.0'
expect 0 "major-only compare ignores patch"   -- "$SUT" '^16.9.9' next app16
expect 1 "wrong package name is absent, not ok" -- "$SUT" '^16.0.0' nextjs app16

echo
if [ "$pass" -eq "$total" ]; then
  echo "PASS: $pass/$total. assert-resolved-version.sh has been observed to fail on false"
  echo "      claims and on absent/zero subjects. The matrix assertions below mean something."
  exit 0
fi
echo "FAIL: $pass/$total"; exit 1
