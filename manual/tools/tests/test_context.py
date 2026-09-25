# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for the Jinja namespace and the outline of context.py.

Covers the filters and functions (both variants), the outline numbering
(including the headings a table macro generates, and the label of every anchor
kind in both cross-reference styles) and the variant resolution and fact
placement::

    uv run --no-project --with-requirements manual/tools/requirements.txt \\
        pytest manual/tools/tests/test_context.py -q
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path
from typing import Any

import jinja2
import pytest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import context  # noqa: E402  (the sys.path shim above must run first)
from context import (  # noqa: E402
    ContextError,
    Outline,
    build_context,
    build_outline,
    make_env,
    md_to_html,
    render_partial,
    render_text,
    unit_label,
    variant_knobs,
)
from load import Spec, load_spec  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SPEC_MINIMAL = FIXTURES / "spec-minimal"
CONTENT_MINIMAL = FIXTURES / "content-minimal"

#: Stand-ins for the chapters the minimal content set leaves out, so that the
#: anchors hosted by chapters 4, 7 and 9 resolve in these tests.
HOST_PARTIALS: dict[int, str] = {
    4: "## Settings table {#sec:settings-table}\n",
    7: "## Procedures {#sec:maintenance-procedures}\n\n{{ tables.maintenance_procedures() }}\n",
    9: "## Signal list {#sec:signal-list}\n\n## Spare parts {#sec:parts}\n",
}


def read_partials(directory: Path) -> dict[int, str]:
    """Read ``NN-<slug>.md`` from a content directory, keyed by chapter."""
    return {
        int(path.name[:2]): path.read_text(encoding="utf-8")
        for path in sorted(directory.glob("*.md"))
    }


@pytest.fixture(scope="module")
def spec() -> Spec:
    return load_spec(SPEC_MINIMAL)


@pytest.fixture(scope="module")
def partials() -> dict[int, str]:
    return {**read_partials(CONTENT_MINIMAL), **HOST_PARTIALS}


@pytest.fixture(scope="module")
def outline(spec: Spec, partials: dict[int, str]) -> Outline:
    return build_outline(spec, partials)


@pytest.fixture
def clean(spec: Spec, outline: Outline) -> context.ManualEnvironment:
    return make_env(spec, "clean", outline)


@pytest.fixture
def realistic(spec: Spec, outline: Outline) -> context.ManualEnvironment:
    return make_env(spec, "realistic", outline)


def call(environment: context.ManualEnvironment, name: str, *args: Any) -> Any:
    """Invoke one registered global the way a template would."""
    function: Any = environment.globals[name]
    return function(*args)


# --- num(): unit rendering and conversion --------------


@pytest.mark.parametrize(
    ("value", "unit", "expected"),
    [
        (10.0, "bar", "10.0 bar"),
        (300, "s", "300 s"),
        (75, "degC", "75 °C"),
        (1.5, "m3_per_min", "1.5 m³/min"),
        (1.97, "per_hour", "1.97 /h"),
        (0.07, "bar_per_min", "0.07 bar/min"),
        (35.0, "percent", "35.0 %"),
        (70, "dBA", "70 dB(A)"),
        (2, "count", "2"),
        (4000, "h", "4000 h"),
    ],
)
def test_num_renders_the_unit_table(
    clean: context.ManualEnvironment, value: float, unit: str, expected: str
) -> None:
    assert call(clean, "num", value, unit) == expected


def test_num_honours_explicit_decimals(clean: context.ManualEnvironment) -> None:
    assert call(clean, "num", 10, "bar", 2) == "10.00 bar"
    assert call(clean, "num", 9.549, "bar", 1) == "9.5 bar"


def test_num_keeps_the_authored_decimals(clean: context.ManualEnvironment) -> None:
    assert call(clean, "num", 8.0, "bar") == "8.0 bar"
    assert call(clean, "num", 8, "bar") == "8 bar"


