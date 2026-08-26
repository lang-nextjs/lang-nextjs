#!/usr/bin/env bash
# Prints the extra `docker compose -f …` arguments needed to point a backend at
# a LOCALLY RUNNING Langfuse fixture — and prints NOTHING when it is not running.
#
# WHY THIS IS A SEPARATE FILE. Reported as "are we running langsmith or langfuse
# locally, how come I don't see" — with the settings panel showing Langfuse
# `not configured` while the fixture had been up, healthy, for thirty-three
# hours. The panel was telling the truth: dev-all.sh started the backend with a
# bare `docker compose up -d`, which never included the override that injects
# the keys and joins the fixture's network, so the backend had no LANGFUSE_*
# variables at all and the fixture collected nothing.
#
# The decision is DETECTION, not assumption, for the reason written in the
# override itself: tracing is opt-in, and a backend hard-coding a tracing host
# "would fail closed for every forker who does not run the fixture".
#
# It lives here rather than inline in dev-all.sh so it can be tested against a
# stubbed `docker` without starting containers — see langfuse-wiring.selftest.sh.
# A branch inside a script that boots real services is a branch nothing checks.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NETWORK="${LANGFUSE_FIXTURE_NETWORK:-langfuse-local_default}"
OVERRIDE="$ROOT/scripts/langfuse-local/backend-override.yml"

# The override file must exist. Emitting `-f` for a missing path would make
# `docker compose` fail with a confusing error about the FILE, on a machine
# whose only mistake was running the fixture.
[ -f "$OVERRIDE" ] || exit 0

docker network inspect "$NETWORK" >/dev/null 2>&1 || exit 0

printf -- '-f\n%s\n' "$OVERRIDE"
