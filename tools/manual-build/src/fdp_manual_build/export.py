# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``tools/eval/fixtures/catalog.json``: the reference catalog.

The document is the contracts ``catalog`` (``packages/contracts``) — the
machine, the signal, message, condition, maintenance and parameter registries,
and one ``catalog-entry`` per cause in the manual's shape. It is what the
evaluation compares init's PDF-derived catalog against, so three properties
matter more than anything else:

* **the ids are the manual's**: ``downstream_air_leak``, ``W104``,
  never ``F-012`` or ``W-021``;
* **the text is resolved but plain**: every ``*_md`` field has been through the
  Jinja pass of one variant, so a sentence carries the numbers the manual
  prints, and every tag a helper emitted is stripped again, so the string can
  be compared with text extracted from a PDF;
* **the bytes are a function of the sources**: sorted keys, two-space indent, a
  trailing newline, no clock and no path outside the manual tree.

``pages`` is filled from the page texts of a rendered variant — the pages a
``fault_id`` is printed on — and is left out entirely when nothing was
rendered, which is what ``--html-only`` and the standalone ``export-catalog``
command do.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final, cast

# jsonschema 4.26.0 ships no stubs; nothing else needs them.
import jsonschema  # type: ignore[import-untyped]

from fdp_manual_build import build, manifest, numbering, render, templating
from fdp_manual_build.config import BuildConfig, load_build_config
from fdp_manual_build.errors import BuildError
from fdp_manual_build.load import load_manual
from fdp_manual_build.model import (
    Alarm,
    AlarmLeaf,
    Cause,
    Condition,
    DigitalBand,
    Interval,
    MaintenanceTask,
    Manual,
    Parameter,
    Quantity,
    SettingRef,
    Signal,
    SignalMove,
)
from fdp_manual_build.units import format_number

if TYPE_CHECKING:  # pragma: no cover - typing only
    from fdp_manual_build.build import BuildResult
    from fdp_manual_build.numbering import SectionMap

__all__ = [
    "DIRECTIONS",
    "FIXTURE_SCHEMA",
    "HOST_SECTIONS",
    "SCHEMA",
    "SOURCE",
    "MoveText",
    "PageTexts",
    "catalog_document",
    "catalog_from_build",
    "export_catalog",
    "fixture_schema",
    "interval_text",
    "main",
    "page_texts",
    "plain_text",
    "validate_catalog",
    "write_catalog",
]

#: ``schema`` of the document.
SCHEMA: Final = "urn:fdp:schema:catalog:v1"
#: The package-local JSON Schema the export validates against; the contracts
#: package validates the committed file against ``@fdp/contracts`` as well.
FIXTURE_SCHEMA: Final = Path(__file__).with_name("schemas") / "catalog-fixture.schema.json"
#: ``source`` of every entry this module writes: the YAML sources, not a PDF.
SOURCE: Final = "yaml"

#: Comparison operator → the direction word ``catalog-entry`` consumers read.
DIRECTIONS: Final[Mapping[str, str]] = {
    "gt": "above",
    "gte": "above",
    "lt": "below",
    "lte": "below",
    "eq": "equal",
    "ne": "not_equal",
}

#: Registry → the prose anchor whose number a registry entry is found under.
#: A tree without the section simply carries
#: no ``section`` for those entries, which the schema allows.
HOST_SECTIONS: Final[Mapping[str, str]] = {
    "signal": "sec:signal-list",
    "alarm": "sec:message-list",
    "parameter": "sec:settings-table",
}

#: Per-variant page texts, in page order, as ``render.extract_pages`` returns them.
type PageTexts = Mapping[str, Sequence[str]]
#: The manual's ``move_text(fault_id)``: one rendered sentence per ``signal_moves`` entry.
type MoveText = Callable[[str], Sequence[str]]

_INDENT: Final = 2
_TAG: Final = re.compile(r"<[^>]+>")
_SPACE: Final = re.compile(r"\s+")
_EXIT_OK: Final = 0
_EXIT_ERROR: Final = 2


# --- text and numbers ------------------------------------------------------


