# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Header profiles, id grammar and vocabularies.

No PDF is opened here: every rule of ``profiles.py`` works on strings. The
vocabularies are checked against the vendored ``common.schema.json`` rather than
against a list repeated in the test, because the contracts are the definition
of what a direction, a phase or a subsystem may be.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from fdp_init.manual.model import Table, TableKind, TableRow
from fdp_init.manual.profiles import (
    ALARM_KIND_WORDS,
    BEHAVIOURS,
    CANONICAL_COLUMNS,
    DEFAULT_ALARM_KIND,
    DEFAULT_SUBSYSTEM,
    DIRECTION_MAP,
    ONSET_MAP,
    PHASE_MAP,
    PROFILES,
    SUBSYSTEM_MAP,
    CauseMarker,
    SignalsIndex,
    alarm_code_re,
    alarm_kind,
    classify_header,
    condition_id_re,
    fault_id_re,
    header_hint_hits,
    infer_subsystem,
    is_benign,
    label_column,
    looks_like_header_line,
    map_subsystem,
    normalize_direction,
    normalize_id,
    parse_cause_marker,
    parse_delay,
    parse_move_sentence,
    parse_quantity,
    signal_tag,
    split_tag_cell,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
EXPECTED: dict[str, Any] = json.loads(
    (FIXTURES / "mini-manual" / "expected.json").read_text(encoding="utf-8")
)
COMMON: dict[str, Any] = json.loads(
    (FIXTURES / "contracts" / "schemas" / "v1" / "common.schema.json").read_text(encoding="utf-8")
)
DEFS: dict[str, Any] = COMMON["$defs"]
IDENTIFIER_RE = re.compile(DEFS["identifier"]["pattern"])

# The signal registry the fixture prints in chapter 9, as the table a
# document hands to SignalsIndex.
SIGNALS_HEADER = ["Tag", "Label", "Description", "Unit", "Kind", "Source column"]
SIGNALS_ROWS = (
    ("discharge_pressure", "P1", "Pressure in the oil separator vessel", "bar"),
    ("line_pressure", "P2", "Line pressure at the pneumatic panel", "bar"),
    ("purge_pressure", "P4", "Pressure in the dryer purge line", "bar"),
    ("oil_temperature", "T1", "Compressor oil temperature", "°C"),
    ("motor_current", "I1", "Current of one motor phase", "A"),
)

# Every move sentence the mini manual prints, with what the profiles must read
# out of it. The last test in this group proves the list covers expected.json.
MOVE_SENTENCES: tuple[tuple[str, str, str, str | None, bool], ...] = (
    (
        "Line pressure (P2) falls faster than usual while unloaded.",
        "line_pressure",
        "falls",
        "unloaded",
        False,
    ),
    ("Load cycle rate is higher.", "load_cycle_rate", "higher", None, True),
    ("Line pressure (P2) is low while loaded.", "line_pressure", "low", "loaded", False),
    ("Motor current (I1) is low while loaded.", "motor_current", "low", "loaded", False),
    ("Purge pressure (P4) is high while loaded.", "purge_pressure", "high", "loaded", False),
    ("Line pressure (P2) falls while loaded.", "line_pressure", "falls", "loaded", False),
    (
        "Line pressure (P2) rises faster than usual while loaded.",
        "line_pressure",
        "rises",
        "loaded",
        False,
    ),
    (
        "Oil temperature (T1) rises gradually in every state.",
        "oil_temperature",
        "rises",
        "gradual, any",
        False,
    ),
    ("Oil temperature (T1) is high in every state.", "oil_temperature", "high", "any", False),
    (
        "Oil temperature (T1) rises gradually while loaded.",
        "oil_temperature",
        "rises",
        "gradual, loaded",
        False,
    ),
)


@pytest.fixture(scope="module")
def signals_index() -> SignalsIndex:
    """The index the fixture's SIGNALS table builds."""
    table = Table(
        section_ref="9",
        page_from=6,
        page_to=6,
        kind=TableKind.SIGNALS,
        header=SIGNALS_HEADER,
        rows=[
            TableRow(cells=[tag, label, description, unit, "analog", ""], page=6)
            for tag, label, description, unit in SIGNALS_ROWS
        ],
        bbox=(0.0, 0.0, 1.0, 1.0),
    )
    return SignalsIndex.from_table(table)


# ---------------------------------------------------------------------------
# Header classification
# ---------------------------------------------------------------------------


def _expected_headers() -> list[tuple[str, tuple[str, ...]]]:
    seen: dict[tuple[str, ...], str] = {}
    for variant in EXPECTED["variants"].values():
        for table in variant["tables"]:
            seen.setdefault(tuple(table["header"]), table["kind"])
    return [(kind, header) for header, kind in seen.items()]


@pytest.mark.parametrize(("kind", "header"), _expected_headers())
def test_classify_header_recognises_every_fixture_header(
    kind: str, header: tuple[str, ...]
) -> None:
    """Every header expected.json names is classified and fully mapped."""
    found_kind, column_map = classify_header(list(header))
    assert found_kind.value == kind
    assert len(column_map) == len(header), "every printed column is named"
    assert sorted(column_map.values()) == list(range(len(header)))


def test_every_profile_names_only_canonical_columns() -> None:
    """A typo in a profile would silently hide a column from the catalog builder.

    ``CANONICAL_COLUMNS`` is the list the profiles give and the builder reads; a
    profile that mapped ``"checkss"`` would still classify its table and then
    lose the column, so the two are checked against each other here.
    """
    named = {column for profile in PROFILES for column in profile.synonyms}
    assert named <= CANONICAL_COLUMNS
    assert CANONICAL_COLUMNS - named == set(), "every canonical column is claimed by a profile"


def test_a_profile_never_gives_one_synonym_to_two_columns() -> None:
    """Within one profile a word means one column, whichever order it is read in."""
    for profile in PROFILES:
        claimed: dict[str, str] = {}
        for column, phrases in profile.synonyms.items():
            for phrase in phrases:
                assert claimed.setdefault(phrase, column) == column, (
                    f"{profile.kind.value}: {phrase!r} names two columns"
                )


def test_classify_header_ignores_case_and_punctuation() -> None:
    kind, column_map = classify_header(["FAULT ID.", "possible-cause", "  Remedy  "])
    assert kind is TableKind.TROUBLESHOOTING
    assert column_map == {"id": 0, "cause": 1, "remedy": 2}


def test_classify_header_reads_the_subsystem_column() -> None:
    """The table has a subsystem column; without it no benign cause infers its subsystem."""
    kind, column_map = classify_header(["Fault", "Cause", "System", "Remedy"])
    assert kind is TableKind.TROUBLESHOOTING
    assert column_map["subsystem"] == 2


def test_classify_header_accepts_a_maintenance_table() -> None:
    kind, column_map = classify_header(["Task", "Every", "Parts", "Procedure"])
    assert kind is TableKind.MAINTENANCE
    assert column_map == {"task": 0, "interval": 1, "consumables": 2, "procedure": 3}


@pytest.mark.parametrize(
    "header",
    [
        ["Left", "Right"],
        ["Code", "Threshold"],
        ["Parameter", "Unit"],
        [],
    ],
)
def test_classify_header_rejects_what_no_profile_requires(header: list[str]) -> None:
    """A partial header is not a profile: the required columns must all be there."""
    assert classify_header(header) == (TableKind.OTHER, {})


def test_header_hints_separate_a_header_from_a_sentence() -> None:
    """The text-strategy fallback must not fire on prose that names columns."""
    sentence = (
        "Each table below lists the causes of one condition, the signals that "
        "move, what to check and what to do."
    )
    assert header_hint_hits(sentence) >= 3, "the sentence does name several columns"
    assert looks_like_header_line(sentence) is False
    assert looks_like_header_line("Fault id Possible cause Subsystem Signals Checks Remedy")
    assert looks_like_header_line("Code Type Message")
    assert looks_like_header_line("") is False


# ---------------------------------------------------------------------------
# Identifier grammar
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("oil_cooler_fouled", "oil_cooler_fouled"),
        ("Raises W101 for dryer_purge_leak.", "dryer_purge_leak"),
        ("8.2.3 Oil temperature high oil_temperature_high", "oil_temperature_high"),
    ],
)
def test_fault_id_pattern_finds_snake_case_ids(text: str, expected: str) -> None:
    match = fault_id_re().search(text)
    assert match is not None
    assert match.group(0) == expected


