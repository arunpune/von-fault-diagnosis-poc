# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The default catalog path: read the tables, invent nothing.

:func:`build_catalog` turns the tables :mod:`fdp_init.manual.tables` recovered
into the value model of :mod:`fdp_init.catalog.model`. It is the whole catalog
on the default path and the draft the optional Anthropic structurer
reconciles against, so it never guesses: a field the page does not print
comes back empty, and a row without a fault id is left to the chunker.

Everything here is a pure function of the :class:`ManualDoc`. The same PDF bytes
give the same catalog, which is what ``test_catalog_deterministic.py`` proves by
building it twice and comparing the serialised documents byte for byte.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from fdp_init.catalog.model import (
    SOURCE_TABLES,
    Alarm,
    Catalog,
    Cause,
    Condition,
    Section,
    Signal,
    SignalMove,
)
from fdp_init.manual.extract import column_map, row_fault_id
from fdp_init.manual.model import ManualDoc, Table, TableKind, TableRow
from fdp_init.manual.profiles import (
    DEFAULT_SUBSYSTEM,
    GROUP_SYMPTOM_SEPARATOR,
    SignalsIndex,
    alarm_code_re,
    alarm_kind,
    condition_id_re,
    infer_subsystem,
    is_benign,
    map_subsystem,
    normalize_id,
    parse_cause_marker,
    parse_delay,
    parse_move_sentence,
    parse_quantity,
    signal_tag,
)
from fdp_init.manual.sections import sections_table
from fdp_init.util.textnorm import norm_ws, slug, split_sentences

__all__ = [
    "ANALOG",
    "DIGITAL",
    "NORMAL_BAND_STATES",
    "build_catalog",
    "split_steps",
]

ANALOG = "analog"
DIGITAL = "digital"
"""The two signal kinds read off the kind cell, or off an empty unit."""

NORMAL_BAND_STATES: tuple[str, ...] = ("loaded", "unloaded", "off")
"""Machine states a ``SIGNALS`` table may print a normal band for."""

_STEP_MARKER = re.compile(r"(?:(?<=^)|(?<=\s))(?:\d{1,2}[.)]|[•·▪◦]|[-–—])\s+")  # noqa: RUF001
"""Where a numbered or bulleted step begins.

The marker must open the string or follow a space, which is what keeps the
``2)`` of a panel label such as ``(P2)`` and the ``0`` of ``7.0`` from opening
a step of their own.
"""

_STEP_SEPARATOR = re.compile(r"[\n;]+")
"""A step also ends at a line break or a semicolon."""

_RANGE = re.compile(r"([+-]?\d+(?:[.,]\d+)?)\s*(?:\.\.\.?|…|–|—|-|to)\s*([+-]?\d+(?:[.,]\d+)?)")  # noqa: RUF001
"""A printed interval such as "5.0 to 9.5", for a range or a normal band."""


def split_steps(text: str) -> list[str]:
    """Split a checks or remedy cell into its steps.

    The manual prints them as a numbered list, as a bulleted list, on separate
    lines or separated by semicolons; all four come back as the same list of
    sentences with the marker removed. A cell with no marker at all is one step.
    """
    steps: list[str] = []
    for part in _STEP_SEPARATOR.split(text):
        for item in _STEP_MARKER.split(part):
            cleaned = norm_ws(item)
            if cleaned:
                steps.append(cleaned)
    return steps


def _cell(row: Sequence[str], index: int | None) -> str:
    """The cell at ``index``, or the empty string when the row is shorter."""
    if index is None or index >= len(row):
        return ""
    return norm_ws(row[index])


def _title_and_rest(text: str) -> tuple[str, str]:
    """Split a cause cell into its first sentence and everything after it."""
    sentences = split_sentences(text)
    if not sentences:
        return "", ""
    title = sentences[0].rstrip(".")
    return title, " ".join(sentences[1:])


def _alarm_codes(row: Sequence[str], columns: dict[str, int]) -> list[str]:
    """Alarm codes of one row: the alarms column first, the whole row after."""
    pattern = alarm_code_re()
    alarms = _cell(row, columns.get("alarms"))
    found = pattern.findall(alarms) if alarms else []
    if not found:
        found = [code for cell in row for code in pattern.findall(cell)]
    return list(dict.fromkeys(found))


def _signal_moves(sentences: Iterable[str], index: SignalsIndex) -> list[SignalMove]:
    """Read the move sentences of one row.

    A sentence that names no known signal and no known direction is dropped
    rather than guessed at; the sentence itself survives in the row's chunk.
    """
    moves: list[SignalMove] = []
    for sentence in sentences:
        draft = parse_move_sentence(sentence, index)
        if draft is None:
            continue
        moves.append(
            SignalMove(
                signal_id=draft.signal_id,
                direction=draft.direction,
                note=draft.note,
                is_behaviour=draft.is_behaviour,
                onset=draft.onset,
                phase=draft.phase,
                text=draft.text,
            )
        )
    return moves


