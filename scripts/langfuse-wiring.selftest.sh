#!/usr/bin/env bash
# Proves langfuse-override-args.sh answers correctly in BOTH directions, and
# that dev-all.sh actually consumes it.
#
# The pair is the point. "Emits -f when the fixture is up" is satisfied by a
# script that emits -f unconditionally — which is precisely the failure mode
# the override file exists to prevent, since it would make every forker who
# does not run the fixture fail closed. Neither case means anything alone.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok()   { printf '  ok   %-56s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL %-56s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# A stubbed `docker` whose `network inspect` exit code we control. This is what
# lets the branch be tested without starting a single container.
stub_docker() {
  local rc="$1" dir; dir="$(mktemp -d)"
  cat > "$dir/docker" <<EOF
#!/usr/bin/env bash
[ "\$1" = "network" ] && exit $rc
exit 0
EOF
  chmod +x "$dir/docker"
  printf '%s' "$dir"
}

run_with_docker_rc() {
  local dir; dir="$(stub_docker "$1")"
  PATH="$dir:$PATH" bash "$ROOT/scripts/langfuse-override-args.sh" "$ROOT" 2>/dev/null
  rm -rf "$dir"
}

# ── the pair ───────────────────────────────────────────────────────────────
out="$(run_with_docker_rc 0)"
case "$out" in
  *backend-override.yml*) ok "fixture RUNNING -> emits the override" "(-f …/backend-override.yml)";;
  *) bad "fixture RUNNING -> emits the override" "got: '${out:-<empty>}'";;
esac

out="$(run_with_docker_rc 1)"
if [ -z "$out" ]; then
  ok "fixture ABSENT -> emits nothing" "(forkers keep working)"
else
  bad "fixture ABSENT -> emits nothing" "got: '$out'"
fi

# ── the file must exist, or the -f is a worse error than no tracing ────────
tmp="$(mktemp -d)"; mkdir -p "$tmp/scripts"
out="$(PATH="$(stub_docker 0):$PATH" bash "$ROOT/scripts/langfuse-override-args.sh" "$tmp" 2>/dev/null)"
if [ -z "$out" ]; then
  ok "override file MISSING -> emits nothing" "(no confusing compose error)"
else
  bad "override file MISSING -> emits nothing" "got: '$out'"
fi
rm -rf "$tmp"

# ── the console URL: a browser address, derived from what docker published ─
# The pair again. "Prints a URL when the fixture is up" is satisfied by a script
# that prints one unconditionally, which would hand every forker without the
# fixture a link to a port nobody is listening on.
consurl() {
  local dir; dir="$(mktemp -d)"
  cat > "$dir/docker" <<EOF
#!/usr/bin/env bash
[ "\$1" = "port" ] && { $1; }
exit 0
EOF
  chmod +x "$dir/docker"
  PATH="$dir:$PATH" LANGFUSE_CONSOLE_URL= bash "$ROOT/scripts/langfuse-console-url.sh" 2>/dev/null
  rm -rf "$dir"
}

# QUOTED. Unquoted, `->` is a shell REDIRECT: `echo 3000/tcp -` written to a
# file literally named `127.0.0.1:3100`. The stub then printed nothing, both
# cases reported an empty result, and it read as the script being broken.
out="$(consurl 'echo "3000/tcp -> 127.0.0.1:3100"; exit 0')"
if [ "$out" = "http://localhost:3100" ]; then
  ok "fixture published on 3100 -> console URL" "($out)"
else
  bad "fixture published on 3100 -> console URL" "got: '${out:-<empty>}'"
fi

# DERIVED, not hardcoded: a fixture on another port must produce that port.
out="$(consurl 'echo "3000/tcp -> 0.0.0.0:9999"; exit 0')"
if [ "$out" = "http://localhost:9999" ]; then
  ok "a different published port is honoured" "($out)"
else
  bad "a different published port is honoured" "got: '${out:-<empty>}'"
fi

out="$(consurl 'exit 1')"
if [ -z "$out" ]; then
  ok "no fixture -> no console URL" "(no dead link offered)"
else
  bad "no fixture -> no console URL" "got: '$out'"
fi

out="$(LANGFUSE_CONSOLE_URL=https://cloud.langfuse.com bash "$ROOT/scripts/langfuse-console-url.sh" 2>/dev/null)"
if [ "$out" = "https://cloud.langfuse.com" ]; then
  ok "an explicit console URL wins" "(a real deployment is undiscoverable)"
else
  bad "an explicit console URL wins" "got: '${out:-<empty>}'"
fi

# ── and dev-all.sh must actually USE it ────────────────────────────────────
# Without this, the two cases above can both pass while the wiring is dead
# code — a helper that answers correctly and is never called.
if grep -q 'langfuse-override-args.sh' "$ROOT/scripts/dev-all.sh"; then
  ok "dev-all.sh calls the override helper" "(the wiring is reachable)"
else
  bad "dev-all.sh calls the override helper" "helper is dead code"
fi

if grep -q 'langfuse-console-url.sh' "$ROOT/scripts/dev-all.sh"; then
  ok "dev-all.sh calls the console helper" "(the wiring is reachable)"
else
  bad "dev-all.sh calls the console helper" "helper is dead code"
fi

if bash -n "$ROOT/scripts/dev-all.sh" 2>/dev/null; then
  ok "dev-all.sh still parses" "(bash -n)"
else
  bad "dev-all.sh still parses" "syntax error"
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "PASS: $PASS/$PASS. Both directions were watched, so neither is vacuous."
  exit 0
fi
echo "FAIL: $FAIL failed, $PASS passed."
exit 1
