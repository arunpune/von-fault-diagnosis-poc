# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Extraction quality on the committed CAU-7 manuals.

``extract_manual`` + ``build_catalog`` — the deterministic path, no LLM, no
database — run on ``data/manual/cau-7-clean.pdf`` and
``data/manual/cau-7-realistic.pdf``, and what they return is compared with the
reference catalog the manual sources export. The clean PDF carries the MUST
manual acceptance checks (3: every fault id; 4: at least 90 % of the
troubleshooting rows); the realistic one is REPORT-level (check 5) with a hard
floor of 70 % fault-id recall, below which retrieval stops being useful. Every
metric and every miss, with the pages that print it, goes to
``reports/init-extraction-quality.json``.

When a test here fails, the fix is the profile (``manual/profiles.py``), the
table reader or the PDF *template* — never the manual content or the
reference, and never a simpler layout. The messages name the
format or the column that was not found so the fix lands in the right place.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from fdp_init.catalog.model import entries
from fdp_init.catalog.validate import is_fatal, validate_catalog
from fdp_init.manual.extract import column_map, row_fault_id
from fdp_init.manual.model import TableKind
from fdp_init.manual.profiles import (
    alarm_code_re,
    condition_id_re,
    fault_id_re,
    normalize_direction,
)
from fdp_init.util.textnorm import slug

from .conftest import (
    Extraction,
    Extractions,
    QualityReport,
    contracts_dir,
    pages_printing,
    prints_token,
    require_reference,
)
from .reference import (
    SHAPE_CAUSES,
    SHAPE_DOCUMENT,
    SHAPE_ENTRIES,
    ReferenceCatalog,
    ReferenceShapeError,
    parse_reference_catalog,
)

pytestmark = pytest.mark.quality

TITLE_JACCARD = 0.8
"""A cause title counts as recovered at this normalised token Jaccard or above."""

CLEAN_ROW_RECOVERY = 0.9
"""Acceptance check 4: the share of troubleshooting rows the clean PDF must give back."""

REALISTIC_FAULT_ID_FLOOR = 0.7
"""The realistic PDF's fault-id recall below which retrieval is not worth running."""

LISTED_ERRORS = 10
"""How many contract-validation messages the report quotes; the counts are complete."""

_WORD = re.compile(r"[a-z0-9]+")


# ---------------------------------------------------------------------------
# Measuring
# ---------------------------------------------------------------------------


def title_tokens(text: str) -> frozenset[str]:
    """Lower-cased alphanumeric tokens: what two cause titles are compared on."""
    return frozenset(_WORD.findall(text.lower()))


def jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    """Token-set Jaccard similarity; two empty titles are identical."""
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def _ratio(found: int, total: int) -> float:
    """``found / total``, ``1.0`` when there is nothing to find."""
    return found / total if total else 1.0


def _move_key(move: Mapping[str, Any]) -> tuple[str, str]:
    """A contracts ``signal_move`` as ``(target, direction)``, like the reference."""
    target = str(move.get("signal") or move.get("behaviour") or "")
    word = str(move.get("direction", ""))
    return target, normalize_direction(word) or word


@dataclass(frozen=True, slots=True)
class _Extracted:
    """The extracted catalog, indexed the way the reference is."""

    by_fault: Mapping[str, Mapping[str, Any]]
    pairs: frozenset[tuple[str, str]]
    occurrence_alarms: Mapping[tuple[str, str], frozenset[str]]
    condition_ids: frozenset[str]
    alarm_codes: frozenset[str]
    signal_ids: frozenset[str]

    @classmethod
    def of(cls, extraction: Extraction) -> _Extracted:
        catalog = extraction.catalog
        occurrences = {
            (condition.condition_id, cause.fault_id): frozenset(cause.alarm_codes)
            for condition in catalog.conditions
            for cause in condition.causes
        }
        return cls(
            by_fault={entry["fault_id"]: entry for entry in entries(catalog)},
            pairs=frozenset(occurrences),
            occurrence_alarms=occurrences,
            condition_ids=frozenset(condition.condition_id for condition in catalog.conditions),
            alarm_codes=frozenset(alarm.code for alarm in catalog.alarms),
            signal_ids=frozenset(signal.signal_id for signal in catalog.signals),
        )

    def title(self, fault_id: str) -> str:
        return str(self.by_fault.get(fault_id, {}).get("name", ""))

    def has(self, fault_id: str, field: str) -> bool:
        return bool(self.by_fault.get(fault_id, {}).get(field))

    def moves(self, fault_id: str) -> frozenset[tuple[str, str]]:
        return frozenset(
            _move_key(move) for move in self.by_fault.get(fault_id, {}).get("signal_moves", [])
        )


