# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Node dependency licences, read from ``pnpm licenses list``.

The workspace has one lockfile at the root, so one invocation per scope covers
every package::

    pnpm licenses list --json --prod
    pnpm licenses list --json --dev

Both answer with a licence-keyed object::

    {"MIT": [{"name": "…", "versions": ["1.2.3"], "license": "MIT", …}], …}

with one entry per package name and every installed version of it in
``versions``; a package that resolved to two majors therefore becomes two
records. When a scope holds no dependencies at all, pnpm prints the sentence
:data:`NO_LICENSES_MESSAGE` on standard output instead of JSON and still
exits 0 — which is what ``--prod`` does in this repository until the backend
lands, so it is an expected answer rather than a failure.
"""

from __future__ import annotations

import json
from pathlib import Path

from fdp_repo_checks.licenses_model import Collected, CollectorError, Record, Scope, merge, run_tool

ECOSYSTEM = "node"

NO_LICENSES_MESSAGE = "No licenses in packages found"
"""What pnpm prints instead of JSON when the scope has no dependencies."""

_SCOPE_FLAGS = ((Scope.RUNTIME, "--prod"), (Scope.DEV, "--dev"))


def parse_report(payload: str, scope: Scope) -> tuple[Record, ...]:
    """Turn one ``pnpm licenses list --json`` answer into records.

    Raises:
        CollectorError: the answer is neither the empty sentence nor the
            documented object shape.
    """
    text = payload.strip()
    if not text or text.startswith(NO_LICENSES_MESSAGE):
        return ()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise CollectorError(f"pnpm licenses list did not answer JSON ({error})") from error
    if not isinstance(data, dict):
        kind = type(data).__name__
        raise CollectorError(f"pnpm licenses list answered {kind}, expected an object")

    records: list[Record] = []
    for declared_key, entries in data.items():
        if not isinstance(entries, list):
            raise CollectorError(f"pnpm licenses list: {declared_key!r} does not hold a list")
        for entry in entries:
            records.extend(_records_for(entry, str(declared_key), scope))
    return tuple(records)


def _records_for(entry: object, declared_key: str, scope: Scope) -> list[Record]:
    """The records one ``{name, versions, license}`` entry stands for."""
    if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
        raise CollectorError(f"pnpm licenses list: {declared_key!r} holds an entry without a name")
    name = str(entry["name"])
    declared = str(entry.get("license") or declared_key)
    raw_versions = entry.get("versions")
    versions = [str(version) for version in raw_versions] if isinstance(raw_versions, list) else []
    return [Record(ECOSYSTEM, name, version, declared, scope) for version in (versions or [""])]


def collect(root: Path, *, pnpm: str = "pnpm") -> Collected:
    """Run pnpm for both scopes over the workspace at ``root``."""
    records: list[Record] = []
    notices: list[str] = []
    for scope, flag in _SCOPE_FLAGS:
        output = run_tool([pnpm, "licenses", "list", "--json", flag], cwd=root)
        found = parse_report(output, scope)
        if not found:
            notices.append(f"node: `pnpm licenses list {flag}` reports no dependencies yet")
        records.extend(found)
    return Collected(merge(records), tuple(notices))
