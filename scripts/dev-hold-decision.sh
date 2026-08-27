#!/usr/bin/env bash
# Should dev-all.sh stay in the foreground, or exit and leave things running?
#
#   hold  — there are background SHELL JOBS to wait on; Ctrl-C is meaningful
#   exit  — nothing this shell owns; the script must not linger
#
# WHY THIS IS ITS OWN FILE. The decision was inline, it was wrong, and the way
# it was wrong was invisible:
#
#   if [ -z "$AGENT_PID$APP_PID$EXAMPLE_PID" ] && [ "$WE_STARTED_BACKEND" = "0" ]
#
# — exit early only when NOTHING was started. So starting only the docker
# backend (which happens whenever the app and agent are already up) fell
# through to `wait`. `wait` with no background jobs RETURNS IMMEDIATELY, the
# script exited, and the EXIT trap tore the container straight back down.
#
# Reported as: "when I run pnpm run dev, look at the ends.... it says backend
# container stopped". The script started a backend and destroyed it in the same
# breath, having just printed "Ctrl-C stops everything this script started".
#
# A DOCKER CONTAINER IS NOT A SHELL JOB. It is a detached daemon that outlives
# this process, and `wait` cannot hold it. So the decision is about background
# PIDs alone, and the backend only changes what we SAY on the way out.
#
# Usage: dev-hold-decision.sh "<pids>" "<we_started_backend>"
set -euo pipefail

pids="${1:-}"
started_backend="${2:-0}"

if [ -n "${pids//[[:space:]]/}" ]; then
  echo "hold"
  exit 0
fi

# Nothing to wait on. Which message depends on whether we left a container up.
if [ "$started_backend" = "1" ]; then
  echo "exit-backend-running"
else
  echo "exit-nothing-started"
fi
