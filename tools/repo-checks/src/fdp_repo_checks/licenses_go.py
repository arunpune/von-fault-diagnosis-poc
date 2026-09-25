# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Go dependency licences, read from ``go-licenses``.

The repository has one Go module, ``services/modbus``, and its
whole dependency graph ships in the simulator and gateway images, so every
row is runtime scope. The tool is run straight from the module cache so that
it never joins ``go.mod``::

    go run github.com/google/go-licenses/v2@v2.0.1 report ./...

It writes headerless CSV on standard output, one row per module::

    github.com/eclipse/paho.golang,https://github.com/…/v0.23.0/LICENSE,EPL-2.0
    github.com/goburrow/serial,https://github.com/…/v0.1.0/LICENSE,MIT

and diagnostics on standard error. The main module is always one of the rows
and is always ``Unknown`` — the tool looks for a licence file beside the Go
package, and the repository keeps its own at the root — so it is dropped: the
subject of the audit is what the module depends on, not the repository.

``go run`` downloads the tool and the module graph, so this collector needs
the network on a cold cache; a module that declares no requirements is
skipped with a notice instead.
"""

from __future__ import annotations

import csv
import io
import re
from pathlib import Path

from fdp_repo_checks.licenses_model import Collected, CollectorError, Record, Scope, merge, run_tool

ECOSYSTEM = "go"

GO_LICENSES = "github.com/google/go-licenses/v2@v2.0.1"
"""Pinned; Apache-2.0, verified 2026-09-19."""

CSV_COLUMNS = 3
"""``module,url,licence`` — go-licenses writes no header row."""

_MODULE_LINE = re.compile(r"^module\s+(\S+)", re.MULTILINE)
_REQUIRE_LINE = re.compile(r"^\s*require[\s(]", re.MULTILINE)
_VERSION_IN_URL = re.compile(r"/blob/([^/]+)/")


def module_path(go_mod_text: str) -> str:
    """The module path a ``go.mod`` declares, or ``""``."""
    match = _MODULE_LINE.search(go_mod_text)
    return match.group(1) if match is not None else ""


def declares_requirements(go_mod_text: str) -> bool:
    """True when ``go.mod`` has at least one ``require`` directive."""
    return _REQUIRE_LINE.search(go_mod_text) is not None


def _version_from_url(url: str) -> str:
    """The module version go-licenses embedded in the licence URL."""
    match = _VERSION_IN_URL.search(url)
    return match.group(1) if match is not None else ""


def parse_report(csv_text: str, *, main_module: str) -> tuple[Record, ...]:
    """Turn a ``go-licenses report`` CSV into records.

    Raises:
        CollectorError: a row does not have the three documented columns.
    """
    records: list[Record] = []
    for row in csv.reader(io.StringIO(csv_text)):
        if not row or not row[0].strip():
            continue
        if len(row) != CSV_COLUMNS:
            raise CollectorError(
                f"go-licenses report: expected {CSV_COLUMNS} columns, found {len(row)} in {row!r}"
            )
        module, url, declared = (field.strip() for field in row)
        if main_module and (module == main_module or module.startswith(f"{main_module}/")):
            continue
        records.append(Record(ECOSYSTEM, module, _version_from_url(url), declared, Scope.RUNTIME))
    return tuple(records)


def collect(root: Path, *, module_dir: str = "services/modbus", go: str = "go") -> Collected:
    """Run go-licenses over the Go module below ``root``."""
    directory = root / module_dir
    manifest = directory / "go.mod"
    if not manifest.is_file():
        return Collected((), (f"go: {module_dir}/go.mod does not exist yet; skipped",))
    try:
        text = manifest.read_text(encoding="utf-8")
    except OSError as error:
        raise CollectorError(f"{manifest}: cannot be read ({error.strerror})") from error
    if not declares_requirements(text):
        return Collected(
            (),
            (f"go: {module_dir} declares no module requirements yet; skipped",),
        )
    output = run_tool([go, "run", GO_LICENSES, "report", "./..."], cwd=directory)
    return Collected(merge(parse_report(output, main_module=module_path(text))))
