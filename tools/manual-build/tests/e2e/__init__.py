# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests: the whole pipeline, from YAML sources to a real artefact.

Each module carries a marker of its own — ``weasyprint`` for the ones that
render a page, ``docker`` for the ones that build the image, ``sources`` for
the ones that read the committed manual — so ``pytest -m "not weasyprint and
not docker and not sources"`` is a fast, hermetic run.

A package rather than a bare directory: the modules here share the fixture
names of ``tests/conftest.py``, and a package keeps their module names from
colliding with the unit tests when pytest imports them.
"""