@pytest.mark.parametrize(
    ("value", "unit", "expected"),
    [
        (10.0, "bar", "10.0 bar (145 psi)"),
        (11.0, "bar", "11.0 bar (160 psi)"),
        (75, "degC", "75 °C (167 °F)"),
        (8.0, "L", "8.0 L (2.1 US gal)"),
        (100, "kg", "100 kg (220 lb)"),
        (25.4, "mm", "25.4 mm (1.00 in)"),
        (2.0, "m", "2.0 m (6.6 ft)"),
        (0.5, "m3_per_min", "0.5 m³/min (18 cfm)"),
        (1.0, "kW", "1.0 kW (1.3 hp)"),
    ],
)
def test_num_adds_the_imperial_value_in_realistic(
    realistic: context.ManualEnvironment, value: float, unit: str, expected: str
) -> None:
    assert call(realistic, "num", value, unit) == expected


@pytest.mark.parametrize("unit", ["s", "A", "V", "Hz", "per_hour", "rpm", "percent"])
def test_num_leaves_inconvertible_units_alone(
    realistic: context.ManualEnvironment, unit: str
) -> None:
    assert "(" not in call(realistic, "num", 12.0, unit)


def test_num_refuses_a_non_number(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="needs a number"):
        call(clean, "num", "ten", "bar")


def test_unit_label_covers_the_rendering_table() -> None:
    assert unit_label("degC") == "°C"
    assert unit_label("m3_per_min") == "m³/min"
    assert unit_label("bar") == "bar"
    assert unit_label("count") == ""


# --- q(), val(), thr(), delay(), sig() ------------------------------------


def test_q_formats_a_quantity(clean: context.ManualEnvironment) -> None:
    assert call(clean, "q", {"value": 11.0, "unit": "bar"}) == "11.0 bar"


def test_q_refuses_a_non_quantity(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="value, unit"):
        call(clean, "q", {"amount": 3})


def test_val_reads_default_min_and_max(clean: context.ManualEnvironment) -> None:
    assert call(clean, "val", "cut_out_pressure") == "10.0 bar"
    assert call(clean, "val", "cut_in_pressure", "min") == "5.0 bar"
    assert call(clean, "val", "cut_in_pressure", "max") == "9.5 bar"


def test_val_rejects_an_unknown_setting_and_field(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="no setting"):
        call(clean, "val", "not_a_setting")
    with pytest.raises(ContextError, match="default, min or max"):
        call(clean, "val", "cut_in_pressure", "typical")


def test_thr_resolves_a_setting_reference(clean: context.ManualEnvironment) -> None:
    assert call(clean, "thr", "W104") == "75 °C"
    assert call(clean, "thr", "S301") == "95 °C"


def test_thr_applies_the_offset(spec: Spec, outline: Outline, tmp_path: Path, mutate: Any) -> None:
    mutated = mutate(
        SPEC_MINIMAL, tmp_path, "alarms", "/alarms/0/trigger/condition/threshold/offset", 5
    )
    environment = make_env(load_spec(mutated), "clean", outline)
    assert call(environment, "thr", "W104") == "80 °C"
    del spec


def test_thr_uses_the_compared_signals_unit(clean: context.ManualEnvironment) -> None:
    # The oil temperature family compares a degC signal against degC settings,
    # so both sources agree; the filter must still name the signal's unit.
    assert call(clean, "thr", "X201").endswith("°C")


def test_thr_and_delay_refuse_a_counter_message(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="no threshold"):
        call(clean, "thr", "M401")
    with pytest.raises(ContextError, match="no confirmation delay"):
        call(clean, "delay", "M401")


def test_delay_reads_the_confirmation_time(clean: context.ManualEnvironment) -> None:
    assert call(clean, "delay", "W104") == "300 s"
    assert call(clean, "delay", "S301") == "5 s"


def test_delay_resolves_a_setting_reference(outline: Outline, tmp_path: Path, mutate: Any) -> None:
    reference = {"setting": "motor_start_mask_time"}
    mutated = mutate(SPEC_MINIMAL, tmp_path, "alarms", "/alarms/0/trigger/for_s", reference)
    environment = make_env(load_spec(mutated), "clean", outline)
    assert call(environment, "delay", "W104") == "15 s"


def test_sig_names_the_signal_and_its_panel_label(clean: context.ManualEnvironment) -> None:
    assert call(clean, "sig", "oil_temperature") == "oil temperature (T1)"
    assert call(clean, "sig", "line_pressure") == "line pressure (P2)"
    with pytest.raises(ContextError, match="no signal"):
        call(clean, "sig", "not_a_signal")


