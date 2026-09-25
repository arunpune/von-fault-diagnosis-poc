# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Jinja namespace, outline numbering and Markdown conversion for the manual.

Implements the content contract of the manual: the Jinja namespace and its
filters, the outline numbering and cross-reference labels, and the variants
and fact placement. It is the single authoring contract for the manual:
``manual/tools/content_checks.py``, ``manual/tools/preview.py`` and the PDF
build in ``tools/manual-build`` all go through it, the last by adding
``manual/tools`` to ``sys.path`` or by vendoring this file unchanged.

The module is pure: it reads no files, writes none and knows nothing about
PDFs. Everything it needs arrives as a :class:`load.Spec` plus the raw
Markdown of the partials::

    spec = load_spec(Path("manual"))
    partials = {2: Path("manual/content/02-description.md").read_text()}
    outline = build_outline(spec, partials)
    env = make_env(spec, "realistic", outline)
    html_body = md_to_html(render_partial(env, 2, partials[2]), footnotes=True)

Three points are decided here and documented in the functions below: the
wording table behind :func:`move_text`, the exact shape of a cross-reference
label per anchor kind, and the Jinja comment delimiters. Jinja's default
``{# … #}`` comment would swallow the ``{#sec:overview}`` heading anchors, so
:func:`make_env` moves comments to ``{## … ##}`` and the anchor syntax stays
literal text.
"""

from __future__ import annotations

import html
import math
import re
import sys
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import jinja2
from markdown_it import MarkdownIt
from mdit_py_plugins.attrs import attrs_plugin
from mdit_py_plugins.footnote import footnote_plugin

if __package__ in (None, ""):  # imported from a script or a sys.path shim
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from load import (
    Spec,
    alarm_by_code,
    cause_by_id,
    condition_by_id,
    resolve_duration,
    resolve_threshold,
    setting_by_id,
    signal_by_id,
    task_by_id,
)

__all__ = [
    "COMMENT_END",
    "COMMENT_START",
    "FIGURE_CHAPTER",
    "GENERATED_HEADING_MACROS",
    "HEADING_PATTERN",
    "MACRO_PATTERN",
    "TABLE_MACROS",
    "ContextError",
    "Heading",
    "ManualEnvironment",
    "Outline",
    "Reference",
    "build_context",
    "build_outline",
    "make_env",
    "md_to_html",
    "render_partial",
    "render_text",
    "unit_label",
    "variant_knobs",
]


class ContextError(Exception):
    """A template asked for something the spec or the outline does not hold."""


# --- fixed contract tables ------------------------

#: The ten generated tables, in chapter order.
TABLE_MACROS: tuple[str, ...] = (
    "alarms",
    "settings",
    "maintenance_schedule",
    "maintenance_procedures",
    "troubleshooting",
    "technical_data",
    "signals",
    "normal_bands",
    "parts",
    "revision_history",
)

#: Macros that contribute headings to the outline.
GENERATED_HEADING_MACROS: tuple[str, ...] = ("maintenance_procedures", "troubleshooting")

#: The two figures and the chapter each belongs to.
FIGURE_CHAPTER: Mapping[str, int] = {"system-schematic": 2, "control-panel": 3}

#: The two scanning regexes.
HEADING_PATTERN = re.compile(r"^(#{2,3})\s+(.+?)\s+\{#([a-z0-9:_-]+)\}\s*$")
MACRO_PATTERN = re.compile(r"\{\{\s*tables\.(\w+)\(\)\s*\}\}")

#: Jinja comment delimiters; the defaults collide with ``{#anchor}`` (see the
#: module docstring), so the manual uses these instead.
COMMENT_START = "{##"
COMMENT_END = "##}"

#: Units that render differently from their spec spelling.
UNIT_LABELS: Mapping[str, str] = {
    "degC": "°C",
    "m3_per_min": "m³/min",
    "per_hour": "/h",
    "bar_per_min": "bar/min",
    "percent": "%",
    "dBA": "dB(A)",
}

#: Units that carry no symbol at all.
UNITLESS: frozenset[str] = frozenset({"count", "bool"})

#: SI -> imperial conversions, used by the realistic variant. A rate converts
#: its numerator only, which is why ``bar_per_min`` carries the ``bar`` factor
#: and keeps ``/min``.
IMPERIAL: Mapping[str, tuple[str, Callable[[float], float]]] = {
    "bar": ("psi", lambda value: value * 14.5038),
    "bar_per_min": ("psi/min", lambda value: value * 14.5038),
    "degC": ("°F", lambda value: value * 9.0 / 5.0 + 32.0),
    "L": ("US gal", lambda value: value * 0.264172),
    "kg": ("lb", lambda value: value * 2.20462),
    "mm": ("in", lambda value: value / 25.4),
    "m": ("ft", lambda value: value * 3.28084),
    "m3_per_min": ("cfm", lambda value: value * 35.3147),
    "kW": ("hp", lambda value: value * 1.34102),
}

#: Wording table behind :func:`move_text`. The words are those of the
#: signal-move vocabulary and the model sentence is "Oil temperature (T1) rises
#: gradually in every state."; these three maps are the smallest table that
#: reproduces it for every enum value of ``common.schema.json``.
ANALOG_VERBS: Mapping[str, str] = {
    "rises": "rises",
    "falls": "falls",
    "high": "is high",
    "low": "is low",
    "unchanged": "is unchanged",
    "fluctuates": "fluctuates",
    "near_zero": "is near zero",
    "not_venting": "does not vent",
}
DIGITAL_VERBS: Mapping[str, str] = {
    "on": "is on",
    "off": "is off",
    "stays_on": "stays on",
    "stays_off": "stays off",
    "toggles": "toggles",
    "no_pulse": "gives no pulse",
}
BEHAVIOUR_VERBS: Mapping[str, str] = {
    "higher": "is higher",
    "lower": "is lower",
    "longer": "is longer",
    "shorter": "is shorter",
    "faster": "is faster",
    "slower": "is slower",
    "not_reached": "is not reached",
    "unchanged": "is unchanged",
}
ONSET_ADVERBS: Mapping[str, str] = {
    "sudden": "suddenly",
    "gradual": "gradually",
    "intermittent": "intermittently",
    "sustained": "persistently",
}
PHASE_CLAUSES: Mapping[str, str] = {
    "loaded": "while loaded",
    "unloaded": "while unloaded",
    "off": "while the unit is off",
    "any": "in every state",
    "start": "at start",
}

#: Section anchors whose number a registry cross-reference points at.
HOST_SECTION: Mapping[str, str] = {
    "alarm": "sec:message-list",
    "setting": "sec:settings-table",
    "signal": "sec:signal-list",
    "part": "sec:parts",
}


# --- numbers --------------------------------------------------------------


def _natural_decimals(value: float) -> int:
    """Return the decimals the authored literal carries (``10.0`` -> 1)."""
    if isinstance(value, bool | int):
        return 0
    text = repr(float(value))
    if "e" in text or "E" in text:
        return 0
    _, _, fraction = text.partition(".")
    return len(fraction)


def _significant_digits(text: str) -> int:
    """Count the significant digits of an already formatted decimal string."""
    digits = text.replace("-", "").replace(".", "").lstrip("0")
    return len(digits) or 1


def _round_significant(value: float, digits: int) -> str:
    """Format ``value`` with ``digits`` significant digits, at least 0 decimals."""
    if value == 0.0:
        return f"{0.0:.{max(digits - 1, 0)}f}"
    exponent = math.floor(math.log10(abs(value)))
    decimals = max(digits - 1 - exponent, 0)
    return f"{value:.{decimals}f}"


def unit_label(unit: str) -> str:
    """Return the printed symbol of a spec unit."""
    if unit in UNITLESS:
        return ""
    return UNIT_LABELS.get(unit, unit)


def _lower_first(text: str) -> str:
    """Lower-case the first letter unless the first word is an acronym or code."""
    if not text:
        return text
    first = text.split(" ", 1)[0]
    if first.isupper() or any(character.isdigit() for character in first):
        return text
    return text[0].lower() + text[1:]


def _upper_first(text: str) -> str:
    return text[0].upper() + text[1:] if text else text


def _with_onset(verb: str, onset: str) -> str:
    """Place the onset adverb inside the verb phrase, so the sentence reads.

    A copula takes the adverb between "is" and the adjective ("is persistently
    high"); an action verb takes it behind ("rises gradually", as in the
    example sentence).
    """
    adverb = ONSET_ADVERBS.get(onset)
    if adverb is None:
        return verb
    if verb.startswith("is "):
        return f"is {adverb} {verb[3:]}"
    return f"{verb} {adverb}"


# --- variants -------------------------------------------------------------


def variant_knobs(build: Mapping[str, Any], name: str) -> dict[str, Any]:
    """Resolve one ``build.yaml`` variant, following ``extends``."""
    variants = build.get("variants") or {}
    chain: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    current: str | None = name
    while current is not None:
        if current not in variants:
            raise ContextError(f"build.yaml has no variant {current!r}")
        if current in seen:
            raise ContextError(f"variant {name!r} extends itself")
        seen.add(current)
        knobs = variants[current]
        chain.append(knobs)
        parent = knobs.get("extends")
        current = str(parent) if parent is not None else None
    resolved: dict[str, Any] = {}
    for knobs in reversed(chain):
        resolved.update({key: value for key, value in knobs.items() if key != "extends"})
    resolved["name"] = name
    return resolved


# --- outline --------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Heading:
    """One numbered heading of the manual, authored or generated by a macro."""

    chapter: int
    level: int
    number: str
    title: str
    anchor: str
    generated: bool = False


@dataclass(frozen=True, slots=True)
class Reference:
    """The parts a cross-reference label is built from."""

    anchor: str
    kind: str
    number: str
    title: str
    lead: str = ""
    parenthesised: bool = False

    @property
    def element_id(self) -> str:
        """The HTML id of the target: the anchor with ``:`` replaced by ``-``."""
        return self.anchor.replace(":", "-")

    def label(self, *, explicit: bool) -> str:
        """The visible label; ``explicit`` spells the word "section" out."""
        word = "chapter" if self.kind == "chapter" else "section"
        if not self.lead:
            return f"{word} {self.number}" if explicit or word == "chapter" else self.number
        if self.parenthesised:
            inner = f"{word} {self.number}" if explicit else self.number
            return f"{self.lead} ({inner})"
        return f"{self.lead} {self.number}"

    @property
    def footnote(self) -> str:
        """The footnote definition text of the ``short_with_footnotes`` style."""
        word = "Chapter" if self.kind == "chapter" else "Section"
        return f"{word} {self.number}, {self.title}"


class Outline:
    """Chapter and section numbering plus cross-reference labels.

    Built by :func:`build_outline` from the raw Markdown of the partials, so
    the preview and the PDF build derive identical numbers from identical
    sources.
    """

    def __init__(
        self,
        headings: Sequence[Heading],
        references: Mapping[str, Reference],
        chapter_titles: Mapping[int, str],
    ) -> None:
        self.headings: tuple[Heading, ...] = tuple(headings)
        self._references = dict(references)
        self.chapter_titles: Mapping[int, str] = dict(chapter_titles)
        self.by_anchor: Mapping[str, Heading] = {
            heading.anchor: heading for heading in self.headings
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Outline({len(self.headings)} headings, {len(self._references)} anchors)"

    def has(self, anchor: str) -> bool:
        """True when ``anchor`` resolves to a numbered target."""
        return anchor in self._references

    def reference(self, anchor: str) -> Reference:
        """Return the :class:`Reference` of ``anchor``."""
        try:
            return self._references[anchor]
        except KeyError:
            raise ContextError(f"unknown cross-reference anchor {anchor!r}") from None

    def label(self, anchor: str) -> str:
        """The label (a bare number for a section anchor)."""
        reference = self.reference(anchor)
        if not reference.lead and reference.kind == "section":
            return reference.number
        return reference.label(explicit=True)

    def number_of(self, anchor: str) -> str:
        """The plain number (``8.4``) of an anchor, without any label wording."""
        return self.reference(anchor).number

    def chapter_headings(self, chapter: int) -> tuple[Heading, ...]:
        """Every heading of one chapter, in document order."""
        return tuple(heading for heading in self.headings if heading.chapter == chapter)

    def figure_number(self, chapter: int, index: int) -> str:
        """The ``N.k`` number of the ``index``-th (1-based) figure of a chapter."""
        if index < 1:
            raise ContextError(f"figure index {index} is not 1-based")
        return f"{chapter}.{index}"

    def anchors(self) -> tuple[str, ...]:
        """Every resolvable anchor, sorted."""
        return tuple(sorted(self._references))


def _chapter_numbers(spec: Spec) -> list[int]:
    chapters = (spec.build or {}).get("chapters") or []
    return [int(chapter["number"]) for chapter in chapters]


def _chapter_titles(spec: Spec) -> dict[int, str]:
    chapters = (spec.build or {}).get("chapters") or []
    return {int(chapter["number"]): str(chapter["title"]) for chapter in chapters}


class _Numbering:
    """Running ``N.k`` / ``N.k.m`` counters for one chapter."""

    def __init__(self, chapter: int) -> None:
        self.chapter = chapter
        self.section = 0
        self.subsection = 0

    def next(self, level: int) -> str:
        if level == 2:
            self.section += 1
            self.subsection = 0
            return f"{self.chapter}.{self.section}"
        self.subsection += 1
        return f"{self.chapter}.{max(self.section, 1)}.{self.subsection}"


def _generated_headings(spec: Spec, macro: str) -> list[tuple[int, str, str]]:
    """Return ``(level, title, anchor)`` for the headings a macro emits."""
    if macro not in GENERATED_HEADING_MACROS:
        return []
    if macro == "maintenance_procedures":
        return [(3, str(task["name"]), f"task:{task['id']}") for task in spec.task_list]
    return [
        (2, str(condition["title"]), f"cond:{condition['id']}") for condition in spec.condition_list
    ]


def _scan_chapter(spec: Spec, chapter: int, text: str) -> Iterator[Heading]:
    """Yield the headings of one partial in document order."""
    numbering = _Numbering(chapter)
    for line in text.splitlines():
        heading = HEADING_PATTERN.match(line)
        if heading is not None:
            level = len(heading.group(1))
            yield Heading(chapter, level, numbering.next(level), heading.group(2), heading.group(3))
            continue
        for macro in MACRO_PATTERN.finditer(line):
            for level, title, anchor in _generated_headings(spec, macro.group(1)):
                yield Heading(chapter, level, numbering.next(level), title, anchor, generated=True)


def _first_condition_of(spec: Spec, fault_id: str) -> dict[str, Any] | None:
    """The first condition that lists ``fault_id``."""
    for condition in spec.condition_list:
        if any(entry.get("fault_id") == fault_id for entry in condition.get("causes", [])):
            return condition
    return None


def _registry_references(spec: Spec, sections: Mapping[str, Heading]) -> dict[str, Reference]:
    """Build the ``alarm:``/``setting:``/``signal:``/``part:``/``fault:`` anchors."""
    references: dict[str, Reference] = {}

    def host(kind: str) -> Heading | None:
        return sections.get(HOST_SECTION[kind])

    def add(anchor: str, kind: str, lead: str, heading: Heading | None) -> None:
        if heading is None:
            return
        references[anchor] = Reference(
            anchor, "section", heading.number, heading.title, lead, parenthesised=True
        )

    for alarm in spec.alarm_list:
        add(f"alarm:{alarm['code']}", "alarm", f"message {alarm['code']}", host("alarm"))
    for setting in spec.setting_list:
        lead = f"parameter {setting['param_no']}"
        add(f"setting:{setting['id']}", "setting", lead, host("setting"))
    for signal in spec.signal_list:
        add(f"signal:{signal['id']}", "signal", str(signal["panel_label"]), host("signal"))
    for part in (spec.machine or {}).get("parts") or []:
        add(f"part:{part['id']}", "part", f"part {part['code']}", host("part"))
    for cause in spec.cause_list:
        condition = _first_condition_of(spec, str(cause["fault_id"]))
        if condition is None:
            continue
        heading = sections.get(f"cond:{condition['id']}")
        if heading is None:
            continue
        references[f"fault:{cause['fault_id']}"] = Reference(
            f"fault:{cause['fault_id']}",
            "section",
            heading.number,
            heading.title,
            str(cause["name"]),
            parenthesised=True,
        )
    return references


def build_outline(spec: Spec, partials: Mapping[int, str]) -> Outline:
    """Number every heading of the manual and resolve every anchor.

    ``partials`` maps a chapter number to the raw Markdown of its partial.
    Chapters without a partial simply contribute no headings, so a writer can
    build an outline over the files they hold.
    """
    headings: list[Heading] = []
    for chapter in _chapter_numbers(spec):
        text = partials.get(chapter)
        if text is None:
            continue
        headings.extend(_scan_chapter(spec, chapter, text))

    sections = {heading.anchor: heading for heading in headings}
    references: dict[str, Reference] = {
        heading.anchor: Reference(heading.anchor, "section", heading.number, heading.title)
        for heading in headings
    }
    for heading in headings:
        if heading.anchor.startswith("task:"):
            references[heading.anchor] = Reference(
                heading.anchor, "section", heading.number, heading.title, "task"
            )
    references.update(_registry_references(spec, sections))

    titles = _chapter_titles(spec)
    for chapter, title in titles.items():
        references[f"ch:{chapter}"] = Reference(f"ch:{chapter}", "chapter", str(chapter), title)
    return Outline(headings, references, titles)


# --- render state ---------------------------------------------------------


@dataclass
class RenderState:
    """Per-partial state: the figure counter and the collected footnotes."""

    chapter: int = 0
    figures: int = 0
    footnotes: bool = False
    markers: dict[str, str] = field(default_factory=dict)
    definitions: list[str] = field(default_factory=list)

    def reset(self, chapter: int, *, footnotes: bool) -> None:
        self.chapter = chapter
        self.figures = 0
        self.footnotes = footnotes
        self.markers = {}
        self.definitions = []

    def restore(self, saved: RenderState) -> None:
        """Put back a state captured before a nested render (see ``render_text``).

        The environment and the filters hold the *same* :class:`RenderState`, so
        a nested render has to hand the fields back rather than rebind the
        object.
        """
        self.chapter = saved.chapter
        self.figures = saved.figures
        self.footnotes = saved.footnotes
        self.markers = saved.markers
        self.definitions = saved.definitions

    def marker(self, reference: Reference) -> str:
        """Allocate (or reuse) the footnote marker of one cross-reference."""
        existing = self.markers.get(reference.anchor)
        if existing is not None:
            return existing
        marker = f"xref-{len(self.markers) + 1}"
        self.markers[reference.anchor] = marker
        self.definitions.append(f"[^{marker}]: {reference.footnote}")
        return marker


class ManualEnvironment(jinja2.Environment):
    """A Jinja environment that carries the manual's per-partial render state."""

    state: RenderState


# --- namespace ------------------------------------------------------------


def _lookup(finder: Callable[[Spec, str], dict[str, Any] | None], spec: Spec, kind: str) -> Any:
    """Wrap a ``load.py`` lookup so a template gets an error, not ``None``."""

    def find(identifier: str) -> dict[str, Any]:
        found = finder(spec, identifier)
        if found is None:
            raise ContextError(f"no {kind} {identifier!r}")
        return found

    return find


def build_context(spec: Spec, variant: str) -> dict[str, Any]:
    """Return the namespace for one variant."""
    build = spec.build or {}
    document = dict(build.get("document") or {})
    document["source_date_epoch"] = build.get("source_date_epoch")
    return {
        "machine": spec.machine or {},
        "signals": spec.signal_list,
        "signal": _lookup(signal_by_id, spec, "signal"),
        "settings": spec.setting_list,
        "setting": _lookup(setting_by_id, spec, "setting"),
        "alarms": spec.alarm_list,
        "alarm": _lookup(alarm_by_code, spec, "controller message"),
        "faults": spec.faults or {},
        "condition": _lookup(condition_by_id, spec, "condition"),
        "cause": _lookup(cause_by_id, spec, "cause"),
        "maintenance": spec.task_list,
        "task": _lookup(task_by_id, spec, "maintenance task"),
        "bands": spec.bands or {},
        "build": {**build, "variant": variant_knobs(build, variant)},
        "doc": document,
    }


def _comparison_leaves(condition: Any) -> list[dict[str, Any]]:
    """Flatten a trigger condition into its comparison leaves."""
    if not isinstance(condition, dict):
        return []
    for key in ("all", "any"):
        if key in condition:
            leaves: list[dict[str, Any]] = []
            for item in condition[key]:
                leaves.extend(_comparison_leaves(item))
            return leaves
    return [condition] if "threshold" in condition else []


class Filters:
    """The filters and functions, bound to one variant."""

    def __init__(self, spec: Spec, variant: Mapping[str, Any], outline: Outline) -> None:
        self.spec = spec
        self.variant = variant
        self.outline = outline
        self.state = RenderState()
        self.imperial = variant.get("units") == "si_plus_imperial"
        self.explicit_xref = variant.get("xref_style", "explicit") == "explicit"
        self.mixed = variant.get("fact_placement") == "mixed"
        self.prose_only = frozenset(variant.get("prose_only") or ())
        self.table_only = frozenset(variant.get("table_only") or ())

    # -- numbers --

    def num(self, value: Any, unit: str, decimals: int | None = None) -> str:
        """Format a number with its unit, adding the imperial value per variant."""
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise ContextError(f"num() needs a number, got {value!r}")
        places = _natural_decimals(value) if decimals is None else int(decimals)
        si_text = f"{float(value):.{places}f}"
        symbol = unit_label(unit)
        rendered = f"{si_text} {symbol}".strip()
        conversion = IMPERIAL.get(unit) if self.imperial else None
        if conversion is None:
            return rendered
        imperial_unit, convert = conversion
        imperial_text = _round_significant(convert(float(value)), _significant_digits(si_text))
        return f"{rendered} ({imperial_text} {imperial_unit})"

    def q(self, quantity: Mapping[str, Any]) -> str:
        """Format a ``{value, unit}`` quantity."""
        if not isinstance(quantity, Mapping) or "value" not in quantity:
            raise ContextError(f"q() needs a {{value, unit}} mapping, got {quantity!r}")
        return self.num(quantity["value"], str(quantity.get("unit", "")))

    def val(self, setting_id: str, which: str = "default") -> str:
        """Format a setting's ``default``, ``min`` or ``max`` with its unit."""
        if which not in {"default", "min", "max"}:
            raise ContextError(f"val() takes default, min or max, not {which!r}")
        setting = setting_by_id(self.spec, setting_id)
        if setting is None:
            raise ContextError(f"no setting {setting_id!r}")
        return self.num(setting[which], str(setting["unit"]))

    def _alarm(self, code: str) -> dict[str, Any]:
        alarm = alarm_by_code(self.spec, code)
        if alarm is None:
            raise ContextError(f"no controller message {code!r}")
        return alarm

    def _threshold_decimals(self, threshold: Mapping[str, Any]) -> int:
        """The decimals the authored values carry, not the resolved float's."""
        if "value" in threshold:
            return _natural_decimals(threshold["value"])
        setting = setting_by_id(self.spec, str(threshold.get("setting", "")))
        authored = [threshold.get("offset", 0)]
        if setting is not None:
            authored.append(setting["default"])
        return max(_natural_decimals(value) for value in authored)

    def thr(self, alarm_code: str) -> str:
        """The resolved threshold of a message, in the compared signal's unit."""
        alarm = self._alarm(alarm_code)
        leaves = _comparison_leaves((alarm.get("trigger") or {}).get("condition"))
        if not leaves:
            raise ContextError(f"message {alarm_code} has no threshold to resolve")
        leaf = leaves[0]
        resolved = resolve_threshold(self.spec, leaf["threshold"])
        if resolved is None:
            raise ContextError(f"message {alarm_code} references a setting that does not exist")
        value, unit = resolved
        signal_id = str(leaf.get("signal", ""))
        compared = signal_by_id(self.spec, signal_id) or self._derived(signal_id)
        return self.num(
            value,
            str(compared["unit"]) if compared else unit,
            self._threshold_decimals(leaf["threshold"]),
        )

    def delay(self, alarm_code: str) -> str:
        """The confirmation delay of a message, in seconds."""
        alarm = self._alarm(alarm_code)
        for_s = (alarm.get("trigger") or {}).get("for_s")
        if for_s is None:
            raise ContextError(f"message {alarm_code} has no confirmation delay")
        seconds = resolve_duration(self.spec, for_s)
        if seconds is None:
            raise ContextError(f"message {alarm_code} references a setting that does not exist")
        return self.num(seconds, "s")

    # -- names --

    def _derived(self, signal_id: str) -> dict[str, Any] | None:
        """Return the derived signal with ``signal_id``, or ``None``.

        A message condition may compare a derived signal instead of a measured
        tag (``signals.yaml`` ``derived:``, admitted by validator rule R1), so
        every namespace helper that names or measures the compared signal has
        to look in both pools.
        """
        derived: list[dict[str, Any]] = (self.spec.signals or {}).get("derived") or []
        return next((item for item in derived if item.get("id") == signal_id), None)

    def sig(self, signal_id: str) -> str:
        """``oil temperature (T1)`` for use inside a sentence.

        A derived signal carries no panel label, because the controller shows
        no tag for it, so it reads as its id in words: ``continuous load time``.
        """
        signal = signal_by_id(self.spec, signal_id)
        if signal is not None:
            return f"{_lower_first(str(signal['name']))} ({signal['panel_label']})"
        derived = self._derived(signal_id)
        if derived is None:
            raise ContextError(f"no signal {signal_id!r}")
        return str(derived["id"]).replace("_", " ")

    def _behaviour(self, behaviour_id: str) -> dict[str, Any]:
        behaviours: list[dict[str, Any]] = (self.spec.signals or {}).get("behaviours") or []
        for behaviour in behaviours:
            if behaviour.get("id") == behaviour_id:
                return behaviour
        raise ContextError(f"no behaviour {behaviour_id!r}")

    def _move_sentence(self, move: Mapping[str, Any]) -> str:
        direction = str(move["direction"])
        if "behaviour" in move:
            subject = _upper_first(str(self._behaviour(str(move["behaviour"]))["description"]))
            verbs: Mapping[str, str] = BEHAVIOUR_VERBS
        else:
            signal = signal_by_id(self.spec, str(move["signal"]))
            if signal is None:
                raise ContextError(f"no signal {move['signal']!r}")
            subject = _upper_first(self.sig(str(move["signal"])))
            verbs = DIGITAL_VERBS if signal.get("group") == "digital" else ANALOG_VERBS
        verb = verbs.get(direction)
        if verb is None:
            raise ContextError(f"direction {direction!r} does not apply to this target")
        parts = [subject, _with_onset(verb, str(move.get("onset", "")))]
        clause = PHASE_CLAUSES.get(str(move.get("phase", "")))
        if clause is not None:
            parts.append(clause)
        sentence = " ".join(parts) + "."
        note = move.get("note")
        return f"{sentence} {note}" if note else sentence

    def move_text(self, fault_id: str) -> list[str]:
        """One plain sentence per ``signal_moves`` entry of a cause."""
        cause = cause_by_id(self.spec, fault_id)
        if cause is None:
            raise ContextError(f"no cause {fault_id!r}")
        return [self._move_sentence(move) for move in cause.get("signal_moves", [])]

    # -- fact placement --

    def fact_in_prose(self, anchor: str) -> bool:
        """False only when the variant mixes facts and ``anchor`` is table-only."""
        return not (self.mixed and anchor in self.table_only)

    def fact_in_table(self, anchor: str) -> bool:
        """False only when the variant mixes facts and ``anchor`` is prose-only."""
        return not (self.mixed and anchor in self.prose_only)

    # -- cross-references and figures --

    def ref(self, anchor: str) -> str:
        """An ``<a class="xref">`` to ``anchor``, labelled per the variant.

        ``short_with_footnotes`` only applies where a footnote definition can
        be appended, that is inside a partial; a YAML text field falls back to
        the explicit label (see :func:`render_text`).
        """
        reference = self.outline.reference(anchor)
        explicit = self.explicit_xref or not self.state.footnotes
        label = reference.label(explicit=explicit)
        link = f'<a class="xref" href="#{reference.element_id}">{html.escape(label)}</a>'
        if explicit:
            return link
        return f"{link}[^{self.state.marker(reference)}]"

    def figure(self, figure_id: str, caption: str) -> str:
        """The ``<figure>`` markup, numbered per chapter."""
        self.state.figures += 1
        number = self.outline.figure_number(self.state.chapter, self.state.figures)
        return (
            f'<figure id="figure-{html.escape(figure_id)}">'
            f'<img src="figures/{html.escape(figure_id)}.svg" alt="{html.escape(caption)}">'
            f"<figcaption>Figure {number} — {html.escape(caption)}</figcaption></figure>"
        )

    def as_mapping(self) -> dict[str, Any]:
        """The callables to register as Jinja filters and globals."""
        return {
            "num": self.num,
            "q": self.q,
            "val": self.val,
            "thr": self.thr,
            "delay": self.delay,
            "sig": self.sig,
            "move_text": self.move_text,
            "fact_in_prose": self.fact_in_prose,
            "fact_in_table": self.fact_in_table,
            "ref": self.ref,
            "figure": self.figure,
            "unit_label": unit_label,
        }


# --- generated table stubs -------------------------------------------------


class _Html(str):
    """A cell value that is already HTML and must not be escaped a second time."""

    __slots__ = ()


def _cell(value: Any) -> str:
    if isinstance(value, _Html):
        return str(value)
    return html.escape("" if value is None else str(value))


def _row(cells: Sequence[Any], anchor: str | None = None) -> str:
    """One ``<tr>``; ``anchor`` becomes its HTML id."""
    opening = f'<tr id="{anchor.replace(":", "-")}">' if anchor else "<tr>"
    return opening + "".join(f"<td>{_cell(cell)}</td>" for cell in cells) + "</tr>"


def _table(
    headers: Sequence[str],
    rows: Sequence[str],
    *,
    css: str,
) -> str:
    head = "".join(f"<th>{_cell(header)}</th>" for header in headers)
    return (
        f'<table class="{css}"><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table>'
    )


class Tables:
    """Preview stubs for the ten generated tables.

    The PDF build replaces these with its own templates; they exist
    so that ``preview.py`` shows where each table lands and so that the
    generated headings of ``troubleshooting`` and ``maintenance_procedures``
    carry the numbers :class:`Outline` computed for them.
    """

    def __init__(
        self, spec: Spec, outline: Outline, filters: Filters, environment: ManualEnvironment
    ) -> None:
        self.spec = spec
        self.outline = outline
        self.filters = filters
        self.environment = environment

    def _text(self, value: Any) -> _Html:
        """Render a YAML text field that lands in a cell.

        ``steps`` and ``remedy`` carry Jinja, so a cell that
        printed them verbatim would show ``{{ ref('task:daily_checks') }}``
        instead of the cross-reference.
        """
        return _Html(render_text(self.environment, "" if value is None else str(value)))

    def _heading(self, level: int, anchor: str) -> str:
        heading = self.outline.by_anchor.get(anchor)
        if heading is None:
            raise ContextError(f"the outline has no generated heading {anchor!r}")
        return (
            f'<h{level} id="{anchor.replace(":", "-")}">'
            f"{heading.number} {_cell(heading.title)}</h{level}>"
        )

    def alarms(self) -> str:
        rows = [
            _row(
                (
                    alarm["code"],
                    alarm["type"],
                    alarm["display"],
                    alarm.get("title", ""),
                    alarm.get("effect", ""),
                ),
                f"alarm:{alarm['code']}",
            )
            for alarm in self.spec.alarm_list
        ]
        return _table(("Code", "Type", "Display", "Title", "Effect"), rows, css="alarms")

    def settings(self) -> str:
        rows = [
            _row(
                (
                    setting["param_no"],
                    setting["name"],
                    self.filters.num(setting["min"], str(setting["unit"])),
                    self.filters.num(setting["default"], str(setting["unit"])),
                    self.filters.num(setting["max"], str(setting["unit"])),
                    setting.get("access", ""),
                ),
                f"setting:{setting['id']}",
            )
            for setting in self.spec.setting_list
        ]
        headers = ("Parameter", "Name", "Minimum", "Default", "Maximum", "Access")
        return _table(headers, rows, css="settings")

    def signals(self) -> str:
        rows = [
            _row(
                (
                    signal["panel_label"],
                    signal["name"],
                    unit_label(str(signal.get("unit", ""))),
                    signal.get("group", ""),
                    signal.get("subsystem", ""),
                ),
                f"signal:{signal['id']}",
            )
            for signal in self.spec.signal_list
        ]
        return _table(("Tag", "Name", "Unit", "Group", "Subsystem"), rows, css="signals")

    def technical_data(self) -> str:
        ratings = (self.spec.machine or {}).get("ratings") or {}
        rows = [
            _row((name.replace("_", " "), self.filters.q(quantity)))
            for name, quantity in sorted(ratings.items())
            if isinstance(quantity, Mapping) and "value" in quantity
        ]
        return _table(("Item", "Value"), rows, css="technical-data")

    def normal_bands(self) -> str:
        rows: list[str] = []
        for signal in self.spec.signal_list:
            unit = str(signal.get("unit", ""))
            for state, band in (signal.get("normal_bands") or {}).items():
                cells = (
                    (signal["panel_label"], state, str(band["expected"]), "")
                    if "expected" in band
                    else (
                        signal["panel_label"],
                        state,
                        self.filters.num(band["low"], unit),
                        self.filters.num(band["high"], unit),
                    )
                )
                rows.append(_row(cells))
        return _table(("Tag", "State", "Low", "High"), rows, css="normal-bands")

    def parts(self) -> str:
        rows = [
            _row(
                (part["code"], part["name"], unit_label(str(part.get("unit", "count")))),
                f"part:{part['id']}",
            )
            for part in ((self.spec.machine or {}).get("parts") or [])
        ]
        return _table(("Code", "Part", "Unit"), rows, css="parts")

    def maintenance_schedule(self) -> str:
        rows = [
            _row(
                (task["name"], _interval_text(task.get("interval") or {}), task.get("duration_min"))
            )
            for task in self.spec.task_list
        ]
        return _table(("Task", "Interval", "Minutes"), rows, css="maintenance-schedule")

    def maintenance_procedures(self) -> str:
        blocks: list[str] = []
        for task in self.spec.task_list:
            blocks.append(self._heading(3, f"task:{task['id']}"))
            rows = [
                _row((index, self._text(step)))
                for index, step in enumerate(task.get("steps", []), start=1)
            ]
            blocks.append(_table(("Step", "Action"), rows, css="procedure"))
        return "".join(blocks)

    def _cause_row(self, condition_id: str, entry: Mapping[str, Any]) -> str:
        cause = cause_by_id(self.spec, str(entry["fault_id"]))
        if cause is None:
            raise ContextError(f"condition {condition_id} lists an unknown cause")
        return _row(
            (
                cause["name"],
                entry.get("likelihood", ""),
                " ".join(self.filters.move_text(str(cause["fault_id"]))),
                self._text(cause.get("remedy", "")),
            ),
            f"fault:{cause['fault_id']}",
        )

    def troubleshooting(self) -> str:
        headers = ("Possible cause", "Likelihood", "Signals", "Remedy")
        blocks: list[str] = []
        for condition in self.spec.condition_list:
            blocks.append(self._heading(2, f"cond:{condition['id']}"))
            rows = [
                self._cause_row(str(condition["id"]), entry)
                for entry in condition.get("causes", [])
            ]
            blocks.append(_table(headers, rows, css="troubleshooting"))
        return "".join(blocks)

    def revision_history(self) -> str:
        document = (self.spec.build or {}).get("document") or {}
        rows = [
            _row((entry.get("revision", ""), entry.get("date", ""), entry.get("change", "")))
            for entry in document.get("revisions", [])
        ]
        return _table(("Revision", "Date", "Change"), rows, css="revision-history")


def _interval_text(interval: Mapping[str, Any]) -> str:
    parts = [f"{value} {name}" for name, value in interval.items() if name != "rule"]
    return " / ".join(parts) if parts else "as required"


# --- environment ----------------------------------------------------------


def make_env(spec: Spec, variant: str, outline: Outline) -> ManualEnvironment:
    """Build the Jinja environment for one variant."""
    knobs = variant_knobs(spec.build or {}, variant)
    filters = Filters(spec, knobs, outline)
    environment = ManualEnvironment(
        undefined=jinja2.StrictUndefined,
        autoescape=False,
        keep_trailing_newline=True,
        comment_start_string=COMMENT_START,
        comment_end_string=COMMENT_END,
    )
    environment.state = filters.state
    callables = filters.as_mapping()
    environment.filters.update(callables)
    environment.globals.update(callables)
    environment.globals.update(build_context(spec, variant))
    environment.globals["tables"] = Tables(spec, outline, filters, environment)
    environment.globals["outline"] = outline
    return environment


def render_text(environment: ManualEnvironment, text: str) -> str:
    """Render one YAML text field.

    A YAML field has no partial to append a footnote definition to, so a
    cross-reference inside a text field always uses the explicit label, whatever
    the variant's ``xref_style`` is.

    The caller's render state is restored afterwards, so a generated table may
    render the text fields of its rows in the middle of a partial without
    resetting that partial's figure counter or dropping the footnote
    definitions it has collected so far.
    """
    state = environment.state
    saved = replace(state)
    state.reset(0, footnotes=False)
    try:
        return environment.from_string(text).render()
    finally:
        state.restore(saved)


def render_partial(environment: ManualEnvironment, chapter: int, text: str) -> str:
    """Render one chapter partial, appending the footnote definitions it made."""
    environment.state.reset(chapter, footnotes=True)
    rendered = environment.from_string(text).render()
    if not environment.state.definitions:
        return rendered
    return rendered.rstrip("\n") + "\n\n" + "\n".join(environment.state.definitions) + "\n"


# --- Markdown -------------------------------------------------------------

_HEADING_ANCHOR = re.compile(r"\s*\{#([a-z0-9:_-]+)\}\s*$")


def _heading_anchors(state: Any) -> None:
    """Move a trailing ``{#anchor}`` onto the heading token as its HTML id.

    ``mdit_py_plugins.attrs`` only parses attributes after *inline* elements,
    so the Pandoc-style heading attribute needs this core rule. The id is the
    anchor with ``:`` replaced by ``-``, matching :attr:`Reference.element_id`.
    """
    tokens = list(state.tokens)
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or index + 1 >= len(tokens):
            continue
        inline = tokens[index + 1]
        if inline.type != "inline":
            continue
        match = _HEADING_ANCHOR.search(inline.content)
        if match is None:
            continue
        inline.content = inline.content[: match.start()]
        for child in reversed(inline.children or []):
            if child.type == "text":
                child.content = _HEADING_ANCHOR.sub("", child.content)
                break
        token.attrSet("id", match.group(1).replace(":", "-"))


def md_to_html(text: str, footnotes: bool) -> str:
    """Convert a rendered partial to HTML (CommonMark + tables + attrs)."""
    markdown = MarkdownIt("commonmark", {"html": True}).enable("table")
    markdown.use(attrs_plugin)
    if footnotes:
        markdown.use(footnote_plugin)
    markdown.core.ruler.after("inline", "fdp_heading_anchors", _heading_anchors)
    rendered: str = markdown.render(text)
    return rendered
