# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Repository hygiene checks for the fault-diagnosis PoC.

Every check is offline, depends on the standard library only and is reachable
through the ``fdp-checks`` console script. Sub-commands live in
:mod:`fdp_repo_checks.commands` and are discovered at start-up, so a new check
is added by dropping a module in that package.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
