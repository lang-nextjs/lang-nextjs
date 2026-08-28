#!/usr/bin/env bash
#
# warm-routes.sh self-test — proves its REPORT tracks reality.
#
# The pairing gate asks for a can-it-fail proof, and this script deliberately
# cannot fail the build: warming shapes latency, it does not gate, and a warm
# step that can go red converts a test signal into an infrastructure one.
#
# SO THE PROPERTY WORTH PROVING IS THE OTHER ONE. A warm step that printed
# success unconditionally would be exactly the vacuous check this repo keeps
# finding — it would name the property and be unable to contradict it, and the
# first person to read "GET /hitl-demo -> 200" over a server that was never
# reachable would believe the routes were warm.
#
# Both halves are asserted, and neither is worth much alone:
#
#   1. against a live server it reports the real status          (200)
#   2. against a dead one it reports the failure AND still exits 0
#
# Half 2 is the one that decays: someone "fixing" the noise by adding `set -e`
# or swallowing the status would break the non-fatal contract, and the only
# symptom would be a red build in a step that is not supposed to be able to
# produce one.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WARM="${HERE}/warm-routes.sh"
pass=0
fail=0

check() {
  local name="$1" ok="$2" detail="$3"
  if [ "$ok" = "yes" ]; then
    pass=$((pass + 1)); echo "  ok   ${name}  ${detail}"
  else
    fail=$((fail + 1)); echo "  FAIL ${name}  ${detail}"
  fi
}

echo "warm-routes.sh self-test — the report must track reality"
echo

# --- A live server: the report must carry its real status ---------------------
PORT=0
for p in 45231 45232 45233 45234; do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then PORT=$p; break; fi
done
if [ "$PORT" = "0" ]; then
  echo "  FAIL could not find a free port for the live-server case"
  exit 1
fi

TMPDIR_SRV="$(mktemp -d)"
# DIRECT CHILD, NOT A SUBSHELL. Written first as `( cd … && python3 … ) &`,
# which makes python a GRANDCHILD: `kill $!` then killed the subshell and left
# the server listening, so the dead-server case ran against a live port and
# reported a false FAIL. The self-test caught it, which is the point of having
# one — but it was the harness that was wrong, not warm-routes.sh.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$TMPDIR_SRV" >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; rm -rf "$TMPDIR_SRV"' EXIT
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 && break
  sleep 0.2
done

live_out="$(bash "$WARM" "http://127.0.0.1:${PORT}" 2>&1)"
live_rc=$?
case "$live_out" in
  *"GET  / -> 200"*) check "a live server is reported as 200" yes "(200)" ;;
  *)                 check "a live server is reported as 200" no  "(got: $(echo "$live_out" | tr '\n' ' ' | cut -c1-70))" ;;
esac
check "a live server exits 0" "$([ "$live_rc" = "0" ] && echo yes || echo no)" "(rc=${live_rc})"

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
# Do not proceed until the port is genuinely closed, or the case below measures
# a live server and passes for the wrong reason.
for _ in $(seq 1 50); do
  curl -sf --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || break
  sleep 0.2
done
if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "  FAIL could not close the test server — the dead-server case cannot run honestly"
  exit 1
fi

# --- A dead server: reported as dead, and STILL non-fatal ---------------------
# Port is now closed. The status must change, and the exit code must not.
dead_out="$(bash "$WARM" "http://127.0.0.1:${PORT}" 2>&1)"
dead_rc=$?
case "$dead_out" in
  *"GET  / -> 200"*)
    # THE VACUITY CASE: unchanged output over a server that is gone.
    check "a dead server is NOT reported as 200" no "(reported 200 for a closed port)" ;;
  *)
    check "a dead server is NOT reported as 200" yes "(status changed)" ;;
esac
check "a dead server still exits 0 (non-fatal contract)" \
  "$([ "$dead_rc" = "0" ] && echo yes || echo no)" "(rc=${dead_rc})"

echo
total=$((pass + fail))
if [ "$fail" -ne 0 ]; then
  echo "FAIL: ${fail}/${total} cases wrong. warm-routes.sh is NOT trustworthy."
  exit 1
fi
echo "PASS: ${pass}/${total}. The report tracks reality, and warming never gates the build."
