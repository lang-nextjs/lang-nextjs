#!/usr/bin/env bash
# Prints a BROWSER-REACHABLE Langfuse console URL, or nothing.
#
# WHY THIS IS NOT THE SAME VALUE AS LANGFUSE_HOST. The backend traces to
# `http://langfuse:3000` — the in-network alias, which is correct for a sibling
# container and unopenable in any browser. The fixture publishes the same
# service on the host, and that is the address a person needs.
#
# The settings panel already refuses to link an unreachable address and says so.
# This supplies the reachable one, so it has something to link.
#
# DERIVED, NOT HARDCODED. `docker port` reports what is actually published, so a
# fixture started on a different port still produces a correct link — and a
# fixture that is up but publishes nothing produces none, rather than a link to
# a port nobody is listening on.
set -euo pipefail

CONTAINER="${LANGFUSE_FIXTURE_CONTAINER:-langfuse-local-langfuse-1}"

# An explicit value always wins: a real deployment has a public console that no
# amount of local inspection could discover.
if [ -n "${LANGFUSE_CONSOLE_URL:-}" ]; then
  printf '%s\n' "$LANGFUSE_CONSOLE_URL"
  exit 0
fi

mapping="$(docker port "$CONTAINER" 3000/tcp 2>/dev/null | head -1)" || exit 0
[ -n "$mapping" ] || exit 0

# `docker port` prints `127.0.0.1:3100` or `0.0.0.0:3100`. Either way the port
# is what matters; the bind address is about who may connect, not about where
# THIS machine's browser should look.
port="${mapping##*:}"
case "$port" in
  ''|*[!0-9]*) exit 0 ;;
esac

printf 'http://localhost:%s\n' "$port"
