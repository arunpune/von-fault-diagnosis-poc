#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Stable name for the ground-truth path check
# (docs/architecture.md#ground-truth-isolation): callers reference this script,
# the implementation lives in `fdp-checks gt-paths`. Every option is passed
# straight through.
set -eu
exec uv run fdp-checks gt-paths "$@"
