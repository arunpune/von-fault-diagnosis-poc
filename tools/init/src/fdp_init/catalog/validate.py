# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The catalog against the contracts schemas.

Two questions, answered separately because they have different consequences.
*Structure* — are there conditions at all, is a condition id used twice, is a
cause listed twice under one condition — is a bug in the extraction and stops
the run (exit 6). *Schema validity* of a single entry is a property of the
manual: a BYO manual with hyphenated ids still ingests, its ids are still
stored, and only the count of entries the contracts reject decides whether the
run is worth finishing.

While the id grammar is unsettled a failure on nothing but the
``pattern`` of a fault id, a condition id or an alarm code is a warning, not a
rejection. Every other schema failure counts, and more than half the entries
failing ends the run.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# jsonschema 4.26.0 ships no stubs; `referencing` does.
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from jsonschema.exceptions import ValidationError  # type: ignore[import-untyped]
from referencing import Registry, Resource

from fdp_init.catalog.model import Catalog, entries, to_catalog_document
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.model import ManualDoc

__all__ = [
    "CATALOG_ENTRY_SCHEMA",
    "CATALOG_SCHEMA",
    "COMMON_SCHEMA",
    "ID_PATTERN_FIELDS",
    "INVALID_ENTRY_SHARE",
    "SCHEMA_SUBDIR",
    "ValidationReport",
    "is_fatal",
    "load_registry",
    "validate_catalog",
]

STEP = "ingest"

SCHEMA_SUBDIR = Path("schemas") / "v1"
"""Where the schemas live inside ``CONTRACTS_DIR``."""

COMMON_SCHEMA = "common"
CATALOG_ENTRY_SCHEMA = "catalog-entry"
CATALOG_SCHEMA = "catalog"

INVALID_ENTRY_SHARE = 0.5
"""More than this share of the entries failing ends the run."""

ID_PATTERN_FIELDS = frozenset({"fault_id", "condition_id", "related_alarms", "alarms"})
"""Fields whose ``pattern`` failure is downgraded to a warning."""


@dataclass(frozen=True, slots=True)
class ValidationReport:
    """What the contracts make of one catalog.

    ``invalid_entries`` holds ``(fault_id, condition_id, message)`` so the
    report names the row a reader has to look at; ``condition_id`` is the first
    condition the entry claims, which is where the row is printed.
    """

    entry_count: int = 0
    structural_errors: list[str] = field(default_factory=list)
    invalid_entries: list[tuple[str, str, str]] = field(default_factory=list)
    id_pattern_warnings: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def invalid_share(self) -> float:
        """The share of entries the contracts rejected; ``0.0`` without any."""
        if not self.entry_count:
            return 0.0
        return len(self.invalid_entries) / self.entry_count


def is_fatal(report: ValidationReport) -> bool:
    """Whether the run must stop with exit 6."""
    return bool(report.structural_errors) or report.invalid_share > INVALID_ENTRY_SHARE


