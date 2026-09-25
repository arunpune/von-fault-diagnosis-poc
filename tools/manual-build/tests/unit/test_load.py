# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``manual/spec/*.yaml`` → ``Manual``: schema errors, duplicates, hashes."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.load import load_manual
from fdp_manual_build.model import Manual, Quantity, SettingRef

#: The signature of the ``mutate`` fixture in ``tests/conftest.py``.
MutateFn = Callable[[Path, str, str, Any], Path]

SIGNALS = "spec/signals.yaml"
FAULTS = "spec/faults.yaml"

#: Every document the loader reads out of the mini fixture.
EXPECTED_SOURCES = (
    "build.yaml",
    "spec/alarms.yaml",
    "spec/derived/normal-bands.json",
    "spec/faults.yaml",
    "spec/machine.yaml",
    "spec/maintenance.yaml",
    "spec/settings.yaml",
    "spec/signals.yaml",
)


def _load(repo_root: Path, root: Path) -> Manual:
    return load_manual(repo_root, load_build_config(repo_root, root))


def test_the_fixture_loads_with_the_expected_counts(mini_manual: Manual) -> None:
    assert len(mini_manual.signals) == 4
    assert len(mini_manual.alarms) == 4
    assert len(mini_manual.conditions) == 3
    assert len(mini_manual.causes) == 5
    assert len(mini_manual.maintenance) == 2
    assert len(mini_manual.parameters) == 2


def test_source_hashes_cover_every_document_read(mini_manual: Manual) -> None:
    assert tuple(mini_manual.source_hashes) == EXPECTED_SOURCES
    assert all(len(digest) == 64 for digest in mini_manual.source_hashes.values())


def test_the_three_metropt_columns_and_the_synthetic_extra(mini_manual: Manual) -> None:
    columns = [signal.metropt_column for signal in mini_manual.signals]
    assert columns == ["TP3", "Oil_temperature", "COMP", None]
    assert mini_manual.signal("ambient_temperature").group == "extra"
    assert mini_manual.signal("ambient_temperature").band_source == "authored"


def test_the_oil_warning_sits_below_the_oil_shutdown(mini_manual: Manual) -> None:
    warning = mini_manual.alarm("W104")
    shutdown = mini_manual.alarm("S301")
    assert warning.trigger.condition is not None
    assert shutdown.trigger.condition is not None
    warning_threshold = warning.trigger.condition.leaves[0].threshold
    shutdown_threshold = shutdown.trigger.condition.leaves[0].threshold
    assert isinstance(warning_threshold, Quantity)
    assert isinstance(shutdown_threshold, Quantity)
    assert warning_threshold == Quantity(value=85.0, unit="degC")
    assert shutdown_threshold == Quantity(value=95.0, unit="degC")
    assert warning_threshold.value < shutdown_threshold.value


def test_a_setting_reference_threshold_is_kept_symbolic(mini_manual: Manual) -> None:
    condition = mini_manual.alarm("W120").trigger.condition
    assert condition is not None
    assert condition.leaves[0].threshold == SettingRef(setting="cut_in_pressure", offset=-0.5)


def test_two_causes_are_shared_and_one_is_benign(mini_manual: Manual) -> None:
    listed = [item.fault_id for condition in mini_manual.conditions for item in condition.causes]
    shared = {fault_id for fault_id in listed if listed.count(fault_id) > 1}
    assert shared == {"high_air_demand", "downstream_air_leak"}
    benign = [cause.fault_id for cause in mini_manual.causes.values() if cause.benign]
    assert benign == ["high_air_demand"]


def test_the_cut_in_default_sits_below_the_cut_out_default(mini_manual: Manual) -> None:
    assert mini_manual.parameter("cut_in_pressure").default == 8.0
    assert mini_manual.parameter("cut_out_pressure").default == 10.0


def test_the_derived_bands_are_available(mini_manual: Manual) -> None:
    assert mini_manual.bands is not None
    assert set(mini_manual.bands["signals"]) == {
        "line_pressure",
        "oil_temperature",
        "intake_closed",
        "ambient_temperature",
    }


def test_schema_error_carries_file_and_json_pointer(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, SIGNALS, "/signals/0/unit", "furlongs")
    with pytest.raises(BuildError) as raised:
        _load(repo_root, root)
    assert [(error.file, error.json_pointer) for error in raised.value.errors] == [
        (SIGNALS, "/signals/0/unit")
    ]
    assert "does not validate" in str(raised.value)


def test_an_unknown_yaml_key_is_an_error(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, SIGNALS, "/signals/0/colour", "red")
    with pytest.raises(BuildError) as raised:
        _load(repo_root, root)
    errors = raised.value.errors
    assert [error.file for error in errors] == [SIGNALS]
    assert errors[0].json_pointer == "/signals/0"
    assert "'colour' was unexpected" in errors[0].message


def test_a_duplicate_fault_id_is_an_error(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, FAULTS, "/causes/1/fault_id", "oil_cooler_fouled")
    with pytest.raises(BuildError) as raised:
        _load(repo_root, root)
    assert [(error.file, error.json_pointer) for error in raised.value.errors] == [
        (FAULTS, "/causes/1/fault_id")
    ]
    assert "duplicate fault id 'oil_cooler_fouled'" in raised.value.errors[0].message


def test_a_duplicate_metropt_column_is_an_error(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
) -> None:
    root = mutate(tmp_path, SIGNALS, "/signals/1/metropt_column", "TP3")
    with pytest.raises(BuildError) as raised:
        _load(repo_root, root)
    assert raised.value.errors[0].json_pointer == "/signals/1/metropt_column"


def test_a_missing_document_is_an_error(
    repo_root: Path,
    tmp_path: Path,
    mutate: MutateFn,
    delete: object,
) -> None:
    root = mutate(tmp_path, SIGNALS, "/signals", delete)
    (root / SIGNALS).unlink()
    with pytest.raises(BuildError) as raised:
        _load(repo_root, root)
    assert [(error.file, error.message) for error in raised.value.errors] == [(SIGNALS, "missing")]


def test_a_second_load_of_the_same_tree_is_identical(
    repo_root: Path,
    mini_config: BuildConfig,
    mini_manual: Manual,
) -> None:
    again = load_manual(repo_root, mini_config)
    assert again == mini_manual


@pytest.mark.sources
def test_the_real_manual_spec_loads(repo_root: Path) -> None:
    """The manual's own tree, once its YAML documents are in the checkout."""
    if not (repo_root / "manual" / "spec" / "machine.yaml").is_file():
        pytest.skip("manual/spec/*.yaml is not in this checkout yet (the manual sources)")
    manual = _load(repo_root, repo_root / "manual")
    assert manual.signals
    assert manual.causes
