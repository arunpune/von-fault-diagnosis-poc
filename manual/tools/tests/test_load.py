# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Tests for manual/tools/load.py."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from load import (
    SCHEMA_DIR,
    SPEC_FILES,
    SpecError,
    SpecLoader,
    alarm_by_code,
    cause_by_id,
    condition_by_id,
    load_spec,
    resolve_duration,
    resolve_threshold,
    setting_by_id,
    signal_by_id,
    task_by_id,
)

MutateFn = Callable[[Path, Path, str, str, Any], Path]

DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"


def _subschemas(node: Any) -> Iterator[dict[str, Any]]:
    """Yield every mapping inside a schema document, the document included.

    ``if`` / ``then`` / ``else`` branches are skipped: they select or refine an
    object the enclosing schema has already closed, so ``additionalProperties:
    false`` inside them would reject every property they do not repeat.
    """
    if isinstance(node, dict):
        yield node
        for key, value in node.items():
            if key not in ("if", "then", "else"):
                yield from _subschemas(value)
    elif isinstance(node, list):
        for value in node:
            yield from _subschemas(value)


def test_every_schema_meets_the_adr_0010_contract() -> None:
    """Draft 2020-12, urn $id, a .license sidecar and no open object anywhere."""
    paths = sorted(SCHEMA_DIR.glob("*.schema.json"))
    assert [path.name for path in paths] == [
        "alarms.schema.json",
        "build.schema.json",
        "common.schema.json",
        "faults.schema.json",
        "machine.schema.json",
        "maintenance.schema.json",
        "normal-bands.schema.json",
        "settings.schema.json",
        "signals.schema.json",
    ]
    for path in paths:
        name = path.name.removesuffix(".schema.json")
        schema = json.loads(path.read_text(encoding="utf-8"))
        assert schema["$schema"] == DRAFT_2020_12, path.name
        assert schema["$id"] == f"urn:fdp:manual:{name}:v1", path.name
        sidecar = path.with_name(path.name + ".license").read_text(encoding="utf-8")
        # REUSE-IgnoreStart - the tag below is test data, not this file's licence
        assert "SPDX-FileCopyrightText" in sidecar, path.name
        assert "SPDX-License-Identifier: Apache-2.0" in sidecar, path.name
        # REUSE-IgnoreEnd
        for node in _subschemas(schema):
            if "properties" in node and "$ref" not in node:
                assert node.get("additionalProperties") is False, (path.name, sorted(node))


def test_loads_every_document_of_the_minimal_spec(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir)
    assert spec.files_present == frozenset(SPEC_FILES)
    assert len(spec.signal_list) == 16
    assert spec.build["document"]["number"] == "CAU7-IOM-EN"
    assert spec.bands["provenance"]["range_override"] is False


def test_only_loads_the_requested_documents(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir, only={"signals"})
    assert spec.files_present == frozenset({"signals"})
    assert spec.machine is None
    assert spec.path_of("signals") == "spec/signals.yaml"


def test_absent_documents_are_simply_not_present(tmp_path: Path) -> None:
    spec = load_spec(tmp_path)
    assert spec.files_present == frozenset()
    assert spec.signal_list == []


def test_yaml_dates_become_iso_strings(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir)
    assert spec.machine["document"]["revision_date"] == "2026-01-15"
    assert spec.build["document"]["revisions"][0]["date"] == "2026-01-15"


def test_bare_off_stays_a_string(tmp_path: Path) -> None:
    """PyYAML reads YAML 1.1 booleans; SpecLoader follows the YAML 1.2 core schema."""
    source = "states:\n  off: stopped\n  on: running\nflag: true\n"
    assert yaml.safe_load(source)["states"] == {False: "stopped", True: "running"}
    parsed = yaml.load(source, Loader=SpecLoader)
    assert parsed["states"] == {"off": "stopped", "on": "running"}
    assert parsed["flag"] is True


def test_rejects_an_unknown_field(minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/bogus_field", 1)
    with pytest.raises(SpecError) as excinfo:
        load_spec(mutated)
    assert any("bogus_field" in message for message in excinfo.value.messages)
    assert any(
        message.startswith("spec/signals.yaml:/signals/0") for message in excinfo.value.messages
    )


def test_rejects_a_bad_identifier(minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/id", "Discharge Pressure")
    with pytest.raises(SpecError) as excinfo:
        load_spec(mutated)
    assert any("^[a-z][a-z0-9_]{1,39}$" in message for message in excinfo.value.messages)


def test_rejects_a_missing_required_field(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn, delete: object
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "machine", "/identity/model", delete)
    with pytest.raises(SpecError) as excinfo:
        load_spec(mutated)
    assert any("'model' is a required property" in message for message in excinfo.value.messages)


def test_rejects_malformed_yaml(minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/schema_version", 1)
    (mutated / "spec" / "signals.yaml").write_text("schema_version: [\n", encoding="utf-8")
    with pytest.raises(SpecError) as excinfo:
        load_spec(mutated)
    assert any("cannot parse" in message for message in excinfo.value.messages)


def test_lookup_helpers(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir)
    assert signal_by_id(spec, "oil_temperature")["panel_label"] == "T1"
    assert signal_by_id(spec, "nope") is None
    assert setting_by_id(spec, "cut_in_pressure")["param_no"] == "P01"
    assert alarm_by_code(spec, "W104")["bit"] == 3
    assert cause_by_id(spec, "oil_cooler_fouled")["subsystem"] == "cooling"
    assert condition_by_id(spec, "low_line_pressure")["alarms"] == []
    assert task_by_id(spec, "oil_change")["service_message"] == "M401"


def test_resolve_threshold_inline_and_by_setting(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir)
    signal = signal_by_id(spec, "oil_temperature")
    assert resolve_threshold(spec, {"value": 12.5, "unit": "bar"}, signal) == (12.5, "bar")
    assert resolve_threshold(spec, {"setting": "oil_temperature_warning"}, signal) == (75.0, "degC")
    assert resolve_threshold(spec, {"setting": "cut_out_pressure", "offset": 0.5}, None) == (
        10.5,
        "bar",
    )
    assert resolve_threshold(spec, {"setting": "nope"}, None) is None


def test_resolve_duration_inline_and_by_setting(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir)
    assert resolve_duration(spec, 300) == 300
    assert resolve_duration(spec, {"setting": "motor_start_mask_time"}) == 15
    assert resolve_duration(spec, {"setting": "nope"}) is None


def test_repository_build_yaml_validates() -> None:
    """manual/build.yaml itself parses and validates against build.schema.json."""
    manual_root = Path(__file__).resolve().parent.parent.parent
    spec = load_spec(manual_root, only={"build"})
    assert spec.files_present == frozenset({"build"})
    assert spec.build["document"]["number"] == "CAU7-IOM-EN"
    assert spec.build["source_date_epoch"] == 1768435200
    assert sorted(spec.build["variants"]) == ["clean", "realistic", "scanned"]
    assert [chapter["number"] for chapter in spec.build["chapters"]] == list(range(1, 11))


def test_unknown_only_key_is_reported(minimal_spec_dir: Path) -> None:
    with pytest.raises(SpecError) as excinfo:
        load_spec(minimal_spec_dir, only={"signals", "nope"})
    assert any("unknown spec file key" in message for message in excinfo.value.messages)
