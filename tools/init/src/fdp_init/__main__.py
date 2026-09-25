# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``python -m fdp_init`` — the same entry point as the ``fdp-init`` script."""

from __future__ import annotations

import sys

from fdp_init.cli import main

if __name__ == "__main__":
    sys.exit(main())
