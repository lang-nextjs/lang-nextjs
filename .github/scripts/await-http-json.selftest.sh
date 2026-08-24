#!/usr/bin/env bash
#
# Proves await-http-json.sh returns non-zero for every way a health endpoint can
# fail to be a health endpoint — including the two that the old `curl -sf` loop
# scored as SUCCESS: a 3xx redirect, and a 200 with an empty body.
#
# CI runs this immediately BEFORE the Python plane. A checker never observed to
# fail is indistinguishable from one that cannot fail; do not remove this step.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$HERE/await-http-json.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"; kill $(jobs -p) 2>/dev/null' EXIT

# Stub server: one behaviour per port, chosen by argv.
cat > "$TMP/stub.py" <<'PY'
import sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
mode = sys.argv[1]; port = int(sys.argv[2])
started = time.time()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if mode == "good":        self._send(200, b'{"status":"ok","ai_backends":["a"]}')
        elif mode == "nokey":     self._send(200, b'{"status":"ok"}')
        elif mode == "empty":     self._send(200, b'')
        elif mode == "garbage":   self._send(200, b'<html>not json</html>')
        elif mode == "redirect":  # THE DJANGO CASE: 3xx + empty body
            self.send_response(301); self.send_header("Location", "/health/")
            self.send_header("Content-Length", "0"); self.end_headers()
        elif mode == "slow":      # unhealthy for 5s, then good
            if time.time() - started < 5: self._send(503, b'starting')
            else: self._send(200, b'{"ai_backends":["a"]}')
    def _send(self, code, body):
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers()
        if body: self.wfile.write(body)
HTTPServer(("127.0.0.1", port), H).serve_forever()
PY

start_stub() { python3 "$TMP/stub.py" "$1" "$2" & sleep 0.6; }
start_stub good     18991
start_stub nokey    18992
start_stub empty    18993
start_stub garbage  18994
start_stub redirect 18995
start_stub slow     18996

pass=0; total=0
expect() { # expect <want-exit> <label> -- cmd...
  local want="$1" label="$2"; shift 3
  total=$((total+1)); "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass+1)); printf '  ok   %-52s (exit %d)\n' "$label" "$got"
  else printf '  FAIL %-52s (exit %d, wanted %d)\n' "$label" "$got" "$want"; fi
}

expect 0 "200 + JSON containing the key"                -- "$SUT" http://127.0.0.1:18991/h ai_backends 6
expect 1 "200 + JSON MISSING the key"                   -- "$SUT" http://127.0.0.1:18992/h ai_backends 4
expect 1 "200 + EMPTY body (produced the traceback)"    -- "$SUT" http://127.0.0.1:18993/h ai_backends 4
expect 1 "200 + unparseable body"                       -- "$SUT" http://127.0.0.1:18994/h ai_backends 4
expect 1 "301 redirect, empty body (THE DJANGO CASE)"   -- "$SUT" http://127.0.0.1:18995/h ai_backends 4
expect 1 "server never listening (unreachable)"         -- "$SUT" http://127.0.0.1:18997/h ai_backends 4
expect 0 "unhealthy 5s then healthy (it really waits)"  -- "$SUT" http://127.0.0.1:18996/h ai_backends 20
expect 2 "no arguments (probe with no subject)"         -- "$SUT"
expect 2 "url but no required key"                      -- "$SUT" http://127.0.0.1:18991/h
expect 2 "non-numeric timeout"                          -- "$SUT" http://127.0.0.1:18991/h ai_backends abc

# The success path must emit the body on STDOUT so callers can capture it.
total=$((total+1))
if [ "$("$SUT" http://127.0.0.1:18991/h ai_backends 6 2>/dev/null)" = '{"status":"ok","ai_backends":["a"]}' ]; then
  pass=$((pass+1)); printf '  ok   %-52s\n' "body is emitted on stdout for capture"
else printf '  FAIL %-52s\n' "body is emitted on stdout for capture"; fi

# A failure must NAME the status code, or the operator is back to guessing.
total=$((total+1))
# NB: capture first. Piping the SUT into grep would let `pipefail` return the
# SUT's own exit 1 even when grep matched — the assertion would then be testing
# the pipeline, not the message.
msg="$("$SUT" http://127.0.0.1:18995/h ai_backends 4 2>&1 >/dev/null)"
if printf '%s' "$msg" | grep -q "301"; then
  pass=$((pass+1)); printf '  ok   %-52s\n' "failure message names the HTTP status"
else printf '  FAIL %-52s\n' "failure message names the HTTP status"; fi

echo
if [ "$pass" -eq "$total" ]; then
  echo "PASS: $pass/$total. await-http-json.sh has been observed to fail on redirects,"
  echo "      empty bodies, bad JSON, missing keys, unreachable servers and no subject."
  exit 0
fi
echo "FAIL: $pass/$total"; exit 1
