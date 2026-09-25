# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The `typesafe-mock` service of compose.ci.yaml. The build context is the repository root, so
# every COPY path starts with packages/contracts/ or is a root manifest.
#
# Three stages so the runtime image carries neither the TypeScript toolchain nor the two SDKs
# that only the compatibility tests need:
#
#   deps     the workspace manifests and a full install for @fdp/contracts, shared by the two
#            stages below so the lockfile is resolved exactly once;
#   build    `tsc -b`, which emits dist/src and dist/mock and copies mock/schemas/*.json beside
#            the compiled server (see packages/contracts/tsconfig.json);
#   runtime  the production dependency tree (ajv, ajv-formats) plus dist.
#
# The answer policy is an environment variable, not a flag, so compose.ci.yaml can set
# MOCK_ANSWER_POLICY=best-overlap without restating the command.
ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db-migrate/package.json packages/db-migrate/package.json
COPY packages/ground-truth/package.json packages/ground-truth/package.json
RUN pnpm install --frozen-lockfile --filter @fdp/contracts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
RUN pnpm --filter @fdp/contracts run build

FROM deps AS runtime-deps
RUN pnpm install --frozen-lockfile --prod --filter @fdp/contracts

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The default; compose.ci.yaml overrides it with best-overlap.
ENV MOCK_ANSWER_POLICY=default
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
USER node
EXPOSE 8089
HEALTHCHECK --interval=5s --timeout=3s --retries=6 --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8089/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/contracts/dist/mock/cli.js", "--host", "0.0.0.0", "--port", "8089"]
