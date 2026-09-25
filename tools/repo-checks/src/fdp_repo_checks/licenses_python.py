# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Python dependency licences, read from the synced uv environment.

Only ``tools/init`` ships in a Compose image, so the runtime scope is exactly
what ``uv export --package fdp-init --no-dev`` resolves; every other
distribution in the workspace environment is dev. The workspace
members themselves are the repository's own code and are left out of the
audit — auditing ``fdp-init`` against the policy would only restate that the
repository is Apache-2.0.

The licence of a distribution comes from its installed metadata, in the order
PEP 639 gives:

1. ``License-Expression`` — an SPDX expression, by definition;
2. ``License`` — free text; accepted only when it is short and one line, so
   that a wheel carrying its whole licence text in that field falls through;
3. the first ``Classifier: License :: …``, mapped through
   :data:`CLASSIFIER_LICENSES`.

What is left is the empty string, which the policy judges ``unknown``. That
is the intended outcome for metadata such as pypdfium2's
``"BSD-3-Clause, Apache-2.0, dependency licenses"``: it names three things
and is not an expression, so a human resolves it once in the ``[overrides]``
table.
"""

from __future__ import annotations

import re
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

from fdp_repo_checks.licenses_model import Collected, CollectorError, Record, Scope, merge, run_tool

ECOSYSTEM = "python"

RUNTIME_PACKAGE = "fdp-init"
"""The only Python distribution that ships in a Compose image."""

MAX_LICENSE_FIELD = 80
"""Longer than this, the legacy ``License`` field holds text, not a name."""

CLASSIFIER_LICENSES = {
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: MIT No Attribution License (MIT-0)": "MIT-0",
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: BSD License": "BSD-3-Clause",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
    "License :: OSI Approved :: zlib/libpng License": "Zlib",
    "License :: OSI Approved :: The Unlicense (Unlicense)": "Unlicense",
    "License :: OSI Approved :: GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "License :: OSI Approved :: GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)": (
        "GPL-2.0-or-later"
    ),
    "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)": (
        "GPL-3.0-or-later"
    ),
    "License :: OSI Approved :: GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
    "License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "License :: OSI Approved :: GNU Lesser General Public License v2 or later (LGPLv2+)": (
        "LGPL-2.0-or-later"
    ),
    "License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)": (
        "LGPL-3.0-or-later"
    ),
    "License :: OSI Approved :: GNU Affero General Public License v3": "AGPL-3.0-only",
    "License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)": (
        "AGPL-3.0-or-later"
    ),
    "License :: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication": "CC0-1.0",
}
"""Trove classifiers mapped to the SPDX identifier they mean."""

_REQUIREMENT_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_CLASSIFIER_PREFIX = "License ::"


@dataclass(frozen=True)
class Distribution:
    """The metadata fields of one installed distribution that matter here."""

    name: str
    version: str
    license_expression: str = ""
    license_field: str = ""
    classifiers: tuple[str, ...] = ()


def canonical_name(name: str) -> str:
    """The PEP 503 normalised form, so ``pdfminer.six`` matches ``pdfminer-six``."""
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def declared_license(distribution: Distribution) -> str:
    """The licence of a distribution, or ``""`` when its metadata says none."""
    expression = distribution.license_expression.strip()
    if expression:
        return expression
    field = distribution.license_field.strip()
    if field and "\n" not in field and len(field) <= MAX_LICENSE_FIELD:
        return field
    for classifier in distribution.classifiers:
        mapped = CLASSIFIER_LICENSES.get(classifier.strip())
        if mapped is not None:
            return mapped
    for classifier in distribution.classifiers:
        if classifier.startswith(_CLASSIFIER_PREFIX):
            return classifier.rsplit("::", 1)[-1].strip()
    return ""


def requirement_names(export_text: str) -> frozenset[str]:
    """The distribution names in a ``uv export`` requirements file.

    Comments, option lines and the editable workspace members themselves all
    start with ``#`` or ``-`` and are skipped, so what is left is the
    third-party closure of the exported package.
    """
    names: set[str] = set()
    for raw in export_text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "-")):
            continue
        candidate = line.split(";", 1)[0].split("@", 1)[0].strip()
        match = _REQUIREMENT_NAME.match(candidate)
        if match is not None:
            names.add(canonical_name(match.group(0)))
    return frozenset(names)


def workspace_names(root: Path) -> frozenset[str]:
    """The uv workspace members' own distribution names.

    Read from the manifests rather than hard-coded, so a new member drops out
    of the audit without touching this module.

    Raises:
        CollectorError: the root manifest is unreadable or malformed.
    """
    manifest = root / "pyproject.toml"
    names: set[str] = set()
    for member in _workspace_members(manifest):
        member_manifest = root / member / "pyproject.toml"
        if not member_manifest.is_file():
            continue
        name = _project_name(member_manifest)
        if name:
            names.add(canonical_name(name))
    return frozenset(names)


def _read_toml(path: Path) -> dict[str, object]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except OSError as error:
        raise CollectorError(f"{path}: cannot be read ({error.strerror})") from error
    except tomllib.TOMLDecodeError as error:
        raise CollectorError(f"{path}: not valid TOML ({error})") from error


def _workspace_members(manifest: Path) -> tuple[str, ...]:
    if not manifest.is_file():
        return ()
    tool = _read_toml(manifest).get("tool")
    uv = tool.get("uv") if isinstance(tool, dict) else None
    workspace = uv.get("workspace") if isinstance(uv, dict) else None
    members = workspace.get("members") if isinstance(workspace, dict) else None
    if not isinstance(members, list):
        return ()
    return tuple(str(member) for member in members)


def _project_name(manifest: Path) -> str:
    project = _read_toml(manifest).get("project")
    name = project.get("name") if isinstance(project, dict) else None
    return str(name) if isinstance(name, str) else ""


def records_from(
    distributions: Iterable[Distribution],
    *,
    runtime: frozenset[str],
    workspace: frozenset[str],
) -> tuple[Record, ...]:
    """Classify installed distributions into runtime and dev records."""
    records = []
    for distribution in distributions:
        key = canonical_name(distribution.name)
        if key in workspace:
            continue
        scope = Scope.RUNTIME if key in runtime else Scope.DEV
        records.append(
            Record(
                ECOSYSTEM,
                distribution.name,
                distribution.version,
                declared_license(distribution),
                scope,
            )
        )
    return merge(records)


def installed_distributions() -> tuple[Distribution, ...]:
    """Every distribution in the interpreter running this check.

    Under ``uv run`` that is the synced workspace environment, which is the
    set the audit is about.
    """
    found: list[Distribution] = []
    for distribution in metadata.distributions():
        fields = distribution.metadata
        name = fields["Name"] or ""
        if not name:
            continue
        found.append(
            Distribution(
                name=name,
                version=distribution.version or "",
                license_expression=fields.get("License-Expression") or "",
                license_field=fields.get("License") or "",
                classifiers=tuple(fields.get_all("Classifier") or []),
            )
        )
    return tuple(found)


def collect(root: Path, *, uv: str = "uv") -> Collected:
    """Export the runtime closure and classify the synced environment."""
    export = run_tool(
        [
            uv,
            "export",
            "--package",
            RUNTIME_PACKAGE,
            "--no-dev",
            "--no-hashes",
            "--format",
            "requirements-txt",
        ],
        cwd=root,
    )
    runtime = requirement_names(export)
    records = records_from(
        installed_distributions(), runtime=runtime, workspace=workspace_names(root)
    )
    notices: list[str] = []
    if not runtime:
        notices.append(
            f"python: `{RUNTIME_PACKAGE}` declares no third-party dependencies yet, "
            "so every distribution in the environment is dev scope"
        )
    return Collected(records, tuple(notices))
