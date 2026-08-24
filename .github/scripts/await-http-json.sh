#!/usr/bin/env bash
#
# await-http-json.sh <url> <required-key> [timeout-seconds]
#
# Wait for <url> to serve HTTP 200 with a JSON body containing <required-key>.
# On success the body is printed to STDOUT (diagnostics go to STDERR, so the
# caller can do HEALTH="$(await-http-json.sh ...)"). On failure: non-zero, with
# a message that names what actually happened.
#
# WHY THIS EXISTS
# The loop it replaces was:
#
#     for i in $(seq 1 60); do
#       curl -sf "$URL" >/dev/null && break
#       sleep 2
#     done
#     HEALTH=$(curl -sf "$URL")
#
# It had NO failure branch: after 60 attempts it simply continued, so a server
# that never came up and a server that came up were the same outcome. Worse,
# `curl -sf` treats ANY 2xx *or 3xx* as success — Django answers /health with a
# 301 to /health/ and an EMPTY body, so the loop "succeeded" on the first try,
# HEALTH became "", and the operator's entire diagnostic was:
#
#     json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
#
# — naming neither the server, the port, the URL, nor the timeout. A gate whose
# failure mode is a decoder traceback teaches people to stop reading it.
#
# A health check that cannot distinguish "server never came up" from "server
# said nothing" is a check with no subject. These are therefore SEPARATE,
# separately-reported outcomes:
#   * unreachable          — connection refused / DNS / timeout
#   * non-200              — the CODE is printed (this is how 301 was invisible)
#   * 200 with empty body  — the exact defect that produced the traceback
#   * 200, unparseable     — body echoed, truncated
#   * 200, JSON, key absent— names the key and what keys were present
# and exhausting the wait is a HARD FAILURE reporting url, elapsed, attempts,
# and the last response seen.
#
# Proven by .github/scripts/await-http-json.selftest.sh, which CI runs first.
set -uo pipefail

URL="${1:-}"; KEY="${2:-}"; TIMEOUT="${3:-120}"
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "ERROR: usage: $0 <url> <required-key> [timeout-seconds]" >&2
  echo "       a probe with no URL or no required key has no subject." >&2
  exit 2
fi
case "$TIMEOUT" in ''|*[!0-9]*) echo "ERROR: timeout must be integer seconds, got '$TIMEOUT'" >&2; exit 2;; esac

start=$(date +%s); attempts=0
last_code="(never connected)"; last_body=""; last_reason="unreachable"

while :; do
  attempts=$((attempts + 1))
  body_file="$(mktemp)"
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)"
  body="$(cat "$body_file")"; rm -f "$body_file"
  last_code="$code"; last_body="$body"

  if [ "$code" = "000" ]; then
    last_reason="unreachable (connection refused / timeout)"
  elif [ "$code" != "200" ]; then
    # THE DJANGO CASE. `curl -sf` called this success and returned an empty body.
    last_reason="HTTP $code (not 200) — a redirect or error, not a served health document"
  elif [ -z "$body" ]; then
    last_reason="HTTP 200 but the body was EMPTY"
  elif ! printf '%s' "$body" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    last_reason="HTTP 200 but the body is not valid JSON"
  elif ! printf '%s' "$body" | python3 -c "import json,sys; sys.exit(0 if '$KEY' in json.load(sys.stdin) else 1)" 2>/dev/null; then
    present="$(printf '%s' "$body" | python3 -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin))))' 2>/dev/null)"
    last_reason="HTTP 200 with JSON, but no '$KEY' key (present: $present)"
  else
    printf '%s' "$body"
    echo "  ok  $URL -> HTTP 200 with '$KEY' after $(( $(date +%s) - start ))s, $attempts attempt(s)" >&2
    exit 0
  fi

  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    {
      echo "ERROR: health wait EXHAUSTED — this is a failure, not something to continue past."
      echo "  url          : $URL"
      echo "  waited       : ${elapsed}s (limit ${TIMEOUT}s)"
      echo "  attempts     : $attempts"
      echo "  last status  : $last_code"
      echo "  diagnosis    : $last_reason"
      if [ -n "$last_body" ]; then
        echo "  last body    : $(printf '%s' "$last_body" | head -c 500)"
      else
        echo "  last body    : <empty>"
      fi
    } >&2
    exit 1
  fi
  sleep 2
done
