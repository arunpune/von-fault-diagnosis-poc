# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The reference fault catalog, read in any of its documented shapes.

Test-only, and deliberately outside ``src/``: the diagnosis path never reads
the reference catalog (ground-truth isolation; ``test_no_ground_truth_refs``
guards ``src/fdp_init``). The quality test compares what the deterministic path
extracts from the committed PDFs with what the manual sources say, and this
module turns the sources' export into something comparable.

The export has come in three shapes, so the loader detects the shape instead
of assuming one:

* ``document`` — an object with ``causes[]``: an envelope (``conditions[]``
  with ``id``/``title``, ``alarms[]``, ``signals[]``) whose causes name their
  conditions by id and their title as ``title``, or — what ``make manual``
  commits — whose causes are the manual's per-cause entries with ``name`` and
  ``conditions[{condition_id, title, likelihood, alarms}]``.
* ``entries`` — an object with ``entries[]``, one row per (condition, cause)
  occurrence: the first draft of the contracts ``catalog`` schema
  (``fault_id``/``condition_id``/``cause_title``/``checks``/``remedy``/
  ``alarm_codes``/``signal_moves[{signal_id, direction}]``).
* ``causes`` — a bare list of the manual's per-cause entries.

Every shape comes out as one :class:`ReferenceEntry` per (condition, cause)
occurrence, with the direction words mapped onto the contracts vocabulary by
the same ``DIRECTION_MAP`` the extractor uses, so a comparison never fails on
spelling alone.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fdp_init.manual.profiles import normalize_direction

__all__ = [
    "SHAPE_CAUSES",
    "SHAPE_DOCUMENT",
    "SHAPE_ENTRIES",
    "ReferenceCatalog",
    "ReferenceEntry",
    "ReferenceShapeError",
    "load_reference_catalog",
    "parse_reference_catalog",
]

SHAPE_DOCUMENT = "document"
SHAPE_ENTRIES = "entries"
SHAPE_CAUSES = "causes"

SignalMoveKey = tuple[str, str]
"""``(signal or behaviour id, direction)``: what signal-move recall compares."""


class ReferenceShapeError(ValueError):
    """The file is JSON but none of the documented catalog shapes."""


@dataclass(frozen=True, slots=True)
class ReferenceEntry:
    """One (condition, cause) occurrence of the reference catalog."""

    fault_id: str
    condition_id: str
    cause_title: str
    checks: tuple[str, ...]
    remedy: str
    alarm_codes: frozenset[str]
    signal_moves: frozenset[SignalMoveKey]


@dataclass(frozen=True, slots=True)
class ReferenceCatalog:
    """The reference catalog, normalised whatever shape it was written in.

    ``condition_titles`` maps every condition id to its printed title, for the
    ``slug(title)`` fallback of condition recall; ``alarm_codes`` and
    ``signal_ids`` are what the catalog declares (or, for the bare list of
    causes, what its entries name).
    """

    shape: str
    entries: tuple[ReferenceEntry, ...]
    condition_titles: Mapping[str, str]
    alarm_codes: frozenset[str]
    signal_ids: frozenset[str]

    @property
    def fault_ids(self) -> frozenset[str]:
        """Every distinct fault id."""
        return frozenset(entry.fault_id for entry in self.entries)

    @property
    def condition_ids(self) -> frozenset[str]:
        """Every condition some cause explains."""
        return frozenset(entry.condition_id for entry in self.entries)

    @property
    def pairs(self) -> frozenset[tuple[str, str]]:
        """Every ``(condition_id, fault_id)`` occurrence: one troubleshooting row each."""
        return frozenset((entry.condition_id, entry.fault_id) for entry in self.entries)

    def first(self, fault_id: str) -> ReferenceEntry:
        """The first occurrence of ``fault_id``, which carries its title and checks."""
        return next(entry for entry in self.entries if entry.fault_id == fault_id)


