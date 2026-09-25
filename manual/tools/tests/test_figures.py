# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Rule tests for figure_checks.py and the two committed manual figures.

The committed figures are the integration point: content_checks.py and CI run
the same ``check_svg`` over them. Every rule of the checker also gets a small
inline SVG that must make it fire, so a rule cannot silently stop working.

Runs with pytest alone; no other dependency::

    uv run --no-project --with pytest==9.1.1 pytest manual/tools/tests/test_figures.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
FIGURES = TOOLS.parent / "figures"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from figure_checks import (  # noqa: E402
    builtin_component_ids,
    builtin_signal_ids,
    check_svg,
    main,
)

SPDX = (
    "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l.\n     SPDX-License-Identifier: CC-BY-4.0 -->"
)
HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100mm">'
XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"'


def write_svg(tmp_path: Path, body: str, head: str = HEAD, spdx: str = SPDX) -> Path:
    """Write a minimal SVG and return its path."""
    path = tmp_path / "figure.svg"
    path.write_text(f"{head}\n{spdx}\n{body}\n</svg>\n", encoding="utf-8")
    return path


def check(
    path: Path, required: set[str] | None = None, blocklist: list[str] | None = None
) -> list[str]:
    return check_svg(path, builtin_signal_ids(), builtin_component_ids(), required, blocklist)


# --- the committed figures -------------------------------------------------


def test_system_schematic_passes_every_rule() -> None:
    assert check(FIGURES / "system-schematic.svg", required=builtin_signal_ids()) == []


def test_control_panel_passes_every_rule() -> None:
    assert check(FIGURES / "control-panel.svg") == []


def test_schematic_shows_every_signal_of_the_register() -> None:
    text = (FIGURES / "system-schematic.svg").read_text(encoding="utf-8")
    missing = [
        signal_id for signal_id in builtin_signal_ids() if f'data-signal="{signal_id}"' not in text
    ]
    assert missing == []


def test_main_accepts_the_committed_figures(capsys: pytest.CaptureFixture[str]) -> None:
    figures = [
        str(FIGURES / "system-schematic.svg"),
        str(FIGURES / "control-panel.svg"),
    ]
    assert main(figures) == 0
    assert "no findings" in capsys.readouterr().out


