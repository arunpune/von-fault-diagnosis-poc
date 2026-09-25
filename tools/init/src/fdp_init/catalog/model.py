# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The catalog value model and its two contract projections.

The dataclasses below are what the deterministic builder produces and what
the store writes into ``app.catalog_*``: one :class:`Condition` per symptom,
one :class:`Cause` per *occurrence* of a cause under a condition (a cause may
explain several conditions), plus the alarms, signals and sections the manual
declares.

Two functions project that model onto the contracts:

* :func:`entries` yields one ``catalog-entry`` per **cause**, with every
  condition it explains aggregated into ``conditions[]``. That is the shape
  ``app.v_catalog_entries`` returns, the shape the evaluation harness reads and
  the shape the LLM structurer has to return.
* :func:`to_catalog_document` yields the whole ``catalog`` document, which
  ``fdp-init export-catalog`` writes to disk and the evaluation
  scores as the headline run.

Both are pure: same catalog in, same dictionaries out, with no clock, no
environment and no iteration over a set.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from fdp_init.manual.model import ManualDoc

__all__ = [
    "CATALOG_SCHEMA_ID",
    "DEFAULT_LIKELIHOOD",
    "MACHINE",
    "SOURCE_LLM",
    "SOURCE_TABLES",
    "Alarm",
    "Catalog",
    "Cause",
    "Condition",
    "Section",
    "Signal",
    "SignalMove",
    "entries",
    "to_catalog_document",
]

CATALOG_SCHEMA_ID = "urn:fdp:schema:catalog:v1"
"""The ``schema`` field every exported catalog document repeats."""

SOURCE_TABLES = "tables"
SOURCE_LLM = "llm"
"""``catalog-entry.source``: read off the fault tables, or reconciled by the model."""

DEFAULT_LIKELIHOOD = "unknown"
"""What a cause's likelihood is when the manual prints no ranking.

The ``catalog-entry`` enum offers ``common | occasional | rare | unknown`` and
the fault tables of this manual print none of them, so guessing one from the row
order would invent a fact the page does not state.
"""

MACHINE: dict[str, str] = {
    "name": "CAU-7 Compressed-Air Unit",
    "short_name": "CAU-7",
    "controller": "CTRL-7",
}
"""The fictional machine of this repository (invented names).

The manual does not print a machine record, and the ``catalog`` document
requires one. A manual somebody else brings along would need these three values
configured; until a task asks for it, they are the constants the rest of the
repository already uses.
"""


@dataclass(frozen=True, slots=True)
class SignalMove:
    """One movement the manual expects from a cause.

    ``signal_id`` is a signal tag, or a behaviour id when ``is_behaviour`` is
    set: the contracts ``signal_move`` requires exactly one of ``signal`` and
    ``behaviour``, and this flag says which key the projection writes.
    ``note`` is the human-readable join of ``onset`` and ``phase`` that the
    table profiles ask for; ``text`` keeps the manual's own sentence.
    """

    signal_id: str
    direction: str
    note: str | None = None
    is_behaviour: bool = False
    onset: str | None = None
    phase: str | None = None
    text: str = ""

    def to_contract(self) -> dict[str, Any]:
        """Render as a contracts ``signal_move`` (``common.schema.json``)."""
        key = "behaviour" if self.is_behaviour else "signal"
        move: dict[str, Any] = {key: self.signal_id, "direction": self.direction}
        if self.onset is not None:
            move["onset"] = self.onset
        if self.phase is not None:
            move["phase"] = self.phase
        if self.text:
            move["text"] = self.text
        return move


@dataclass(frozen=True, slots=True)
class Cause:
    """One cause as it appears under one condition.

    The same ``fault_id`` under two conditions gives two of these — a cause may
    explain several conditions, and the ``UNIQUE (condition_pk, fault_id)`` of
    the database — which :func:`entries` folds back into a single catalog entry.
    """

    fault_id: str
    title: str
    description: str
    subsystem: str
    benign: bool
    checks: list[str]
    remedy: str
    remedy_steps: list[str]
    signal_moves: list[SignalMove]
    alarm_codes: list[str]
    manual_section: str
    page_start: int
    page_end: int
    ordinal: int


