#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Dependency licence audit (ground rule 9: permissive runtime dependencies).
# The stable name CI and the other areas call; the implementation lives in
# `fdp-checks licenses`. Every argument is passed through, e.g.
#
#     scripts/check-licenses.sh --ecosystem node
#     scripts/check-licenses.sh --report reports/licenses.md --format json

set -eu

exec uv run fdp-checks licenses "$@"
