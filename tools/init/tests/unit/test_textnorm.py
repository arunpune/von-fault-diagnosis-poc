# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Text normalisation, including the id slug."""

from __future__ import annotations

import pytest

from fdp_init.util.textnorm import dehyphenate, norm_header_cell, norm_ws, slug


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  two   words  ", "two words"),
        ("line\nbreak\tand tab", "line break and tab"),
        ("non\u00a0breaking", "non breaking"),
        ("soft\u00adhyphen", "softhyphen"),
        ("", ""),
    ],
)
def test_norm_ws(raw: str, expected: str) -> None:
    assert norm_ws(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Fault id", "fault id"),
        ("Fault-id", "fault id"),
        ("FAULT ID.", "fault id"),
        ("Possible cause", "possible cause"),
        ("Delay (s)", "delay s"),
        ("Source column / MetroPT column", "source column metropt column"),
    ],
)
def test_norm_header_cell(raw: str, expected: str) -> None:
    assert norm_header_cell(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("oil tempera-\nture high", "oil temperature high"),
        ("re-\r\nplace the element", "replace the element"),
        ("oil tempera\u2010\nture", "oil temperature"),
        ("start- and stop signals", "start- and stop signals"),
        ("cut-out reached", "cut-out reached"),
        ("load/unload regulation", "load/unload regulation"),
        ("8.2-\n3", "8.2-\n3"),
    ],
)
def test_dehyphenate(raw: str, expected: str) -> None:
    assert dehyphenate(raw) == expected


@pytest.mark.parametrize(
    ("title", "identifier"),
    [
        ("Oil temperature high", "oil_temperature_high"),
        ("Motor current high", "motor_current_high"),
    ],
)
def test_slug_reproduces_a_printed_registry_id(title: str, identifier: str) -> None:
    """Titles that already spell their id round-trip exactly.

    Most of the manual's 17 conditions do not — ``"Line pressure below setpoint"`` is
    ``low_line_pressure`` — which is why the manual prints the condition id and
    the slug is only the fallback for a BYO manual.
    """
    assert slug(title) == identifier


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Dryer purge pressure high, air escaping", "dryer_purge_pressure_high_air_escaping"),
        ("  8.2.3  Oil temperature high  ", "8_2_3_oil_temperature_high"),
        ("Réservoir déviation", "reservoir_deviation"),
        ("---", ""),
        ("Cut-out reached", "cut_out_reached"),
    ],
)
def test_slug(raw: str, expected: str) -> None:
    assert slug(raw) == expected


def test_slug_is_stable() -> None:
    assert slug(slug("Oil temperature high")) == slug("Oil temperature high")
