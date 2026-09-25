# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Extraction quality against the reference catalog.

Everything here is marked ``quality``: it reads the committed CAU-7 manuals and
the reference catalog, which nothing under ``src/`` may do (ground-truth
isolation). Run it with ``make test-init-quality``; a checkout without those
files skips it.
"""