def test_sig_names_a_derived_signal_without_a_panel_label(
    clean: context.ManualEnvironment,
) -> None:
    # Validator rule R1 lets a message condition compare a derived signal, and
    # the alarm table names every compared signal through sig(). A derived
    # signal has no panel label, so it reads as its id in words.
    assert call(clean, "sig", "continuous_load_time") == "continuous load time"
    assert call(clean, "sig", "motor_starts_per_hour") == "motor starts per hour"


# --- move_text() ----------------------------------------------------------


def test_move_text_renders_an_analog_move(clean: context.ManualEnvironment) -> None:
    sentences = call(clean, "move_text", "oil_cooler_fouled")
    assert sentences[0] == "Oil temperature (T1) rises gradually in every state."


def test_move_text_renders_a_digital_move(clean: context.ManualEnvironment) -> None:
    sentences = call(clean, "move_text", "dryer_purge_leak")
    assert "Purge pressure switch (D6) stays on while loaded." in sentences


def test_move_text_renders_a_behaviour_move(clean: context.ManualEnvironment) -> None:
    sentences = call(clean, "move_text", "high_air_demand")
    assert sentences[1] == "How often the compressor loads per hour is higher."


def test_move_text_places_the_onset_inside_a_copula(clean: context.ManualEnvironment) -> None:
    sentences = call(clean, "move_text", "high_air_demand")
    assert sentences[2] == "Line pressure (P2) is persistently low while loaded."


def test_move_text_renders_a_no_pulse_move(clean: context.ManualEnvironment) -> None:
    sentences = call(clean, "move_text", "reservoir_isolation_valve_closed")
    assert "Flow pulse (D8) gives no pulse while loaded." in sentences


def test_move_text_rejects_an_unknown_cause(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="no cause"):
        call(clean, "move_text", "not_a_cause")


# --- fact placement ------------------------------------


@pytest.mark.parametrize(
    "anchor",
    ["setting:unload_run_on_time", "setting:motor_current_low_warning", "machine.ratings.x"],
)
def test_clean_states_every_fact_in_both_places(
    clean: context.ManualEnvironment, anchor: str
) -> None:
    assert call(clean, "fact_in_prose", anchor) is True
    assert call(clean, "fact_in_table", anchor) is True


def test_realistic_hides_prose_only_facts_from_the_tables(
    realistic: context.ManualEnvironment,
) -> None:
    assert call(realistic, "fact_in_prose", "setting:unload_run_on_time") is True
    assert call(realistic, "fact_in_table", "setting:unload_run_on_time") is False


def test_realistic_hides_table_only_facts_from_the_prose(
    realistic: context.ManualEnvironment,
) -> None:
    assert call(realistic, "fact_in_prose", "setting:motor_current_low_warning") is False
    assert call(realistic, "fact_in_table", "setting:motor_current_low_warning") is True


# --- outline numbering ---------------------------------


def test_outline_numbers_authored_headings_in_document_order(outline: Outline) -> None:
    numbers = {heading.anchor: heading.number for heading in outline.chapter_headings(2)}
    assert numbers["sec:overview"] == "2.1"
    assert numbers["sec:schematic"] == "2.7"


def test_outline_inserts_the_generated_troubleshooting_headings(outline: Outline) -> None:
    generated = [
        (heading.number, heading.anchor)
        for heading in outline.chapter_headings(8)
        if heading.generated
    ]
    assert generated == [
        ("8.3", "cond:oil_temperature_high"),
        ("8.4", "cond:low_line_pressure"),
        ("8.5", "cond:frequent_cycling"),
    ]
    assert outline.by_anchor["sec:after-repair"].number == "8.6"


def test_outline_inserts_the_generated_maintenance_headings(outline: Outline) -> None:
    generated = [
        (heading.number, heading.level, heading.anchor)
        for heading in outline.chapter_headings(7)
        if heading.generated
    ]
    assert generated == [("7.1.1", 3, "task:oil_change"), ("7.1.2", 3, "task:daily_checks")]


def test_outline_numbers_figures_per_chapter(outline: Outline) -> None:
    assert outline.figure_number(2, 1) == "2.1"
    assert outline.figure_number(3, 2) == "3.2"
    with pytest.raises(ContextError, match="1-based"):
        outline.figure_number(3, 0)


