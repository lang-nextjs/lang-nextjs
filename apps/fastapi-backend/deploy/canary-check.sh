#!/usr/bin/env bash
set -euo pipefail

# Canary validation script for FastAPI backend
# Returns 0 on success, 1 on failure

HEALTH_URL="${HEALTH_URL:-http://localhost:8001/health}"
API_URL="${API_URL:-http://localhost:8001/api/chat/stream}"

FAILED=0

echo "=== FastAPI Canary Check ==="
echo "HEALTH_URL: $HEALTH_URL"
echo "API_URL: $API_URL"

# Check 1: Health endpoint returns 200
echo -n "Check 1 — Health endpoint (200): "
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL")
if [ "$HTTP_STATUS" -eq 200 ]; then
    echo "PASS ($HTTP_STATUS)"
else
    echo "FAIL ($HTTP_STATUS)"
    FAILED=1
fi

# Check 2: Health endpoint returns valid JSON
echo -n "Check 2 — Health returns valid JSON: "
RESPONSE=$(curl -s "$HEALTH_URL")
if echo "$RESPONSE" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
    echo "PASS"
else
    echo "FAIL (not valid JSON)"
    FAILED=1
fi

# Check 3: API route does not return 5xx
echo -n "Check 3 — API route (not 5xx): "
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL")
if [ "$API_STATUS" -lt 500 ]; then
    echo "PASS ($API_STATUS)"
else
    echo "FAIL ($API_STATUS)"
    FAILED=1
fi

if [ $FAILED -eq 0 ]; then
    echo "=== All checks passed ==="
    exit 0
else
    echo "=== One or more checks failed ==="
    exit 1
fi