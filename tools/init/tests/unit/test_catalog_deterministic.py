# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The deterministic catalog against both fixtures.

``expected.json`` keeps the catalog *outside* its ``variants`` block on purpose:
the two PDFs print the same manual in two layouts and the deterministic path
promises the same catalog from either. That promise is the first test here, and
the second is determinism — the exported document has to be byte-identical
across two runs, because that is what the evaluation scores and what the
idempotency check of the store assumes.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from fdp_init.catalog.deterministic import build_catalog, split_steps
from fdp_init.catalog.model import (
    CATALOG_SCHEMA_ID,
    DEFAULT_LIKELIHOOD,
    SOURCE_TABLES,
    Catalog,
    entries,
    to_catalog_document,
)
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import (
    ExtractStats,
    Heading,
    ManualDoc,
    Table,
    TableKind,
    TableRow,
    TextBlock,
)

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "mini-manual"
CONTRACTS = Path(__file__).resolve().parents[1] / "fixtures" / "contracts"
VARIANTS = ("clean", "realistic")
EXPECTED: dict[str, Any] = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))

ENTRY_KEYS = frozenset(
    json.loads(
        (CONTRACTS / "schemas" / "v1" / "catalog-entry.schema.json").read_text(encoding="utf-8")
    )["properties"]
)
"""Every key the ``catalog-entry`` schema knows; an entry may use no other."""

REQUIRED_ENTRY_KEYS = frozenset(
    json.loads(
        (CONTRACTS / "schemas" / "v1" / "catalog-entry.schema.json").read_text(encoding="utf-8")
    )["required"]
)


@pytest.fixture(scope="module")
def documents() -> dict[str, ManualDoc]:
    return {
        variant: extract_manual(FIXTURES / f"mini-manual-{variant}.pdf") for variant in VARIANTS
    }


@pytest.fixture(scope="module")
def catalogs(documents: dict[str, ManualDoc]) -> dict[str, Catalog]:
    return {variant: build_catalog(doc) for variant, doc in documents.items()}


def _as_expected(catalog: Catalog) -> dict[str, Any]:
    """The catalog in the shape ``expected.json`` states it."""
    return {
        "conditions": [
            {
                "condition_id": condition.condition_id,
                "title": condition.title,
                "causes": [
                    {
                        "fault_id": cause.fault_id,
                        "title": cause.title,
                        "subsystem": cause.subsystem,
                        "benign": cause.benign,
                        "checks_count": len(cause.checks),
                        "alarm_codes": cause.alarm_codes,
                        "signal_moves": [
                            {
                                "signal_id": move.signal_id,
                                "direction": move.direction,
                                "note": move.note,
                            }
                            for move in cause.signal_moves
                        ],
                    }
                    for cause in condition.causes
                ],
            }
            for condition in catalog.conditions
        ],
        "alarms": [
            {
                "code": alarm.code,
                "kind": alarm.kind,
                "threshold": alarm.threshold,
                "threshold_unit": alarm.threshold_unit,
                "delay_s": alarm.delay_s,
            }
            for alarm in catalog.alarms
        ],
        "signals": [
            {
                "signal_id": signal.signal_id,
                "unit": signal.unit,
                "kind": signal.kind,
                "metropt_column": signal.metropt_column,
            }
            for signal in catalog.signals
        ],
    }


# --------------------------------------------------------------------------
# The catalog itself
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_catalog_matches_the_fixture(variant: str, catalogs: dict[str, Catalog]) -> None:
    """Conditions, causes, alarms and signals equal ``expected.json``."""
    assert _as_expected(catalogs[variant]) == EXPECTED["catalog"]


def test_both_layouts_give_the_same_catalog(catalogs: dict[str, Catalog]) -> None:
    """Layout-independent extraction: the clean and realistic catalogs agree."""
    assert _as_expected(catalogs["clean"]) == _as_expected(catalogs["realistic"])