def test_outline_rejects_an_unknown_anchor(outline: Outline) -> None:
    assert outline.has("sec:overview") is True
    assert outline.has("sec:nowhere") is False
    with pytest.raises(ContextError, match="unknown cross-reference anchor"):
        outline.reference("sec:nowhere")


@pytest.mark.parametrize(
    ("anchor", "expected"),
    [
        ("sec:overview", "2.1"),
        ("cond:low_line_pressure", "8.4"),
        ("task:oil_change", "task 7.1.1"),
        ("fault:oil_cooler_fouled", "Oil cooler fouled (section 8.3)"),
        ("alarm:W104", "message W104 (section 3.4)"),
        ("setting:cut_out_pressure", "parameter P02 (section 4.1)"),
        ("signal:line_pressure", "P2 (section 9.1)"),
        ("part:oil_filter_element", "part CAU7-OF-01 (section 9.2)"),
        ("ch:3", "chapter 3"),
    ],
)
def test_outline_label_follows_the_plan(outline: Outline, anchor: str, expected: str) -> None:
    assert outline.label(anchor) == expected


# --- ref() in both cross-reference styles ---------------------------------


@pytest.mark.parametrize(
    ("anchor", "element_id", "label"),
    [
        ("sec:overview", "sec-overview", "section 2.1"),
        ("cond:low_line_pressure", "cond-low_line_pressure", "section 8.4"),
        ("task:oil_change", "task-oil_change", "task 7.1.1"),
        ("fault:oil_cooler_fouled", "fault-oil_cooler_fouled", "Oil cooler fouled (section 8.3)"),
        ("alarm:W104", "alarm-W104", "message W104 (section 3.4)"),
        ("setting:cut_out_pressure", "setting-cut_out_pressure", "parameter P02 (section 4.1)"),
        ("signal:line_pressure", "signal-line_pressure", "P2 (section 9.1)"),
        ("part:oil_filter_element", "part-oil_filter_element", "part CAU7-OF-01 (section 9.2)"),
        ("ch:3", "ch-3", "chapter 3"),
    ],
)
def test_ref_spells_the_section_out_in_clean(
    clean: context.ManualEnvironment, anchor: str, element_id: str, label: str
) -> None:
    rendered = render_text(clean, "{{ ref('" + anchor + "') }}")
    assert rendered == f'<a class="xref" href="#{element_id}">{label}</a>'


@pytest.mark.parametrize(
    ("anchor", "label"),
    [
        ("sec:overview", "2.1"),
        ("cond:low_line_pressure", "8.4"),
        ("task:oil_change", "task 7.1.1"),
        ("fault:oil_cooler_fouled", "Oil cooler fouled (8.3)"),
        ("alarm:W104", "message W104 (3.4)"),
        ("setting:cut_out_pressure", "parameter P02 (4.1)"),
        ("signal:line_pressure", "P2 (9.1)"),
        ("part:oil_filter_element", "part CAU7-OF-01 (9.2)"),
        ("ch:3", "chapter 3"),
    ],
)
def test_ref_shortens_and_footnotes_in_realistic(
    realistic: context.ManualEnvironment, anchor: str, label: str
) -> None:
    rendered = render_partial(realistic, 2, "{{ ref('" + anchor + "') }}\n")
    assert f">{label}</a>[^xref-1]" in rendered
    assert rendered.rstrip().endswith("[^xref-1]: " + realistic_footnote(realistic, anchor))


def realistic_footnote(environment: context.ManualEnvironment, anchor: str) -> str:
    outline: Outline = environment.globals["outline"]
    return outline.reference(anchor).footnote


def test_ref_reuses_one_footnote_per_anchor(realistic: context.ManualEnvironment) -> None:
    rendered = render_partial(realistic, 2, "{{ ref('sec:overview') }} {{ ref('sec:overview') }}\n")
    assert rendered.count("[^xref-1]:") == 1
    assert rendered.count("[^xref-2]") == 0