def load_reference_catalog(path: Path) -> ReferenceCatalog:
    """Read and normalise the reference catalog at ``path``.

    Raises:
        OSError: the file cannot be read.
        json.JSONDecodeError: it is not JSON.
        ReferenceShapeError: it is none of the three documented shapes.
    """
    return parse_reference_catalog(json.loads(path.read_text(encoding="utf-8")))


def parse_reference_catalog(document: object) -> ReferenceCatalog:
    """Normalise an already-parsed reference catalog (see the module docstring)."""
    if isinstance(document, list):
        return _from_causes(document)
    if isinstance(document, dict):
        if isinstance(document.get("entries"), list):
            return _from_entries(document)
        if isinstance(document.get("causes"), list):
            return _from_document(document)
        raise ReferenceShapeError(
            f"a catalog object needs causes[] or entries[]; it has {sorted(document)}"
        )
    raise ReferenceShapeError(f"a catalog is an object or a list, not {type(document).__name__}")


# ---------------------------------------------------------------------------
# Field readers shared by the three shapes
# ---------------------------------------------------------------------------


def _records(value: object) -> list[Mapping[str, Any]]:
    """The objects of a JSON array; anything else in it is skipped."""
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, list) else []


def _strings(value: object) -> tuple[str, ...]:
    """The strings of a JSON array, in order."""
    return tuple(item for item in value if isinstance(item, str)) if isinstance(value, list) else ()


def _text(record: Mapping[str, Any], *keys: str) -> str:
    """The first of ``keys`` that holds a string, ``""`` when none does."""
    for key in keys:
        value = record.get(key)
        if isinstance(value, str):
            return value
    return ""


def _moves(value: object) -> frozenset[SignalMoveKey]:
    """Signal moves as ``(target, direction)``, the manual's words mapped onto the contracts.

    The target is ``signal`` or ``behaviour`` (the manual's entries) or
    ``signal_id`` (the contracts draft). A direction word the map does not know
    is kept as it is spelled, so it shows up as a miss instead of disappearing.
    """
    moves: set[SignalMoveKey] = set()
    for move in _records(value):
        target = _text(move, "signal", "behaviour", "signal_id")
        word = _text(move, "direction")
        if target and word:
            moves.add((target, normalize_direction(word) or word))
    return frozenset(moves)