def _condition_recalled(
    condition_id: str, reference: ReferenceCatalog, extracted: _Extracted
) -> bool:
    """By printed id, or by the slug of its title — the BYO fallback."""
    if condition_id in extracted.condition_ids:
        return True
    title = reference.condition_titles.get(condition_id, "")
    return bool(title) and slug(title) in extracted.condition_ids


def _misses(extraction: Extraction, tokens: Iterable[str]) -> list[dict[str, Any]]:
    """Each missed id with the pages that print it and whether ``full_text`` has it."""
    missed = sorted(set(tokens))
    pages = pages_printing(extraction.path, missed)
    return [
        {
            "id": token,
            "pages": pages.get(token, []),
            "in_full_text": prints_token(extraction.doc.full_text, token),
        }
        for token in missed
    ]


def _rows_without_fault_id(extraction: Extraction) -> list[dict[str, Any]]:
    """Every troubleshooting row the builder had to leave to the chunker."""
    rows: list[dict[str, Any]] = []
    for table in extraction.doc.tables:
        if table.kind is not TableKind.TROUBLESHOOTING:
            continue
        columns = column_map(table)
        for row in table.rows:
            if row_fault_id(row.cells, columns) is None:
                rows.append({"page": row.page, "cells": [cell[:60] for cell in row.cells]})
    return rows


def _contract_validation(extraction: Extraction) -> dict[str, Any]:
    """What the contracts make of the catalog this manual exports."""
    report = validate_catalog(extraction.catalog, contracts_dir(), extraction.doc)
    return {
        "entries": report.entry_count,
        "invalid_entries": len(report.invalid_entries),
        "fatal": is_fatal(report),
        "first_entry_errors": [message for _, _, message in report.invalid_entries[:LISTED_ERRORS]],
        "document_errors": len(report.warnings),
        "first_document_errors": report.warnings[:LISTED_ERRORS],
        "entries_without_signal_moves": sorted(
            entry["fault_id"] for entry in entries(extraction.catalog) if not entry["signal_moves"]
        ),
    }


def measure(extraction: Extraction, reference: ReferenceCatalog) -> dict[str, Any]:
    """Every metric for one manual, with its misses and its self-check."""
    extracted = _Extracted.of(extraction)
    fault_ids = reference.fault_ids
    found = fault_ids & set(extracted.by_fault)
    titles_matched = {
        fault_id
        for fault_id in fault_ids
        if jaccard(
            title_tokens(extracted.title(fault_id)),
            title_tokens(reference.first(fault_id).cause_title),
        )
        >= TITLE_JACCARD
    }
    conditions = reference.condition_ids
    recalled = {c for c in conditions if _condition_recalled(c, reference, extracted)}
    rows = reference.pairs & extracted.pairs
    alarm_expected = sum(len(entry.alarm_codes) for entry in reference.entries)
    alarm_found = sum(
        len(
            entry.alarm_codes
            & extracted.occurrence_alarms.get((entry.condition_id, entry.fault_id), frozenset())
        )
        for entry in reference.entries
    )
    move_expected = sum(len(reference.first(fault_id).signal_moves) for fault_id in fault_ids)
    move_found = sum(
        len(reference.first(fault_id).signal_moves & extracted.moves(fault_id))
        for fault_id in fault_ids
    )
    stats = extraction.doc.stats
    return {
        "manual": {
            "file": extraction.path.name,
            "sha256": extraction.doc.sha256,
            "pages": extraction.doc.page_count,
        },
        "metrics": {
            "fault_id_recall": _ratio(len(found), len(fault_ids)),
            "condition_recall": _ratio(len(recalled), len(conditions)),
            "cause_title_match_rate": _ratio(len(titles_matched), len(fault_ids)),
            "checks_non_empty_rate": _ratio(
                sum(extracted.has(f, "checks") for f in fault_ids), len(fault_ids)
            ),
            "remedy_non_empty_rate": _ratio(
                sum(extracted.has(f, "remedy") for f in fault_ids), len(fault_ids)
            ),
            "alarm_code_recall": _ratio(alarm_found, alarm_expected),
            "declared_alarm_recall": _ratio(
                len(reference.alarm_codes & extracted.alarm_codes), len(reference.alarm_codes)
            ),
            "signal_move_recall": _ratio(move_found, move_expected),
            "signal_id_recall": _ratio(
                len(reference.signal_ids & extracted.signal_ids), len(reference.signal_ids)
            ),
            "row_recovery": _ratio(len(rows), len(reference.pairs)),
        },
        "counts": {
            "reference_fault_ids": len(fault_ids),
            "reference_conditions": len(conditions),
            "reference_rows": len(reference.pairs),
            "reference_signal_moves": move_expected,
            "troubleshooting_rows_extracted": len(extracted.pairs),
            "rows_recovered": len(rows),
            "extra_fault_ids": sorted(set(extracted.by_fault) - fault_ids),
            "extra_condition_ids": sorted(extracted.condition_ids - conditions),
        },
        "misses": {
            "fault_ids": _misses(extraction, fault_ids - found),
            "condition_ids": _misses(extraction, conditions - recalled),
            "rows": [
                {"condition_id": condition_id, "fault_id": fault_id}
                for condition_id, fault_id in sorted(reference.pairs - rows)
            ],
            "cause_titles": [
                {
                    "fault_id": f,
                    "extracted": extracted.title(f),
                    "reference": reference.first(f).cause_title,
                }
                for f in sorted(fault_ids - titles_matched)
            ],
            "declared_alarm_codes": _misses(
                extraction, reference.alarm_codes - extracted.alarm_codes
            ),
            "rows_without_fault_id": _rows_without_fault_id(extraction),
        },
        "self_check": {
            "table_recall_estimate": stats.table_recall_estimate,
            "fault_ids_in_text": stats.fault_ids_in_text,
            "fault_ids_in_tables": stats.fault_ids_in_tables,
            "tables_by_kind": dict(sorted(stats.tables_by_kind.items())),
            "merged_fragments": stats.merged_fragments,
            "group_rows": stats.group_rows,
            "rows_dropped": stats.rows_dropped,
            "furniture_lines": stats.furniture_lines,
        },
        "contract_validation": _contract_validation(extraction),
    }


