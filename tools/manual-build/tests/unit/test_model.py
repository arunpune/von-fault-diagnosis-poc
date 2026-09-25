# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The data model is frozen, looked up by id and free of rendered HTML."""

from __future__ import annotations

import dataclasses
from dataclasses import fields

import pytest

from fdp_manual_build.model import (
    Alarm,
    Cause,
    Component,
    Condition,
    ConditionCause,
    MaintenanceTask,
    Manual,
    Parameter,
    Part,
    Signal,
    SignalMove,
)

#: Every dataclass that carries a ``*_md`` / ``*_html`` pair.
TEXT_CARRIERS = (
    Signal,
    Alarm,
    SignalMove,
    Cause,
    ConditionCause,
    Condition,
    MaintenanceTask,
    Parameter,
    Component,
    Part,
)


def _html_fields(instance: object) -> list[str]:
    return [field.name for field in fields(instance) if field.name.endswith("_html")]  # type: ignore[arg-type]


def test_every_html_field_has_a_markdown_twin() -> None:
    for cls in TEXT_CARRIERS:
        names = {field.name for field in fields(cls)}
        html = {name for name in names if name.endswith("_html")}
        assert html, f"{cls.__name__} carries no rendered field"
        for name in html:
            assert f"{name.removesuffix('_html')}_md" in names


def test_the_loader_leaves_every_html_field_empty(mini_manual: Manual) -> None:
    carriers: list[object] = [
        *mini_manual.signals,
        *mini_manual.alarms,
        *mini_manual.conditions,
        *mini_manual.causes.values(),
        *mini_manual.maintenance,
        *mini_manual.parameters,
        *mini_manual.machine.components,
        *mini_manual.machine.parts,
    ]
    for cause in mini_manual.causes.values():
        carriers.extend(cause.signal_moves)
    for condition in mini_manual.conditions:
        carriers.extend(condition.causes)
    for item in carriers:
        for name in _html_fields(item):
            assert getattr(item, name) is None, f"{type(item).__name__}.{name}"


def test_lookups_find_every_kind_of_entry(mini_manual: Manual) -> None:
    assert mini_manual.signal("line_pressure").panel_label == "P2"
    assert mini_manual.alarm("M401").type == "service"
    assert mini_manual.condition("frequent_cycling").alarms == ()
    assert mini_manual.cause("high_air_demand").benign is True
    assert mini_manual.task("oil_change").service_message == "M401"
    assert mini_manual.parameter("cut_out_pressure").param_no == "P02"


@pytest.mark.parametrize(
    ("method", "argument"),
    [
        ("signal", "no_such_tag"),
        ("alarm", "W999"),
        ("condition", "no_such_condition"),
        ("cause", "no_such_cause"),
        ("task", "no_such_task"),
        ("parameter", "no_such_parameter"),
    ],
)
def test_an_unknown_id_raises(mini_manual: Manual, method: str, argument: str) -> None:
    with pytest.raises(KeyError, match=argument):
        getattr(mini_manual, method)(argument)


def test_the_model_is_frozen(mini_manual: Manual) -> None:
    signal = mini_manual.signals[0]
    with pytest.raises(dataclasses.FrozenInstanceError):
        signal.unit = "psi"  # type: ignore[misc]


def test_mappings_inside_the_model_are_read_only(mini_manual: Manual) -> None:
    with pytest.raises(TypeError):
        mini_manual.signals[0].normal_bands["loaded"] = None  # type: ignore[index]
    with pytest.raises(TypeError):
        mini_manual.machine.ratings["mass"] = None  # type: ignore[index]


def test_lists_keep_source_order(mini_manual: Manual) -> None:
    assert [signal.id for signal in mini_manual.signals] == [
        "line_pressure",
        "oil_temperature",
        "intake_closed",
        "ambient_temperature",
    ]
    assert [alarm.code for alarm in mini_manual.alarms] == ["W104", "S301", "W120", "M401"]
    assert list(mini_manual.causes) == [
        "oil_cooler_fouled",
        "oil_filter_clogged",
        "high_air_demand",
        "downstream_air_leak",
        "intake_filter_clogged",
    ]
