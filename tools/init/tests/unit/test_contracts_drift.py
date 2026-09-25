# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The vendored contract copies must stay byte-identical to their originals.

``tools/init/tests/fixtures/contracts``, ``.../conformance`` and
``.../initdb`` hold copies of files another package owns, so the init tests can
run without reaching outside ``tools/init``.
Because the contracts merged a phase earlier, the copies are byte copies and
this is a hard equality test: a change on either side fails
here instead of being discovered by a test that quietly validates against a
stale schema.

The module also proves what the copies are for: the three schemas compile as
JSON Schema 2020-12 and the two catalog-entry fixtures pass and fail as their
names say.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "tools" / "init" / "tests" / "fixtures"
VENDORED_CONTRACTS = FIXTURES / "contracts"
SCHEMA_DIR = VENDORED_CONTRACTS / "schemas" / "v1"

# vendored path (relative to tests/fixtures) -> the file it copies (from ROOT).
COPIES: dict[str, str] = {
    "contracts/embedding.json": "packages/contracts/embedding.json",
    "contracts/schemas/v1/common.schema.json": ("packages/contracts/schemas/v1/common.schema.json"),
    "contracts/schemas/v1/catalog-entry.schema.json": (
        "packages/contracts/schemas/v1/catalog-entry.schema.json"
    ),
    "contracts/schemas/v1/catalog.schema.json": (
        "packages/contracts/schemas/v1/catalog.schema.json"
    ),
    # The two catalog-entry fixtures keep a neutral name here, because the init
    # tests want "one that passes and one that fails" rather than the specific
    # entry the contracts happen to hold.
    "contracts/fixtures/catalog-entry/valid-1.json": (
        "packages/contracts/fixtures/catalog-entry/valid-downstream-air-leak.json"
    ),
    "contracts/fixtures/catalog-entry/invalid-1.json": (
        "packages/contracts/fixtures/catalog-entry/invalid-bad-subsystem.json"
    ),
    "conformance/expected.json": "db/conformance/expected.json",
    "initdb/00-roles.sh": "infra/postgres/initdb/00-roles.sh",
}

CONFORMANCE_CASES = FIXTURES / "conformance" / "cases"
REAL_CONFORMANCE_CASES = ROOT / "db" / "conformance" / "cases"


def _relative_files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


@pytest.mark.parametrize("vendored", sorted(COPIES))
def test_vendored_file_is_a_byte_copy(vendored: str) -> None:
    copy = FIXTURES / vendored
    original = ROOT / COPIES[vendored]
    assert original.is_file(), f"{COPIES[vendored]} is missing: the copy has nothing to track"
    assert copy.read_bytes() == original.read_bytes(), (
        f"{vendored} drifted from {COPIES[vendored]}: copy the original over it"
    )


def test_vendored_conformance_cases_are_byte_copies() -> None:
    assert REAL_CONFORMANCE_CASES.is_dir()
    assert _relative_files(CONFORMANCE_CASES) == _relative_files(REAL_CONFORMANCE_CASES)
    for name in _relative_files(CONFORMANCE_CASES):
        assert (CONFORMANCE_CASES / name).read_bytes() == (
            REAL_CONFORMANCE_CASES / name
        ).read_bytes(), f"conformance case {name} drifted"


def test_vendored_conformance_expectation_lists_every_case() -> None:
    expected = json.loads((FIXTURES / "conformance" / "expected.json").read_text())
    names = [case["name"] for case in expected["cases"]]
    assert names == [
        "basic",
        "rerun",
        "hash_change",
        "failing",
        "out_of_order",
        "missing_file",
        "bad_filename",
    ]
    for case in expected["cases"]:
        for step in case["steps"]:
            assert (FIXTURES / "conformance" / step["dir"]).is_dir()


def test_vendored_roles_script_creates_the_three_login_roles() -> None:
    script = (FIXTURES / "initdb" / "00-roles.sh").read_text()
    for role in ("app_rw", "gt_rw", "eval"):
        assert f"CREATE ROLE {role}" in script


def _registry() -> Registry:
    resources = []
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        schema = json.loads(path.read_text())
        resources.append((schema["$id"], Resource.from_contents(schema)))
    return Registry().with_resources(resources)


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())


def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(_schema(name), registry=_registry())


@pytest.mark.parametrize("name", ["common", "catalog-entry", "catalog"])
def test_vendored_schema_compiles(name: str) -> None:
    schema = _schema(name)
    assert schema["$id"] == f"urn:fdp:schema:{name}:v1"
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(schema)


def _entry(name: str) -> dict:
    return json.loads(
        (VENDORED_CONTRACTS / "fixtures" / "catalog-entry" / f"{name}.json").read_text()
    )


def test_valid_catalog_entry_fixture_passes() -> None:
    _validator("catalog-entry").validate(_entry("valid-1"))


def test_invalid_catalog_entry_fixture_fails() -> None:
    errors: Iterator[object] = _validator("catalog-entry").iter_errors(_entry("invalid-1"))
    assert next(iter(errors), None) is not None, "the invalid fixture validated"
