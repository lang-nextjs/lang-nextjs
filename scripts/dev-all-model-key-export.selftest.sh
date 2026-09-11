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
PASS=0; FAIL=0; REASON=""
ok()  { printf '  ok   %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL %s\n' "$*"; FAIL=$((FAIL+1)); }

# Real command lines only. A `#` line naming `docker compose up` is prose — the
# file explains this bug in comments, and matching those would read as the
# launch being in the right place.
line_of() { # file, extended-regex
  grep -nE "$2" "$1" | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1
}

# `docker compose ... up -d`, excluding the `-f scripts/langfuse-local/...`
# advice line, which is a `say` string and not a fork.
FORK='cd "\$ROOT/apps/[a-z-]+" && docker compose .*up -d'

check_file() { # file -> 0 holds / 1 violated / 2 unaskable; the reason is left in REASON
  local f="$1" export_line first_up
  # THE FIRST FORK, NOT THE LAST (#1181). The keys must precede EVERY fork, and preceding
  # the first is the only position that implies it. This once compared against the last
  # fork under a comment claiming that covered every one: an export moved between
  # fastapi's fork and django's passed, and fastapi is the backend this proof exists for.
  first_up="$(line_of "$f" "$FORK")"
  # The fork is this check's ANCHOR. With no fork there is no position to be above, so the
  # question cannot be asked.
  [ -n "$first_up" ] || { REASON="no compose fork line matched"; return 2; }
  export_line="$(line_of "$f" '^[[:space:]]*export "\$k=')"
  # The export is this check's SUBJECT, so its absence is the violation itself, not a lost
  # anchor. Reporting it as CANNOT ASK told the reader to repair the check, on exactly the
  # tree -- no export at all -- that this proof was written to catch.
  [ -n "$export_line" ] || { REASON="no model-key export found in dev-all.sh"; return 1; }
  [ "$export_line" -lt "$first_up" ] && return 0
  REASON="the export (line $export_line) comes after the first compose fork (line $first_up)"
  return 1
}

printf '\n  dev-all.sh exports the model keys before forking docker compose\n\n'

check_file "$TARGET"; rc=$?
case "$rc" in
  0) ok "the model-key export precedes every compose fork" ;;
  1) bad "$REASON — Compose v5 injects an EMPTY key into any service started before it, overriding .env" ;;
  2) printf '  \033[33mCANNOT ASK\033[0m: an anchor is missing from dev-all.sh (%s).\n' "$REASON"
     printf '  This check has lost its subject. Repair the pattern; do not delete the check.\n\n'
     exit 2 ;;
esac

# ── THE CONTROLS ─────────────────────────────────────────────────────────────
# Without these the file names a property it cannot fail: loosen a pattern and
# check_file returns 0 for anything. Each runs the same function against a copy of
# dev-all.sh altered one way, and each copy must come back with a SPECIFIC answer.
#
#   after-first-fork  the export moved to just before the SECOND fork -- below
#                     fastapi's, above the rest. The one position that tells a
#                     first-fork comparison from a last-fork one. An end-of-file
#                     control cannot, because both comparisons catch it.
#   no-export         the export removed: dev-all.sh as it was before this proof.
#   no-fork           every fork removed: the anchor gone, so CANNOT ASK is right.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mutant() { # mode -> the path of an altered copy of TARGET, or nothing if it cannot be built
  local out="$TMP/dev-all-$1.sh"
  python3 - "$TARGET" "$out" "$1" <<'PY' || return 0
import re, sys
src = open(sys.argv[1]).read().splitlines(keepends=True)
mode = sys.argv[3]
fork = re.compile(r'cd "\$ROOT/apps/[a-z-]+" && docker compose .*up -d')
is_fork = lambda l: bool(fork.search(l)) and not l.lstrip().startswith("#")
exps = [i for i, l in enumerate(src) if re.match(r'^\s*export "\$k=', l)]
if mode == "no-fork":
    src = [l for l in src if not is_fork(l)]
elif mode == "no-export":
    src = [l for i, l in enumerate(src) if i not in exps]
else:
    if not exps:
        sys.exit(3)
    line = src.pop(exps[0])
    fk = [i for i, l in enumerate(src) if is_fork(l)]
    if len(fk) < 2:
        sys.exit(3)
    src.insert(fk[1], line)
open(sys.argv[2], "w").write("".join(src))
PY
  printf '%s' "$out"
}
expect_rc() { # wanted-rc, label, file
  [ -n "$3" ] || { bad "$2 — the altered copy could not be built from this dev-all.sh"; return; }
  check_file "$3"; local got=$?
  if [ "$got" = "$1" ]; then ok "$2"; else bad "$2 — got $got, wanted $1 ($REASON)"; fi
}
expect_rc 1 "control: an export below the FIRST fork, above the rest, is reported as violated" "$(mutant after-first-fork)"
expect_rc 1 "control: NO export at all, the pre-fix arrangement, is violated and not CANNOT ASK" "$(mutant no-export)"
expect_rc 2 "control: with every fork gone the anchor is lost, and it refuses rather than passing" "$(mutant no-fork)"

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