def load_registry(contracts_dir: Path) -> Registry:
    """A ``referencing`` registry over the ``schemas/v1`` directory.

    Every schema is registered under its own ``$id``, which is what resolves
    ``urn:fdp:schema:common:v1#/$defs/fault_id`` without a network lookup.

    Raises:
        InitError: exit code 2, when the directory holds no schema at all;
            without the contracts there is nothing to validate against.
    """
    directory = contracts_dir / SCHEMA_SUBDIR
    resources = []
    for path in sorted(directory.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        resources.append((str(schema["$id"]), Resource.from_contents(schema)))
    if not resources:
        raise InitError(
            ExitCode.CONFIG,
            f"no contract schema found in {directory}: set CONTRACTS_DIR to the contracts package",
            STEP,
        )
    return Registry().with_resources(resources)


def _validator(contracts_dir: Path, name: str, registry: Registry) -> Draft202012Validator:
    """A validator for one named schema, resolving refs through ``registry``."""
    path = contracts_dir / SCHEMA_SUBDIR / f"{name}.schema.json"
    if not path.is_file():
        raise InitError(ExitCode.CONFIG, f"the contract schema {path} is missing", STEP)
    return Draft202012Validator(json.loads(path.read_text(encoding="utf-8")), registry=registry)


def _field_of(error: ValidationError) -> str:
    """The property name the error sits on, ``""`` for a whole-object error."""
    for step in reversed(error.absolute_path):
        if isinstance(step, str):
            return step
    return ""


def _is_id_pattern(error: ValidationError) -> bool:
    """True for a ``pattern`` failure on an identifier field."""
    return error.validator == "pattern" and _field_of(error) in ID_PATTERN_FIELDS


def _describe(entry: dict[str, Any], error: ValidationError) -> str:
    """One line naming the entry, the path and what the schema objected to."""
    path = "/".join(str(step) for step in error.absolute_path) or "<entry>"
    return f"{entry.get('fault_id', '<no id>')}: {path}: {error.message}"


def _first_condition(entry: dict[str, Any]) -> str:
    """The condition the entry is printed under, for the report line."""
    conditions = entry.get("conditions") or []
    if conditions and isinstance(conditions[0], dict):
        return str(conditions[0].get("condition_id", ""))
    return ""


def _structural_errors(catalog: Catalog) -> list[str]:
    """The three failures that mean the extraction itself went wrong."""
    errors: list[str] = []
    if not catalog.conditions:
        errors.append("the manual yielded no condition: the fault tables were not recognised")
    seen_conditions: set[str] = set()
    for condition in catalog.conditions:
        if condition.condition_id in seen_conditions:
            errors.append(f"condition {condition.condition_id} is declared twice")
        seen_conditions.add(condition.condition_id)
        seen_causes: set[str] = set()
        for cause in condition.causes:
            if cause.fault_id in seen_causes:
                errors.append(
                    f"cause {cause.fault_id} is listed twice under condition "
                    f"{condition.condition_id}"
                )
            seen_causes.add(cause.fault_id)
    return errors


def _validate_entries(
    rows: Sequence[dict[str, Any]], validator: Draft202012Validator
) -> tuple[list[tuple[str, str, str]], list[str]]:
    """Validate every entry, splitting id-pattern failures off as warnings."""
    invalid: list[tuple[str, str, str]] = []
    warnings: list[str] = []
    for entry in rows:
        errors = sorted(validator.iter_errors(entry), key=lambda error: list(error.absolute_path))
        pattern_failures = [error for error in errors if _is_id_pattern(error)]
        warnings.extend(_describe(entry, error) for error in pattern_failures)
        blocking = [error for error in errors if not _is_id_pattern(error)]
        if blocking:
            invalid.append(
                (
                    str(entry.get("fault_id", "")),
                    _first_condition(entry),
                    _describe(entry, blocking[0]),
                )
            )
    return invalid, warnings


def _document_warnings(errors: Iterable[ValidationError]) -> list[str]:
    """Whole-document failures, as report lines."""
    return [
        f"catalog document: {'/'.join(str(step) for step in error.absolute_path) or '<document>'}"
        f": {error.message}"
        for error in errors
    ]


def validate_catalog(
    catalog: Catalog, contracts_dir: Path, doc: ManualDoc | None = None
) -> ValidationReport:
    """Validate a catalog against the contracts.

    Args:
        catalog: What the structurer produced.
        contracts_dir: ``CONTRACTS_DIR``; its ``schemas/v1`` holds the schemas.
        doc: The manual the catalog came from. With it, the whole ``catalog``
            document is validated too; without it only the entries are, and the
            report says so. The pipeline always has it.

    Returns:
        The report. :func:`is_fatal` decides whether the run may continue.

    Raises:
        InitError: exit code 2, when ``contracts_dir`` holds no schemas.
    """
    registry = load_registry(contracts_dir)
    rows = entries(catalog)
    invalid, id_warnings = _validate_entries(
        rows, _validator(contracts_dir, CATALOG_ENTRY_SCHEMA, registry)
    )
    warnings: list[str] = []
    if doc is None:
        warnings.append("the catalog document was not validated: no manual was passed")
    else:
        document = to_catalog_document(catalog, doc)
        errors = _validator(contracts_dir, CATALOG_SCHEMA, registry).iter_errors(document)
        warnings.extend(_document_warnings(errors))
    return ValidationReport(
        entry_count=len(rows),
        structural_errors=_structural_errors(catalog),
        invalid_entries=invalid,
        id_pattern_warnings=id_warnings,
        warnings=warnings,
    )
