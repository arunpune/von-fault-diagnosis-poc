# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Structural checks for the hand-drawn SVG figures of the manual.

Implements rule C6 of the manual's source rules, the figure rules.
``content_checks.py`` and the CI job call :func:`check_svg`; running this module
directly checks the committed figures with nothing but the standard library
installed::

    python manual/tools/figure_checks.py manual/figures/*.svg

Every finding is one line ``C6 file:<path> <detail>``, the format the other
manual checkers print. Brand names (rule N3) are never listed in this file:
the repository keeps them hashed behind ``scripts/blocklist.sh``, so
``blocklist`` is optional and only passed by callers that hold a plain-text
list, such as the rule tests.
"""

from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path
from typing import Any

RULE = "C6"
_DESCRIPTION = "Check the hand-drawn SVG figures of the manual (rule C6)."

#: The number lint of rule N1, copied verbatim so both rules stay in step.
NUMBER_LINT_PATTERN = r"(?<![A-Za-z0-9_/-])\d+(?:[.,]\d+)?\s?(bar|psi|°C|°F|degC|K|A|V|kW|hp|Hz|h|hours|min|s|ms|L|l|m³|m3|cfm|mm|cm|m|kg|lb|%|dB\(A\)|dBA|rpm|Nm)(?![A-Za-z])"  # noqa: E501
NUMBER_LINT = re.compile(NUMBER_LINT_PATTERN)

#: The two embedded families of the manual.
ALLOWED_FONT_FAMILIES = ("ibm plex sans, sans-serif", "ibm plex mono, monospace")
FORBIDDEN_ELEMENTS = ("image", "script", "foreignObject")
EXTERNAL_SCHEMES = ("http:", "https:", "file:")
#: Elements whose character data reaches a reader, on screen or through a reader tool.
TEXT_ELEMENTS = ("text", "title", "desc")
#: A manual page holds 170 mm of type; a wider figure cannot be placed unscaled.
MAX_WIDTH_MM = 170.0

#: Signal ids, in register order. Fallback for a tree in which
#: ``manual/spec/signals.yaml`` does not exist.
BUILTIN_SIGNAL_IDS: tuple[str, ...] = (
    "discharge_pressure",
    "line_pressure",
    "separator_discharge_pressure",
    "dryer_purge_pressure",
    "reservoir_pressure",
    "oil_temperature",
    "motor_current",
    "intake_closed",
    "load_valve",
    "dryer_tower",
    "regulator_contact",
    "low_pressure_switch",
    "purge_switch",
    "oil_level_ok",
    "flow_pulse",
    "ambient_temperature",
)

#: Component ids, in flow order. Fallback for a tree in which
#: ``manual/spec/machine.yaml`` does not exist.
BUILTIN_COMPONENT_IDS: tuple[str, ...] = (
    "intake_filter",
    "intake_valve",
    "airend",
    "motor",
    "coupling",
    "separator_vessel",
    "minimum_pressure_valve",
    "blowdown_valve",
    "oil_cooler",
    "aftercooler",
    "cooling_fan",
    "thermostatic_valve",
    "oil_filter",
    "cyclonic_separator",
    "condensate_drain",
    "dryer_tower_1",
    "dryer_tower_2",
    "changeover_valves",
    "purge_valve",
    "purge_silencer",
    "reservoirs",
    "reservoir_isolation_valve",
    "pneumatic_panel",
    "safety_valve",
    "controller",
    "oil_level_switch",
    "flow_sensor",
)

#: Only the schematic has to carry every signal; the control panel carries none.
FIGURES_REQUIRING_EVERY_SIGNAL = ("system-schematic.svg",)

_LENGTH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|pt|pc|px)?\s*$")
_MM_PER_UNIT = {
    "mm": 1.0,
    "cm": 10.0,
    "in": 25.4,
    "pt": 25.4 / 72.0,
    "pc": 25.4 / 6.0,
    "px": 25.4 / 96.0,
}
_ROOT_START_TAG = re.compile(r"<svg\b[^>]*>")
_LEADING_COMMENT = re.compile(r"\s*<!--(.*?)-->", re.DOTALL)
_ANY_COMMENT = re.compile(r"<!--(.*?)-->", re.DOTALL)
_SPDX_TAGS = ("SPDX-FileCopyrightText:", "SPDX-License-Identifier:")
_FONT_FAMILY_DECLARATION = re.compile(r"font-family\s*:\s*([^;}]+)")


def builtin_signal_ids() -> set[str]:
    """Return the signal ids."""
    return set(BUILTIN_SIGNAL_IDS)


def builtin_component_ids() -> set[str]:
    """Return the component ids."""
    return set(BUILTIN_COMPONENT_IDS)


def check_svg(
    path: Path,
    signal_ids: set[str],
    component_ids: set[str],
    required_signal_ids: set[str] | None = None,
    blocklist: list[str] | None = None,
) -> list[str]:
    """Check one SVG figure and return one message per violation.

    ``signal_ids`` and ``component_ids`` are the ids every ``data-signal`` and
    ``data-component`` attribute must be drawn from, ``required_signal_ids``
    the ids the figure must carry, and ``blocklist`` plain terms that must not
    appear in its text. An empty list means the figure passes.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        return [_message(path, f"cannot be read ({error.strerror or error})")]
    try:
        # The figures are repository-controlled sources, not untrusted input.
        root = ET.fromstring(raw)  # noqa: S314
    except ET.ParseError as error:
        return [_message(path, f"is not well-formed XML ({error})")]

    messages = _check_root(path, root)
    messages += _check_spdx(path, raw)
    messages += _check_elements(path, root)
    messages += _check_fonts(path, root)
    messages += _check_ids(path, root, signal_ids, component_ids, required_signal_ids)
    messages += _check_text(path, root, blocklist)
    return messages


def _message(path: Path, detail: str) -> str:
    return f"{RULE} file:{path.as_posix()} {detail}"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _check_root(path: Path, root: ET.Element) -> list[str]:
    """Root element, viewBox and printable width."""
    if _local_name(root.tag) != "svg":
        return [_message(path, f"root element is <{_local_name(root.tag)}>, not <svg>")]
    messages = []
    if not root.get("viewBox"):
        messages.append(_message(path, "root <svg> has no viewBox"))
    width = root.get("width")
    if width is not None:
        width_mm = _length_mm(width)
        if width_mm is None:
            messages.append(_message(path, f"root <svg> width {width!r} is not a plain length"))
        elif width_mm > MAX_WIDTH_MM:
            messages.append(
                _message(path, f"root <svg> is {width!r} wide, over the printable text width")
            )
    return messages


def _length_mm(value: str) -> float | None:
    match = _LENGTH.match(value)
    if match is None:
        return None
    return float(match.group(1)) * _MM_PER_UNIT[match.group(2) or "px"]


def _check_spdx(path: Path, raw: str) -> list[str]:
    """An SPDX comment before the root element or as its first child."""
    start_tag = _ROOT_START_TAG.search(raw)
    if start_tag is None:
        return [_message(path, "has no <svg> start tag")]
    prolog_comments = (match.group(1) for match in _ANY_COMMENT.finditer(raw[: start_tag.start()]))
    first_child = _LEADING_COMMENT.match(raw, start_tag.end())
    candidates = list(prolog_comments)
    if first_child is not None:
        candidates.append(first_child.group(1))
    if any(all(tag in comment for tag in _SPDX_TAGS) for comment in candidates):
        return []
    return [_message(path, "has no SPDX comment before the root element or as its first child")]


def _check_elements(path: Path, root: ET.Element) -> list[str]:
    """No raster images, scripts or foreign content, and no external reference."""
    messages = []
    for element in root.iter():
        name = _local_name(element.tag)
        if name in FORBIDDEN_ELEMENTS:
            messages.append(_message(path, f"contains a <{name}> element"))
        for attribute, value in element.items():
            if _local_name(attribute) != "href":
                continue
            if value.strip().lower().startswith(EXTERNAL_SCHEMES):
                messages.append(
                    _message(path, f"<{name}> references {value.strip()!r} outside the repository")
                )
    return messages


def _check_fonts(path: Path, root: ET.Element) -> list[str]:
    """Only the two families the manual embeds."""
    messages = []
    for family in _font_families(root):
        if _normalise_font_family(family) not in ALLOWED_FONT_FAMILIES:
            messages.append(_message(path, f"uses font-family {family.strip()!r}"))
    return messages


def _font_families(root: ET.Element) -> Iterator[str]:
    for element in root.iter():
        family = element.get("font-family")
        if family is not None:
            yield family
        style = element.get("style")
        if style is not None:
            yield from _FONT_FAMILY_DECLARATION.findall(style)
        if _local_name(element.tag) == "style" and element.text:
            yield from _FONT_FAMILY_DECLARATION.findall(element.text)


def _normalise_font_family(family: str) -> str:
    parts = (part.strip().strip("\"'") for part in family.split(","))
    return ", ".join(" ".join(part.split()) for part in parts).lower()


def _check_ids(
    path: Path,
    root: ET.Element,
    signal_ids: set[str],
    component_ids: set[str],
    required_signal_ids: set[str] | None,
) -> list[str]:
    """Every data-signal and data-component is a known id, and none is missing."""
    seen_signals = _attribute_values(root, "data-signal")
    seen_components = _attribute_values(root, "data-component")
    messages = [
        _message(path, f"marks data-signal={value!r}, which is not a signal id")
        for value in sorted(seen_signals - signal_ids)
    ]
    messages += [
        _message(path, f"marks data-component={value!r}, which is not a component id")
        for value in sorted(seen_components - component_ids)
    ]
    if required_signal_ids is not None:
        messages += [
            _message(path, f"does not show signal {value!r}")
            for value in sorted(required_signal_ids - seen_signals)
        ]
    return messages


def _attribute_values(root: ET.Element, attribute: str) -> set[str]:
    return {value for element in root.iter() if (value := element.get(attribute)) is not None}


def _check_text(path: Path, root: ET.Element, blocklist: list[str] | None) -> list[str]:
    """Number lint (rule N1) and, when a list is given, brand names (rule N3)."""
    messages = []
    for element in root.iter():
        name = _local_name(element.tag)
        if name not in TEXT_ELEMENTS:
            continue
        content = "".join(element.itertext())
        for hit in NUMBER_LINT.finditer(content):
            messages.append(
                _message(path, f"has the number with unit {hit.group(0)!r} in <{name}>")
            )
        for term in blocklist or []:
            if term.lower() in content.lower():
                messages.append(_message(path, f"has the blocked term {term!r} in its text"))
    return messages


def _load_ids(spec_file: Path, key: str) -> list[dict[str, Any]] | None:
    """Return the entries under ``key`` of a spec file, or None when unusable."""
    if not spec_file.is_file():
        return None
    try:
        import yaml  # type: ignore[import-untyped]  # noqa: PLC0415
    except ImportError:
        print(f"figure_checks: no PyYAML, using the built-in ids for {spec_file}", file=sys.stderr)
        return None
    document = yaml.safe_load(spec_file.read_text(encoding="utf-8"))
    entries = document if isinstance(document, list) else (document or {}).get(key)
    if not isinstance(entries, list):
        return None
    return [entry for entry in entries if isinstance(entry, dict) and "id" in entry]


def _signal_ids(spec_dir: Path) -> tuple[set[str], set[str]]:
    """Return (every signal id, the ids a schematic must show)."""
    entries = _load_ids(spec_dir / "signals.yaml", "signals")
    if entries is None:
        return builtin_signal_ids(), builtin_signal_ids()
    every = {str(entry["id"]) for entry in entries}
    shown = {str(entry["id"]) for entry in entries if entry.get("shown_in_schematic", True)}
    return every, shown


def _component_ids(spec_dir: Path) -> set[str]:
    entries = _load_ids(spec_dir / "machine.yaml", "components")
    if entries is None:
        return builtin_component_ids()
    return {str(entry["id"]) for entry in entries}


def main(argv: Sequence[str] | None = None) -> int:
    """Check every figure given on the command line; return the exit status."""
    parser = argparse.ArgumentParser(description=_DESCRIPTION)
    parser.add_argument("figures", nargs="+", type=Path, help="SVG files to check")
    parser.add_argument(
        "--spec",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "spec",
        help="directory holding signals.yaml and machine.yaml (built-in ids when absent)",
    )
    arguments = parser.parse_args(argv)

    signal_ids, required = _signal_ids(arguments.spec)
    component_ids = _component_ids(arguments.spec)
    messages: list[str] = []
    for figure in arguments.figures:
        needed = required if figure.name in FIGURES_REQUIRING_EVERY_SIGNAL else None
        messages += check_svg(figure, signal_ids, component_ids, needed)
    _report(messages, arguments.figures)
    return 1 if messages else 0


def _report(messages: Iterable[str], figures: Sequence[Path]) -> None:
    printed = False
    for message in messages:
        print(message)
        printed = True
    if not printed:
        print(f"figure_checks: {len(figures)} figure(s) checked, no findings")


if __name__ == "__main__":
    sys.exit(main())
