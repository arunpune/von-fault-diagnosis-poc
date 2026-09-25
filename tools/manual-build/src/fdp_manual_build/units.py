# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Number, unit and range formatting.

Two formatters exist in this repository and they answer different questions.

``manual/tools/context.py::Filters.num`` is the **authoring contract**: it is
what the manual's prose and the generated tables print, and it keeps the
decimals the source literal carries (``10.0 bar``). This module is the
**reference formatter**: it strips trailing zeros (``10``), groups thousands
and rounds an imperial conversion to three significant figures with
:data:`decimal.ROUND_HALF_UP`. The manual acceptance checks build their
expected strings with :func:`format_number`, so coverage never fails on
formatting, and :func:`qty_range` renders the ranges the manual's namespace has
no call for.

The two SI→imperial tables must agree on every unit they share;
``tests/unit/test_units.py`` compares them value by value so a factor cannot
drift.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from decimal import ROUND_HALF_UP, Decimal
from typing import Final, Literal

__all__ = [
    "CELSIUS",
    "EN_DASH",
    "IMPERIAL",
    "SIGNIFICANT_FIGURES",
    "UNITLESS",
    "UNIT_SYMBOLS",
    "UnitsMode",
    "convert_to_imperial",
    "fmt_qty",
    "format_number",
    "natural_decimals",
    "qty_range",
    "unit_symbol",
]

#: ``units:`` knob of ``build.yaml``.
UnitsMode = Literal["si", "si_plus_imperial"]

#: U+2013, the dash a range is written with.
EN_DASH: Final = "\u2013"
#: Imperial values carry three significant figures.
SIGNIFICANT_FIGURES: Final = 3
#: Absolute value from which the integer part is grouped with commas.
THOUSANDS_FROM: Final = 10_000
#: The spec unit whose conversion rounds to whole degrees instead.
CELSIUS: Final = "degC"

#: Spec unit → printed symbol, for the units that are spelled differently.
UNIT_SYMBOLS: Final[Mapping[str, str]] = {
    "degC": "°C",
    "m3_per_min": "m³/min",
    "per_hour": "/h",
    "bar_per_min": "bar/min",
    "percent": "%",
    "dBA": "dB(A)",
}

#: Units that print without a symbol at all.
UNITLESS: Final[frozenset[str]] = frozenset({"count", "bool"})

#: SI → (imperial symbol, conversion). A rate converts its numerator
#: only, which is why ``bar_per_min`` carries the ``bar`` factor.
IMPERIAL: Final[Mapping[str, tuple[str, Callable[[float], float]]]] = {
    "bar": ("psi", lambda value: value * 14.5038),
    "bar_per_min": ("psi/min", lambda value: value * 14.5038),
    "degC": ("°F", lambda value: value * 9.0 / 5.0 + 32.0),
    "L": ("US gal", lambda value: value * 0.264172),
    "kW": ("hp", lambda value: value * 1.34102),
    "kg": ("lb", lambda value: value * 2.20462),
    "m": ("ft", lambda value: value * 3.28084),
    "m3_per_min": ("cfm", lambda value: value * 35.3147),
    "mm": ("in", lambda value: value / 25.4),
}


def unit_symbol(unit: str) -> str:
    """Return the printed symbol of a spec unit, ``""`` for a unitless one."""
    if unit in UNITLESS:
        return ""
    return UNIT_SYMBOLS.get(unit, unit)


def natural_decimals(value: float) -> int:
    """The decimals the authored literal carries (``10.0`` → 1, ``10`` → 0)."""
    if isinstance(value, bool | int):
        return 0
    text = repr(float(value))
    if "e" in text or "E" in text:
        exponent = Decimal(text).as_tuple().exponent
        return -exponent if isinstance(exponent, int) and exponent < 0 else 0
    _, _, fraction = text.partition(".")
    return len(fraction)


