# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The eleven manual acceptance checks (docs/manual.md#acceptance-checks).

:mod:`~fdp_manual_build.checks.runner` builds one
:class:`~fdp_manual_build.checks.base.CheckContext`, runs every check in the
fixed order and hands the results to
:mod:`~fdp_manual_build.checks.report`.

The source-level checks (#1, #2, #7, #8, #11) do not re-implement their rules:
``manual/tools/validate.py`` and ``manual/tools/content_checks.py`` are the
reference implementation, so the modules
here are adapters that run those tools and map their ``RULE file:pointer
message`` lines onto the report rows. Check #6 delegates in the same way to
the brand blocklist scanner through ``scripts/blocklist.sh``.

Checks #3, #4, #5, #9 and #10 read what the build produced rather than what the
sources say: coverage and table recovery of both variants through
:mod:`~fdp_manual_build.checks.pdftext`, the committed PDFs against
``data/manual/build-manifest.json`` and a fresh rebuild, and the licensing of
the manual through the REUSE tool. They are the rows that need
``make manual`` to have run; without a built PDF they fail, or say they were
skipped when ``--no-require-pdf`` allows it.
"""

from __future__ import annotations

__all__: tuple[str, ...] = ()
