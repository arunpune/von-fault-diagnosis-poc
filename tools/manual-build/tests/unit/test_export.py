# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``tools/eval/fixtures/catalog.json``.

The export is the interface between the manual and the evaluation, so the tests here
guard the four things a consumer relies on: the shape validates against the
fixture schema, the ``causes[*].conditions`` inverse index really is the
inverse of ``conditions[*].causes``, no text field carries markup a PDF would
never show, and two runs of the exporter write the same bytes.

``pages`` is exercised with stub page texts rather than a rendered PDF, so the
lookup is covered without the ``weasyprint`` marker.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from fdp_manual_build import numbering
from fdp_manual_build.build import read_sources
from fdp_manual_build.config import BuildConfig
from fdp_manual_build.errors import BuildError
from fdp_manual_build.export import (
    SCHEMA,
    SOURCE,
    catalog_document,
    export_catalog,
    interval_text,
    main,
    plain_text,
    validate_catalog,
)
from fdp_manual_build.model import Manual
from fdp_manual_build.numbering import SectionMap
from fdp_manual_build.templating import Sources, make_templating

PROVENANCE = {
    "file": "mini-spec/build.yaml",
    "sha256": "0" * 64,
    "variant": "realistic",
}


@pytest.fixture(scope="module")
def sources(request: pytest.FixtureRequest) -> Sources:
    repo_root: Path = request.getfixturevalue("repo_root")
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    return read_sources(cfg, repo_root)


@pytest.fixture(scope="module")
def sections(request: pytest.FixtureRequest, sources: Sources) -> SectionMap:
    manual: Manual = request.getfixturevalue("mini_manual")
    return numbering.scan(sources.chapters, numbering.generated_sections(manual))


@pytest.fixture(scope="module")
def resolved(
    request: pytest.FixtureRequest, sources: Sources, sections: SectionMap
) -> Iterator[tuple[Manual, Any]]:
    """The mini manual with every text field resolved, plus the manual's ``move_text``."""
    cfg: BuildConfig = request.getfixturevalue("mini_config")
    manual: Manual = request.getfixturevalue("mini_manual")
    rendering = make_templating(cfg, cfg.variant("realistic"), manual, sections, sources)
    yield rendering.resolve(manual), rendering.env.globals["move_text"]


@pytest.fixture
def document(
    resolved: tuple[Manual, Any], sections: SectionMap, mini_manual: Manual
) -> dict[str, Any]:
    manual, move_text = resolved
    return catalog_document(manual, sections, {}, generated_from=PROVENANCE, move_text=move_text)


# --- shape -----------------------------------------------------------------


def test_the_document_validates_against_the_fixture_schema(document: dict[str, Any]) -> None:
    validate_catalog(document)
    assert document["schema"] == SCHEMA
    assert document["generated_from"]["variant"] == "realistic"


def test_the_machine_block_names_the_fictional_unit(
    document: dict[str, Any], mini_manual: Manual
) -> None:
    identity = mini_manual.machine.identity
    assert document["machine"] == {
        "name": identity.name,
        "short_name": identity.model,
        "controller": identity.controller,
    }


def test_every_registry_is_exported_once_in_source_order(
    document: dict[str, Any], mini_manual: Manual
) -> None:
    assert [item["id"] for item in document["signals"]] == [
        signal.id for signal in mini_manual.signals
    ]
    assert [item["code"] for item in document["alarms"]] == [
        alarm.code for alarm in mini_manual.alarms
    ]
    assert [item["id"] for item in document["conditions"]] == [
        condition.id for condition in mini_manual.conditions
    ]
    assert [item["fault_id"] for item in document["causes"]] == list(mini_manual.causes)
    assert [item["id"] for item in document["maintenance"]] == [
        task.id for task in mini_manual.maintenance
    ]
    assert [item["id"] for item in document["parameters"]] == [
        parameter.id for parameter in mini_manual.parameters
    ]


def test_the_ids_are_the_manuals_registry_ids(document: dict[str, Any]) -> None:
    """No ``F-NNN``, no ``C-NN``, no ``W-021``: the manual's own registry ids."""
    fault_ids = [item["fault_id"] for item in document["causes"]]
    assert "downstream_air_leak" in fault_ids
    assert all("-" not in fault_id for fault_id in fault_ids)
    assert [item["code"] for item in document["alarms"]] == ["W104", "S301", "W120", "M401"]


