# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``fdp-init export-catalog`` on the mini-manual fixture.

The command is what the evaluation's headline run scores, so the two promises
tested here are the ones the harness relies on: the file is a valid contracts
``catalog`` document, and the same PDF gives the same bytes every time. It runs
through :func:`fdp_init.cli.main`, the way ``uv run fdp-init`` starts it.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

import pytest

# jsonschema 4.26.0 ships no stubs.
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from fdp_init import cli
from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import CATALOG_SCHEMA_ID, Catalog
from fdp_init.catalog.validate import load_registry
from fdp_init.commands import export_catalog
from fdp_init.errors import ExitCode
from fdp_init.manual.model import ManualDoc

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
MINI = FIXTURES / "mini-manual"
CONTRACTS = FIXTURES / "contracts"
VARIANTS = ("clean", "realistic")


@pytest.fixture(autouse=True)
def _environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Resolve every default inside ``tmp_path`` and validate against the vendored schemas."""
    monkeypatch.setenv("INIT_ROOT_DIR", str(tmp_path))
    monkeypatch.setenv("CONTRACTS_DIR", str(CONTRACTS))
    monkeypatch.setenv("LOG_FORMAT", "text")


def _export(manual: Path | None, out: Path) -> int:
    argv = ["export-catalog", "--out", str(out)]
    if manual is not None:
        argv += ["--manual", str(manual)]
    return cli.main(argv)


def _catalog_validator() -> Draft202012Validator:
    schema = json.loads(
        (CONTRACTS / "schemas" / "v1" / "catalog.schema.json").read_text(encoding="utf-8")
    )
    return Draft202012Validator(schema, registry=load_registry(CONTRACTS))


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_export_is_a_valid_catalog_document(variant: str, tmp_path: Path) -> None:
    out = tmp_path / "catalog.json"
    assert _export(MINI / f"mini-manual-{variant}.pdf", out) == int(ExitCode.OK)

    document = json.loads(out.read_text(encoding="utf-8"))
    errors = [error.message for error in _catalog_validator().iter_errors(document)]
    assert errors == []
    assert document["schema"] == CATALOG_SCHEMA_ID
    assert document["generated_from"]["file"] == f"mini-manual-{variant}.pdf"
    assert document["generated_from"]["variant"] == variant
    assert {cause["fault_id"] for cause in document["causes"]} >= {"downstream_air_leak"}


@pytest.mark.parametrize("variant", VARIANTS)
def test_two_exports_are_byte_identical(variant: str, tmp_path: Path) -> None:
    """The evaluation scores a file; the same PDF must always be the same file."""
    manual = MINI / f"mini-manual-{variant}.pdf"
    first, second = tmp_path / "first.json", tmp_path / "second.json"
    assert _export(manual, first) == int(ExitCode.OK)
    assert _export(manual, second) == int(ExitCode.OK)
    assert first.read_bytes() == second.read_bytes()


def test_the_export_has_sorted_keys_and_one_trailing_newline(tmp_path: Path) -> None:
    out = tmp_path / "catalog.json"
    assert _export(MINI / "mini-manual-clean.pdf", out) == int(ExitCode.OK)
    text = out.read_text(encoding="utf-8")
    assert text.endswith("}\n") and not text.endswith("\n\n")
    canonical = json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert text == canonical


def test_the_manual_defaults_to_manual_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MANUAL_PATH", str(MINI / "mini-manual-clean.pdf"))
    out = tmp_path / "catalog.json"
    assert _export(None, out) == int(ExitCode.OK)
    assert json.loads(out.read_text(encoding="utf-8"))["generated_from"]["variant"] == "clean"


def test_a_missing_output_directory_is_created(tmp_path: Path) -> None:
    out = tmp_path / "reports" / "eval" / "ingested-clean.json"
    assert _export(MINI / "mini-manual-clean.pdf", out) == int(ExitCode.OK)
    assert out.is_file()


def test_a_missing_manual_is_a_configuration_error(tmp_path: Path) -> None:
    out = tmp_path / "catalog.json"
    assert _export(tmp_path / "absent.pdf", out) == int(ExitCode.CONFIG)
    assert not out.exists()


def test_an_unwritable_output_is_a_configuration_error(tmp_path: Path) -> None:
    """``--out`` naming a directory cannot be written as a file."""
    assert _export(MINI / "mini-manual-clean.pdf", tmp_path) == int(ExitCode.CONFIG)


def _without_signal_moves(doc: ManualDoc) -> Catalog:
    """The fixture's catalog with every signal move dropped, as a manual that prints none."""
    catalog = build_catalog(doc)
    conditions = [
        dataclasses.replace(
            condition,
            causes=[dataclasses.replace(cause, signal_moves=[]) for cause in condition.causes],
        )
        for condition in catalog.conditions
    ]
    return dataclasses.replace(catalog, conditions=conditions)


def test_an_invalid_catalog_is_refused_and_nothing_is_written(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``catalog-entry`` needs one signal move at least; the harness would refuse the file."""
    monkeypatch.setattr(export_catalog, "build_catalog", _without_signal_moves)
    out = tmp_path / "catalog.json"
    assert _export(MINI / "mini-manual-clean.pdf", out) == int(ExitCode.MANUAL)
    assert not out.exists()
    logged = capsys.readouterr().out
    assert "not a valid contracts catalog document" in logged
    assert "downstream_air_leak: signal_moves" in logged, "the failing entry is named"
