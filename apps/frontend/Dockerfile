# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The `frontend` image: Vite builds the app in a Node stage, and nginx serves
# dist/ on 8080 and proxies /api/ and /ws to BACKEND_UPSTREAM, so the UI and
# the backend share one origin.
#
# The build context is the repository root, because the package installs from
# the workspace lockfile:
#   docker build -f apps/frontend/Dockerfile -t fdp-frontend .
# BuildKit reads the ignore list from `Dockerfile.dockerignore` next to this
# file, a symlink to `.dockerignore` in this directory, instead of the root
# one: it admits the workspace manifests, @fdp/contracts and this package, and
# never a `.env`: secrets reach the stack through the environment only.

FROM node:26.10.0-trixie-slim AS build
RUN corepack enable && corepack prepare pnpm@11.27.0 --activate
WORKDIR /repo
# Manifests before sources, so the install layer is reused until a dependency
# changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/frontend/package.json apps/frontend/
# `@fdp/frontend...` is the package and its workspace dependency
# @fdp/contracts, which is installed and built first, as in every workspace
# build. The UI imports it with `import type` only, so none of it reaches
# dist/.
RUN pnpm install --frozen-lockfile --filter "@fdp/frontend..."
COPY packages/contracts packages/contracts
COPY apps/frontend apps/frontend
RUN pnpm --filter "@fdp/contracts..." build \
 && pnpm --filter @fdp/frontend build

FROM nginx:1.31.0-alpine-slim
# The entrypoint renders /etc/nginx/templates/*.template with envsubst; the
# filter keeps it to BACKEND_* so nginx's own $uri and $http_upgrade survive.
ENV NGINX_ENVSUBST_FILTER=^BACKEND_
COPY apps/frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
ENV BACKEND_UPSTREAM=backend:3000
EXPOSE 8080
# 127.0.0.1, not localhost: the template listens on IPv4 only (IPv6 may be off
# in a container, and `listen [::]:8080` would then stop nginx from starting),
# while busybox wget resolves localhost to ::1 first and gives up on refusal.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
