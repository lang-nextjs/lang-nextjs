#!/usr/bin/env bash
#
# Start the local Langfuse fixture, generating its ENCRYPTION_KEY rather than
# carrying one in the repo.
#
# WHY GENERATED AND NOT COMMITTED.
# Langfuse requires ENCRYPTION_KEY to be exactly 64 hex characters, so it cannot
# be labelled the way the neighbouring values are ("local-only-not-a-secret-salt").
# A 64-hex literal is indistinguishable from a real key BY CONSTRUCTION — to
# gitleaks, to a reviewer skimming a diff, and to whoever copies this compose
# file somewhere less throwaway. One committed here turned secret scanning red on
# EVERY open pull request in the repo, because security.yml checks out with
# fetch-depth 0 and `gitleaks detect --source .` scans the whole object graph
# rather than the PR's diff. A secret-shaped string on any branch blocks all of
# them.
#
# Generating costs nothing HERE specifically: ENCRYPTION_KEY only encrypts data
# at rest inside a container that `langfuse:down` destroys. What makes the trace
# proof reproducible is the LANGFUSE_INIT_* project keys, which are deliberately
# low-entropy labelled strings and stay in the compose file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"

# Refuse to write a key anywhere git would track it. This is the whole point of
# the exercise, so it is a hard failure rather than a warning — and it catches
# the case where someone moves this fixture to a directory .gitignore misses.
if ! git -C "$HERE" check-ignore -q "$ENV_FILE" 2>/dev/null; then
  echo "ERROR: $ENV_FILE is NOT gitignored." >&2
  echo "       Refusing to generate a key into a file git would track." >&2
  echo "       Add it to .gitignore before running this." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  # Reused across restarts once generated: regenerating would orphan anything
  # Langfuse already encrypted with the previous key.
  printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  generated $ENV_FILE (gitignored, 64 hex chars)"
else
  echo "  reusing existing $ENV_FILE"
fi

exec docker compose --env-file "$ENV_FILE" -f "$HERE/docker-compose.yml" "${@:-up -d --wait}"
