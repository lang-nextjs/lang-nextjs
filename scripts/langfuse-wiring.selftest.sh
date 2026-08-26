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

# ── and dev-all.sh must actually USE it ────────────────────────────────────
# Without this, the two cases above can both pass while the wiring is dead
# code — a helper that answers correctly and is never called.
if grep -q 'langfuse-override-args.sh' "$ROOT/scripts/dev-all.sh"; then
  ok "dev-all.sh calls the helper" "(the wiring is reachable)"
else
  bad "dev-all.sh calls the helper" "helper is dead code"
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
