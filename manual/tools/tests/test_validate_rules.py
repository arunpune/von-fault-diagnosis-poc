# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""One passing and one failing case for every rule of manual/tools/validate.py."""

# Test names carry the upper-case published rule id, so pep8-naming is off in
# this module.
# ruff: noqa: N802
from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import validate
from load import load_spec
from validate import Finding, Minimums, run_rules

MutateFn = Callable[[Path, Path, str, str, Any], Path]

#: the fixture is deliberately tiny, so rule A1 runs against lowered floors
MIN = Minimums(conditions=2, causes=3, sharing=1, benign=1)


def findings(rule_id: str, spec_dir: Path, minimums: Minimums = MIN) -> list[Finding]:
    """Run one rule against the spec at ``spec_dir``."""
    return validate.RULES[rule_id].func(load_spec(spec_dir), minimums)


def rules_of(items: list[Finding]) -> set[str]:
    return {finding.rule for finding in items}


# --- the fixture is clean ------------------------------------------------


@pytest.mark.parametrize("rule_id", sorted(validate.RULES))
def test_rule_passes_on_the_minimal_spec(rule_id: str, minimal_spec_dir: Path) -> None:
    assert findings(rule_id, minimal_spec_dir) == []


def test_every_rule_of_the_plan_is_registered() -> None:
    expected = {
        "S1",
        "S2",
        "R1",
        "R2",
        "R3",
        "R4",
        "R5",
        "P1",
        "P2",
        "P3",
        "P4",
        "P5",
        "P6",
        "M1",
        "M2",
        "B1",
        "B2",
        "A1",
        "A2",
        "A3",
        "A4",
        "A5",
        "N2",
        "L1",
    }
    assert set(validate.RULES) == expected


def test_run_rules_skips_what_it_cannot_check(minimal_spec_dir: Path) -> None:
    spec = load_spec(minimal_spec_dir, only={"signals"})
    found, skipped = run_rules(spec, MIN)
    assert found == []
    assert any(line.startswith("SKIP R1 needs ") for line in skipped)
    assert not any(line.startswith("SKIP M1") for line in skipped)


# --- schemas and identifiers ---------------------------------------------


