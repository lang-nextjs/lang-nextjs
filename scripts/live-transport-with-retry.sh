#!/usr/bin/env bash
# THE RETRY POLICY, IN ONE PLACE THAT CI RUNS AND A TEST EXERCISES (#400 step 2).
#
# It lived inline in e2e.yml, twice. Policy in a YAML `run:` block is shell that
# nothing executes outside CI, so the only way to learn it was wrong was to push
# — and a test that RESTATED it here would be a second copy that agrees until it
# does not. One script, called by the workflow and driven by the selftest.
#
# WHAT IT DOES, and the retry is safe only because the two cases are finally
# distinguishable: a defect in EITHER attempt exits 1 and stays red, so this
# cannot hide a transport break behind a re-run. Before the classification
# existed, a retry here was the option #400 explicitly rejected.
#
# EVIDENCE, AND ITS SIZE. Justified by ONE observed recovery — push b2ecbb11
# failed on two topologies with provider-attributed frames and its re-run
# succeeded. n=1. Not a recovery RATE. The LIVE_TRANSPORT_VERDICT records carry
# attempt=first|retry so further samples accumulate without anyone noticing them
# one at a time; three more pairs would make it a number.
#
# `exit 0` AFTER A SECOND UPSTREAM FAILURE IS GREEN, NOT "NEUTRAL". A workflow
# STEP cannot set a neutral conclusion — only the Checks API can, and this is
# not one. The honest description is "does not go red, and says loudly that
# nothing was verified"; the warning annotation and the verdict record are what
# stop that green being read as a pass.
set -uo pipefail

PROJECT="${1:?usage: live-transport-with-retry.sh <playwright-project>}"

# Overridable so the selftest can drive the POLICY without a live model or a
# browser. Defaults are what CI runs.
RUN_CMD="${LIVE_TRANSPORT_RUN_CMD:-pnpm e2e --project=$PROJECT}"
CLASSIFY_CMD="${LIVE_TRANSPORT_CLASSIFY_CMD:-node scripts/classify-live-failure.mjs}"
LOG_DIR="${LIVE_TRANSPORT_LOG_DIR:-/tmp}"

attempt() {
  local log="$1" is_retry="$2"
  $RUN_CMD > "$log" 2>&1
  local code=$?
  cat "$log"
  if [ "$is_retry" = "1" ]; then
    LIVE_TRANSPORT_IS_RETRY=1 $CLASSIFY_CMD "$log" "$code"
  else
    $CLASSIFY_CMD "$log" "$code"
  fi
  return $?
}

attempt "$LOG_DIR/live-transport.log" 0
verdict=$?

# 3 is the classifier's UPSTREAM-ONLY code. Anything else — pass or a real
# failure — is the answer, and retrying it would either waste a run or mask a
# defect.
if [ "$verdict" -ne 3 ]; then
  exit "$verdict"
fi

echo "first attempt was upstream-only — retrying once (#400)"
attempt "$LOG_DIR/live-transport-retry.log" 1
verdict2=$?

if [ "$verdict2" -eq 3 ]; then
  echo "::warning title=live-transport::UNVERIFIED — both attempts failed on provider-attributed frames. The transport was NOT exercised; this is not a pass."
  exit 0
fi
exit "$verdict2"