@pytest.mark.parametrize("variant", VARIANTS)
def test_a_shared_cause_appears_under_every_condition_it_explains(
    variant: str, catalogs: dict[str, Catalog]
) -> None:
    """``downstream_air_leak`` is one cause per occurrence (it explains two conditions)."""
    catalog = catalogs[variant]
    occurrences = [cause for cause in catalog.causes if cause.fault_id == "downstream_air_leak"]
    assert len(occurrences) == 2
    assert [
        condition.condition_id
        for condition in catalog.conditions
        if any(cause.fault_id == "downstream_air_leak" for cause in condition.causes)
    ] == ["low_line_pressure", "frequent_cycling"]
    assert len(catalog.causes) == EXPECTED["counts"]["cause_rows"]
    assert len(catalog.fault_ids) == EXPECTED["counts"]["causes"]


@pytest.mark.parametrize("variant", VARIANTS)
def test_condition_ids_come_from_the_printed_id_not_the_slug(
    variant: str, catalogs: dict[str, Catalog]
) -> None:
    """``Compressor starts and loads too often`` does not slug to its id."""
    catalog = catalogs[variant]
    by_id = {condition.condition_id: condition for condition in catalog.conditions}
    assert by_id["frequent_cycling"].title == "Compressor starts and loads too often"
    assert by_id["low_line_pressure"].title == "Line pressure below setpoint"


@pytest.mark.parametrize("variant", VARIANTS)
def test_sections_mirror_the_heading_tree(
    variant: str, catalogs: dict[str, Catalog], documents: dict[str, ManualDoc]
) -> None:
    """One ``app.catalog_sections`` row per heading, with its parent."""
    catalog = catalogs[variant]
    doc = documents[variant]
    assert [section.section_ref for section in catalog.sections] == [
        heading.ref for heading in doc.headings
    ]
    parents = {section.section_ref: section.parent_ref for section in catalog.sections}
    assert parents["8.1"] == "8"
    assert parents["8"] is None


@pytest.mark.parametrize("variant", VARIANTS)
def test_checks_and_remedy_are_split_into_steps(variant: str, catalogs: dict[str, Catalog]) -> None:
    """A numbered checks cell becomes three instructions, the remedy one step."""
    cause = catalogs[variant].causes[0]
    assert cause.checks == [
        "Close the isolation valve at the reservoir outlet.",
        "Watch line pressure (P2) for ten minutes with the unit stopped.",
        "Walk the distribution line and listen at every joint.",
    ]
    assert cause.remedy_steps == [cause.remedy]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1. First. 2. Second.", ["First.", "Second."]),
        ("First;\nSecond", ["First", "Second"]),
        ("• First\n• Second", ["First", "Second"]),
        ("Read line pressure (P2) at 7.0 bar.", ["Read line pressure (P2) at 7.0 bar."]),
        ("", []),
    ],
)
def test_split_steps_only_breaks_on_a_real_marker(text: str, expected: list[str]) -> None:
    """A panel label and a decimal are not step numbers."""
    assert split_steps(text) == expected


# --------------------------------------------------------------------------
# The contract projections
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_entries_use_exactly_the_catalog_entry_keys(
    variant: str, catalogs: dict[str, Catalog]
) -> None:
    """One entry per cause, with every required key and no invented one."""
    rows = entries(catalogs[variant])
    assert len(rows) == EXPECTED["counts"]["causes"]
    for row in rows:
        assert set(row) <= ENTRY_KEYS
        assert set(row) >= REQUIRED_ENTRY_KEYS
        assert row["source"] == SOURCE_TABLES
        assert row["signal_moves"], "every fixture cause states at least one move"
        for move in row["signal_moves"]:
            assert ("signal" in move) != ("behaviour" in move)
        for condition in row["conditions"]:
            assert condition["likelihood"] == DEFAULT_LIKELIHOOD


