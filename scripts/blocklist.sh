#!/bin/sh
# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Brand blocklist scan (ground rule 2: no real brands). The one entry point
# the manual content checks and the PDF acceptance checks call, so that there
# is never a second term list.
#
# Every argument is passed through, e.g.
#
#     scripts/blocklist.sh --pdf data/manual/cau-7-realistic.pdf
#     scripts/blocklist.sh --staged

set -eu

exec uv run fdp-blocklist scan "$@"
