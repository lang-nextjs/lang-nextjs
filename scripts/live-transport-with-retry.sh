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
# A SECOND UPSTREAM FAILURE IS RED, AND THE ROUTE TO "NEUTRAL" WAS CLOSED BY
# MEASUREMENT RATHER THAN BY PREFERENCE.
#
# The approved policy was "finish NEUTRAL, not green", for the right reason:
# "we could not test this" is not "this works". A genuine neutral turned out
# not to be reachable from here:
#
#   - A job's conclusion is a check run owned by the `github-actions` app and
#     set by the runner from the exit status. Enumerated across two full main
#     runs, the only conclusions this repo produces are success, skipped and
#     failure. There is no neutral among them.
#   - Creating a check run through the Checks API — even with `checks: write`
#     scoped to this job — ADDS an entry beside the job. It does not change the
#     job's own. Exit 0 would still leave a green
#     "E2E — open-swe live transport" on main's board, which is precisely what
#     the policy forbade.
#
# So the honest implementation of "not green" is RED. It is a DIFFERENT red
# from the one #400 was filed about: that one was unlabelled and trained people
# to discount main, and this one names its cause — UPSTREAM_UNAVAILABLE, both
# attempts. A labelled red beats a false green, and the classification is what
# makes the label possible.
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
  echo "::error title=live-transport::UNVERIFIED — both attempts failed on provider-attributed frames (UPSTREAM_UNAVAILABLE). The transport was NOT exercised. This red names its cause and is not a defect in this repository."
  exit 1
fi
exit "$verdict2"