@pytest.mark.parametrize("text", ["Oil cooler fouled", "cooler", "Downstream air leak."])
def test_fault_id_pattern_never_matches_ordinary_words(text: str) -> None:
    """One underscore is required, so prose cannot look like an id."""
    assert fault_id_re().search(text) is None


def test_alarm_code_pattern_matches_the_fixture_codes() -> None:
    codes = [item["code"] for item in EXPECTED["catalog"]["alarms"]]
    assert [alarm_code_re().findall(code) for code in codes] == [[code] for code in codes]
    assert alarm_code_re().search("W1042") is None


def test_env_overrides_replace_the_default_patterns(monkeypatch: pytest.MonkeyPatch) -> None:
    """A BYO manual with another grammar ingests through CATALOG_*_PATTERN."""
    monkeypatch.setenv("CATALOG_FAULT_ID_PATTERN", r"\bF-[0-9]{3}\b")
    monkeypatch.setenv("CATALOG_CONDITION_ID_PATTERN", r"\bC-[0-9]{2}\b")
    monkeypatch.setenv("CATALOG_ALARM_CODE_PATTERN", r"\bALM[0-9]{2}\b")
    assert fault_id_re().search("see F-101 here") is not None
    assert fault_id_re().search("oil_cooler_fouled") is None
    assert condition_id_re().search("C-07") is not None
    assert alarm_code_re().search("ALM42") is not None
    assert alarm_code_re().search("W104") is None


