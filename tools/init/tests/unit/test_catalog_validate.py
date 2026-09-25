# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The catalog against the contracts schemas.

Three things are proved here. The fixture catalog validates with no invalid
entry, so the deterministic path really does produce what the contracts
describe. The contracts' own fixtures pass and fail as their names say, which is
what makes the first statement mean anything. And the two exceptions behave:
a structural failure stops the run, while an id the grammar does not recognise
is a warning, because the id grammar is still open and a manual
somebody else brings along must still ingest.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import Catalog, Cause, Condition, SignalMove
from fdp_init.catalog.validate import (
    CATALOG_ENTRY_SCHEMA,
    CATALOG_SCHEMA,
    ValidationReport,
    is_fatal,
    load_registry,
    validate_catalog,
)
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ManualDoc

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
VENDORED_CONTRACTS = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"
SHARED_CONTRACTS = ROOT / "packages" / "contracts"
VARIANTS = ("clean", "realistic")


def contracts_dir() -> Path:
    """The contracts package when it is present, the vendored byte copies otherwise."""
    if (SHARED_CONTRACTS / "schemas" / "v1" / "catalog.schema.json").is_file():
        return SHARED_CONTRACTS
    return VENDORED_CONTRACTS


def _shared_fixtures(name: str) -> list[Path]:
    directory = SHARED_CONTRACTS / "fixtures" / name
    return sorted(directory.glob("*.json")) if directory.is_dir() else []


@pytest.fixture(scope="module")
def documents() -> dict[str, ManualDoc]:
    return {
        variant: extract_manual(FIXTURES / f"mini-manual-{variant}.pdf") for variant in VARIANTS
    }


@pytest.fixture(scope="module")
def catalogs(documents: dict[str, ManualDoc]) -> dict[str, Catalog]:
    return {variant: build_catalog(doc) for variant, doc in documents.items()}


def _validator(name: str) -> Draft202012Validator:
    directory = contracts_dir()
    schema = json.loads(
        (directory / "schemas" / "v1" / f"{name}.schema.json").read_text(encoding="utf-8")
    )
    return Draft202012Validator(schema, registry=load_registry(directory))


def _sample(catalog: Catalog) -> tuple[Condition, Cause]:
    condition = catalog.conditions[0]
    return condition, condition.causes[0]


def _one_cause_catalog(condition: Condition, cause: Cause) -> Catalog:
    """A catalog holding exactly one condition and one cause, for a probe."""
    return Catalog(conditions=[replace(condition, causes=[cause])])


# --------------------------------------------------------------------------
# The fixture catalog
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_fixture_catalog_validates(
    variant: str, catalogs: dict[str, Catalog], documents: dict[str, ManualDoc]
) -> None:
    """No structural error, no invalid entry, no id warning, no document error."""
    report = validate_catalog(catalogs[variant], contracts_dir(), documents[variant])
    assert report.structural_errors == []
    assert report.invalid_entries == []
    assert report.id_pattern_warnings == []
    assert report.warnings == []
    assert report.entry_count == 7
    assert not is_fatal(report)


def test_without_a_manual_the_document_is_not_validated(catalogs: dict[str, Catalog]) -> None:
    """The optional manual is what the whole-document check needs."""
    report = validate_catalog(catalogs["clean"], contracts_dir())
    assert report.invalid_entries == []
    assert any("not validated" in warning for warning in report.warnings)


def test_a_contracts_dir_without_schemas_is_a_configuration_error(tmp_path: Path) -> None:
    """Exit 2 before anything is validated, not a confusing schema error."""
    with pytest.raises(InitError) as raised:
        load_registry(tmp_path)
    assert raised.value.exit_code == ExitCode.CONFIG
    assert "CONTRACTS_DIR" in raised.value.message


# --------------------------------------------------------------------------
# The contracts' shared fixtures
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", [CATALOG_ENTRY_SCHEMA, CATALOG_SCHEMA])
def test_shared_fixtures_behave_as_labelled(name: str) -> None:
    """Every ``valid-*`` passes and every ``invalid-*`` fails, as its name says."""
    fixtures = _shared_fixtures(name)
    if not fixtures:
        pytest.skip(f"packages/contracts/fixtures/{name} is not present")
    validator = _validator(name)
    for path in fixtures:
        document = json.loads(path.read_text(encoding="utf-8"))
        errors = list(validator.iter_errors(document))
        if path.name.startswith("valid-"):
            assert errors == [], f"{path.name} should validate: {errors[:1]}"
        else:
            assert errors, f"{path.name} should not validate"