def _signals_index(doc: ManualDoc) -> SignalsIndex:
    """Build the tag index from every ``SIGNALS`` table of the document.

    The clean CAU-7 manual splits its signal list by group, one table each, so
    the first table alone knows the analog tags and none of the switches.
    """
    return SignalsIndex(
        candidates=tuple(
            candidate
            for table in doc.tables
            if table.kind is TableKind.SIGNALS
            for candidate in SignalsIndex.from_table(table).candidates
        )
    )


@dataclass(frozen=True, slots=True)
class _ConditionKey:
    """The condition a troubleshooting row belongs to, as the page prints it."""

    condition_id: str
    title: str
    symptom: str


def _condition_key(row: TableRow, table: Table, columns: dict[str, int]) -> _ConditionKey:
    """The condition a row belongs to.

    The group row and the ``8.2.k`` heading both print the id after the title,
    so the id is cut out of the title and read as the condition id; a manual
    that prints none falls back to slugging the title, which is the BYO case.
    A condition column that holds an id on the row itself wins over both: the
    committed manual prints one in every identification band, and a long
    heading can wrap its id onto a line of its own. A group row that runs on
    into the symptom has it cut off the title.
    """
    line, _, symptom = norm_ws(row.group_title or table.section_ref).partition(
        GROUP_SYMPTOM_SEPARATOR
    )
    printed = norm_ws(line)
    pattern = condition_id_re()
    match = pattern.search(printed)
    title = norm_ws(printed[: match.start()] + printed[match.end() :]) if match else printed
    column = _cell(row.cells, columns.get("condition"))
    if pattern.fullmatch(column):
        condition_id = normalize_id("condition", column)
    elif match is not None:
        condition_id = normalize_id("condition", match.group(0))
    else:
        condition_id = slug(printed)
    return _ConditionKey(condition_id, title or printed, norm_ws(symptom))


def _cause(
    row: TableRow, columns: dict[str, int], section: str, ordinal: int, index: SignalsIndex
) -> Cause | None:
    """Read one troubleshooting row into a :class:`Cause`, ``None`` without an id."""
    fault_id = row_fault_id(row.cells, columns)
    if fault_id is None:
        return None
    cause_cell = _cell(row.cells, columns.get("cause"))
    if columns.get("id") is None:
        cause_cell = norm_ws(cause_cell.replace(fault_id, "", 1))
    title, description = _title_and_rest(cause_cell)
    benign = is_benign(cause_cell)
    marker = parse_cause_marker(cause_cell)
    if marker is not None:
        # The page states the name and whether the cause is benign; the first
        # sentence and the keyword rule are only what a manual without the
        # marker falls back on.
        title, description, benign = marker.name, marker.rest, marker.benign
    printed_subsystem = _cell(row.cells, columns.get("subsystem"))
    signals_cell = _cell(row.cells, columns.get("signals"))
    remedy = _cell(row.cells, columns.get("remedy"))
    return Cause(
        fault_id=fault_id,
        title=title,
        description=description,
        subsystem=(
            map_subsystem(printed_subsystem) if printed_subsystem else infer_subsystem(cause_cell)
        ),
        benign=benign,
        checks=split_steps(_cell(row.cells, columns.get("checks"))),
        remedy=remedy,
        remedy_steps=split_steps(remedy),
        signal_moves=_signal_moves(split_sentences(signals_cell or cause_cell), index),
        alarm_codes=_alarm_codes(row.cells, columns),
        manual_section=row.group_ref or section,
        page_start=row.page,
        page_end=row.page,
        ordinal=ordinal,
    )


def _section_text(doc: ManualDoc, ref: str) -> tuple[str, list[str]]:
    """The first paragraph and the list items of section ``ref``."""
    description = ""
    symptoms: list[str] = []
    for block in doc.blocks:
        if block.section_ref != ref:
            continue
        if block.kind == "paragraph" and not description:
            description = block.text
        elif block.kind == "list":
            symptoms.extend(split_steps(block.text))
    return description, symptoms


def _conditions(doc: ManualDoc, index: SignalsIndex) -> list[Condition]:
    """Group every troubleshooting row into the conditions.

    Groups are keyed by condition id, so the three single-condition tables of
    the clean layout and the one spanning table of the realistic layout produce
    the same three conditions.
    """
    order: list[str] = []
    keys: dict[str, _ConditionKey] = {}
    refs: dict[str, str] = {}
    causes: dict[str, list[Cause]] = {}
    pages: dict[str, list[int]] = {}
    for table in doc.tables:
        if table.kind is not TableKind.TROUBLESHOOTING:
            continue
        columns = column_map(table)
        for row in table.rows:
            key = _condition_key(row, table, columns)
            condition_id = key.condition_id
            ordinal = len(causes.get(condition_id, []))
            cause = _cause(row, columns, table.section_ref, ordinal, index)
            if cause is None:
                continue
            if condition_id not in causes:
                order.append(condition_id)
                keys[condition_id] = key
                refs[condition_id] = cause.manual_section
                causes[condition_id] = []
                pages[condition_id] = []
            causes[condition_id].append(cause)
            pages[condition_id].append(row.page)
    conditions: list[Condition] = []
    for condition_id in order:
        description, symptoms = _section_text(doc, refs[condition_id])
        # A heading too long for one line wraps its printed id onto a line of
        # its own, which the paragraph under it then opens with.
        description = norm_ws(description.removeprefix(condition_id))
        conditions.append(
            Condition(
                condition_id=condition_id,
                title=keys[condition_id].title,
                # A spanning table prints the symptom in its group row, where
                # the section around it holds no paragraph of its own.
                description=description or keys[condition_id].symptom,
                symptoms=symptoms,
                manual_section=refs[condition_id],
                page_start=min(pages[condition_id]),
                page_end=max(pages[condition_id]),
                causes=causes[condition_id],
            )
        )
    return conditions


