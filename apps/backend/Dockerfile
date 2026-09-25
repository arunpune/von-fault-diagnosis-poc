# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The backend image (apps/backend/README.md, "The image").
#
# Build context is the repository root, because the package resolves
# @fdp/contracts through the workspace. Debian, not Alpine: onnxruntime-node
# ships prebuilt binaries for glibc only.
#
# Nothing of `data/`, `.env` or a key reaches a layer: the root .dockerignore
# excludes them from the context, and `pnpm deploy` copies only what the
# package declares in `files`.

FROM node:24.21.0-trixie-slim AS build
RUN corepack enable && corepack prepare pnpm@11.27.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
# A development dependency of the test helpers, and `pnpm install` refuses a
# workspace link it cannot see. `pnpm deploy --prod` leaves it behind, so it
# reaches no layer of the runtime stage.
COPY packages/db-migrate ./packages/db-migrate
COPY apps/backend ./apps/backend
# `@fdp/backend...` is the package and its workspace dependencies, so the
# contracts package is installed and built before the backend compiles against
# its `dist/`: the built entry point resolves the `default` condition, not the
# `@fdp/source` one the tests use.
RUN pnpm install --frozen-lockfile --filter "@fdp/backend..." \
 && pnpm --filter "@fdp/backend..." build \
 && pnpm --filter @fdp/backend deploy --prod --legacy /out

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