def plain_text(value: str) -> str:
    """Strip the HTML a Jinja helper emitted and collapse the whitespace.

    ``ref()`` renders an ``<a class="xref">`` even inside a YAML sentence, so a
    resolved ``*_md`` field is Markdown with a little HTML in it. The catalog
    stores the sentence a reader sees, which is what init extracts from the PDF.
    """
    return _SPACE.sub(" ", html.unescape(_TAG.sub("", value))).strip()


def interval_text(interval: Interval) -> str:
    """When a maintenance task falls due, as chapter 7 prints it.

    ``manual/templates/partials/table-maintenance.html.j2`` builds the same
    string in Jinja for the schedule table; ``test_data_chapters.py`` compares
    the two for every task of the fixture so they cannot drift apart.
    """
    parts = [
        f"{format_number(interval.hours)} h" if interval.hours is not None else None,
        f"{format_number(interval.months)} months" if interval.months is not None else None,
        interval.calendar,
        f"replacement at {format_number(interval.replacement_hours)} h"
        if interval.replacement_hours is not None
        else None,
    ]
    named = [part for part in parts if part]
    return " / ".join(named) if named else "as required"


# --- the document ----------------------------------------------------------


def catalog_document(
    manual: Manual,
    sections: SectionMap,
    pages_by_variant: PageTexts,
    *,
    generated_from: Mapping[str, str],
    move_text: MoveText | None = None,
) -> dict[str, Any]:
    """Build the ``catalog`` document of one manual.

    Args:
        manual: the model with every ``*_md`` field already Jinja-resolved for
            the variant named in ``generated_from``.
        sections: the outline, which gives every entry its section number.
        pages_by_variant: variant name → the text of each rendered page. An
            empty mapping leaves ``pages`` out of every entry.
        generated_from: the provenance block; ``file``, ``sha256`` and
            ``variant`` are required.
        move_text: the manual's ``move_text``, which renders the ``signal_moves``
            sentences. Without it ``signal_moves_text`` stays empty.

    Raises:
        BuildError: when a cause is listed by no condition, so the entry would
            have no ``manual_ref`` to point at.
    """
    pages = {name: list(texts) for name, texts in pages_by_variant.items()}
    return {
        "schema": SCHEMA,
        "generated_from": dict(generated_from),
        "machine": {
            "name": manual.machine.identity.name,
            "short_name": manual.machine.identity.model,
            "controller": manual.machine.identity.controller,
        },
        "signals": [_signal(signal, sections) for signal in manual.signals],
        "alarms": [_alarm(alarm, manual, sections) for alarm in manual.alarms],
        "conditions": [_condition(condition, sections) for condition in manual.conditions],
        "causes": [
            _cause(manual.cause(fault_id), manual, sections, pages, move_text)
            for fault_id in _cause_order(manual)
        ],
        "maintenance": [_task(task, sections) for task in manual.maintenance],
        "parameters": [_parameter(parameter, sections) for parameter in manual.parameters],
    }


def _cause_order(manual: Manual) -> tuple[str, ...]:
    """Every ``fault_id`` in the order ``faults.yaml`` declares them."""
    return tuple(manual.causes)


def _section(sections: SectionMap, anchor: str) -> str | None:
    reference = sections.get(anchor)
    return None if reference is None else reference.number


def _with_section(entry: dict[str, Any], sections: SectionMap, anchor: str) -> dict[str, Any]:
    number = _section(sections, anchor)
    if number is not None:
        entry["section"] = number
    return entry


def _signal(signal: Signal, sections: SectionMap) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": signal.id,
        "panel_label": signal.panel_label,
        "name": signal.name,
        "metropt_column": signal.metropt_column,
        "group": signal.group,
        "kind": signal.kind,
        "unit": signal.unit,
        "subsystem": signal.subsystem,
        "normal_band": {
            state: (band.expected if isinstance(band, DigitalBand) else [band.low, band.high])
            for state, band in signal.normal_bands.items()
        },
    }
    if signal.range is not None:
        entry["range"] = [signal.range.min, signal.range.max]
    return _with_section(entry, sections, HOST_SECTIONS["signal"])


def _leaf(alarm: Alarm) -> AlarmLeaf | None:
    """The comparison a message's threshold and direction are read from."""
    condition = alarm.trigger.condition
    if condition is None or not condition.leaves:
        return None
    return condition.leaves[0]


