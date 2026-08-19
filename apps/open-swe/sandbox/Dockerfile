# Workspace image for open-swe Docker sandboxes.
#
# DockerSandbox keeps each workspace container alive with `tail -f /dev/null`
# and runs agent tool calls via `docker exec`. This image is the recommended
# workspace base — Alpine plus the tools a coding agent needs.
#
# Build and use it:
#   docker build -t open-swe-sandbox:latest apps/open-swe/sandbox
#   SANDBOX_IMAGE=open-swe-sandbox:latest pnpm --filter open-swe dev
#
# Without SANDBOX_IMAGE set, DockerSandbox falls back to public node:22-alpine
# (node + busybox only — no git/python), which works zero-config for smoke tests.
FROM node:22-alpine

# git + python: the staples an SWE agent reaches for. bash/curl for ergonomics.
RUN apk add --no-cache git python3 py3-pip bash curl

WORKDIR /workspace

# Run tools as a non-root user — defence in depth on top of the container's
# --memory / --cpus / --pids-limit caps.
RUN addgroup -S agent \
  && adduser -S agent -G agent \
  && chown -R agent:agent /workspace
USER agent

# No foreground process of its own — DockerSandbox supplies `tail -f /dev/null`
# as the container command, so this is just a safe default.
CMD ["tail", "-f", "/dev/null"]