@dataclass(frozen=True, slots=True)
class Condition:
    """One symptom of the fault tables, with the causes listed under it."""

    condition_id: str
    title: str
    description: str
    symptoms: list[str]
    manual_section: str
    page_start: int
    page_end: int
    causes: list[Cause]

    @property
    def alarm_codes(self) -> list[str]:
        """Every alarm code its causes raise, in first-seen order."""
        return _unique(code for cause in self.causes for code in cause.alarm_codes)


@dataclass(frozen=True, slots=True)
class Alarm:
    """One controller message of an ``ALARMS`` table."""

    code: str
    kind: str
    title: str
    trigger_text: str
    threshold: float | None
    threshold_unit: str | None
    delay_s: int | None
    reset_rule: str | None
    bit: int | None
    manual_section: str


@dataclass(frozen=True, slots=True)
class Signal:
    """One tag of the ``SIGNALS`` table.

    ``panel_label`` and ``subsystem`` are not in the extracted table's field
    list but the contracts ``catalog_signal`` prints the first and requires the
    second, so the model carries both rather than making the projection invent
    them.
    """

    signal_id: str
    description: str
    unit: str
    kind: str
    metropt_column: str | None
    range_min: float | None
    range_max: float | None
    normal_bands: dict[str, list[float]]
    manual_section: str
    panel_label: str = ""
    subsystem: str = "compressor"


@dataclass(frozen=True, slots=True)
class Section:
    """One ``app.catalog_sections`` row, mirroring the heading tree."""

    section_ref: str
    title: str
    level: int
    parent_ref: str | None
    page_start: int
    page_end: int


@dataclass(frozen=True, slots=True)
class Catalog:
    """Everything the builder read out of one manual."""

    source: str = SOURCE_TABLES
    conditions: list[Condition] = field(default_factory=list)
    alarms: list[Alarm] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)
    sections: list[Section] = field(default_factory=list)

    @property
    def causes(self) -> list[Cause]:
        """Every cause occurrence, in document order."""
        return [cause for condition in self.conditions for cause in condition.causes]

    @property
    def fault_ids(self) -> list[str]:
        """The distinct fault ids, in the order they first appear."""
        return _unique(cause.fault_id for cause in self.causes)


def _unique[T](values: Iterable[T]) -> list[T]:
    """The values in first-seen order, duplicates removed."""
    seen: dict[T, None] = {}
    for value in values:
        seen.setdefault(value, None)
    return list(seen)


def _occurrences(catalog: Catalog) -> dict[str, list[tuple[Condition, Cause]]]:
    """Group the cause occurrences by fault id, keeping document order."""
    grouped: dict[str, list[tuple[Condition, Cause]]] = {}
    for condition in catalog.conditions:
        for cause in condition.causes:
            grouped.setdefault(cause.fault_id, []).append((condition, cause))
    return grouped


def _entry_condition(condition: Condition, cause: Cause, summary: str) -> dict[str, Any]:
    """One ``entry_condition``: the symptom this occurrence explains."""
    entry: dict[str, Any] = {
        "condition_id": condition.condition_id,
        "title": condition.title,
        "likelihood": DEFAULT_LIKELIHOOD,
        "alarms": list(cause.alarm_codes),
    }
    # The manual repeats a shared cause under each condition with wording of its
    # own, so the entry keeps the first wording as its summary and every other
    # one as the note of its occurrence; nothing the page says is dropped on the
    # way into a single entry.
    if cause.description and cause.description != summary:
        entry["note"] = cause.description
    return entry


def entries(catalog: Catalog) -> list[dict[str, Any]]:
    """One ``catalog-entry`` per cause, conditions aggregated.

    The entries come back in the order the causes first appear in the manual, so
    two runs over the same PDF produce the same list.
    """
    rows: list[dict[str, Any]] = []
    for fault_id, occurrences in _occurrences(catalog).items():
        first = occurrences[0][1]
        rows.append(
            {
                "fault_id": fault_id,
                "name": first.title,
                "subsystem": first.subsystem,
                "benign": first.benign,
                "summary": first.description,
                "signal_moves": [move.to_contract() for move in first.signal_moves],
                # The schema reserves signal_moves_text for entries built from
                # the manual source; an entry read off the PDF keeps the
                # manual's sentence on each move instead.
                "signal_moves_text": [],
                "checks": list(first.checks),
                "remedy": first.remedy,
                "conditions": [
                    _entry_condition(condition, cause, first.description)
                    for condition, cause in occurrences
                ],
                "parts": [],
                "maintenance": [],
                "related_alarms": _unique(
                    code for _, cause in occurrences for code in cause.alarm_codes
                ),
                "manual_ref": {
                    "section": first.manual_section,
                    "page": first.page_start,
                },
                "source": catalog.source,
            }
        )
    return rows