@pytest.mark.parametrize("variant", VARIANTS)
def test_a_shared_cause_folds_into_one_entry(variant: str, catalogs: dict[str, Catalog]) -> None:
    """The two occurrences of the leak become one entry with two conditions."""
    entry = next(
        row for row in entries(catalogs[variant]) if row["fault_id"] == "downstream_air_leak"
    )
    assert [condition["condition_id"] for condition in entry["conditions"]] == [
        "low_line_pressure",
        "frequent_cycling",
    ]
    assert entry["related_alarms"] == ["W101", "W108"]
    # The second occurrence is worded differently; that wording is kept as a
    # note instead of being dropped when the two fold into one entry.
    assert "note" in entry["conditions"][1]
    assert entry["conditions"][1]["note"] != entry["summary"]


@pytest.mark.parametrize("variant", VARIANTS)
def test_the_exported_document_has_the_catalog_shape(
    variant: str, catalogs: dict[str, Catalog], documents: dict[str, ManualDoc]
) -> None:
    """``to_catalog_document`` is what ``export-catalog`` writes."""
    doc = documents[variant]
    document = to_catalog_document(catalogs[variant], doc)
    assert document["schema"] == CATALOG_SCHEMA_ID
    assert document["generated_from"] == {
        "file": doc.path.name,
        "sha256": doc.sha256,
        "variant": variant,
        "source": SOURCE_TABLES,
    }
    assert document["machine"]["short_name"] == "CAU-7"
    assert [alarm["code"] for alarm in document["alarms"]] == sorted(
        alarm["code"] for alarm in EXPECTED["catalog"]["alarms"]
    )
    assert [condition["id"] for condition in document["conditions"]] == [
        condition["condition_id"] for condition in EXPECTED["catalog"]["conditions"]
    ]
    assert document["causes"] == entries(catalogs[variant])
    assert document["maintenance"] == []
    assert document["parameters"] == []


# --------------------------------------------------------------------------
# Determinism
# --------------------------------------------------------------------------