def _explain(misses: list[dict[str, Any]]) -> str:
    """One line per miss for an assertion message."""
    return "; ".join(
        f"{miss['id']} (pages {miss['pages'] or 'none'}, "
        f"{'in' if miss['in_full_text'] else 'not in'} the extracted text)"
        for miss in misses
    )


# ---------------------------------------------------------------------------
# The committed manuals
# ---------------------------------------------------------------------------


def test_clean_manual_recovers_every_fault_id_and_row(
    extractions: Extractions, reference: ReferenceCatalog, quality_report: QualityReport
) -> None:
    """Acceptance checks 3 and 4 (MUST) on the clean PDF."""
    measured = measure(extractions.get("clean"), reference)
    quality_report.record("clean", measured)
    metrics, misses = measured["metrics"], measured["misses"]
    assert metrics["fault_id_recall"] == 1.0, f"fault ids missed: {_explain(misses['fault_ids'])}"
    assert metrics["row_recovery"] >= CLEAN_ROW_RECOVERY, (
        f"{measured['counts']['rows_recovered']} of {measured['counts']['reference_rows']} "
        f"troubleshooting rows recovered; missing (condition, fault) pairs: {misses['rows']}"
    )


def test_clean_manual_extracts_exactly_the_reference_conditions(
    extractions: Extractions, reference: ReferenceCatalog
) -> None:
    """Every extracted condition id is one of the registry's, and none is lost."""
    extracted = {
        condition.condition_id for condition in extractions.get("clean").catalog.conditions
    }
    assert extracted - reference.condition_ids == set(), (
        "condition ids the reference does not know: the printed id was not found, so the "
        "title was slugged; print the id beside the heading or fix CONDITION_ID_RE"
    )
    assert reference.condition_ids - extracted == set()


