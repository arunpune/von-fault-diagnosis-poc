# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The one-shot init image. The build context is the repository root, so the
# root .dockerignore decides what reaches the daemon:
#   docker build -f tools/init/Dockerfile -t fdp-init:local .
#
# Two stages on the same pinned base. The builder resolves the uv workspace
# from its metadata alone, so the dependency layer changes only when uv.lock
# or a member's pyproject.toml does; the runtime stage carries the virtual
# environment, the migrations and the contracts, and nothing else of the
# repository.
#
# No secret reaches a layer: `.env` never enters the build context (root
# .dockerignore) and no ARG or ENV names a key. LLM_API_KEY arrives at
# run time, from the environment Compose passes explicitly.
#
# The image runs as root on purpose. init writes the MetroPT-3 download into
# the host bind mount ./data/metropt3 and its report into ./reports, and the
# owner of those directories is whatever uid the host uses (a CI runner, a
# developer's machine). It is a one-shot that exits; every long-running
# service is non-root.

FROM python:3.13.15-slim-trixie@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0 AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /src

# uv reads the whole workspace, so every member's pyproject.toml has to be
# here even though only fdp-init is installed.
COPY pyproject.toml uv.lock ./
COPY tools/init/pyproject.toml tools/init/
COPY tools/manual-build/pyproject.toml tools/manual-build/
COPY tools/repo-checks/pyproject.toml tools/repo-checks/
COPY tools/blocklist/pyproject.toml tools/blocklist/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package fdp-init --extra llm

# `--no-editable` builds the package into /opt/venv, so the runtime stage needs
# no source tree at the path this stage used. The `llm` extra makes the
# optional catalog structurer work as soon as LLM_API_KEY is set.
COPY tools/init/src tools/init/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package fdp-init --extra llm

# pypdfium2 (through pdfplumber) bundles PDFium and ships the licences of its
# build dependencies in the wheel; they become the image's third-party notices.
# A wheel without them leaves the directory empty.
RUN mkdir -p /notices/pypdfium2 \
    && licences="$(find /opt/venv -type d -name BUILD_LICENSES -path '*pypdfium2*' | head -n 1)" \
    && if [ -n "$licences" ]; then cp -R "$licences"/. /notices/pypdfium2/; fi

FROM python:3.13.15-slim-trixie@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0 AS runtime

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /notices/pypdfium2 /usr/share/doc/third-party/pypdfium2

# Baked because they version with the code. data/SHA256SUMS is not: it is read
# from its bind mount, so a hash update needs no rebuild.
COPY db/migrations /db/migrations
COPY packages/contracts/schemas /contracts/schemas
COPY packages/contracts/embedding.json /contracts/embedding.json

# The container side of the path contract (tools/init/README.md): relative
# paths such as MANUAL_PATH=data/byo-manual/x.pdf resolve against INIT_ROOT_DIR,
# and Compose mounts ./data/* under /data. INIT_REPORT_DIR keeps its relative default
# (`reports`, so /reports).
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    INIT_ROOT_DIR=/ \
    MIGRATIONS_DIR=/db/migrations \
    CONTRACTS_DIR=/contracts \
    MODEL_CACHE_DIR=/models \
    METROPT_CSV="/data/metropt3/MetroPT3(AirCompressor).csv" \
    SHA256SUMS_PATH=/data/SHA256SUMS

# The embedding model cache: the `model-cache` volume the backend mounts
# read-only. No model is baked; the first run fills it.
VOLUME ["/models"]

ENTRYPOINT ["fdp-init"]
CMD ["run"]
