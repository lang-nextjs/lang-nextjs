#!/usr/bin/env bash
set -euo pipefail

# Canary validation script for open-swe dashboard
# Returns 0 on success, 1 on failure

HEALTH_URL="${HEALTH_URL:-http://localhost:3001}"
API_RUNS_URL="${API_RUNS_URL:-http://localhost:3001/api/open-swe/runs}"

FAILED=0

echo "=== open-swe Canary Check ==="
echo "HEALTH_URL: $HEALTH_URL"
echo "API_RUNS_URL: $API_RUNS_URL"

# Check 1: Root page returns 200 (not 5xx)
echo -n "Check 1 — Root page (not 5xx): "
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL/")
if [ "$HTTP_STATUS" -lt 500 ]; then
    echo "PASS ($HTTP_STATUS)"
else
    echo "FAIL ($HTTP_STATUS)"
    FAILED=1
fi

# Check 2: API runs endpoint returns 200 (not 5xx)
echo -n "Check 2 — API runs endpoint (not 5xx): "
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_RUNS_URL")
if [ "$API_STATUS" -lt 500 ]; then
    echo "PASS ($API_STATUS)"
else
    echo "FAIL ($API_STATUS)"
    FAILED=1
fi

# Check 3: Root page does not contain error HTML
echo -n "Check 3 — No error HTML indicators: "
BODY=$(curl -s "$HEALTH_URL/")
if echo "$BODY" | grep -qiE '(500|502|503|internal server error)'; then
    echo "FAIL (error indicators found)"
    FAILED=1
else
    echo "PASS"
fi

if [ $FAILED -eq 0 ]; then
    echo "=== All checks passed ==="
    exit 0
else
    echo "=== One or more checks failed ==="
    exit 1
fi