def test_a_message_carries_its_resolved_threshold_and_delay(document: dict[str, Any]) -> None:
    by_code = {item["code"]: item for item in document["alarms"]}
    assert by_code["W120"]["threshold"] == {"value": 7.5, "unit": "bar"}
    assert by_code["W120"]["direction"] == "below"
    assert by_code["W120"]["signal"] == "line_pressure"
    assert by_code["W120"]["delay_s"] == 600
    assert by_code["M401"]["threshold"] is None
    assert by_code["M401"]["delay_s"] is None
    assert by_code["M401"]["bit"] is None


def test_a_signal_carries_its_range_and_its_bands(document: dict[str, Any]) -> None:
    by_id = {item["id"]: item for item in document["signals"]}
    assert by_id["line_pressure"]["range"] == [-1.0, 16.0]
    assert by_id["line_pressure"]["normal_band"]["loaded"] == [8.0, 10.1]
    assert by_id["intake_closed"]["normal_band"]["unloaded"] == 1
    assert by_id["ambient_temperature"]["metropt_column"] is None


def test_every_entry_says_where_it_is_printed(document: dict[str, Any]) -> None:
    assert {item["section"] for item in document["alarms"]} == {"3.1"}
    assert {item["section"] for item in document["parameters"]} == {"4.1"}
    assert {item["section"] for item in document["signals"]} == {"9.1"}
    assert [item["section"] for item in document["conditions"]] == ["8.2", "8.3", "8.4"]
    assert [item["section"] for item in document["maintenance"]] == ["7.2.1", "7.2.2"]


# --- the per-cause entry ---------------------------------------------------


def test_a_cause_entry_carries_mans_per_cause_fields(document: dict[str, Any]) -> None:
    entry = next(item for item in document["causes"] if item["fault_id"] == "oil_filter_clogged")
    assert entry["name"] == "Oil filter clogged"
    assert entry["subsystem"] == "oil"
    assert entry["benign"] is False
    assert entry["source"] == SOURCE
    assert entry["parts"] == ["oil_filter_element", "compressor_oil"]
    assert entry["maintenance"] == ["oil_change"]
    assert entry["related_alarms"] == ["W104", "S301"]
    assert entry["manual_ref"] == {
        "section": "8.2",
        "anchor": "fault:oil_filter_clogged",
        "title": "Oil temperature high",
    }
    assert "pages" not in entry


def test_the_condition_index_of_a_cause_is_the_inverse_of_the_cause_list(
    document: dict[str, Any],
) -> None:
    forward = {
        (entry["fault_id"], condition["id"])
        for condition in document["conditions"]
        for entry in condition["causes"]
    }
    backward = {
        (cause["fault_id"], listed["condition_id"])
        for cause in document["causes"]
        for listed in cause["conditions"]
    }
    assert forward == backward
    shared = next(item for item in document["causes"] if item["fault_id"] == "high_air_demand")
    assert [listed["condition_id"] for listed in shared["conditions"]] == [
        "oil_temperature_high",
        "low_line_pressure",
        "frequent_cycling",
    ]
    assert [listed["likelihood"] for listed in shared["conditions"]] == [
        "occasional",
        "common",
        "occasional",
    ]


def test_a_signal_move_keeps_mans_vocabulary_and_its_rendered_sentence(
    document: dict[str, Any],
) -> None:
    entry = next(item for item in document["causes"] if item["fault_id"] == "oil_cooler_fouled")
    assert entry["signal_moves"][0] == {
        "signal": "oil_temperature",
        "direction": "rises",
        "phase": "any",
        "onset": "gradual",
        "text": "Oil temperature (T1) rises gradually in every state.",
    }
    assert entry["signal_moves"][1]["behaviour"] == "load_cycle_rate"
    assert entry["signal_moves_text"] == [move["text"] for move in entry["signal_moves"]]


def test_without_move_text_the_sentences_stay_empty(
    resolved: tuple[Manual, Any], sections: SectionMap
) -> None:
    manual, _ = resolved
    document = catalog_document(manual, sections, {}, generated_from=PROVENANCE)
    validate_catalog(document)
    assert all(entry["signal_moves_text"] == [] for entry in document["causes"])
    assert all("text" not in move for entry in document["causes"] for move in entry["signal_moves"])


# --- text ------------------------------------------------------------------


def test_plain_text_strips_the_markup_a_helper_emitted() -> None:
    assert plain_text('see <a class="xref" href="#x">section 4.1</a>') == "see section 4.1"
    assert plain_text("a &amp; b\n  c") == "a & b c"


def test_no_text_field_carries_html(document: dict[str, Any]) -> None:
    texts = [
        value
        for entry in document["causes"]
        for value in [entry["summary"], entry["remedy"], *entry["checks"]]
    ]
    texts += [condition["symptom"] for condition in document["conditions"]]
    texts += [alarm["text"] for alarm in document["alarms"] if "text" in alarm]
    assert texts
    assert not [text for text in texts if "<" in text or "&" in text]


