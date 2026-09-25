# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Acquisition of the MetroPT-3 CSV the simulator replays.

:mod:`fdp_init.dataset.metropt` is the whole package: it decides between a
file that is already there, a hand-placed fixture and a download, and hands
back a :class:`~fdp_init.dataset.metropt.DatasetResult` the report and
``ingest_runs.stats`` carry.
"""
