# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Sub-commands of ``fdp-checks``, discovered at start-up.

A module in this package becomes a sub-command by exposing four names:

``NAME``
    the sub-command as it is typed, e.g. ``gt-paths``;
``HELP``
    the one-line description ``fdp-checks --help`` prints;
``register(parser)``
    adds the sub-command's own options;
``run(args) -> int``
    performs the check and returns 0 (clean), 1 (findings) or 2 (error).

``cli.py`` never names a module, so a new check such as ``commits.py`` or
``licenses.py`` adds a file and nothing else.
"""