def _resolve(value: Quantity | SettingRef, manual: Manual, unit: str | None) -> dict[str, Any]:
    """A threshold as ``{value, unit}``, following a reference to a setting."""
    if isinstance(value, Quantity):
        return {"value": value.value, "unit": unit or value.unit}
    setting = manual.parameter(value.setting)
    return {"value": setting.default + value.offset, "unit": unit or setting.unit}


def _compared(manual: Manual, signal_id: str) -> tuple[str, str]:
    """The id and unit of the quantity a message condition compares.

    Validator rule R1 lets a message compare a *derived* signal instead of a
    measured tag — ``W102`` weighs ``continuous_load_time`` against a setting —
    and ``signals.yaml`` keeps those in their own pool, so resolve against the
    measured tags first and fall back to the derived ones, exactly as the manual's
    ``sig()`` and ``thr()`` do.

    Raises:
        BuildError: when neither pool holds ``signal_id``.
    """
    try:
        signal = manual.signal(signal_id)
    except KeyError:
        pass
    else:
        return signal.id, signal.unit
    for derived in manual.derived_signals:
        if derived.id == signal_id:
            return derived.id, derived.unit
    raise BuildError(f"catalog: no measured or derived signal {signal_id!r}")


def _delay_seconds(alarm: Alarm, manual: Manual) -> int | None:
    for_s = alarm.trigger.for_s
    if for_s is None:
        return None
    if isinstance(for_s, SettingRef):
        return int(manual.parameter(for_s.setting).default + for_s.offset)
    return int(for_s)


def _alarm(alarm: Alarm, manual: Manual, sections: SectionMap) -> dict[str, Any]:
    leaf = _leaf(alarm)
    entry: dict[str, Any] = {
        "code": alarm.code,
        "type": alarm.type,
        "bit": alarm.bit,
        "title": alarm.title,
        "reset": alarm.reset.mode,
        "threshold": None,
        "delay_s": _delay_seconds(alarm, manual),
    }
    if leaf is not None:
        signal_id, unit = _compared(manual, leaf.signal)
        entry["threshold"] = _resolve(leaf.threshold, manual, unit)
        entry["signal"] = signal_id
        entry["direction"] = DIRECTIONS[leaf.op]
    text = alarm.operator_action_md or alarm.cause_hint_md
    if text:
        entry["text"] = plain_text(text)
    return _with_section(entry, sections, HOST_SECTIONS["alarm"])


def _condition(condition: Condition, sections: SectionMap) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": condition.id,
        "title": condition.title,
        "symptom": plain_text(condition.symptom_md),
        "alarms": list(condition.alarms),
        "causes": [
            {"fault_id": item.fault_id, "likelihood": item.likelihood}
            | ({"note": plain_text(item.note_md)} if item.note_md else {})
            for item in condition.causes
        ],
    }
    return _with_section(entry, sections, f"cond:{condition.id}")


def _conditions_of(cause: Cause, manual: Manual) -> tuple[Condition, ...]:
    """Every condition that lists ``cause``, in document order."""
    return tuple(
        condition
        for condition in manual.conditions
        if any(item.fault_id == cause.fault_id for item in condition.causes)
    )


def _signal_move(move: SignalMove, text: str | None) -> dict[str, Any]:
    entry: dict[str, Any] = {"direction": move.direction}
    if move.signal is not None:
        entry["signal"] = move.signal
    if move.behaviour is not None:
        entry["behaviour"] = move.behaviour
    if move.phase is not None:
        entry["phase"] = move.phase
    if move.onset is not None:
        entry["onset"] = move.onset
    if move.note_md:
        entry["note"] = plain_text(move.note_md)
    if text:
        entry["text"] = text
    return entry


def _found_on(pages: Sequence[str], needle: str) -> list[int]:
    """The 1-based pages whose extracted text holds ``needle``."""
    return [number for number, text in enumerate(pages, start=1) if needle in text]