def test_an_empty_override_means_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty environment value is the same as an absent one."""
    monkeypatch.setenv("CATALOG_FAULT_ID_PATTERN", "   ")
    assert fault_id_re().search("oil_cooler_fouled") is not None


def test_a_broken_override_is_reported_with_its_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CATALOG_ALARM_CODE_PATTERN", "[unclosed")
    with pytest.raises(ValueError, match="CATALOG_ALARM_CODE_PATTERN"):
        alarm_code_re()


def test_normalize_id_is_the_identity_but_for_a_subsystem() -> None:
    assert normalize_id("fault", "oil_cooler_fouled") == "oil_cooler_fouled"
    assert normalize_id("condition", " low_line_pressure ") == "low_line_pressure"
    assert normalize_id("subsystem", "intake unloading") == "intake_unloading"
    assert normalize_id("subsystem", "Separator-Drain") == "separator_drain"


# ---------------------------------------------------------------------------
# Vocabularies against the contracts
# ---------------------------------------------------------------------------


def test_directions_are_exactly_the_contract_enum() -> None:
    """The map normalises English onto the manual's words and invents none."""
    assert set(DIRECTION_MAP.values()) == set(
        DEFS["signal_move"]["properties"]["direction"]["enum"]
    )


def test_onsets_and_phases_stay_inside_the_contract_enums() -> None:
    assert set(ONSET_MAP.values()) <= set(DEFS["signal_move"]["properties"]["onset"]["enum"])
    assert set(PHASE_MAP.values()) <= set(DEFS["signal_move"]["properties"]["phase"]["enum"])