def format_number(value: float, decimals: int | None = None) -> str:
    """Format ``value`` with the reference string rules.

    Integers print as they are; floats print in fixed notation with trailing
    zeros stripped (``10.0`` → ``"10"``, ``8.05`` → ``"8.05"``); an absolute
    value of 10,000 or more groups its integer part with commas. ``decimals``
    forces exactly that many decimal places and keeps their zeros.
    """
    if decimals is not None:
        return _group(f"{float(value):.{decimals}f}")
    if isinstance(value, int) and not isinstance(value, bool):
        return _group(str(value))
    text = repr(float(value))
    if "e" in text or "E" in text:
        text = f"{Decimal(text):f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return _group(text or "0")


def convert_to_imperial(value: float, unit: str) -> str | None:
    """Return ``"145 psi"`` for a convertible unit, ``None`` for the rest.

    Three significant figures, never finer than whole units, rounded half up;
    a temperature goes to the nearest whole degree Fahrenheit.
    """
    entry = IMPERIAL.get(unit)
    if entry is None:
        return None
    symbol, convert = entry
    converted = convert(float(value))
    decimals = 0 if unit == CELSIUS else _decimals_for(converted, SIGNIFICANT_FIGURES)
    return f"{_quantize(converted, decimals)} {symbol}"


def fmt_qty(
    value: float,
    unit: str,
    decimals: int | None = None,
    units_mode: UnitsMode = "si",
) -> str:
    """Format one quantity: ``"10 bar"``, or ``"10 bar (145 psi)"`` in imperial.

    The separator before the unit is U+0020; no thin or non-breaking space is
    used anywhere, because the acceptance checks compare extracted PDF text.
    """
    rendered = f"{format_number(value, decimals)} {unit_symbol(unit)}".strip()
    if units_mode != "si_plus_imperial":
        return rendered
    imperial = convert_to_imperial(value, unit)
    return rendered if imperial is None else f"{rendered} ({imperial})"


def qty_range(
    low: float,
    high: float,
    unit: str,
    decimals: int | None = None,
    units_mode: UnitsMode = "si",
) -> str:
    """Format an inclusive range: the two ends joined by :data:`EN_DASH`.

    ``qty_range(8.0, 10.0, "bar", units_mode="si_plus_imperial")`` gives the
    printed band, with the dash between the SI ends and again between the
    imperial ones. Both ends print with the same number of decimals, the wider
    of the two authored literals, so a band reads as one quantity, not two.
    """
    places = (
        decimals if decimals is not None else max(natural_decimals(low), natural_decimals(high))
    )
    span = f"{format_number(low, places)}{EN_DASH}{format_number(high, places)}"
    rendered = f"{span} {unit_symbol(unit)}".strip()
    if units_mode != "si_plus_imperial":
        return rendered
    entry = IMPERIAL.get(unit)
    low_imperial = convert_to_imperial(low, unit)
    high_imperial = convert_to_imperial(high, unit)
    if entry is None or low_imperial is None or high_imperial is None:
        return rendered
    symbol = entry[0]
    low_number = low_imperial.removesuffix(f" {symbol}")
    high_number = high_imperial.removesuffix(f" {symbol}")
    return f"{rendered} ({low_number}{EN_DASH}{high_number} {symbol})"


def _group(text: str) -> str:
    """Group the integer part of ``text`` with commas from 10,000 upwards."""
    sign = "-" if text.startswith("-") else ""
    whole, dot, fraction = text.lstrip("-").partition(".")
    if int(whole or "0") < THOUSANDS_FROM:
        return text
    return f"{sign}{int(whole):,}{dot}{fraction}"


def _decimals_for(value: float, digits: int) -> int:
    """Decimal places that give ``digits`` significant figures, at least zero."""
    if value == 0.0:
        return max(digits - 1, 0)
    return max(digits - 1 - math.floor(math.log10(abs(value))), 0)


def _quantize(value: float, decimals: int) -> str:
    """Round ``value`` half up to ``decimals`` places and print it in full."""
    quantum = Decimal(1).scaleb(-decimals)
    return f"{Decimal(repr(float(value))).quantize(quantum, rounding=ROUND_HALF_UP):f}"
