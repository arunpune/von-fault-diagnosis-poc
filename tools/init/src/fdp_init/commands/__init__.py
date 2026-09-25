# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One module per ``fdp-init`` sub-command.

Each module exposes ``run(args: argparse.Namespace, settings: Settings) -> int``
and nothing else. :mod:`fdp_init.cli` imports the module only when its
sub-command runs, so a task can add a step without touching the CLI and a
half-built tree still gives ``--help``.
"""