def test_subsystem_map_is_the_identity_over_the_contract_enum() -> None:
    """No downstream/controls/other: the manual's ten subsystems are the enum."""
    enum = set(DEFS["subsystem"]["enum"])
    assert set(SUBSYSTEM_MAP) == enum
    assert all(key == value for key, value in SUBSYSTEM_MAP.items())
    assert DEFAULT_SUBSYSTEM in enum


def test_alarm_kinds_are_exactly_the_contract_enum() -> None:
    kinds = {kind for _, kind in ALARM_KIND_WORDS} | {DEFAULT_ALARM_KIND}
    assert kinds == set(DEFS["alarm_type"]["enum"])


def test_behaviour_ids_follow_the_identifier_grammar() -> None:
    assert all(IDENTIFIER_RE.fullmatch(behaviour) for behaviour in BEHAVIOURS)


@pytest.mark.parametrize(
    ("word", "expected"),
    [
        ("rises", "rises"),
        ("Falls", "falls"),
        ("is higher", "higher"),
        ("more often", "higher"),
        ("flat", "unchanged"),
        ("erratic", "fluctuates"),
        ("stays on", "stays_on"),
        ("nonsense", None),
    ],
)
def test_normalize_direction_maps_english_onto_man(word: str, expected: str | None) -> None:
    assert normalize_direction(word) == expected


# ---------------------------------------------------------------------------
# Subsystems and benign causes
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("printed", "expected"),
    [
        ("intake unloading", "intake_unloading"),
        ("distribution", "distribution"),
        ("control", "control"),
        ("electrical", "electrical"),
        ("Cooling", "cooling"),
    ],
)
def test_map_subsystem_reads_the_printed_column(printed: str, expected: str) -> None:
    assert map_subsystem(printed) == expected


def test_map_subsystem_matches_every_subsystem_of_the_fixture() -> None:
    printed = {
        cause["subsystem"]
        for condition in EXPECTED["catalog"]["conditions"]
        for cause in condition["causes"]
    }
    assert {map_subsystem(value.replace("_", " ")) for value in printed} == printed


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Downstream air leak.", "distribution"),
        ("No fault: high ambient temperature.", "cooling"),
        ("Oil filter clogged.", "oil"),
        ("Reservoir isolation valve closed.", "reservoirs"),
        ("Dryer purge leak.", "dryer"),
        ("A cause with no keyword at all.", DEFAULT_SUBSYSTEM),
    ],
)
def test_infer_subsystem_falls_back_to_keywords(text: str, expected: str) -> None:
    assert infer_subsystem(text) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("No fault: high ambient temperature.", True),
        ("High air demand at the outlet.", True),
        ("Normal operation after a restart.", True),
        ("Oil cooler fouled.", False),
    ],
)
def test_is_benign_follows_the_registry_wording(text: str, expected: bool) -> None:
    assert is_benign(text) is expected


@pytest.mark.parametrize(
    ("printed", "expected"),
    [
        ("Warning", "warning"),
        ("Shutdown warning", "shutdown_warning"),
        ("Shutdown", "shutdown"),
        ("Service", "service"),
        ("", "warning"),
    ],
)
def test_alarm_kind_reads_the_type_cell(printed: str, expected: str) -> None:
    assert alarm_kind(printed) == expected


# ---------------------------------------------------------------------------
# Quantities and delays
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("7.0 bar (102 psi)", (7.0, "bar")),
        ("7.0 bar", (7.0, "bar")),
        ("75 °C (167 °F)", (75.0, "°C")),
        ("6 per hour", (6.0, "per hour")),
        ("10 min", (10.0, "min")),
        ("Automatic", None),
        ("", None),
    ],
)
def test_parse_quantity_keeps_the_si_value(cell: str, expected: tuple[float, str] | None) -> None:
    assert parse_quantity(cell) == expected