def test_main_reports_and_fails_on_a_broken_figure(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = write_svg(tmp_path, '<image href="cover.png"/>')
    assert main([str(broken)]) == 1
    assert "C6 file:" in capsys.readouterr().out


# --- one failing case per rule ---------------------------------------------


def test_unreadable_file_is_reported(tmp_path: Path) -> None:
    messages = check(tmp_path / "absent.svg")
    assert len(messages) == 1
    assert "cannot be read" in messages[0]


def test_malformed_xml_is_reported(tmp_path: Path) -> None:
    path = tmp_path / "figure.svg"
    path.write_text(f"{HEAD}\n{SPDX}\n<g>\n", encoding="utf-8")
    messages = check(path)
    assert len(messages) == 1
    assert "not well-formed XML" in messages[0]


def test_root_must_be_svg(tmp_path: Path) -> None:
    path = tmp_path / "figure.svg"
    path.write_text("<drawing><g/></drawing>\n", encoding="utf-8")
    messages = check(path)
    assert any("root element is <drawing>" in message for message in messages)


def test_missing_viewbox_is_reported(tmp_path: Path) -> None:
    head = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm">'
    messages = check(write_svg(tmp_path, "<g/>", head=head))
    assert any("no viewBox" in message for message in messages)


def test_unparseable_width_is_reported(tmp_path: Path) -> None:
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="80%">'
    messages = check(write_svg(tmp_path, "<g/>", head=head))
    assert any("is not a plain length" in message for message in messages)


def test_width_over_the_text_width_is_reported(tmp_path: Path) -> None:
    head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="21cm">'
    messages = check(write_svg(tmp_path, "<g/>", head=head))
    assert any("over the printable text width" in message for message in messages)


def test_missing_spdx_comment_is_reported(tmp_path: Path) -> None:
    messages = check(write_svg(tmp_path, "<g/>", spdx="<!-- a drawing -->"))
    assert any("no SPDX comment" in message for message in messages)


def test_spdx_comment_before_the_root_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "figure.svg"
    path.write_text(f"{SPDX}\n{HEAD}\n<g/>\n</svg>\n", encoding="utf-8")
    assert check(path) == []


@pytest.mark.parametrize(
    "body",
    [
        '<image href="cover.png"/>',
        "<script>alert(1)</script>",
        "<foreignObject><p/></foreignObject>",
    ],
)
def test_forbidden_elements_are_reported(tmp_path: Path, body: str) -> None:
    messages = check(write_svg(tmp_path, body))
    assert any("contains a <" in message for message in messages)


@pytest.mark.parametrize(
    "reference",
    ["https://example.invalid/logo.svg", "http://example.invalid/logo.svg", "file:///tmp/logo.svg"],
)
def test_external_references_are_reported(tmp_path: Path, reference: str) -> None:
    body = f'<a href="{reference}"><text>Link</text></a>'
    messages = check(write_svg(tmp_path, body))
    assert any("outside the repository" in message for message in messages)


def test_external_xlink_reference_is_reported(tmp_path: Path) -> None:
    head = f'<svg xmlns="http://www.w3.org/2000/svg" {XLINK} viewBox="0 0 100 50" width="100mm">'
    body = '<use xlink:href="https://example.invalid/part.svg#a"/>'
    messages = check(write_svg(tmp_path, body, head=head))
    assert any("outside the repository" in message for message in messages)


def test_a_relative_reference_is_accepted(tmp_path: Path) -> None:
    assert check(write_svg(tmp_path, '<use href="#arrow"/>')) == []


@pytest.mark.parametrize(
    "body",
    [
        '<text font-family="Verdana, sans-serif">Airend</text>',
        '<text style="font-family: Verdana, sans-serif">Airend</text>',
        "<style>text { font-family: Verdana, sans-serif; }</style>",
    ],
)
def test_other_font_families_are_reported(tmp_path: Path, body: str) -> None:
    messages = check(write_svg(tmp_path, body))
    assert any("uses font-family" in message for message in messages)


@pytest.mark.parametrize(
    "family",
    ["IBM Plex Sans, sans-serif", "'IBM Plex Mono', monospace", "IBM Plex Sans,sans-serif"],
)
def test_the_embedded_families_are_accepted(tmp_path: Path, family: str) -> None:
    body = f'<text font-family="{family}">Airend</text>'
    assert check(write_svg(tmp_path, body)) == []


def test_unknown_data_signal_is_reported(tmp_path: Path) -> None:
    body = '<circle data-signal="oil_pressure" r="3"/>'
    messages = check(write_svg(tmp_path, body))
    assert any("not a signal id" in message for message in messages)


def test_unknown_data_component_is_reported(tmp_path: Path) -> None:
    body = '<g data-component="gearbox"><rect width="4" height="4"/></g>'
    messages = check(write_svg(tmp_path, body))
    assert any("not a component id" in message for message in messages)


def test_missing_required_signal_is_reported(tmp_path: Path) -> None:
    body = '<circle data-signal="oil_temperature" r="3"/>'
    messages = check(write_svg(tmp_path, body), required={"oil_temperature", "motor_current"})
    assert len(messages) == 1
    assert "does not show signal 'motor_current'" in messages[0]


@pytest.mark.parametrize("content", ["Set to 10 bar", "Rated 7 A", "Trips at 110 °C", "0.5 m3/min"])
def test_numbers_with_units_in_text_are_reported(tmp_path: Path, content: str) -> None:
    messages = check(write_svg(tmp_path, f"<text>{content}</text>"))
    assert any("number with unit" in message for message in messages)


def test_numbers_with_units_across_tspans_are_reported(tmp_path: Path) -> None:
    messages = check(write_svg(tmp_path, "<text>10 <tspan>bar</tspan></text>"))
    assert any("number with unit" in message for message in messages)


@pytest.mark.parametrize("content", ["Dryer tower 1", "CTRL-7 controller", "P1", "W104"])
def test_plain_labels_pass_the_number_lint(tmp_path: Path, content: str) -> None:
    assert check(write_svg(tmp_path, f"<text>{content}</text>")) == []


def test_blocked_terms_in_text_are_reported(tmp_path: Path) -> None:
    body = "<text>Northwind compressor</text>"
    messages = check(write_svg(tmp_path, body), blocklist=["northwind"])
    assert any("blocked term" in message for message in messages)


def test_without_a_blocklist_no_term_is_checked(tmp_path: Path) -> None:
    assert check(write_svg(tmp_path, "<text>Northwind compressor</text>")) == []
