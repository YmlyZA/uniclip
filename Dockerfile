# syntax=docker/dockerfile:1.7
#
# Build speed notes:
# - Each stage copies only manifests (workspace yaml, lockfile, every package's
#   package.json) BEFORE `pnpm install`, then the source AFTER. So editing source
#   (the common case) reuses the cached install layer instead of reinstalling.
# - `--mount=type=cache,id=pnpm,target=/pnpm/store` gives all stages a shared,
#   persistent pnpm content-addressable store, so deps are fetched once and reused
#   across stages and across builds (survives as long as the BuildKit cache does).
# - CLI cross-compilation (the slowest step) caches unless apps/cli or packages
#   change; pass --build-arg CLI_TARGETS="" to skip it entirely for a fast relay
#   build (the served /dl binaries then stay empty until a full build).

FROM node:22-alpine AS web-builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# Manifests first (+ patches, referenced by patchedDependencies) so the install
# layer caches across source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY patches ./patches
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/room-code/package.json ./packages/room-code/
COPY packages/client-core/package.json ./packages/client-core/
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter @uniclip/web... --filter @uniclip/web
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @uniclip/web build

FROM oven/bun:1.3-alpine AS relay-builder
WORKDIR /repo
# oven/bun's alpine npm doesn't ship the corepack shim, so install pnpm directly.
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY patches ./patches
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/room-code/package.json ./packages/room-code/
COPY packages/client-core/package.json ./packages/client-core/
COPY apps/relay/package.json ./apps/relay/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter @uniclip/relay... --filter @uniclip/relay
COPY packages ./packages
COPY apps/relay ./apps/relay
RUN cd apps/relay && bun build src/server.ts --target=bun --outfile=dist/server.js

FROM oven/bun:1.3-alpine AS cli-builder
WORKDIR /repo
ARG GIT_SHA=dev
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY patches ./patches
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/room-code/package.json ./packages/room-code/
COPY packages/client-core/package.json ./packages/client-core/
COPY apps/cli/package.json ./apps/cli/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter @uniclip/cli... --filter @uniclip/cli
COPY packages ./packages
COPY apps/cli ./apps/cli
# Empty CLI_TARGETS skips the cross-compile (fast relay builds); default builds all.
ARG CLI_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
RUN cd apps/cli && CLI_TARGETS="$CLI_TARGETS" GIT_SHA="$GIT_SHA" sh scripts/build-binaries.sh

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ARG GIT_SHA=dev
ENV UNICLIP_GIT_SHA=$GIT_SHA
COPY --from=relay-builder /repo/apps/relay/dist/server.js ./server.js
COPY --from=web-builder /repo/apps/web/dist ./web
COPY --from=cli-builder /repo/apps/cli/dist/dl ./web/dl
ENV STATIC_ROOT=/app/web
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1
CMD ["bun", "run", "server.js"]