def _condition_document(condition: Condition) -> dict[str, Any]:
    """One ``catalog_condition`` of the exported document."""
    document: dict[str, Any] = {
        "id": condition.condition_id,
        "title": condition.title,
        "alarms": condition.alarm_codes,
        "causes": [
            {"fault_id": cause.fault_id, "likelihood": DEFAULT_LIKELIHOOD}
            for cause in condition.causes
        ],
        "section": condition.manual_section,
    }
    if condition.description:
        document["symptom"] = condition.description
    if condition.symptoms:
        document["symptoms"] = list(condition.symptoms)
    return document


def _alarm_document(alarm: Alarm) -> dict[str, Any]:
    """One ``catalog_alarm`` of the exported document."""
    document: dict[str, Any] = {
        "code": alarm.code,
        "type": alarm.kind,
        "bit": alarm.bit,
        "title": alarm.title,
    }
    if alarm.threshold is not None:
        threshold: dict[str, Any] = {"value": alarm.threshold}
        if alarm.threshold_unit:
            threshold["unit"] = alarm.threshold_unit
        document["threshold"] = threshold
    if alarm.delay_s is not None:
        document["delay_s"] = alarm.delay_s
    if alarm.reset_rule:
        document["reset"] = alarm.reset_rule
    if alarm.trigger_text:
        document["text"] = alarm.trigger_text
    if alarm.manual_section:
        document["section"] = alarm.manual_section
    return document


def _signal_document(signal: Signal) -> dict[str, Any]:
    """One ``catalog_signal`` of the exported document."""
    document: dict[str, Any] = {
        "id": signal.signal_id,
        "metropt_column": signal.metropt_column,
        "group": signal.kind if signal.kind in ("analog", "digital") else "extra",
        "unit": signal.unit,
        "subsystem": signal.subsystem,
    }
    if signal.panel_label:
        document["panel_label"] = signal.panel_label
    if signal.description:
        document["name"] = signal.description
    if signal.kind:
        document["kind"] = signal.kind
    if signal.range_min is not None and signal.range_max is not None:
        document["range"] = [signal.range_min, signal.range_max]
    if signal.normal_bands:
        document["normal_band"] = {state: list(band) for state, band in signal.normal_bands.items()}
    if signal.manual_section:
        document["section"] = signal.manual_section
    return document


def to_catalog_document(catalog: Catalog, doc: ManualDoc) -> dict[str, Any]:
    """Project the catalog onto the contracts ``catalog`` document.

    ``fdp-init export-catalog`` writes exactly this, with sorted keys, and the
    evaluation harness scores it as the headline run. ``generated_from.file`` is
    the manual's *base name*, never the path it happened to be read from, so the
    same PDF exports the same bytes on every machine.

    ``maintenance`` and ``parameters`` are empty: the builder reads the
    troubleshooting, alarm and signal tables, and nothing else fills those two
    arrays yet. The schema requires the keys, not their contents.
    """
    return {
        "schema": CATALOG_SCHEMA_ID,
        "generated_from": {
            "file": doc.path.name,
            "sha256": doc.sha256,
            "variant": doc.variant,
            "source": catalog.source,
        },
        "machine": dict(MACHINE),
        "signals": [_signal_document(signal) for signal in catalog.signals],
        "alarms": [_alarm_document(alarm) for alarm in sorted(catalog.alarms, key=_alarm_key)],
        "conditions": [_condition_document(condition) for condition in catalog.conditions],
        "causes": entries(catalog),
        "maintenance": [],
        "parameters": [],
    }


def _alarm_key(alarm: Alarm) -> str:
    """Sort key for the exported alarms: the code, as the schema asks."""
    return alarm.code
