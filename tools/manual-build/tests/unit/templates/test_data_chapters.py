# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The generated tables of chapters 3, 4, 7, 8 and 9.

Each chapter is rendered on the mini fixture and parsed with ``tinyhtml5``
(already a WeasyPrint dependency), so the assertions are about the element tree
the renderer sees: table headers, one row per model entry, the anchor ids the manual's
``ref()`` targets, and the two layouts of the troubleshooting table.

The realistic layout is forced through ``cfg.variant("realistic")`` rather than
through a second build, so both branches of
``partials/table-troubleshooting.html.j2`` are covered by one fixture.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import pytest
import tinyhtml5

from fdp_manual_build import numbering
from fdp_manual_build.build import CHAPTER_TEMPLATES, RenderedChapter, read_sources
from fdp_manual_build.config import BuildConfig, VariantConfig
from fdp_manual_build.export import interval_text
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import SectionMap
from fdp_manual_build.templating import Sources, Templating, make_templating

XHTML = "{http://www.w3.org/1999/xhtml}"


def parse(html: str) -> ElementTree.Element:
    """Parse one chapter fragment the way the renderer does, into an element tree."""
    return tinyhtml5.parse(f"<!DOCTYPE html><html><body>{html}</body></html>")


def find(root: ElementTree.Element, tag: str) -> list[ElementTree.Element]:
    """Every descendant with the HTML tag ``tag``."""
    return list(root.iter(f"{XHTML}{tag}"))


def text_of(element: ElementTree.Element) -> str:
    """The element's text content with the whitespace collapsed."""
    return " ".join("".join(element.itertext()).split())


def ids(root: ElementTree.Element) -> set[str]:
    """Every ``id`` attribute in the fragment."""
    return {element.get("id", "") for element in root.iter()} - {""}


def headers(table: ElementTree.Element) -> list[str]:
    """The header cells of one table, in order."""
    return [text_of(cell) for cell in find(table, "th")]


def body_rows(table: ElementTree.Element) -> list[ElementTree.Element]:
    """Every ``tr`` of the table body, header rows excluded."""
    return [row for body in find(table, "tbody") for row in find(body, "tr")]


def cells(row: ElementTree.Element) -> list[str]:
    """The text of every cell of one row."""
    return [text_of(cell) for cell in find(row, "td")]


@pytest.fixture(scope="module")
def sources(request: pytest.FixtureRequest) -> Sources:
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    return read_sources(cfg, repo_root)


@pytest.fixture(scope="module")
def sections(request: pytest.FixtureRequest, sources: Sources) -> SectionMap:
    manual: Manual = request.getfixturevalue("mini_manual")
    return numbering.scan(sources.chapters, numbering.generated_sections(manual))


def make(
    cfg: BuildConfig,
    manual: Manual,
    sections: SectionMap,
    sources: Sources,
    variant: VariantConfig,
) -> Templating:
    rendering = make_templating(cfg, variant, manual, sections, sources)
    rendering.resolve(manual)
    return rendering


@pytest.fixture(scope="module")
def clean(
    request: pytest.FixtureRequest, sources: Sources, sections: SectionMap
) -> Iterator[Templating]:
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    yield make(cfg, manual, sections, sources, cfg.variant("clean"))


@pytest.fixture(scope="module")
def realistic(
    request: pytest.FixtureRequest, sources: Sources, sections: SectionMap
) -> Iterator[Templating]:
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    yield make(cfg, manual, sections, sources, cfg.variant("realistic"))


def chapter(rendering: Templating, sources: Sources, number: int) -> ElementTree.Element:
    """Render one chapter the way ``base.html.j2`` does and parse it."""
    source = next(item for item in sources.chapters if item.number == number)
    rendered = RenderedChapter(
        number=source.number,
        slug=source.slug,
        title=source.title,
        template=CHAPTER_TEMPLATES[number],
        body=rendering.chapter_body(source),
        columns=1,
        sections=(),
    )
    template = rendering.pages.get_template(f"chapters/{CHAPTER_TEMPLATES[number]}")
    return parse(template.render(ch=rendered))


def macro(rendering: Templating, name: str) -> ElementTree.Element:
    """Render one ``tables.*`` macro on its own, for a table the fixture omits."""
    rendering.env.state.reset(9, footnotes=False)
    return parse(getattr(rendering.env.globals["tables"], name)())


# --- chapter 3, controller messages ----------------------------------------

ALARM_HEADERS = ["Code", "Message", "Trigger", "Threshold", "Delay", "Reset", "Action"]