@pytest.mark.parametrize("variant", VARIANTS)
def test_two_runs_produce_identical_json(variant: str) -> None:
    """Same PDF bytes, same document bytes — no clock, no set iteration."""
    path = FIXTURES / f"mini-manual-{variant}.pdf"
    renders = []
    for _ in range(2):
        doc = extract_manual(path)
        document = to_catalog_document(build_catalog(doc), doc)
        renders.append(json.dumps(document, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    assert renders[0] == renders[1]


# --------------------------------------------------------------------------
# The committed CAU-7 layout, on hand-built tables
# --------------------------------------------------------------------------

BANDED_HEADER = [
    "Condition",
    "Fault id",
    "",
    "Subsystem",
    "Possible cause",
    "What to check",
    "Remedy",
    "See also",
]
"""What ``tables.fold_banded_rows`` leaves: the two header rows side by side."""


def _banded_doc(group_title: str, blocks: list[TextBlock]) -> ManualDoc:
    """One condition in the committed layout, plus a signal list that prints labels."""
    troubleshooting = Table(
        section_ref="8.6",
        page_from=29,
        page_to=29,
        kind=TableKind.TROUBLESHOOTING,
        header=BANDED_HEADER,
        rows=[
            TableRow(
                cells=[
                    "purge_pressure_high",
                    "dryer_purge_leak",
                    "",
                    "dryer",
                    "Dryer purge valve not seating (common) The valve no longer closes.",
                    "• Listen at the silencer. • Read the purge pressure.",
                    "Fit a new valve kit.",
                    "Purge valve service; W103",
                ],
                page=29,
                group_ref="8.6",
                group_title=group_title,
            ),
            TableRow(
                cells=[
                    "purge_pressure_high",
                    "high_ambient_temperature",
                    "",
                    "cooling",
                    "Ambient temperature above the operating range (rare, benign)",
                    "The checks of section 8.7.",
                    "The remedy of section 8.7.",
                    "W104",
                ],
                page=29,
                group_ref="8.6",
                group_title=group_title,
            ),
        ],
        bbox=(40.0, 100.0, 555.0, 700.0),
    )
    signals = Table(
        section_ref="9.2",
        page_from=42,
        page_to=42,
        kind=TableKind.SIGNALS,
        header=["Tag", "Unit", "Range"],
        rows=[TableRow(cells=["P4 dryer_purge_pressure", "bar", "-1.0–16.0 bar"], page=42)],  # noqa: RUF001
        bbox=(40.0, 100.0, 555.0, 700.0),
    )
    return ManualDoc(
        path=Path("cau-7-clean.pdf"),
        sha256="0" * 64,
        bytes=0,
        page_count=48,
        title=None,
        variant="clean",
        headings=[
            Heading(ref="8", title="Problem solving", level=1, page=25, top=50.0),
            Heading(ref="8.6", title=group_title, level=2, page=29, top=60.0),
        ],
        blocks=blocks,
        tables=[troubleshooting, signals],
        furniture=[],
        full_text="",
        stats=ExtractStats(),
    )


def test_a_wrapped_heading_takes_its_condition_id_from_the_band() -> None:
    """The clean heading wraps its id away; the band still prints it on the row."""
    symptom = TextBlock(
        section_ref="8.6", page=29, ordinal=0, text="purge_pressure_high message W103 appears."
    )
    title = "Dryer purge pressure high, air escaping at the purge silencer"
    (condition,) = build_catalog(_banded_doc(title, [symptom])).conditions
    assert condition.condition_id == "purge_pressure_high"
    assert condition.title == title
    assert condition.description == "message W103 appears."


def test_a_group_row_symptom_is_cut_off_the_title_and_kept() -> None:
    """The realistic group row runs on into the symptom after an em dash."""
    doc = _banded_doc("Dryer purge pressure high purge_pressure_high — message W103 appears.", [])
    (condition,) = build_catalog(doc).conditions
    assert condition.condition_id == "purge_pressure_high"
    assert condition.title == "Dryer purge pressure high"
    assert condition.description == "message W103 appears."


def test_the_likelihood_marker_gives_the_name_and_the_benign_flag() -> None:
    catalog = build_catalog(_banded_doc("Dryer purge pressure high", []))
    leak, ambient = catalog.causes
    assert (leak.title, leak.description, leak.benign) == (
        "Dryer purge valve not seating",
        "The valve no longer closes.",
        False,
    )
    assert leak.checks == ["Listen at the silencer.", "Read the purge pressure."]
    assert leak.alarm_codes == ["W103"]
    assert (ambient.title, ambient.description, ambient.benign) == (
        "Ambient temperature above the operating range",
        "",
        True,
    )


def test_a_label_printed_in_the_tag_cell_is_split_off_the_signal_id() -> None:
    (signal,) = build_catalog(_banded_doc("Dryer purge pressure high", [])).signals
    assert (signal.signal_id, signal.panel_label) == ("dryer_purge_pressure", "P4")
    assert (signal.range_min, signal.range_max) == (-1.0, 16.0)


def test_the_signals_column_gives_the_moves_named_in_any_signal_table() -> None:
    """The clean layout prints one signal table per group, so a move may name a
    tag of the second one; the moves come from the signals column that
    ``tables.fold_labelled_rows`` rebuilt, and the cause text keeps none of it."""
    doc = _banded_doc("Dryer purge pressure high", [])
    troubleshooting, analog = doc.tables
    leak = troubleshooting.rows[0]
    moves = (
        "Dryer purge pressure (P4) is persistently high while loaded. "
        "Purge switch (D6) is persistently on while the unit is off."
    )
    with_signals = replace(
        troubleshooting,
        header=[*BANDED_HEADER, "Signals"],
        rows=[replace(leak, cells=[*leak.cells, moves])],
    )
    digital = replace(
        analog,
        page_from=43,
        page_to=43,
        rows=[TableRow(cells=["D6 purge_switch", "", ""], page=43)],
    )
    (cause,) = build_catalog(replace(doc, tables=[with_signals, analog, digital])).causes
    assert [
        (move.signal_id, move.direction, move.onset, move.phase) for move in cause.signal_moves
    ] == [
        ("dryer_purge_pressure", "high", "sustained", "loaded"),
        ("purge_switch", "on", "sustained", "off"),
    ]
    assert cause.description == "The valve no longer closes."
