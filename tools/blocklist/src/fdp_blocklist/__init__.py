# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Brand blocklist scanner: no real brand name in the repository or the manual PDFs.

Dev-only tool. The terms it matches are never in Git in plain text: the
committed artefact is a salted SHA-256 digest per term, and the plain-text
list lives in the gitignored ``tools/blocklist/private/``.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