def test_chapter_3_prints_one_table_per_message_type(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    tables = find(chapter(clean, sources, 3), "table")
    assert [table.get("class") for table in tables] == ["alarms"] * 3
    assert [headers(table) for table in tables] == [ALARM_HEADERS] * 3
    assert sum(len(body_rows(table)) for table in tables) == len(mini_manual.alarms)


def test_chapter_3_gives_every_message_its_anchor_and_its_code(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(clean, sources, 3)
    present = ids(root)
    codes = {
        text_of(span) for span in root.iter(f"{XHTML}span") if span.get("class") == "alarm-code"
    }
    for alarm in mini_manual.alarms:
        assert f"alarm-{alarm.code}" in present
        assert alarm.code in codes


def test_chapter_3_resolves_a_threshold_that_points_at_a_setting(
    clean: Templating, sources: Sources
) -> None:
    row = next(
        row
        for table in find(chapter(clean, sources, 3), "table")
        for row in body_rows(table)
        if row.get("id") == "alarm-W120"
    )
    # cut_in_pressure default 8.0 bar, offset -0.5 bar.
    assert cells(row)[3] == "7.5 bar"
    assert cells(row)[4] == "600 s"


def test_chapter_3_spans_one_table_in_the_realistic_variant(
    realistic: Templating, sources: Sources, mini_manual: Manual
) -> None:
    tables = find(chapter(realistic, sources, 3), "table")
    assert len(tables) == 1
    assert len(body_rows(tables[0])) == len(mini_manual.alarms)


# --- chapter 4, programmable settings --------------------------------------


def test_chapter_4_prints_one_parameter_row_per_setting(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    table = find(chapter(clean, sources, 4), "table")[0]
    assert headers(table) == ["Parameter", "Unit", "Min", "Default", "Max", "Description"]
    rows = body_rows(table)
    assert len(rows) == len(mini_manual.parameters)
    assert [row.get("id") for row in rows] == [
        f"setting-{parameter.id}" for parameter in mini_manual.parameters
    ]
    assert cells(rows[0])[2:5] == ["5 bar", "8 bar", "9.5 bar"]


def test_chapter_4_hides_a_prose_only_value_behind_see_text(
    realistic: Templating, sources: Sources
) -> None:
    rows = body_rows(find(chapter(realistic, sources, 4), "table")[0])
    hidden = next(row for row in rows if row.get("id") == "setting-cut_in_pressure")
    shown = next(row for row in rows if row.get("id") == "setting-cut_out_pressure")
    assert "see text" in cells(hidden)
    assert "8 bar" not in " ".join(cells(hidden))
    assert "10 bar (145 psi)" in cells(shown)


# --- chapter 7, maintenance ------------------------------------------------


def test_chapter_7_prints_the_schedule_and_one_procedure_per_task(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(clean, sources, 7)
    schedule = find(root, "table")[0]
    assert headers(schedule) == ["Task", "Interval", "Consumables"]
    assert len(body_rows(schedule)) == len(mini_manual.maintenance)
    present = ids(root)
    for task in mini_manual.maintenance:
        assert f"task-{task.id}" in present
    assert "7.2.1 Oil change" in [text_of(item) for item in find(root, "h3")]


def test_chapter_7_lists_the_steps_and_the_post_service_checks(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(clean, sources, 7)
    task = mini_manual.task("oil_change")
    steps = find(root, "ol")[0]
    assert [text_of(item) for item in find(steps, "li")] == list(task.steps_md)
    checks = next(item for item in find(root, "ul") if item.get("class") == "task-checks")
    assert [text_of(item) for item in find(checks, "li")] == list(task.post_checks_md)


def test_the_schedule_interval_agrees_with_the_catalog(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    """The Jinja and the Python formatter of an interval must not drift apart."""
    rows = body_rows(find(chapter(clean, sources, 7), "table")[0])
    printed = {row.get("data-task"): cells(row)[1] for row in rows}
    assert printed == {task.id: interval_text(task.interval) for task in mini_manual.maintenance}


# --- chapter 8, problem solving --------------------------------------------

#: The two header rows: the identification band, then the four prose columns.
TROUBLESHOOTING_HEADERS = [
    "Condition",
    "Fault id",
    "Subsystem",
    "Possible cause",
    "What to check",
    "Remedy",
    "See also",
]


def troubleshooting_tables(root: ElementTree.Element) -> list[ElementTree.Element]:
    """Every table of section 8.2, whichever layout the variant printed."""
    return [
        table for table in find(root, "table") if "troubleshooting" in (table.get("class") or "")
    ]


def band_rows(root: ElementTree.Element) -> list[ElementTree.Element]:
    """The identification band of every cause entry, in document order."""
    return [
        row
        for table in find(root, "table")
        for row in body_rows(table)
        if "cause" in (row.get("class") or "").split()
    ]


def pairs(root: ElementTree.Element) -> list[tuple[str, str]]:
    """Every ``(fault_id, condition_id)`` pair the tables print, in order."""
    return [(row.get("data-fault", ""), row.get("data-condition", "")) for row in band_rows(root)]


def expected_pairs(manual: Manual) -> list[tuple[str, str]]:
    return [
        (entry.fault_id, condition.id)
        for condition in manual.conditions
        for entry in condition.causes
    ]


def test_chapter_8_prints_one_table_per_condition_in_the_clean_variant(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(clean, sources, 8)
    tables = troubleshooting_tables(root)
    assert len(tables) == len(mini_manual.conditions)
    assert [headers(table) for table in tables] == [TROUBLESHOOTING_HEADERS] * len(tables)
    assert [item.get("id") for item in find(root, "h2")][1:] == [
        f"cond-{condition.id}" for condition in mini_manual.conditions
    ]


def test_chapter_8_prints_every_cause_condition_pair_as_a_row(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(clean, sources, 8)
    assert pairs(root) == expected_pairs(mini_manual)
    first = next(row for row in find(root, "tr") if row.get("id") == "fault-high_air_demand")
    assert first.get("data-condition") == "oil_temperature_high"
    # A cause shared by three conditions still carries its anchor exactly once.
    assert [row.get("id") for row in find(root, "tr")].count("fault-high_air_demand") == 1


def test_chapter_8_prints_the_ids_verbatim_on_the_identification_band(
    clean: Templating, sources: Sources
) -> None:
    """The ids get a row of their own so they never wrap (check #3 needs them
    whole in the extracted text), and they stay the first two cells of the row
    check #4 recovers."""
    bands = band_rows(chapter(clean, sources, 8))
    row = next(row for row in bands if row.get("data-fault") == "downstream_air_leak")
    assert cells(row) == ["low_line_pressure", "downstream_air_leak", "distribution"]
    assert [cell.get("colspan") for cell in find(row, "td")] == [None, "2", None]


def test_chapter_8_prints_the_entry_of_a_cause_once_and_cross_references_the_rest(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    """A cause listed by several conditions prints its summary, checks and
    remedy under the first of them and points there from the others."""
    root = chapter(clean, sources, 8)
    details = [
        row
        for table in find(root, "table")
        for row in body_rows(table)
        if "detail" in (row.get("class") or "").split()
    ]
    assert len(details) == len(expected_pairs(mini_manual))
    full = [row for row in details if "repeat" not in (row.get("class") or "").split()]
    assert {row.get("data-fault") for row in full} == set(mini_manual.causes)
    for row in details:
        if "repeat" in (row.get("class") or "").split():
            assert cells(row)[1].startswith("The checks of section ")
            assert cells(row)[2].startswith("The remedy of section ")


@pytest.mark.parametrize("variant", ["clean", "realistic"])
def test_chapter_8_prints_the_signal_moves_under_every_full_entry(
    variant: str, request: pytest.FixtureRequest, sources: Sources, mini_manual: Manual
) -> None:
    """Each cause states in plain words which signals move. The full
    entry of a cause is followed by one row across the table that carries
    the manual's ``move_text()`` sentences; an entry that points to the full one
    does not repeat them."""
    rendering: Templating = request.getfixturevalue(variant)
    move_text = rendering.env.globals["move_text"]
    rows = [
        row for table in find(chapter(rendering, sources, 8), "table") for row in body_rows(table)
    ]
    signals = [index for index, row in enumerate(rows) if row.get("class") == "signals"]
    assert {rows[index].get("data-fault") for index in signals} == set(mini_manual.causes)
    assert len(signals) == len(mini_manual.causes)
    for index in signals:
        row, above = rows[index], rows[index - 1]
        assert above.get("class") == "detail"
        assert (above.get("data-fault"), above.get("data-condition")) == (
            row.get("data-fault"),
            row.get("data-condition"),
        )
        (cell,) = find(row, "td")
        assert cell.get("colspan") == "4"
        sentences = move_text(row.get("data-fault", ""))
        assert sentences
        assert text_of(cell) == " ".join(["Signals:", *sentences])


def test_chapter_8_spans_one_table_with_group_rows_in_the_realistic_variant(
    realistic: Templating, sources: Sources, mini_manual: Manual
) -> None:
    root = chapter(realistic, sources, 8)
    tables = troubleshooting_tables(root)
    assert len(tables) == 1
    assert len(find(tables[0], "thead")) == 1
    groups = [row for row in body_rows(tables[0]) if row.get("class") == "group"]
    assert len(groups) == len(mini_manual.conditions)
    assert [row.get("id") for row in groups] == [
        f"cond-{condition.id}" for condition in mini_manual.conditions
    ]
    assert {cell.get("colspan") for row in groups for cell in find(row, "td")} == {"4"}
    assert pairs(root) == expected_pairs(mini_manual)


# --- chapter 9, technical data and signal list -----------------------------

SIGNAL_HEADERS = [
    "Tag",
    "MetroPT-3 column",
    "Description",
    "Unit",
    "Range",
    "Sample rate",
    "Normal, loaded",
    "Normal, unloaded",
    "Normal, off",
    "Register",
]


def test_chapter_9_splits_the_signal_list_by_group(
    clean: Templating, sources: Sources, mini_manual: Manual
) -> None:
    tables = find(chapter(clean, sources, 9), "table")
    assert [headers(table) for table in tables] == [SIGNAL_HEADERS] * 3
    assert sum(len(body_rows(table)) for table in tables) == len(mini_manual.signals)


def test_chapter_9_prints_the_signals_yaml_numbers(clean: Templating, sources: Sources) -> None:
    row = next(
        row
        for row in find(chapter(clean, sources, 9), "tr")
        if row.get("id") == "signal-line_pressure"
    )
    printed = cells(row)
    assert printed[0] == "P2 line_pressure"
    assert printed[1] == "TP3"
    assert printed[3] == "bar"
    assert printed[4] == "-1.0\u201316.0 bar"
    assert printed[5] == "10 s"
    assert printed[6:9] == [
        "8.0\u201310.1 bar",
        "9.0\u201310.1 bar",
        "8.1\u20139.5 bar",
    ]
    assert printed[9] == "0 int16 \u00d71000"


def test_chapter_9_prints_a_digital_tag_without_a_range(
    clean: Templating, sources: Sources
) -> None:
    row = next(
        row
        for row in find(chapter(clean, sources, 9), "tr")
        if row.get("id") == "signal-intake_closed"
    )
    printed = cells(row)
    assert printed[4] == "—"
    assert printed[6:9] == ["0", "1", "1"]


def test_the_technical_data_table_groups_ratings_limits_and_reference_conditions(
    clean: Templating, mini_manual: Manual
) -> None:
    table = find(macro(clean, "technical_data"), "table")[0]
    assert headers(table) == ["Item", "Value"]
    rows = body_rows(table)
    groups = [text_of(row) for row in rows if row.get("class") == "group"]
    assert groups == ["Ratings", "Limits", "Reference conditions"]
    machine = mini_manual.machine
    facts = [row.get("data-fact") for row in rows if row.get("data-fact")]
    assert len(facts) == len(machine.ratings) + len(machine.limits) + len(
        machine.reference_conditions
    )
    values = {row.get("data-fact"): cells(row)[1] for row in rows if row.get("data-fact")}
    assert values["machine.ratings.max_working_pressure"] == "11 bar"
    assert values["machine.limits.ambient_operating"] == "2.0\u201340.0 °C"


def test_the_technical_data_table_hides_a_prose_only_rating(realistic: Templating) -> None:
    rows = body_rows(find(macro(realistic, "technical_data"), "table")[0])
    row = next(row for row in rows if row.get("data-fact") == "machine.ratings.oil_fill_volume")
    assert cells(row)[1] == "8 L (2.11 US gal)"


def test_the_parts_table_carries_one_anchored_row_per_part(
    clean: Templating, mini_manual: Manual
) -> None:
    table = find(macro(clean, "parts"), "table")[0]
    assert headers(table) == ["Code", "Part", "Unit", "Description"]
    rows = body_rows(table)
    assert [row.get("id") for row in rows] == [
        f"part-{part.id}" for part in mini_manual.machine.parts
    ]
    assert cells(rows[0])[0] == "CAU7-OF-01"


def test_the_normal_bands_table_prints_every_state_of_every_tag(
    clean: Templating, mini_manual: Manual
) -> None:
    table = find(macro(clean, "normal_bands"), "table")[0]
    assert headers(table) == ["Tag", "State", "Normal band", "Step", "Source"]
    rows = body_rows(table)
    states = mini_manual.machine_states.order
    assert len(rows) == len(mini_manual.signals) * len(states)
    assert cells(rows[0])[1:3] == ["off", "8.1\u20139.5 bar"]


# --- what the whole build produces -----------------------------------------


def test_every_generated_anchor_the_outline_reserves_exists(
    clean: Templating, sources: Sources, sections: SectionMap
) -> None:
    """Every ``cond:``/``task:`` heading the outline numbered is a real element."""
    present: set[str] = set()
    for number in (7, 8):
        present |= ids(chapter(clean, sources, number))
    generated = [anchor for anchor in sections if anchor.startswith(("cond:", "task:"))]
    assert generated
    assert {sections[anchor].html_id for anchor in generated} <= present


def test_a_table_macro_without_a_partial_falls_back_to_mans_stub(clean: Templating) -> None:
    """Chapter 10's revision history is still the manual's preview stub."""
    tables: Any = clean.env.globals["tables"]
    assert 'class="revision-history"' in tables.revision_history()
