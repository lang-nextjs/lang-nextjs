#!/usr/bin/env bash
#
# diagnose-ci-billing.sh — Pinpoint whether CI "failures" are real, or just
# GitHub Actions refusing to start jobs because the org ran out of minutes.
#
# Why this exists: when an org exhausts its included Actions minutes (and has no
# paid spending limit), GitHub marks every triggered job as conclusion=failure
# WITHOUT running any step. Symptoms that look like a code regression but aren't:
#   - runs finish in a few seconds
#   - failed-step name is empty, logs are 0 bytes
#   - the run annotation reads "...spending limit needs to be increased"
#   - workflows that were green on the previous commit "regress" on a trivial diff
#
# This script reads the org's billing usage (works with a plain `repo` token via
# the enhanced billing API) and the latest run annotation, then prints a verdict.
#
# Usage:
#   scripts/diagnose-ci-billing.sh
#   INCLUDED_MINUTES=3000 scripts/diagnose-ci-billing.sh   # Team plan, etc.
#   BRANCH=feat/foo scripts/diagnose-ci-billing.sh
#
# Requires: gh (authenticated), python3.
set -euo pipefail

INCLUDED_MINUTES="${INCLUDED_MINUTES:-2000}"   # GitHub Free for orgs = 2000/mo
BILLING_BLOCK_RE='spending limit needs to be increased|recent account payments have failed|job was not started'

command -v gh >/dev/null  || { echo "✗ gh CLI not found"; exit 2; }
command -v python3 >/dev/null || { echo "✗ python3 not found"; exit 2; }

# --- resolve repo + owner ----------------------------------------------------
read -r OWNER REPO < <(gh repo view --json owner,name \
  --jq '"\(.owner.login) \(.name)"' 2>/dev/null) || {
    echo "✗ not in a GitHub repo (or gh not authenticated)"; exit 2; }
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}"

echo "Repo:     $OWNER/$REPO"
echo "Branch:   ${BRANCH:-<none>}"
echo "Plan inc: ${INCLUDED_MINUTES} Actions minutes/month (override via INCLUDED_MINUTES)"
echo

# --- 1) billing usage (authoritative minutes counter) ------------------------
# Enhanced billing endpoint; readable with a standard `repo`-scoped token.
USAGE_JSON="$(gh api "orgs/${OWNER}/settings/billing/usage" 2>/dev/null || true)"

MINUTES_VERDICT="unknown"
if [ -n "$USAGE_JSON" ] && printf '%s' "$USAGE_JSON" | grep -q usageItems; then
  USAGE_FILE="$(mktemp)"
  trap 'rm -f "$USAGE_FILE"' EXIT
  printf '%s' "$USAGE_JSON" > "$USAGE_FILE"
  # Program is read from the heredoc via `python3 -`, so the usage JSON must be
  # passed by path (argv[1]) — stdin is taken by the heredoc, not the data.
  set +e
  INCLUDED_MINUTES="$INCLUDED_MINUTES" REPO="$REPO" python3 - "$USAGE_FILE" <<'PY'
import json, os, sys
with open(sys.argv[1]) as fh:
    data = json.load(fh)
items = data.get("usageItems", [])
included = float(os.environ["INCLUDED_MINUTES"])
this_repo = os.environ["REPO"]

# Pick the most recent billing month present in the data.
mins = [i for i in items
        if i.get("product") == "actions" and i.get("unitType") == "Minutes"]
if not mins:
    print("Actions minutes:  no minute-usage rows returned")
    sys.exit(0)
latest_month = max(i["date"] for i in mins)
month_rows = [i for i in mins if i["date"] == latest_month]
total = sum(i["quantity"] for i in month_rows)

print(f"Billing month:    {latest_month[:7]}")
print(f"Actions minutes:  {total:.0f} used / {included:.0f} included", end="")
pct = total / included * 100 if included else 0
print(f"  ({pct:.0f}%)")
for i in sorted(month_rows, key=lambda x: -x["quantity"]):
    print(f"    - {i['quantity']:>7.0f} min  {i.get('sku','?'):<18} {i.get('repositoryName','?')}")

remaining = included - total
if remaining <= 0:
    print(f"\n>>> MINUTES EXHAUSTED: {-remaining:.0f} min over the included allowance.")
    print(">>> With no paid spending limit, GitHub will NOT start new jobs until reset.")
    sys.exit(10)   # signal: exhausted
else:
    print(f"\n>>> {remaining:.0f} min remaining this cycle.")
    sys.exit(0)
PY
  case $? in
    10) MINUTES_VERDICT="exhausted" ;;
    0)  MINUTES_VERDICT="ok" ;;
    *)  MINUTES_VERDICT="unknown" ;;
  esac
  set -e
else
  echo "Actions minutes:  billing usage not readable with current token scopes."
  echo "                  (need org access; falling back to run annotations)"
fi
echo

# --- 2) latest run annotation (what GitHub actually told us) -----------------
echo "Latest workflow runs on ${BRANCH:-this branch}:"
# Prefer the latest FAILED run for the annotation cross-check (a green Dependabot
# run carries no annotation and would muddy the signal); fall back to latest run.
RUN_ID="$(gh run list ${BRANCH:+--branch "$BRANCH"} --limit 20 \
  --json databaseId,conclusion \
  --jq 'map(select(.conclusion=="failure")) | .[0].databaseId // empty' 2>/dev/null || true)"
[ -z "$RUN_ID" ] && RUN_ID="$(gh run list ${BRANCH:+--branch "$BRANCH"} --limit 1 \
  --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"

ANNOTATION_BLOCK="no"
if [ -n "$RUN_ID" ]; then
  ANNOT="$(gh run view "$RUN_ID" 2>/dev/null | sed -n '/ANNOTATIONS/,/View this run/p' || true)"
  if printf '%s' "$ANNOT" | grep -Eqi "$BILLING_BLOCK_RE"; then
    ANNOTATION_BLOCK="yes"
    echo "  run $RUN_ID → BILLING BLOCK annotation present:"
    printf '%s\n' "$ANNOT" | grep -Ei "$BILLING_BLOCK_RE" | sed 's/^/    /'
  else
    echo "  run $RUN_ID → no billing-block annotation (jobs are starting normally)"
  fi
else
  echo "  (no runs found)"
fi
echo

# --- verdict -----------------------------------------------------------------
echo "================= VERDICT ================="
if [ "$MINUTES_VERDICT" = "exhausted" ] || [ "$ANNOTATION_BLOCK" = "yes" ]; then
  echo "CI is BLOCKED BY LACK OF ACTIONS MINUTES — this is NOT a code failure."
  echo "Jobs are not started, so any 'failure' conclusion is spurious."
  echo
  echo "Fix (org owner): raise the spending limit or wait for the monthly reset:"
  echo "  https://github.com/organizations/${OWNER}/settings/billing"
  exit 1
elif [ "$MINUTES_VERDICT" = "ok" ] && [ "$ANNOTATION_BLOCK" = "no" ]; then
  echo "Minutes available and no billing block — any failures are REAL. Inspect logs:"
  echo "  gh run view ${RUN_ID:-<id>} --log-failed"
  exit 0
else
  echo "Inconclusive from billing alone. Check the latest run directly:"
  echo "  gh run view ${RUN_ID:-<id>} --log-failed"
  exit 0
fi
