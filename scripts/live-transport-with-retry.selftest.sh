#!/usr/bin/env bash
# The retry policy, watched behaving in every branch (#400).
#
# THE PROPERTY THAT MATTERS IS THE ONE THAT MUST STAY RED: a defect on the retry
# must NOT be swallowed by the retry that was allowed for an outage. A policy
# only ever watched recovering from upstream failures is indistinguishable from
# one that returns 0 whenever it retried at all.
#
# The suite and the classifier are stubbed so the POLICY is what is exercised —
# no live model, no browser. The stubs return the classifier's real exit
# contract: 0 pass, 1 real failure, 3 upstream-only.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/live-transport-with-retry.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok() { if [ "$1" = "1" ]; then printf "  ok     %s\n" "$2"; else printf "  FAIL   %s\n" "$2"; fails=$((fails+1)); fi; }

# A classifier stub that returns scripted codes, one per attempt, and records
# how many times it was called.
make_stub() {
  cat > "$TMP/classify-stub.sh" <<STUB
#!/usr/bin/env bash
n=\$(cat "$TMP/calls" 2>/dev/null || echo 0)
n=\$((n+1)); echo "\$n" > "$TMP/calls"
codes=($1)
exit \${codes[\$((n-1))]}
STUB
  chmod +x "$TMP/classify-stub.sh"
  rm -f "$TMP/calls"
}

run_case() {
  local codes="$1"
  make_stub "$codes"
  LIVE_TRANSPORT_RUN_CMD="true" \
  LIVE_TRANSPORT_CLASSIFY_CMD="$TMP/classify-stub.sh" \
  LIVE_TRANSPORT_LOG_DIR="$TMP" \
    bash "$SCRIPT" open-swe-live > "$TMP/out" 2>&1
  echo $?
}
calls() { cat "$TMP/calls" 2>/dev/null || echo 0; }

echo "live-transport-with-retry selftest"
echo ""

c=$(run_case "0 0");   ok "$([ "$c" = "0" ] && [ "$(calls)" = "1" ] && echo 1)" "a pass exits 0 and does NOT retry (calls=$(calls))"
c=$(run_case "1 0");   ok "$([ "$c" = "1" ] && [ "$(calls)" = "1" ] && echo 1)" "a DEFECT exits 1 and does NOT retry (calls=$(calls))"
c=$(run_case "3 0");   ok "$([ "$c" = "0" ] && [ "$(calls)" = "2" ] && echo 1)" "upstream then pass exits 0, after ONE retry (calls=$(calls))"
c=$(run_case "3 3");   ok "$([ "$c" = "1" ] && [ "$(calls)" = "2" ] && echo 1)" "upstream twice exits 1 — RED, never a green claiming success (calls=$(calls))"
grep -q "UNVERIFIED" "$TMP/out"; ok "$([ $? = 0 ] && echo 1)" "  ...and the red NAMES its cause, which unlabelled red never did"
c=$(run_case "3 1");   ok "$([ "$c" = "1" ] && echo 1)" "THE ONE THAT MATTERS: upstream then DEFECT exits 1, not swallowed"
c=$(run_case "1 1");   ok "$([ "$(calls)" = "1" ] && echo 1)" "a first-attempt defect never reaches a second run"

# THE CRITERION, ASSERTED DIRECTLY RATHER THAN INFERRED FROM THE ROWS ABOVE.
# The whole objection to the first design was: someone reading main's board
# sees a green job and concludes live transport works. So no path through this
# script may exit 0 without the suite having actually passed. Stated as its own
# case because it is the requirement, and the rows above are only evidence for
# it — a future branch added without re-reading them could satisfy every row
# and still return 0 for an unverified run.
for pair in "3 3" "3 1" "1 0" "1 1"; do
  set -- $pair
  c=$(run_case "$1 $2")
  ok "$([ "$c" != "0" ] && echo 1)" "verdicts ($1,$2) never exit 0 — no unverified run reads as a pass"
done

echo ""
if [ "$fails" = "0" ]; then
  echo "PASS: the retry recovers an outage and cannot hide a defect in either attempt."
else
  echo "FAIL: $fails case(s). Do not trust this policy."
fi
exit "$fails"
