# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The image the committed manual PDFs are built in, so they are reproducible.
# WeasyPrint's line breaking depends on the Pango and HarfBuzz versions, which
# differ between macOS and Linux, so the reference build is this image and
# `make manual-native` is iteration only. Everything that could move between
# two builds is pinned: the base image by digest, uv by tag, the Python
# dependencies by `uv.lock`, and the five system libraries are written into
# /etc/fdp-system-packages.txt so the build manifest can record them.
#
# The build context is the repository root:
#   docker build -f tools/manual-build/Dockerfile -t fdp-manual-build:local .
# BuildKit reads the ignore list from `Dockerfile.dockerignore` next to this
# file, which is a symlink to `.dockerignore` in the same directory.
FROM python:3.13.15-slim-trixie@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0

COPY --from=ghcr.io/astral-sh/uv:0.12.17 /uv /uvx /bin/

ENV DEBIAN_FRONTEND=noninteractive \
    UV_NO_CACHE=1 \
    UV_FROZEN=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONDONTWRITEBYTECODE=1

# Trixie 13.7 ships Pango 1.56.3-1, HarfBuzz 10.2.0-1+deb13u1 and fontconfig
# 2.15.0-2.3; `dpkg-query` records whatever the archive actually installed, so
# a security rebuild that moves a version is visible in the manifest.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz0b \
        libharfbuzz-subset0 \
        fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg-query -W -f='${Package}=${Version}\n' \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libharfbuzz-subset0 fontconfig \
        > /etc/fdp-system-packages.txt

WORKDIR /work

# Two stages: the dependency layer only changes when a lock file or a member's
# metadata changes, so editing the package's sources rebuilds one cheap layer.
# Every workspace member's pyproject.toml has to be here for uv to resolve the
# workspace, even though only fdp-manual-build is installed.
COPY pyproject.toml uv.lock ./
COPY tools/manual-build/pyproject.toml tools/manual-build/
COPY tools/init/pyproject.toml tools/init/
COPY tools/repo-checks/pyproject.toml tools/repo-checks/
COPY tools/blocklist/pyproject.toml tools/blocklist/
RUN uv sync --frozen --package fdp-manual-build --no-dev --no-install-workspace

COPY tools/manual-build/src tools/manual-build/src
RUN uv sync --frozen --package fdp-manual-build --no-dev

# FDP_BUILD_* is what manifest.py records under `built_in` and `image`.
ENV PATH="/opt/venv/bin:$PATH" \
    FONTCONFIG_FILE=/etc/fonts/fonts.conf \
    SOURCE_DATE_EPOCH=1767225600 \
    FDP_BUILD_IN_CONTAINER=1 \
    FDP_BUILD_IMAGE_REF=python:3.13.15-slim-trixie \
    FDP_BUILD_IMAGE_DIGEST=sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0

ENTRYPOINT ["fdp-manual-build"]