def test_realistic_manual_is_reported_and_keeps_the_floor(
    extractions: Extractions, reference: ReferenceCatalog, quality_report: QualityReport
) -> None:
    """Acceptance check 5 (REPORT): every metric to the report, fault-id recall ≥ 70 %."""
    measured = measure(extractions.get("realistic"), reference)
    quality_report.record("realistic", measured)
    assert quality_report.path.is_file()
    recall = measured["metrics"]["fault_id_recall"]
    assert recall >= REALISTIC_FAULT_ID_FLOOR, (
        f"fault-id recall {recall:.0%} is below the {REALISTIC_FAULT_ID_FLOOR:.0%} floor; "
        f"missed: {_explain(measured['misses']['fault_ids'])}"
    )


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_printed_ids_match_the_configured_patterns(
    variant: str, extractions: Extractions, reference: ReferenceCatalog
) -> None:
    """Every reference id the PDF prints is found by the scanner that must find it.

    A manual that printed ``F-012`` where the profile expects ``oil_cooler_fouled``
    fails here with the printed form in the message: the fix is the
    ``CATALOG_*_PATTERN`` default or the template, not the parser's guesswork.
    """
    text = extractions.get(variant).doc.full_text
    for kind, ids, pattern in (
        ("fault ids", reference.fault_ids, fault_id_re()),
        ("condition ids", reference.condition_ids, condition_id_re()),
        ("alarm codes", reference.alarm_codes, alarm_code_re()),
    ):
        scanned = set(pattern.findall(text))
        unmatched = sorted(
            token for token in ids if prints_token(text, token) and token not in scanned
        )
        assert unmatched == [], (
            f"the {variant} PDF prints {kind} such as {unmatched[:3]} that the configured "
            f"pattern {pattern.pattern!r} does not match"
        )


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_every_troubleshooting_row_prints_a_fault_id(
    variant: str, extractions: Extractions
) -> None:
    """A row without an id is a chunk only; here none may be one."""
    doc = extractions.get(variant).doc
    tables = [table for table in doc.tables if table.kind is TableKind.TROUBLESHOOTING]
    assert tables, (
        f"no troubleshooting table recognised in the {variant} PDF; headers seen: "
        f"{[table.header for table in doc.tables]}"
    )
    for table in tables:
        columns = column_map(table)
        orphans = [row for row in table.rows if row_fault_id(row.cells, columns) is None]
        where = "an id column" if "id" in columns else "no id column (add one, or an id synonym)"
        assert orphans == [], (
            f"{len(orphans)} troubleshooting rows of section {table.section_ref} print no fault "
            f"id; the header {table.header} has {where}; first row on page {orphans[0].page}: "
            f"{orphans[0].cells}"
        )


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_each_manual_exports_a_valid_contracts_catalog(
    variant: str, extractions: Extractions
) -> None:
    """The evaluation scores the catalog exported from the realistic PDF, and
    ``export-catalog`` and ``run`` refuse one the contracts reject (exit 6).

    A cause without signal moves means the troubleshooting table printed none
    (each cause states which signals move) or the move sentences were
    not read; the fix is the PDF template or the profile's move vocabulary.
    """
    validation = _contract_validation(extractions.get(variant))
    assert not validation["fatal"], (
        f"the catalog of the {variant} PDF is not a valid contracts document: "
        f"{validation['invalid_entries']} of {validation['entries']} entries invalid, "
        f"first {validation['first_entry_errors']}; causes without signal moves: "
        f"{validation['entries_without_signal_moves']}"
    )


# ---------------------------------------------------------------------------
# The reference loader: three documented shapes, one normalised result
# ---------------------------------------------------------------------------

_LEAK_MOVES = [
    {"signal": "line_pressure", "direction": "falls", "phase": "loaded"},
    {"behaviour": "load_cycle_rate", "direction": "higher"},
]

PDF_SKETCH: dict[str, Any] = {
    "schema": "urn:fdp:fixture:catalog:v1",
    "alarms": [{"code": "W101"}, {"code": "W108"}],
    "signals": [{"id": "line_pressure"}],
    "conditions": [
        {"id": "low_line_pressure", "title": "Line pressure below setpoint", "alarms": ["W101"]},
        {
            "id": "frequent_cycling",
            "title": "Compressor starts and loads too often",
            "alarms": ["W108"],
        },
    ],
    "causes": [
        {
            "fault_id": "downstream_air_leak",
            "title": "Leak in the distribution network",
            "signal_moves": _LEAK_MOVES,
            "checks": ["Walk the line."],
            "remedy": "Seal the joints.",
            "related_alarms": ["W101", "W108"],
            "conditions": ["low_line_pressure", "frequent_cycling"],
        }
    ],
}
"""The envelope shape: causes name their conditions by id."""

