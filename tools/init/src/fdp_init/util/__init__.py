# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Helpers shared by the init steps: downloading, hashing, text normalisation.

Nothing here knows about Postgres, the manual or the catalog, so the dataset
step and the model cache can use the same downloader.
"""
