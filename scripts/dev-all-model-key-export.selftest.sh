#!/usr/bin/env bash
# THE MODEL KEYS MUST BE EXPORTED BEFORE ANY `docker compose up` IS FORKED.
#
# apps/fastapi-backend/docker-compose.yml lists the model keys under
# `environment:` as BARE NAMES. Its comment states the bare form "passes a
# variable through only when the host has one" — true of older Compose. On
# Compose v5 a bare name whose host value is unset is injected as EMPTY, and a
# value in `environment:` OVERRIDES `env_file`. So an unexported key does not
# fall through to .env; it BLANKS it.
#
# Measured 2026-09-10 on Compose v5.3.1: the running container carried
# NVIDIA_API_KEY and OPENROUTER_API_KEY with no value while LANGFUSE_* — not
# listed under `environment:`, so untouched by this — carried theirs. The
# backend reported "NO MODEL KEY VISIBLE TO THE BACKEND" and every run was
# scripted, with a valid key sitting in .env the whole time.
#
# WHY THIS IS A TEST AND NOT A COMMENT. The failure is silent and blames the
# wrong thing: `pnpm dev` prints success, the settings panel says no key, and
# the developer goes looking at their .env — where nothing is wrong. The fix is
# an export whose only job is to sit ABOVE a fork; that is exactly the shape a
# future reorder breaks without any visible symptom.
#
# EXIT CODES follow the repo convention:
#   0  the property holds
#   1  the property is violated
#   2  the question could not be asked (an anchor is gone — repair it rather
#      than believe the check)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/scripts/dev-all.sh"
PASS=0; FAIL=0
ok()  { printf '  ok   %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL+1)); }

# Real command lines only. A `#` line naming `docker compose up` is prose — the
# file explains this bug in comments, and matching those would read as the
# launch being in the right place.
line_of() { # file, extended-regex
  grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}
last_line_of() { # file, extended-regex — the LAST fork, so every one is covered
  grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | tail -1 | cut -d: -f1
}

check_file() { # file -> 0 holds / 1 violated / 2 unaskable
  local f="$1" export_line last_up
  export_line="$(line_of "$f" '^[[:space:]]*export "\$k=')"
  # `docker compose ... up -d`, excluding the `-f scripts/langfuse-local/...`
  # advice line, which is a `say` string and not a fork.
  last_up="$(last_line_of "$f" 'cd "\$ROOT/apps/[a-z-]+" && docker compose .*up -d')"
  [ -n "$export_line" ] && [ -n "$last_up" ] || return 2
  [ "$export_line" -lt "$last_up" ] && return 0
  return 1
}

printf '\n  dev-all.sh exports the model keys before forking docker compose\n\n'

check_file "$TARGET"; rc=$?
case "$rc" in
  0) ok "the model-key export precedes every compose fork" ;;
  1) bad "a compose service is started before the keys are exported — Compose v5 will inject an EMPTY key and override .env" ;;
  2) printf '  \033[33mCANNOT ASK\033[0m: an anchor is missing from dev-all.sh.\n'
     printf '  This check has lost its subject. Repair the pattern; do not delete the check.\n\n'
     exit 2 ;;
esac

# ── THE POSITIVE CONTROL ──────────────────────────────────────────────────
# Without this the file names a property it cannot fail: loosen a pattern and
# check_file returns 0 for anything. So the same function is run against a copy
# with the export moved BELOW the last fork — the pre-fix arrangement — and it
# must come back violated.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BROKEN="$TMP/dev-all-broken.sh"
python3 - "$TARGET" "$BROKEN" <<'PY'
import re, sys
src = open(sys.argv[1]).read().splitlines(keepends=True)
exp = next(i for i, l in enumerate(src) if re.match(r'^\s*export "\$k=', l))
# Move the export line to the very end, below every fork.
line = src.pop(exp)
src.append(line)
open(sys.argv[2], 'w').write(''.join(src))
PY
check_file "$BROKEN"; brc=$?
case "$brc" in
  1) ok "positive control: the pre-fix arrangement IS reported as violated" ;;
  0) bad "positive control FAILED — a script with the export below the fork passed. This check cannot fail and proves nothing." ;;
  2) bad "positive control could not be asked — the mutation broke an anchor" ;;
esac

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