def _cause(
    cause: Cause,
    manual: Manual,
    sections: SectionMap,
    pages_by_variant: Mapping[str, Sequence[str]],
    move_text: MoveText | None,
) -> dict[str, Any]:
    conditions = _conditions_of(cause, manual)
    if not conditions:
        raise BuildError(
            f"cause {cause.fault_id!r} is listed by no condition, so the catalog entry "
            "has no section to point at"
        )
    sentences = list(move_text(cause.fault_id)) if move_text is not None else []
    entry: dict[str, Any] = {
        "fault_id": cause.fault_id,
        "name": cause.name,
        "subsystem": cause.subsystem,
        "benign": cause.benign,
        "summary": plain_text(cause.summary_md),
        "signal_moves": [
            _signal_move(move, sentences[index] if index < len(sentences) else None)
            for index, move in enumerate(cause.signal_moves)
        ],
        "signal_moves_text": [plain_text(sentence) for sentence in sentences],
        "checks": [plain_text(check) for check in cause.checks_md],
        "remedy": plain_text(cause.remedy_md),
        "conditions": [_cause_condition(cause, condition) for condition in conditions],
        "parts": list(cause.parts),
        "maintenance": list(cause.maintenance),
        "related_alarms": _unique(code for item in conditions for code in item.alarms),
        "manual_ref": _manual_ref(cause, conditions[0], sections),
        "source": SOURCE,
    }
    pages = {
        variant: _found_on(texts, cause.fault_id) for variant, texts in pages_by_variant.items()
    }
    if pages:
        entry["pages"] = pages
    return entry


def _cause_condition(cause: Cause, condition: Condition) -> dict[str, Any]:
    item = next(entry for entry in condition.causes if entry.fault_id == cause.fault_id)
    listed: dict[str, Any] = {
        "condition_id": condition.id,
        "title": condition.title,
        "likelihood": item.likelihood,
        "alarms": list(condition.alarms),
    }
    if item.note_md:
        listed["note"] = plain_text(item.note_md)
    return listed


def _manual_ref(cause: Cause, first: Condition, sections: SectionMap) -> dict[str, Any]:
    number = _section(sections, f"cond:{first.id}")
    if number is None:
        raise BuildError(
            f"condition {first.id!r} has no numbered section, so cause {cause.fault_id!r} "
            "cannot be referenced"
        )
    return {"section": number, "anchor": f"fault:{cause.fault_id}", "title": first.title}


def _unique(values: Iterable[str]) -> list[str]:
    """``values`` without repetitions, first occurrence first."""
    seen: dict[str, None] = {}
    for value in values:
        seen.setdefault(value, None)
    return list(seen)


def _task(task: MaintenanceTask, sections: SectionMap) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": task.id,
        "title": task.name,
        "interval": interval_text(task.interval),
    }
    return _with_section(entry, sections, f"task:{task.id}")


def _parameter(parameter: Parameter, sections: SectionMap) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": parameter.id,
        "param_no": parameter.param_no,
        "name": parameter.name,
        "unit": parameter.unit,
        "min": parameter.min,
        "default": parameter.default,
        "max": parameter.max,
    }
    return _with_section(entry, sections, HOST_SECTIONS["parameter"])


# --- validating and writing ------------------------------------------------


def fixture_schema() -> dict[str, Any]:
    """The package-local JSON Schema 2020-12 the document must satisfy."""
    if not FIXTURE_SCHEMA.is_file():  # pragma: no cover - shipped with the package
        raise BuildError(f"{FIXTURE_SCHEMA}: the catalog schema is missing from the package")
    return cast("dict[str, Any]", json.loads(FIXTURE_SCHEMA.read_text(encoding="utf-8")))


def validate_catalog(document: Mapping[str, Any]) -> None:
    """Check ``document`` against :data:`FIXTURE_SCHEMA`.

    Raises:
        BuildError: naming the JSON pointer of the first value that fails.
    """
    validator = jsonschema.Draft202012Validator(fixture_schema())
    errors = sorted(validator.iter_errors(document), key=lambda error: error.json_path)
    if not errors:
        return
    first = errors[0]
    pointer = "/" + "/".join(str(part) for part in first.absolute_path)
    raise BuildError(f"the catalog does not validate at {pointer}: {first.message}")