def test_ref_numbers_footnotes_per_partial(realistic: context.ManualEnvironment) -> None:
    rendered = render_partial(realistic, 2, "{{ ref('sec:overview') }} {{ ref('ch:3') }}\n")
    assert "[^xref-1]" in rendered
    assert "[^xref-2]" in rendered
    second = render_partial(realistic, 3, "{{ ref('ch:3') }}\n")
    assert "[^xref-1]" in second
    assert "[^xref-2]" not in second


def test_a_text_field_never_emits_a_footnote(realistic: context.ManualEnvironment) -> None:
    rendered = render_text(realistic, "See {{ ref('sec:overview') }}.")
    assert rendered == 'See <a class="xref" href="#sec-overview">section 2.1</a>.'


def test_ref_raises_for_an_anchor_outside_the_outline(clean: context.ManualEnvironment) -> None:
    with pytest.raises(ContextError, match="unknown cross-reference anchor"):
        render_text(clean, "{{ ref('sec:nowhere') }}")


# --- figure(), tables and the namespace -----------------------------------


def test_figure_numbers_per_chapter(clean: context.ManualEnvironment) -> None:
    rendered = render_partial(clean, 3, "{{ figure('control-panel', 'Front of the unit') }}\n")
    assert 'src="figures/control-panel.svg"' in rendered
    assert "Figure 3.1 — Front of the unit" in rendered


def test_figure_counts_from_one_in_every_partial(clean: context.ManualEnvironment) -> None:
    template = "{{ figure('a', 'one') }}{{ figure('b', 'two') }}\n"
    rendered = render_partial(clean, 2, template)
    assert "Figure 2.1 — one" in rendered
    assert "Figure 2.2 — two" in rendered
    assert "Figure 2.1 — one" in render_partial(clean, 2, template)


def test_tables_emit_the_generated_headings_with_ids(clean: context.ManualEnvironment) -> None:
    rendered = render_partial(clean, 8, "{{ tables.troubleshooting() }}\n")
    assert '<h2 id="cond-oil_temperature_high">8.3 Oil temperature high</h2>' in rendered
    assert '<tr id="fault-oil_cooler_fouled">' in rendered


def test_every_table_macro_renders(clean: context.ManualEnvironment) -> None:
    for name in context.TABLE_MACROS:
        chapter = 7 if name == "maintenance_procedures" else 8
        rendered = render_partial(clean, chapter, "{{ tables." + name + "() }}\n")
        assert "<table" in rendered or "<h" in rendered


def test_a_generated_table_renders_the_jinja_of_a_text_field(
    tmp_path: Path, partials: dict[int, str], mutate: Any
) -> None:
    """``steps`` and ``remedy`` hold Jinja, so a cell must not print them verbatim."""
    mutated = mutate(
        SPEC_MINIMAL,
        tmp_path,
        "maintenance",
        "/tasks/1/steps/0",
        "Read {{ sig('oil_temperature') }} as {{ ref('sec:overview') }} describes.",
    )
    mutated = mutate(
        mutated,
        tmp_path / "remedy",
        "faults",
        "/causes/0/remedy",
        "Clean the cooler block, then repeat {{ ref('sec:cooling') }}.",
    )
    spec = load_spec(mutated)
    environment = make_env(spec, "realistic", build_outline(spec, partials))

    procedures = render_partial(environment, 7, "{{ tables.maintenance_procedures() }}\n")
    assert "{{" not in procedures
    assert "Read oil temperature (T1) as " in procedures
    assert '<a class="xref" href="#sec-overview">section 2.1</a>' in procedures

    troubleshooting = render_partial(environment, 8, "{{ tables.troubleshooting() }}\n")
    assert "{{" not in troubleshooting
    assert '<a class="xref" href="#sec-cooling">section 2.4</a>' in troubleshooting


def test_a_generated_table_leaves_the_partials_footnotes_alone(
    realistic: context.ManualEnvironment,
) -> None:
    """A cell's text field is rendered inside the partial, not instead of it."""
    rendered = render_partial(
        realistic,
        7,
        "Before {{ ref('sec:overview') }}.\n\n{{ tables.maintenance_procedures() }}\n\n"
        "After {{ ref('sec:cooling') }}.\n",
    )
    assert "[^xref-1]" in rendered
    assert "[^xref-2]" in rendered
    assert rendered.count("[^xref-1]: ") == 1
    assert rendered.count("[^xref-2]: ") == 1