def _require_id(record: Mapping[str, Any], key: str, where: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise ReferenceShapeError(f"{where} has no {key}")
    return value


# ---------------------------------------------------------------------------
# The shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Occurrence:
    condition_id: str
    title: str
    alarms: frozenset[str]


def _occurrences(
    cause: Mapping[str, Any], fault_id: str, declared: Mapping[str, Mapping[str, Any]]
) -> list[_Occurrence]:
    """The conditions one per-cause entry explains, with each one's alarm codes.

    The manual's entries carry ``conditions[]`` as objects with their own
    alarms; the envelope names them by id, and then the alarms come from
    the declared condition, or from the cause's ``related_alarms`` when the
    document does not declare it.
    """
    related = frozenset(_strings(cause.get("related_alarms")))
    listed = cause.get("conditions")
    found: list[_Occurrence] = []
    for condition in listed if isinstance(listed, list) else []:
        if isinstance(condition, str):
            record = declared.get(condition, {})
            alarms = frozenset(_strings(record.get("alarms"))) or related
            found.append(_Occurrence(condition, _text(record, "title"), alarms))
        elif isinstance(condition, Mapping):
            condition_id = _require_id(condition, "condition_id", f"cause {fault_id}'s condition")
            alarms = frozenset(_strings(condition.get("alarms")))
            found.append(_Occurrence(condition_id, _text(condition, "title"), alarms))
    if not found:
        raise ReferenceShapeError(f"cause {fault_id} names no condition")
    return found


def _cause_entries(
    causes: Sequence[Mapping[str, Any]], declared: Mapping[str, Mapping[str, Any]]
) -> tuple[list[ReferenceEntry], dict[str, str]]:
    """One entry per (condition, cause) of a list of per-cause records."""
    entries: list[ReferenceEntry] = []
    titles: dict[str, str] = {}
    for cause in causes:
        fault_id = _require_id(cause, "fault_id", "a cause")
        for occurrence in _occurrences(cause, fault_id, declared):
            if occurrence.title:
                titles.setdefault(occurrence.condition_id, occurrence.title)
            entries.append(
                ReferenceEntry(
                    fault_id=fault_id,
                    condition_id=occurrence.condition_id,
                    cause_title=_text(cause, "name", "title"),
                    checks=_strings(cause.get("checks")),
                    remedy=_text(cause, "remedy"),
                    alarm_codes=occurrence.alarms,
                    signal_moves=_moves(cause.get("signal_moves")),
                )
            )
    return entries, titles


def _declared_conditions(document: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    """The ``conditions[]`` table of a document, by id (``id`` or ``condition_id``)."""
    declared: dict[str, Mapping[str, Any]] = {}
    for condition in _records(document.get("conditions")):
        condition_id = _text(condition, "id", "condition_id")
        if condition_id:
            declared[condition_id] = condition
    return declared


def _declared_codes(document: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(_text(alarm, "code") for alarm in _records(document.get("alarms"))) - {""}


def _declared_signals(document: Mapping[str, Any]) -> frozenset[str]:
    signals = _records(document.get("signals"))
    return frozenset(_text(signal, "id", "signal_id") for signal in signals) - {""}


def _from_document(document: Mapping[str, Any]) -> ReferenceCatalog:
    declared = _declared_conditions(document)
    entries, titles = _cause_entries(_records(document["causes"]), declared)
    for condition_id, condition in declared.items():
        title = _text(condition, "title")
        if title:
            titles[condition_id] = title
    return ReferenceCatalog(
        shape=SHAPE_DOCUMENT,
        entries=tuple(entries),
        condition_titles=titles,
        alarm_codes=_declared_codes(document),
        signal_ids=_declared_signals(document),
    )


def _from_causes(causes: Sequence[object]) -> ReferenceCatalog:
    records = _records(list(causes))
    entries, titles = _cause_entries(records, {})
    return ReferenceCatalog(
        shape=SHAPE_CAUSES,
        entries=tuple(entries),
        condition_titles=titles,
        alarm_codes=frozenset(code for entry in entries for code in entry.alarm_codes)
        | frozenset(code for cause in records for code in _strings(cause.get("related_alarms"))),
        signal_ids=_signal_targets(record.get("signal_moves") for record in records),
    )


def _signal_targets(move_lists: Iterable[object]) -> frozenset[str]:
    """The signal ids (not the behaviours) a list of causes names in its moves."""
    return frozenset(
        _text(move, "signal", "signal_id")
        for moves in move_lists
        for move in _records(moves)
        if _text(move, "signal", "signal_id")
    )


def _from_entries(document: Mapping[str, Any]) -> ReferenceCatalog:
    entries: list[ReferenceEntry] = []
    titles: dict[str, str] = {}
    for record in _records(document["entries"]):
        fault_id = _require_id(record, "fault_id", "an entry")
        condition_id = _require_id(record, "condition_id", f"entry {fault_id}")
        condition_title = _text(record, "condition_title")
        if condition_title:
            titles.setdefault(condition_id, condition_title)
        entries.append(
            ReferenceEntry(
                fault_id=fault_id,
                condition_id=condition_id,
                cause_title=_text(record, "cause_title", "name", "title"),
                checks=_strings(record.get("checks")),
                remedy=_text(record, "remedy"),
                alarm_codes=frozenset(_strings(record.get("alarm_codes"))),
                signal_moves=_moves(record.get("signal_moves")),
            )
        )
    declared_signals = _declared_signals(document)
    return ReferenceCatalog(
        shape=SHAPE_ENTRIES,
        entries=tuple(entries),
        condition_titles=titles,
        alarm_codes=_declared_codes(document)
        or frozenset(code for entry in entries for code in entry.alarm_codes),
        signal_ids=declared_signals
        or _signal_targets(record.get("signal_moves") for record in _records(document["entries"])),
    )
