# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS web-builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
# patchedDependencies (pnpm-workspace.yaml / package.json) references this file;
# pnpm install reads it to hash the patch even when the patched dep isn't in the
# filtered scope, so every builder stage needs it or install fails with ENOENT.
COPY patches ./patches
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @uniclip/web... --filter @uniclip/web
RUN pnpm --filter @uniclip/web build

FROM oven/bun:1-alpine AS relay-builder
WORKDIR /repo
# oven/bun's alpine npm doesn't ship the corepack shim, so install pnpm directly.
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
# patchedDependencies (pnpm-workspace.yaml / package.json) references this file;
# pnpm install reads it to hash the patch even when the patched dep isn't in the
# filtered scope, so every builder stage needs it or install fails with ENOENT.
COPY patches ./patches
COPY packages ./packages
COPY apps/relay ./apps/relay
RUN pnpm install --frozen-lockfile --filter @uniclip/relay... --filter @uniclip/relay
RUN cd apps/relay && bun build src/server.ts --target=bun --outfile=dist/server.js

FROM oven/bun:1-alpine AS cli-builder
WORKDIR /repo
ARG GIT_SHA=dev
RUN apk add --no-cache nodejs npm && npm install -g pnpm@9.12.0
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
# patchedDependencies (pnpm-workspace.yaml / package.json) references this file;
# pnpm install reads it to hash the patch even when the patched dep isn't in the
# filtered scope, so every builder stage needs it or install fails with ENOENT.
COPY patches ./patches
COPY packages ./packages
COPY apps/cli ./apps/cli
RUN pnpm install --frozen-lockfile --filter @uniclip/cli... --filter @uniclip/cli
ARG CLI_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
RUN cd apps/cli && CLI_TARGETS="$CLI_TARGETS" GIT_SHA="$GIT_SHA" sh scripts/build-binaries.sh

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ARG GIT_SHA=dev
ENV UNICLIP_GIT_SHA=$GIT_SHA
COPY --from=relay-builder /repo/apps/relay/dist/server.js ./server.js
COPY --from=web-builder /repo/apps/web/dist ./web
COPY --from=cli-builder /repo/apps/cli/dist/dl ./web/dl
ENV STATIC_ROOT=/app/web
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "server.js"]