def _alarms(doc: ManualDoc) -> list[Alarm]:
    """Read every ``ALARMS`` table into :class:`Alarm` rows."""
    pattern = alarm_code_re()
    alarms: list[Alarm] = []
    seen: set[str] = set()
    for table in doc.tables:
        if table.kind is not TableKind.ALARMS:
            continue
        columns = column_map(table)
        for row in table.rows:
            match = pattern.search(_cell(row.cells, columns.get("code")))
            if match is None or match.group(0) in seen:
                continue
            seen.add(match.group(0))
            quantity = parse_quantity(_cell(row.cells, columns.get("threshold")))
            alarms.append(
                Alarm(
                    code=match.group(0),
                    kind=alarm_kind(_cell(row.cells, columns.get("type"))),
                    title=_cell(row.cells, columns.get("title")),
                    trigger_text=_cell(row.cells, columns.get("trigger")),
                    threshold=None if quantity is None else quantity[0],
                    threshold_unit=None if quantity is None else (quantity[1] or None),
                    delay_s=parse_delay(_cell(row.cells, columns.get("delay"))),
                    reset_rule=_cell(row.cells, columns.get("reset")) or None,
                    bit=_parse_bit(_cell(row.cells, columns.get("bit"))),
                    manual_section=table.section_ref,
                )
            )
    return alarms


def _parse_bit(text: str) -> int | None:
    """The alarm-bit position, only when the table prints a column for it."""
    return int(text) if text.isdigit() else None


def _normal_bands(header: Sequence[str], cells: Sequence[str]) -> dict[str, list[float]]:
    """Normal bands keyed by machine state, from state-named columns.

    ``classify_header`` folds ``Loaded``, ``Unloaded`` and ``Off`` into the one
    canonical ``normal`` column, so the raw header is read again here: the band
    of each state is the interval printed under its own column.
    """
    bands: dict[str, list[float]] = {}
    for position, title in enumerate(header):
        state = norm_ws(title).lower()
        if state not in NORMAL_BAND_STATES or position >= len(cells):
            continue
        match = _RANGE.search(cells[position])
        if match is None:
            continue
        bands[state] = [_number(match.group(1)), _number(match.group(2))]
    return bands


def _number(text: str) -> float:
    return float(text.replace(",", "."))


def _signals(doc: ManualDoc) -> list[Signal]:
    """Read every ``SIGNALS`` table into :class:`Signal` rows."""
    signals: list[Signal] = []
    seen: set[str] = set()
    for table in doc.tables:
        if table.kind is not TableKind.SIGNALS:
            continue
        columns = column_map(table)
        for row in table.rows:
            # The SIGNALS profile requires the tag column, so it is always mapped.
            tag, label = signal_tag(row.cells, columns["tag"], columns.get("label"))
            if not tag or tag in seen:
                continue
            seen.add(tag)
            unit = _cell(row.cells, columns.get("unit"))
            printed_kind = _cell(row.cells, columns.get("kind")).lower()
            description = _cell(row.cells, columns.get("description"))
            span = _RANGE.search(_cell(row.cells, columns.get("range")))
            signals.append(
                Signal(
                    signal_id=tag,
                    description=description,
                    unit=unit,
                    kind=printed_kind or (ANALOG if unit else DIGITAL),
                    metropt_column=_cell(row.cells, columns.get("source_column")) or None,
                    range_min=None if span is None else _number(span.group(1)),
                    range_max=None if span is None else _number(span.group(2)),
                    normal_bands=_normal_bands(table.header, row.cells),
                    manual_section=table.section_ref,
                    panel_label=label,
                    subsystem=infer_subsystem(f"{tag} {description}") or DEFAULT_SUBSYSTEM,
                )
            )
    return signals


def build_catalog(doc: ManualDoc) -> Catalog:
    """Build the default catalog from an extracted manual.

    Args:
        doc: The document :func:`~fdp_init.manual.extract.extract_manual`
            produced. Only its tables, blocks, headings and page count are read.

    Returns:
        The catalog in document order: conditions in the order the fault tables
        open them, causes in the order the rows print them, alarms and signals
        in table order and the sections mirroring the heading tree.
    """
    index = _signals_index(doc)
    return Catalog(
        source=SOURCE_TABLES,
        conditions=_conditions(doc, index),
        alarms=_alarms(doc),
        signals=_signals(doc),
        sections=[Section(**row) for row in sections_table(doc.headings, doc.page_count)],
    )