def test_the_registry_resolves_the_common_schema() -> None:
    """``urn:fdp:schema:common:v1`` comes off the local directory, not the net."""
    registry = load_registry(contracts_dir())
    resolved = registry.get("urn:fdp:schema:common:v1")
    assert resolved is not None
    assert "fault_id" in resolved.contents["$defs"]


# --------------------------------------------------------------------------
# The two exceptions
# --------------------------------------------------------------------------


def test_a_direction_outside_the_vocabulary_is_an_invalid_entry(
    catalogs: dict[str, Catalog],
) -> None:
    """A move the contracts do not know counts against the run."""
    condition, cause = _sample(catalogs["clean"])
    broken = replace(cause, signal_moves=[SignalMove(signal_id="line_pressure", direction="up")])
    report = validate_catalog(_one_cause_catalog(condition, broken), contracts_dir())
    assert report.id_pattern_warnings == []
    assert len(report.invalid_entries) == 1
    fault_id, condition_id, message = report.invalid_entries[0]
    assert fault_id == cause.fault_id
    assert condition_id == condition.condition_id
    assert "direction" in message


def test_a_hyphenated_id_is_a_warning_not_a_rejection(catalogs: dict[str, Catalog]) -> None:
    """The id grammar is still open, so the entry is stored anyway."""
    condition, cause = _sample(catalogs["clean"])
    renamed = replace(cause, fault_id="downstream-air-leak")
    report = validate_catalog(_one_cause_catalog(condition, renamed), contracts_dir())
    assert report.invalid_entries == []
    assert len(report.id_pattern_warnings) == 1
    assert "downstream-air-leak" in report.id_pattern_warnings[0]
    assert not is_fatal(report)


def test_an_unknown_alarm_code_is_a_warning_too(catalogs: dict[str, Catalog]) -> None:
    """The same downgrade applies to an alarm code of another grammar."""
    condition, cause = _sample(catalogs["clean"])
    renamed = replace(cause, alarm_codes=["W-101"])
    report = validate_catalog(_one_cause_catalog(condition, renamed), contracts_dir())
    assert report.invalid_entries == []
    assert report.id_pattern_warnings


# --------------------------------------------------------------------------
# Structural failures and the fatal threshold
# --------------------------------------------------------------------------


def test_a_catalog_without_conditions_is_structurally_broken() -> None:
    """Nothing was recognised as a fault table; that stops the run."""
    report = validate_catalog(Catalog(), contracts_dir())
    assert report.structural_errors
    assert is_fatal(report)


def test_a_duplicate_condition_is_structurally_broken(catalogs: dict[str, Catalog]) -> None:
    """Two conditions with one id would break ``UNIQUE (condition_id)``."""
    condition = catalogs["clean"].conditions[0]
    report = validate_catalog(Catalog(conditions=[condition, condition]), contracts_dir())
    assert any("declared twice" in error for error in report.structural_errors)
    assert is_fatal(report)


def test_a_duplicate_cause_under_one_condition_is_structurally_broken(
    catalogs: dict[str, Catalog],
) -> None:
    """``UNIQUE (condition_pk, fault_id)`` is checked before the insert."""
    condition, cause = _sample(catalogs["clean"])
    report = validate_catalog(
        Catalog(conditions=[replace(condition, causes=[cause, cause])]), contracts_dir()
    )
    assert any("listed twice" in error for error in report.structural_errors)
    assert is_fatal(report)


@pytest.mark.parametrize(
    ("entry_count", "invalid", "fatal"),
    [(10, 5, False), (10, 6, True), (2, 1, False), (0, 0, False)],
)
def test_more_than_half_the_entries_invalid_ends_the_run(
    entry_count: int, invalid: int, fatal: bool
) -> None:
    """The 50 % threshold, at and just past the boundary."""
    report = ValidationReport(
        entry_count=entry_count,
        invalid_entries=[("f", "c", "broken")] * invalid,
    )
    assert is_fatal(report) is fatal