def test_build_context_exposes_the_namespace_of_the_plan(spec: Spec) -> None:
    namespace = build_context(spec, "realistic")
    assert set(namespace) == {
        "machine",
        "signals",
        "signal",
        "settings",
        "setting",
        "alarms",
        "alarm",
        "faults",
        "condition",
        "cause",
        "maintenance",
        "task",
        "bands",
        "build",
        "doc",
    }
    assert namespace["doc"]["number"] == "CAU7-IOM-EN"
    assert namespace["doc"]["source_date_epoch"] == 1768435200
    assert namespace["build"]["variant"]["name"] == "realistic"


def test_lookup_functions_reach_every_registry(clean: context.ManualEnvironment) -> None:
    rendered = render_text(
        clean,
        "{{ signal('oil_temperature').panel_label }}/{{ setting('cut_in_pressure').param_no }}/"
        "{{ alarm('W104').type }}/{{ condition('frequent_cycling').title }}/"
        "{{ cause('oil_cooler_fouled').subsystem }}/{{ task('oil_change').name }}",
    )
    assert rendered == "T1/P01/warning/Compressor starts and loads too often/cooling/Oil change"


# --- variants and StrictUndefined -----------------------------------------


def test_variant_knobs_resolve_extends(spec: Spec) -> None:
    scanned = variant_knobs(spec.build or {}, "scanned")
    assert scanned["name"] == "scanned"
    assert scanned["units"] == "si_plus_imperial"
    assert scanned["raster_dpi"] == 200
    assert "extends" not in scanned


def test_variant_knobs_reject_an_unknown_variant(spec: Spec) -> None:
    with pytest.raises(ContextError, match="no variant"):
        variant_knobs(spec.build or {}, "glossy")


def test_strict_undefined_raises_on_an_unknown_name(clean: context.ManualEnvironment) -> None:
    with pytest.raises(jinja2.UndefinedError):
        render_text(clean, "{{ not_a_name }}")
    with pytest.raises(jinja2.UndefinedError):
        render_partial(clean, 2, "{{ machine.identity.not_a_field }}\n")


def test_a_heading_anchor_is_not_a_jinja_comment(clean: context.ManualEnvironment) -> None:
    rendered = render_partial(clean, 2, "## Overview {#sec:overview}\n")
    assert rendered.strip() == "## Overview {#sec:overview}"


# --- Markdown -------------------------------------------------------------


def test_md_to_html_moves_the_heading_anchor_to_an_id() -> None:
    rendered = md_to_html("## Air flow {#sec:air-flow}\n", footnotes=False)
    assert rendered.strip() == '<h2 id="sec-air-flow">Air flow</h2>'


def test_md_to_html_renders_tables_and_raw_html() -> None:
    rendered = md_to_html("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n<p>raw</p>\n", footnotes=False)
    assert "<th>a</th>" in rendered
    assert "<p>raw</p>" in rendered


def test_md_to_html_renders_footnotes_only_when_asked() -> None:
    text = "Body[^xref-1]\n\n[^xref-1]: Section 2.1, Overview\n"
    assert "footnote-ref" in md_to_html(text, footnotes=True)
    assert "footnote-ref" not in md_to_html(text, footnotes=False)


# --- purity (task acceptance) ---------------------------------------------


def test_context_imports_nothing_beyond_its_contract() -> None:
    tree = ast.parse((TOOLS / "context.py").read_text(encoding="utf-8"))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    allowed = {
        "__future__",
        "collections",
        "dataclasses",
        "figure_checks",
        "html",
        "jinja2",
        "load",
        "markdown_it",
        "math",
        "mdit_py_plugins",
        "pathlib",
        "re",
        "sys",
        "typing",
        "yaml",
    }
    assert roots <= allowed, f"unexpected imports: {sorted(roots - allowed)}"


def test_context_writes_nothing(tmp_path: Path, spec: Spec, outline: Outline) -> None:
    before = sorted(tmp_path.iterdir())
    environment = make_env(spec, "realistic", outline)
    render_partial(environment, 3, (CONTENT_MINIMAL / "03-controller.md").read_text("utf-8"))
    assert sorted(tmp_path.iterdir()) == before
