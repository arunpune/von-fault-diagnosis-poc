# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Integration tests: real containers, no network beyond the image pull.

Everything here is marked ``integration`` and skipped
by a plain ``pytest`` run. The fixtures live in :mod:`conftest` and start one
PostgreSQL server per session on a host port Docker chooses, so several
worktrees can run this suite at the same time.
"""