def test_S1_fires_on_a_wrong_schema_version(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/schema_version", 2)
    assert "S1" in rules_of(findings("S1", mutated))


def test_S2_fires_on_a_duplicate_panel_label(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/1/panel_label", "P1")
    assert "S2" in rules_of(findings("S2", mutated))


def test_S2_fires_when_a_cause_reuses_a_signal_id(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/causes/0/fault_id", "oil_temperature")
    assert "S2" in rules_of(findings("S2", mutated))


def test_S2_allows_a_part_named_after_its_component(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "machine", "/parts/0/id", "oil_cooler")
    assert findings("S2", mutated) == []


# --- referential integrity ------------------------------------------------


def test_R1_fires_on_an_unknown_component(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/causes/0/components/0", "nope")
    assert "R1" in rules_of(findings("R1", mutated))


def test_R2_fires_when_a_cause_is_listed_by_no_condition(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir,
        tmp_path,
        "faults",
        "/conditions/1/causes/6/fault_id",
        "downstream_air_leak",
    )
    messages = [str(item) for item in findings("R2", mutated)]
    assert any("supply_voltage_low_or_unbalanced" in message for message in messages)


def test_R3_fires_when_an_evaluable_message_is_unreachable(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn, delete: object
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/conditions/0/alarms/2", delete)
    messages = [str(item) for item in findings("R3", mutated)]
    assert any("S301" in message for message in messages)


def test_R4_fires_on_an_unused_setting(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "settings", "/settings/0/used_by", [])
    messages = [str(item) for item in findings("R4", mutated)]
    assert any("cut_in_pressure" in message for message in messages)


def test_R5_fires_when_a_task_drops_its_service_message(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "maintenance", "/tasks/0/service_message", None)
    messages = [str(item) for item in findings("R5", mutated)]
    assert any("M401" in message for message in messages)


# --- physical plausibility ------------------------------------------------


def test_P1_fires_when_a_family_is_out_of_order(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "alarms", "/alarms/0/rank", 4)
    assert "P1" in rules_of(findings("P1", mutated))


def test_P2_fires_when_a_sensor_range_drifts(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "machine", "/sensors/5/range/max", 130)
    messages = [str(item) for item in findings("P2", mutated)]
    assert any("machine.yaml sensor range" in message for message in messages)


def test_P2_fires_on_a_threshold_outside_the_signal_range(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir,
        tmp_path,
        "alarms",
        "/alarms/0/trigger/condition/threshold",
        {"value": 500, "unit": "degC"},
    )
    messages = [str(item) for item in findings("P2", mutated)]
    assert any("outside the range" in message for message in messages)


def test_P3_fires_when_a_default_leaves_its_bounds(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "settings", "/settings/0/default", 9.9)
    assert "P3" in rules_of(findings("P3", mutated))


def test_P3_fires_when_a_constraint_breaks(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir, tmp_path, "machine", "/ratings/max_working_pressure/value", 9.0
    )
    messages = [str(item) for item in findings("P3", mutated)]
    assert any("max_working_pressure" in message for message in messages)


def test_P4_fires_when_a_band_reaches_its_warning(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir, tmp_path, "signals", "/signals/5/normal_bands/loaded/high", 90
    )
    messages = [str(item) for item in findings("P4", mutated)]
    assert any("below the loaded band high" in message for message in messages)


def test_P5_fires_on_a_start_mask_without_a_running_guard(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "alarms", "/alarms/0/trigger/state", "any")
    messages = [str(item) for item in findings("P5", mutated)]
    assert any("running state guard" in message for message in messages)


def test_P6_fires_when_the_document_blocks_disagree(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "machine", "/document/revision", "1.1")
    messages = [str(item) for item in findings("P6", mutated)]
    assert any("build.yaml" in message for message in messages)


# --- MetroPT-3 mapping and derived bands ---------------------------------


def test_M1_fires_on_an_unknown_metropt_column(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/metropt_column", "TP9")
    messages = [str(item) for item in findings("M1", mutated)]
    assert any("TP9" in message for message in messages)
    assert any("TP2" in message for message in messages)


def test_M1_fires_when_an_extra_claims_a_derived_band(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/15/band/source", "derived")
    assert "M1" in rules_of(findings("M1", mutated))


def test_M2_fires_on_a_wrong_modbus_scale(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/modbus/scale", 100)
    assert "M2" in rules_of(findings("M2", mutated))


def test_M2_fires_when_the_groups_interleave(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "signals", "/signals/0/group", "digital")
    messages = [str(item) for item in findings("M2", mutated)]
    assert any("file order" in message or "analog tags" in message for message in messages)


def test_B1_fires_when_the_reference_operation_drifts(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "bands", "/cycle/loaded_run_typical", 111)
    messages = [str(item) for item in findings("B1", mutated)]
    assert any("loaded_run_typical" in message for message in messages)


def test_B1_fires_when_a_band_drifts(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir, tmp_path, "bands", "/signals/oil_temperature/loaded/typical", 57
    )
    assert "B1" in rules_of(findings("B1", mutated))


def test_B2_fires_on_wrong_provenance(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "bands", "/provenance/rows_total", 999)
    assert "B2" in rules_of(findings("B2", mutated))


def test_B2_rejects_a_range_override(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "bands", "/provenance/range_override", True)
    messages = [str(item) for item in findings("B2", mutated)]
    assert any("--range" in message for message in messages)


# --- ambiguity of the fault catalog --------------------------------------


def test_A1_fires_below_the_catalog_floors(minimal_spec_dir: Path) -> None:
    demanding = Minimums(conditions=99, causes=99, sharing=99, benign=1)
    messages = [str(item) for item in findings("A1", minimal_spec_dir, demanding)]
    assert len(messages) == 3
    assert any("conditions sharing a cause" in message for message in messages)


def test_A2_fires_on_an_uncovered_subsystem(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/causes/0/subsystem", "oil")
    messages = [str(item) for item in findings("A2", mutated)]
    assert any("cooling" in message for message in messages)


def test_A3_fires_without_a_benign_cause(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/causes/4/benign", False)
    assert "A3" in rules_of(findings("A3", mutated))


def test_A4_fires_when_the_leak_loses_a_condition(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn, delete: object
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/conditions/2/causes/0", delete)
    messages = [str(item) for item in findings("A4", mutated)]
    assert any("frequent_cycling" in message for message in messages)


def test_A5_fires_on_a_direction_from_the_wrong_vocabulary(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir, tmp_path, "faults", "/causes/0/signal_moves/0/direction", "higher"
    )
    messages = [str(item) for item in findings("A5", mutated)]
    assert any("analog signal direction" in message for message in messages)


def test_A5_fires_without_a_remedy(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(minimal_spec_dir, tmp_path, "faults", "/causes/0/remedy", "   ")
    messages = [str(item) for item in findings("A5", mutated)]
    assert any("no remedy" in message for message in messages)


def test_N2_fires_on_a_digit_in_a_summary(
    minimal_spec_dir: Path, tmp_path: Path, mutate: MutateFn
) -> None:
    mutated = mutate(
        minimal_spec_dir, tmp_path, "faults", "/causes/0/summary", "Dust covers 2 of the passages."
    )
    assert "N2" in rules_of(findings("N2", mutated))


# --- licensing ------------------------------------------------------------


def _copy(spec_dir: Path, tmp_path: Path) -> Path:
    target = tmp_path / "spec-copy"
    shutil.copytree(spec_dir, target)
    return target


def test_L1_fires_without_an_spdx_header(minimal_spec_dir: Path, tmp_path: Path) -> None:
    target = _copy(minimal_spec_dir, tmp_path)
    path = target / "spec" / "machine.yaml"
    body = [
        line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith("#")
    ]
    path.write_text("\n".join(body) + "\n", encoding="utf-8")
    messages = [str(item) for item in findings("L1", target)]
    assert any("spec/machine.yaml" in message for message in messages)


def test_L1_fires_without_a_license_sidecar(minimal_spec_dir: Path, tmp_path: Path) -> None:
    target = _copy(minimal_spec_dir, tmp_path)
    (target / "spec" / "derived" / "normal-bands.json.license").unlink()
    messages = [str(item) for item in findings("L1", target)]
    assert any("missing .license sidecar" in message for message in messages)