@pytest.mark.parametrize(
    ("cell", "expected"),
    [("10 s", 10), ("2 min", 120), ("30 s", 30), ("0 s", 0), ("5 min", 300), ("1 h", 3600)],
)
def test_parse_delay_returns_seconds(cell: str, expected: int) -> None:
    assert parse_delay(cell) == expected


@pytest.mark.parametrize("cell", ["Automatic", "", "3 fortnights"])
def test_parse_delay_refuses_what_is_not_a_delay(cell: str) -> None:
    assert parse_delay(cell) is None


def test_thresholds_and_delays_of_the_fixture_parse() -> None:
    """The alarm cells of the mini manual give the values expected.json states.

    The threshold cells print the imperial value beside the SI one, which is the
    form the deterministic catalog has to drop; the delay cells are the ones the
    fixture prints in chapter 3, in the order ``expected.json`` lists them.
    """
    printed_delays = ["10 s", "2 min", "5 min", "0 s", "30 s", "5 s"]
    alarms = EXPECTED["catalog"]["alarms"]
    assert len(printed_delays) == len(alarms)
    for alarm, printed_delay in zip(alarms, printed_delays, strict=True):
        unit = alarm["threshold_unit"]
        printed = f"{alarm['threshold']:g} {unit}"
        assert parse_quantity(printed) == (float(alarm["threshold"]), unit)
        assert parse_delay(printed_delay) == alarm["delay_s"]


# ---------------------------------------------------------------------------
# Move sentences
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("sentence", "signal_id", "direction", "note", "behaviour"), MOVE_SENTENCES
)
def test_parse_move_sentence_reads_the_fixture_sentences(
    signals_index: SignalsIndex,
    sentence: str,
    signal_id: str,
    direction: str,
    note: str | None,
    behaviour: bool,
) -> None:
    """The manual's wording maps onto the contracts vocabulary, nothing else."""
    draft = parse_move_sentence(sentence, signals_index)
    assert draft is not None
    assert (draft.signal_id, draft.direction, draft.note) == (signal_id, direction, note)
    assert draft.is_behaviour is behaviour
    assert draft.text == sentence


def test_the_sentence_list_covers_every_move_of_expected_json() -> None:
    """Keeps this file honest: the fixture may not grow a move nobody parses."""
    parsed = {(signal_id, direction, note) for _, signal_id, direction, note, _ in MOVE_SENTENCES}
    from_fixture = {
        (move["signal_id"], move["direction"], move["note"])
        for condition in EXPECTED["catalog"]["conditions"]
        for cause in condition["causes"]
        for move in cause["signal_moves"]
    }
    assert from_fixture <= parsed


def test_a_signal_is_resolved_by_its_panel_label_alone(signals_index: SignalsIndex) -> None:
    draft = parse_move_sentence("(T1) rises suddenly while starting.", signals_index)
    assert draft is not None
    assert (draft.signal_id, draft.direction) == ("oil_temperature", "rises")
    assert (draft.onset, draft.phase) == ("sudden", "start")
    assert draft.note == "sudden, start"


def test_an_unknown_signal_or_direction_is_left_to_the_caller(
    signals_index: SignalsIndex,
) -> None:
    assert parse_move_sentence("Ambient humidity rises slowly.", signals_index) is None
    assert parse_move_sentence("Oil temperature (T1) matters here.", signals_index) is None
    assert parse_move_sentence("   ", signals_index) is None


def test_an_empty_index_still_resolves_behaviours() -> None:
    draft = parse_move_sentence("Loaded run is longer.", SignalsIndex.empty())
    assert draft is not None
    assert (draft.signal_id, draft.direction, draft.is_behaviour) == (
        "loaded_run_duration",
        "longer",
        True,
    )