def write_catalog(document: Mapping[str, Any], out_path: Path) -> None:
    """Write ``document`` deterministically: sorted keys, 2 spaces, one newline."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document, indent=_INDENT, sort_keys=True, ensure_ascii=False)
    out_path.write_text(f"{text}\n", encoding="utf-8")


def export_catalog(  # noqa: PLR0913 - the four inputs plus their two contexts
    manual: Manual,
    sections: SectionMap,
    pages_by_variant: PageTexts,
    out_path: Path,
    *,
    generated_from: Mapping[str, str],
    move_text: MoveText | None = None,
) -> dict[str, Any]:
    """Build, validate and write the catalog; return the document.

    Raises:
        BuildError: when the document does not satisfy the fixture schema.
    """
    document = catalog_document(
        manual,
        sections,
        pages_by_variant,
        generated_from=generated_from,
        move_text=move_text,
    )
    validate_catalog(document)
    write_catalog(document, out_path)
    return document


# --- the two callers -------------------------------------------------------


def page_texts(result: BuildResult) -> dict[str, list[str]]:
    """Variant name → the text of each rendered page, empty without PDFs."""
    texts: dict[str, list[str]] = {}
    for variant in result.variants:
        if variant.pdf_path is None:
            continue
        texts[variant.name] = render.extract_pages(variant.pdf_path.read_bytes())
    return texts


def _provenance(cfg: BuildConfig, manual: Manual, variant: str) -> dict[str, str]:
    """``generated_from``: which sources, which variant, which digest."""
    return {
        "file": f"{cfg.manual_root.name}/{cfg.path.name}",
        "sha256": cfg.source_hash,
        "variant": variant,
        "inputs_tree_sha256": manifest.inputs_tree_sha256(manual.source_hashes),
        "manual_revision": manual.machine.document.revision,
    }


def _resolved(
    cfg: BuildConfig,
    manual: Manual,
    sections: SectionMap,
    sources: templating.Sources,
    variant: str,
) -> tuple[Manual, MoveText]:
    """Resolve every text field for ``variant`` and hand back the manual's ``move_text``."""
    rendering = templating.make_templating(cfg, cfg.variant(variant), manual, sections, sources)
    resolved = rendering.resolve(manual)
    move_text: MoveText = rendering.env.globals["move_text"]
    return resolved, move_text


def catalog_from_build(result: BuildResult, repo_root: Path, out_path: Path) -> dict[str, Any]:
    """Export the catalog of a finished ``build`` run."""
    cfg = result.cfg
    variant = cfg.default_variant
    sources = build.read_sources(cfg, repo_root)
    resolved, move_text = _resolved(cfg, result.manual, result.sections, sources, variant)
    return export_catalog(
        resolved,
        result.sections,
        page_texts(result),
        out_path,
        generated_from=_provenance(cfg, result.manual, variant),
        move_text=move_text,
    )


def main(argv: Sequence[str], repo_root: Path) -> int:
    """``fdp-manual-build export-catalog``; see :mod:`fdp_manual_build.cli`."""
    args = _parser().parse_args(list(argv))
    try:
        manual_root, checkout = build.split_roots(args.repo_root, repo_root)
        cfg = load_build_config(checkout, manual_root)
        variant = args.variant or cfg.default_variant
        manual = load_manual(checkout, cfg)
        sources = build.read_sources(cfg, checkout)
        sections = numbering.scan(sources.chapters, numbering.generated_sections(manual))
        resolved, move_text = _resolved(cfg, manual, sections, sources, variant)
        out_path = Path(args.out) if args.out else (manual_root or checkout) / cfg.pdf.catalog
        export_catalog(
            resolved,
            sections,
            {},
            out_path,
            generated_from=_provenance(cfg, manual, variant),
            move_text=move_text,
        )
    except BuildError as error:
        print(f"fdp-manual-build export-catalog: {error}", file=sys.stderr)
        return _EXIT_ERROR
    print(f"export-catalog: {out_path}")
    return _EXIT_OK


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fdp-manual-build export-catalog",
        description="Write the reference fault catalog of the manual.",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="checkout, or a manual tree holding build.yaml (default: search upwards)",
    )
    parser.add_argument(
        "--out", default=None, help="where the catalog goes (default: pdf.outputs.catalog)"
    )
    parser.add_argument("--variant", default=None, help="resolve the text fields for this variant")
    return parser
