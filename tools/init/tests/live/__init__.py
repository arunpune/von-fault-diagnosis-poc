# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in tests against the real Anthropic API.

Everything here is marked ``live`` and skips unless ``LLM_API_KEY`` is set.
It is run by hand, with an approved live budget; no automated run and no CI
job sets the key.
"""