# The sentences the manual's move_text() prints for the committed CAU-7 manuals
# (manual/tools/context.py): a behaviour opens with its signals.yaml
# description, the onset sits after the copula and "off" is a whole clause.
MAN_MOVE_SENTENCES: tuple[tuple[str, str, str, str | None, str | None], ...] = (
    (
        "How fast line pressure falls while the unit is not delivering is gradually faster.",
        "unloaded_pressure_decay",
        "faster",
        "gradual",
        None,
    ),
    ("How often the compressor loads per hour is higher.", "load_cycle_rate", "higher", None, None),
    (
        "How long each loaded run lasts is gradually longer while loaded.",
        "loaded_run_duration",
        "longer",
        "gradual",
        "loaded",
    ),
    (
        "Whether a loaded run ends at the cut-out pressure is not reached.",
        "cut_out_reached",
        "not_reached",
        None,
        None,
    ),
    (
        "How fast line pressure rises during a loaded run is persistently slower.",
        "pressure_rise_while_loaded",
        "slower",
        "sustained",
        None,
    ),
    (
        "The current peak at motor start is higher at start.",
        "start_current_peak",
        "higher",
        None,
        "start",
    ),
    (
        "Line pressure (P2) falls persistently while loaded.",
        "line_pressure",
        "falls",
        "sustained",
        "loaded",
    ),
    (
        "Oil temperature (T1) is high while the unit is off.",
        "oil_temperature",
        "high",
        None,
        "off",
    ),
)


@pytest.mark.parametrize(("sentence", "target", "direction", "onset", "phase"), MAN_MOVE_SENTENCES)
def test_parse_move_sentence_reads_mans_move_text_wording(
    signals_index: SignalsIndex,
    sentence: str,
    target: str,
    direction: str,
    onset: str | None,
    phase: str | None,
) -> None:
    """A behaviour's description names a signal on the way ("line pressure"),
    so the description itself must be what the sentence resolves to."""
    draft = parse_move_sentence(sentence, signals_index)
    assert draft is not None
    assert (draft.signal_id, draft.direction, draft.onset, draft.phase) == (
        target,
        direction,
        onset,
        phase,
    )
    assert draft.is_behaviour is (target in BEHAVIOURS)


def test_an_onset_between_the_copula_and_on_or_off_keeps_the_state() -> None:
    """The manual prints "is persistently on"; the bare "on" is only read in a phrase."""
    switches = SignalsIndex.from_table(
        Table(
            section_ref="9",
            page_from=6,
            page_to=6,
            kind=TableKind.SIGNALS,
            header=SIGNALS_HEADER,
            rows=[TableRow(cells=["low_pressure_switch", "D5", "", "", "digital", ""], page=6)],
            bbox=(0.0, 0.0, 1.0, 1.0),
        )
    )
    on = parse_move_sentence("Low-pressure switch (D5) is persistently on while loaded.", switches)
    off = parse_move_sentence(
        "Low-pressure switch (D5) is suddenly off while the unit is off.", switches
    )
    assert on is not None
    assert off is not None
    assert (on.signal_id, on.direction, on.onset, on.phase) == (
        "low_pressure_switch",
        "on",
        "sustained",
        "loaded",
    )
    assert (off.direction, off.onset, off.phase) == ("off", "sudden", "off")


def test_a_compound_the_line_broke_at_its_hyphen_still_resolves() -> None:
    """pdfplumber gives "cut-\\nout" back as "cutout" once the line break is joined."""
    draft = parse_move_sentence(
        "Whether a loaded run ends at the cutout pressure is not reached.", SignalsIndex.empty()
    )
    assert draft is not None
    assert (draft.signal_id, draft.direction) == ("cut_out_reached", "not_reached")


def test_label_column_names_the_column_a_printed_label_stands_for() -> None:
    assert label_column(TableKind.TROUBLESHOOTING, "Signals") == "signals"
    assert label_column(TableKind.TROUBLESHOOTING, "Signal behaviour") == "signals"
    assert label_column(TableKind.TROUBLESHOOTING, "Note") is None
    assert label_column(TableKind.OTHER, "Signals") is None


