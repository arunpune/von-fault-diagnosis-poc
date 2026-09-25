# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Number, unit and range formatting."""

from __future__ import annotations

from pathlib import Path

import pytest

from fdp_manual_build.templating import manual_context
from fdp_manual_build.units import (
    EN_DASH,
    IMPERIAL,
    convert_to_imperial,
    fmt_qty,
    format_number,
    natural_decimals,
    qty_range,
    unit_symbol,
)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (10, "10"),
        (10.0, "10"),
        (8.05, "8.05"),
        (0.5, "0.5"),
        (0.07, "0.07"),
        (0.0, "0"),
        (-8.5, "-8.5"),
        (12345.6, "12,345.6"),
        (9999.5, "9999.5"),
        (10000, "10,000"),
        (-123456, "-123,456"),
        (1e-05, "0.00001"),
    ],
)
def test_format_number_follows_the_string_rules(value: float, expected: str) -> None:
    assert format_number(value) == expected


@pytest.mark.parametrize(
    ("value", "decimals", "expected"),
    [(10, 2, "10.00"), (8.049, 2, "8.05"), (12345.6, 0, "12,346"), (0.5, 3, "0.500")],
)
def test_format_number_honours_an_explicit_decimals(
    value: float, decimals: int, expected: str
) -> None:
    assert format_number(value, decimals) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [(10, 0), (10.0, 1), (8.05, 2), (0.075, 3), (True, 0)],
)
def test_natural_decimals_reads_the_authored_literal(value: float, expected: int) -> None:
    assert natural_decimals(value) == expected


@pytest.mark.parametrize(
    ("unit", "expected"),
    [
        ("bar", "bar"),
        ("degC", "°C"),
        ("m3_per_min", "m³/min"),
        ("bar_per_min", "bar/min"),
        ("percent", "%"),
        ("per_hour", "/h"),
        ("dBA", "dB(A)"),
        ("count", ""),
        ("bool", ""),
    ],
)
def test_unit_symbol_spells_the_unit_out(unit: str, expected: str) -> None:
    assert unit_symbol(unit) == expected


def test_a_quantity_separates_value_and_unit_with_u0020() -> None:
    rendered = fmt_qty(10, "bar")
    assert rendered == "10 bar"
    assert "\u00a0" not in rendered
    assert "\u2009" not in rendered


@pytest.mark.parametrize(
    ("value", "unit", "expected"),
    [
        (10, "bar", "10 bar (145 psi)"),
        (10.0, "bar", "10 bar (145 psi)"),
        (60, "degC", "60 °C (140 °F)"),
        (-10, "degC", "-10 °C (14 °F)"),
        (8.0, "L", "8 L (2.11 US gal)"),
        (22, "kW", "22 kW (29.5 hp)"),
        (1.1, "bar_per_min", "1.1 bar/min (16.0 psi/min)"),
        (250, "mm", "250 mm (9.84 in)"),
    ],
)
def test_the_realistic_variant_adds_the_imperial_value(
    value: float, unit: str, expected: str
) -> None:
    assert fmt_qty(value, unit, units_mode="si_plus_imperial") == expected


@pytest.mark.parametrize("unit", ["A", "V", "Hz", "s", "min", "h", "percent", "rpm", "count"])
def test_an_inconvertible_unit_is_left_alone(unit: str) -> None:
    assert "(" not in fmt_qty(12, unit, units_mode="si_plus_imperial")


def test_a_rate_converts_its_numerator_only() -> None:
    assert convert_to_imperial(1.0, "bar_per_min") == "14.5 psi/min"


def test_a_temperature_rounds_to_a_whole_degree_fahrenheit() -> None:
    assert convert_to_imperial(37.5, "degC") == "100 °F"


def test_a_range_uses_an_en_dash_and_one_decimal_count() -> None:
    assert qty_range(8.0, 10.0, "bar") == f"8.0{EN_DASH}10.0 bar"
    assert qty_range(8, 10, "bar") == f"8{EN_DASH}10 bar"
    assert qty_range(0.05, 0.15, "bar_per_min") == f"0.05{EN_DASH}0.15 bar/min"


def test_a_range_converts_both_ends() -> None:
    rendered = qty_range(8.0, 10.0, "bar", units_mode="si_plus_imperial")
    assert rendered == f"8.0{EN_DASH}10.0 bar (116{EN_DASH}145 psi)"


def test_a_range_of_an_inconvertible_unit_stays_si() -> None:
    assert qty_range(99, 129, "s", units_mode="si_plus_imperial") == f"99{EN_DASH}129 s"


def test_the_two_conversion_tables_agree(repo_root: Path) -> None:
    """units.py and the manual's context.py must never disagree on a factor."""
    contract = manual_context(repo_root).IMPERIAL
    shared = sorted(set(IMPERIAL) & set(contract))
    assert shared, "the two tables share no unit at all"
    for unit in shared:
        assert IMPERIAL[unit][0] == contract[unit][0], unit
        for sample in (1.0, 7.5, 250.0):
            assert IMPERIAL[unit][1](sample) == pytest.approx(contract[unit][1](sample)), unit


def test_the_contract_table_covers_every_unit_the_pdf_converts(repo_root: Path) -> None:
    contract = manual_context(repo_root).IMPERIAL
    assert set(IMPERIAL) <= set(contract)