def test_the_text_is_resolved_for_the_variant(
    resolved: tuple[Manual, Any], sections: SectionMap
) -> None:
    """``num()`` in a YAML sentence prints the imperial value in ``realistic``."""
    manual, move_text = resolved
    document = catalog_document(
        manual, sections, {}, generated_from=PROVENANCE, move_text=move_text
    )
    assert "{{" not in json.dumps(document)


def test_interval_text_reads_the_authored_interval(mini_manual: Manual) -> None:
    assert interval_text(mini_manual.task("oil_change").interval) == "4000 h / 12 months"
    assert interval_text(mini_manual.task("daily_checks").interval) == "daily"


# --- page lookup -----------------------------------------------------------


def test_pages_are_looked_up_in_the_page_texts_of_each_variant(
    resolved: tuple[Manual, Any], sections: SectionMap
) -> None:
    manual, move_text = resolved
    pages = {
        "clean": ["cover", "oil_cooler_fouled here", "", "oil_cooler_fouled again"],
        "realistic": ["", "", "oil_cooler_fouled"],
    }
    document = catalog_document(
        manual, sections, pages, generated_from=PROVENANCE, move_text=move_text
    )
    validate_catalog(document)
    entry = next(item for item in document["causes"] if item["fault_id"] == "oil_cooler_fouled")
    assert entry["pages"] == {"clean": [2, 4], "realistic": [3]}
    missing = next(item for item in document["causes"] if item["fault_id"] == "high_air_demand")
    assert missing["pages"] == {"clean": [], "realistic": []}


# --- validation and writing ------------------------------------------------


def test_an_invalid_document_is_refused_with_its_pointer(document: dict[str, Any]) -> None:
    document["causes"][0]["subsystem"] = "not_a_subsystem"
    with pytest.raises(BuildError, match="causes"):
        validate_catalog(document)


def test_a_cause_no_condition_lists_cannot_be_exported(
    resolved: tuple[Manual, Any], sections: SectionMap
) -> None:
    import dataclasses  # noqa: PLC0415 - one rewrite of the frozen model, for this test only

    manual, _ = resolved
    orphaned = dataclasses.replace(manual, conditions=manual.conditions[:1])
    with pytest.raises(BuildError, match="downstream_air_leak"):
        catalog_document(orphaned, sections, {}, generated_from=PROVENANCE)


def test_two_runs_write_the_same_bytes(
    resolved: tuple[Manual, Any], sections: SectionMap, tmp_path: Path
) -> None:
    manual, move_text = resolved
    first, second = tmp_path / "one.json", tmp_path / "two.json"
    for target in (first, second):
        export_catalog(
            manual,
            sections,
            {},
            target,
            generated_from=PROVENANCE,
            move_text=move_text,
        )
    assert first.read_bytes() == second.read_bytes()
    text = first.read_text(encoding="utf-8")
    assert text.endswith("}\n")
    assert '\n  "alarms"' in text
    assert json.loads(text)["schema"] == SCHEMA


# --- the command line ------------------------------------------------------


def test_the_subcommand_writes_and_validates_the_catalog(
    repo_root: Path, mini_spec_dir: Path, tmp_path: Path
) -> None:
    out_path = tmp_path / "catalog.json"
    argv = ["--repo-root", str(mini_spec_dir), "--out", str(out_path)]
    assert main(argv, repo_root) == 0
    document = json.loads(out_path.read_text(encoding="utf-8"))
    validate_catalog(document)
    assert document["generated_from"]["variant"] == "realistic"
    assert document["generated_from"]["file"] == "mini-spec/build.yaml"
    assert len(document["generated_from"]["sha256"]) == 64
    assert len(document["generated_from"]["inputs_tree_sha256"]) == 64


def test_the_subcommand_can_resolve_the_text_of_the_clean_variant(
    repo_root: Path, mini_spec_dir: Path, tmp_path: Path
) -> None:
    out_path = tmp_path / "clean.json"
    argv = ["--repo-root", str(mini_spec_dir), "--out", str(out_path), "--variant", "clean"]
    assert main(argv, repo_root) == 0
    assert json.loads(out_path.read_text(encoding="utf-8"))["generated_from"]["variant"] == "clean"


def test_the_subcommand_reports_an_unusable_manual_tree(
    repo_root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["--repo-root", str(tmp_path)], repo_root) == 2
    assert "build.yaml" in capsys.readouterr().err