def test_signals_index_indexes_every_tag_and_its_panel_label(
    signals_index: SignalsIndex,
) -> None:
    """One entry per tag plus one per printed label, so either name resolves."""
    assert len(signals_index.candidates) == 2 * len(SIGNALS_ROWS)
    for tag, label, _, _ in SIGNALS_ROWS:
        spaced = tag.replace("_", " ")
        assert parse_move_sentence(f"{spaced} rises.", signals_index) is not None
        assert parse_move_sentence(f"({label}) rises.", signals_index) is not None


def test_signals_index_ignores_a_table_without_tags() -> None:
    table = Table(
        section_ref="4",
        page_from=2,
        page_to=2,
        kind=TableKind.PARAMETERS,
        header=["Parameter", "Unit", "Min", "Default", "Max"],
        rows=[TableRow(cells=["Cut-in pressure", "bar", "5.0", "8.0", "9.5"], page=2)],
        bbox=(0.0, 0.0, 1.0, 1.0),
    )
    assert SignalsIndex.from_table(table).candidates == ()


# ---------------------------------------------------------------------------
# The committed CAU-7 layout
# ---------------------------------------------------------------------------


def test_parse_cause_marker_splits_name_ranking_and_summary() -> None:
    marker = parse_cause_marker(
        "Air demand above the rated delivery (common, benign) The consumers ask for more air."
    )
    assert marker == CauseMarker(
        name="Air demand above the rated delivery",
        likelihood="common",
        benign=True,
        rest="The consumers ask for more air.",
    )
    plain = parse_cause_marker("Oil cooler fouled (occasional)")
    assert plain == CauseMarker(
        name="Oil cooler fouled", likelihood="occasional", benign=False, rest=""
    )


@pytest.mark.parametrize(
    "cell",
    [
        "Oil cooler fouled. The matrix is blocked with dust.",
        "Oil cooler fouled. It happens (rare) in dusty rooms.",
        "Oil cooler fouled (see 7.3.7) and the fan is slow.",
    ],
)
def test_parse_cause_marker_needs_the_marker_before_any_sentence_end(cell: str) -> None:
    """The mini manual prints "Name. Summary." and must keep its first-sentence rule."""
    assert parse_cause_marker(cell) is None


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("P1 discharge_pressure", ("discharge_pressure", "P1")),
        ("T2 ambient_temperature", ("ambient_temperature", "T2")),
        ("discharge_pressure", ("discharge_pressure", "")),
        ("Line pressure", ("Line pressure", "")),
    ],
)
def test_split_tag_cell_reads_a_label_printed_before_the_tag(
    cell: str, expected: tuple[str, str]
) -> None:
    assert split_tag_cell(cell) == expected


def test_signal_tag_prefers_a_label_column_to_a_label_in_the_tag_cell() -> None:
    assert signal_tag(["P1 discharge_pressure", "TP2"], 0, None) == ("discharge_pressure", "P1")
    assert signal_tag(["discharge_pressure", "P1"], 0, 1) == ("discharge_pressure", "P1")
    assert signal_tag(["X9 discharge_pressure", "P1"], 0, 1) == ("discharge_pressure", "P1")


def test_signals_index_resolves_a_label_printed_in_the_tag_cell() -> None:
    table = Table(
        section_ref="9.2",
        page_from=42,
        page_to=42,
        kind=TableKind.SIGNALS,
        header=["Tag", "MetroPT-3 column", "Unit"],
        rows=[TableRow(cells=["P2 line_pressure", "TP3", "bar"], page=42)],
        bbox=(0.0, 0.0, 1.0, 1.0),
    )
    index = SignalsIndex.from_table(table)
    for sentence in ("Line pressure falls while loaded.", "(P2) falls while loaded."):
        draft = parse_move_sentence(sentence, index)
        assert draft is not None
        assert (draft.signal_id, draft.direction) == ("line_pressure", "falls")
