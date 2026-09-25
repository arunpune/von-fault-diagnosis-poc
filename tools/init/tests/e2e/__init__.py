# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests: the init image, built and run.

Everything here is marked ``e2e`` and skips unless ``-m e2e`` selects it, so a
plain ``pytest`` run never builds an image. The one module builds
``tools/init/Dockerfile`` under a tag of its own and runs it against pgvector
and Mosquitto on a private Docker network.
"""
