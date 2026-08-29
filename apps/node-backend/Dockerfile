# The node runtime, built inside the pnpm workspace it belongs to.
#
# WHY THE ROOT MANIFESTS ARE COPIED. Unlike the two Python backends, this app is
# a workspace member: `pnpm install` resolves it against pnpm-workspace.yaml and
# the root lockfile, and running it in an isolated copy of just this directory
# would silently install a DIFFERENT dependency tree from the one CI resolved.
# The lockfile is the point of a lockfile.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /monorepo

# Manifests first, so a source-only change does not re-resolve the tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/node-backend/package.json apps/node-backend/
RUN pnpm install --filter node-backend --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/node-backend apps/node-backend
RUN pnpm --filter node-backend build

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /monorepo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/node-backend/package.json apps/node-backend/
# PRODUCTION DEPS ONLY. The dev set pulls vitest and @deepagents-nextjs/server,
# which exist for the adapter-contract test and have no business in a runtime
# image — and @deepagents-nextjs/server would need building here to install.
RUN pnpm install --filter node-backend --frozen-lockfile --prod
COPY --from=build /monorepo/apps/node-backend/dist apps/node-backend/dist

# Drop root before running the app. Without this the node process — the one
# thing here reachable from the network — owns the container: a code-execution
# bug becomes root inside it. Mirrors apps/fastapi-backend/Dockerfile.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /monorepo
USER appuser

ENV NODE_ENV=production
EXPOSE 8003
WORKDIR /monorepo/apps/node-backend
CMD ["node", "dist/index.js"]