MAN_ENTRY: dict[str, Any] = {
    "fault_id": "downstream_air_leak",
    "name": "Leak in the distribution network",
    "summary": "Air escapes from the pipework.",
    "signal_moves": _LEAK_MOVES,
    "signal_moves_text": [],
    "checks": ["Walk the line."],
    "remedy": "Seal the joints.",
    "conditions": [
        {
            "condition_id": "low_line_pressure",
            "title": "Line pressure below setpoint",
            "likelihood": "common",
            "alarms": ["W101"],
        },
        {
            "condition_id": "frequent_cycling",
            "title": "Compressor starts and loads too often",
            "likelihood": "common",
            "alarms": ["W108"],
        },
    ],
    "related_alarms": ["W101", "W108"],
    "manual_ref": {"section": "8.3"},
}
"""The manual's shape: one entry per cause, conditions as objects."""

CONTRACTS_ENTRIES: dict[str, Any] = {
    "schema": "urn:fdp:schema:catalog:v1",
    "alarms": [{"code": "W101"}, {"code": "W108"}],
    "signals": [{"id": "line_pressure"}],
    "entries": [
        {
            "fault_id": "downstream_air_leak",
            "condition_id": condition_id,
            "condition_title": title,
            "cause_title": "Leak in the distribution network",
            "checks": ["Walk the line."],
            "remedy": "Seal the joints.",
            "alarm_codes": [code],
            "signal_moves": [
                {"signal_id": "line_pressure", "direction": "falls"},
                {"signal_id": "load_cycle_rate", "direction": "is higher"},
            ],
        }
        for condition_id, title, code in (
            ("low_line_pressure", "Line pressure below setpoint", "W101"),
            ("frequent_cycling", "Compressor starts and loads too often", "W108"),
        )
    ],
}
"""The first contracts draft: one flat entry per (condition, cause)."""


@pytest.mark.parametrize(
    ("document", "shape"),
    [
        (PDF_SKETCH, SHAPE_DOCUMENT),
        (
            {**PDF_SKETCH, "schema": "urn:fdp:schema:catalog:v1", "causes": [MAN_ENTRY]},
            SHAPE_DOCUMENT,
        ),
        (CONTRACTS_ENTRIES, SHAPE_ENTRIES),
        ([MAN_ENTRY], SHAPE_CAUSES),
    ],
    ids=["pdf-sketch", "r08-document", "contracts-entries", "man-export"],
)
def test_every_shape_normalises_to_the_same_entries(document: object, shape: str) -> None:
    catalog = parse_reference_catalog(document)
    assert catalog.shape == shape
    assert catalog.pairs == {
        ("low_line_pressure", "downstream_air_leak"),
        ("frequent_cycling", "downstream_air_leak"),
    }
    by_condition = {entry.condition_id: entry for entry in catalog.entries}
    assert by_condition["low_line_pressure"].alarm_codes == {"W101"}
    assert by_condition["frequent_cycling"].alarm_codes == {"W108"}
    leak = catalog.first("downstream_air_leak")
    assert leak.cause_title == "Leak in the distribution network"
    assert leak.checks == ("Walk the line.",)
    assert leak.remedy == "Seal the joints."
    assert leak.signal_moves == {("line_pressure", "falls"), ("load_cycle_rate", "higher")}
    assert catalog.condition_titles["frequent_cycling"] == "Compressor starts and loads too often"
    assert catalog.alarm_codes == {"W101", "W108"}
    assert "line_pressure" in catalog.signal_ids


def test_the_committed_reference_is_the_contracts_document(reference: ReferenceCatalog) -> None:
    """``make manual`` writes the contracts document with the manual's entries."""
    assert reference.shape == SHAPE_DOCUMENT
    assert reference.fault_ids and reference.pairs
    assert all(entry.cause_title for entry in reference.entries)
    assert all(entry.signal_moves for entry in reference.entries)


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ({"machine": {}}, "causes[] or entries[]"),
        ("catalog", "not str"),
        ([{"fault_id": "downstream_air_leak", "conditions": []}], "names no condition"),
        ({"entries": [{"fault_id": "downstream_air_leak"}]}, "has no condition_id"),
    ],
)
def test_an_undocumented_shape_is_refused(document: object, message: str) -> None:
    with pytest.raises(ReferenceShapeError, match=re.escape(message)):
        parse_reference_catalog(document)


# ---------------------------------------------------------------------------
# Missing inputs skip, they do not fail
# ---------------------------------------------------------------------------


def test_a_missing_reference_catalog_skips(tmp_path: Path) -> None:
    with pytest.raises(pytest.skip.Exception, match="is absent"):
        require_reference(tmp_path / "catalog.json")


def test_a_missing_manual_skips(tmp_path: Path) -> None:
    with pytest.raises(pytest.skip.Exception, match=re.escape("cau-7-clean.pdf is absent")):
        Extractions(tmp_path).get("clean")
