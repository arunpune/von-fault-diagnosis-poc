# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The optional Claude catalog structurer.

One request per manual: the troubleshooting and alarm chapters of the extracted
text plus the deterministic draft go to Claude, which returns a corrected
``catalog`` document constrained by the contracts schema itself
(``output_config.format`` with ``type: "json_schema"``). The answer is
validated locally and accepted only when every acceptance rule holds;
otherwise the draft is kept and the reason is recorded, so the model can
improve the catalog but can never fail an init run.

Nothing here logs a request body, a response body or a header, and the key
reaches nothing but the client constructor: secrets come from the environment
only.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any, Final, Protocol

import anthropic

# jsonschema 4.26.0 ships no stubs.
from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

from fdp_init.catalog.deterministic import split_steps
from fdp_init.catalog.model import (
    CATALOG_SCHEMA_ID,
    SOURCE_LLM,
    Alarm,
    Catalog,
    Cause,
    Condition,
    Signal,
    SignalMove,
    to_catalog_document,
)
from fdp_init.catalog.provider import (
    FALLBACK_AUTH,
    FALLBACK_CONNECTION,
    FALLBACK_INVALID_OUTPUT,
    FALLBACK_MISSING_IDS,
    FALLBACK_RATE_LIMIT,
    FALLBACK_REFUSAL,
    FALLBACK_SDK_ERROR,
    FALLBACK_TIMEOUT,
    FALLBACK_TRUNCATED,
    FALLBACK_UNKNOWN_IDS,
    StructureResult,
    status_reason,
    stop_reason_fallback,
)
from fdp_init.catalog.validate import SCHEMA_SUBDIR, load_registry, validate_catalog
from fdp_init.config import Settings
from fdp_init.errors import ExitCode, InitError
from fdp_init.manual.model import Heading, ManualDoc, TableKind
from fdp_init.manual.profiles import fault_id_re

__all__ = [
    "CLIENT_RETRIES",
    "MAX_TOKENS",
    "MIN_ID_RECALL",
    "STORED_KEYS",
    "STRUCTURER_NAME",
    "SYSTEM_PROMPT",
    "AnthropicStructurer",
    "ClientFactory",
    "MessagesClient",
    "build_payload",
    "catalog_from_document",
    "load_output_schema",
]

log = logging.getLogger(__name__)

STEP = "ingest"

STRUCTURER_NAME = "anthropic"

MAX_TOKENS: Final = 16000
"""One whole catalog document has to fit in the answer."""

MIN_ID_RECALL: Final = 0.9
"""Rule (d): the answer keeps at least this share of the draft's fault ids."""

CLIENT_RETRIES: Final = 2
"""``max_retries`` of the client; the SDK retries 408, 409, 429 and 5xx."""

STORED_KEYS: Final = ("signals", "alarms", "conditions", "causes")
"""The arrays of the answer that become the catalog. The rest of the document —
``schema``, ``generated_from``, ``machine``, ``maintenance``, ``parameters`` — is
what the draft already says or what the deterministic catalog does not store,
so it is not read."""

_STOP_REASONS: Final[Mapping[str, str]] = {
    "refusal": FALLBACK_REFUSAL,
    "max_tokens": FALLBACK_TRUNCATED,
}
"""``stop_reason`` values rule (a) names, and the reason each one records."""

_PAYLOAD_KINDS: Final = frozenset({TableKind.TROUBLESHOOTING, TableKind.ALARMS})
"""The chapters the request sends are the ones holding these tables."""

SYSTEM_PROMPT: Final = """\
You reconcile a fault catalog that was extracted from the PDF of an industrial \
operator manual. You are given the manual's troubleshooting and controller \
message chapters as plain text and the catalog a deterministic table reader \
built from them, and you return the corrected, complete catalog as one JSON \
document.

The table reader is reliable about identifiers and about which cause belongs to \
which condition, and less reliable about text that a page break or a column \
layout split. Your job is to repair what it got wrong and add what it missed, \
not to rewrite what it got right:
- Every identifier you return appears verbatim in the manual text or in the \
draft. Never invent, translate, shorten or re-case an identifier.
- Keep every condition, cause, alarm and signal of the draft. Add a cause only \
when the manual text lists it and the draft does not.
- Use only the enumerated values the schema allows for a direction, a \
subsystem, an onset, a phase, a likelihood and an alarm type.
- Fill the signal movements of a cause from what the chapter text says about \
it, and leave out a movement the text does not state.
- A summary, a check or a remedy states what the page states, not what a \
machine of this kind usually needs.
- Reference sections by the numbering the manual prints, for example 8.2.1.
"""

_INSTRUCTIONS: Final = """\
Return the corrected catalog for this manual as one JSON document that matches \
the schema you were given. Keep every identifier verbatim and invent none, use \
only the allowed enumerated values, and fill each cause's signal movements \
from the chapter text above. Copy schema, generated_from and machine from the \
draft and leave maintenance and parameters empty: only conditions, causes, \
alarms and signals are read back.
"""


# --------------------------------------------------------------------------
# The output schema: the contracts catalog schema, inlined and made strict
# --------------------------------------------------------------------------

_SCHEMA_KEYWORDS: Final = frozenset({"$id", "$schema", "$defs", "$comment"})
"""Dropped while inlining: the result is one anonymous, self-contained schema."""

_ANNOTATIONS: Final = ("title", "description")

_VALUE_KEYWORDS: Final = frozenset({"enum", "const", "default", "examples", "required"})
"""Keywords whose values are data, never subschemas, so rewriting skips them."""


def _schema_documents(contracts_dir: Path) -> dict[str, Any]:
    """Every schema of ``schemas/v1``, keyed by its ``$id``."""
    documents: dict[str, Any] = {}
    for path in sorted((contracts_dir / SCHEMA_SUBDIR).glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        documents[str(schema["$id"])] = schema
    return documents


def _catalog_documents(contracts_dir: Path) -> dict[str, Any]:
    """The schema documents, failing like validation does when one is missing.

    Raises:
        InitError: exit code 2 when ``CONTRACTS_DIR`` holds no catalog schema;
            that is a configuration mistake, not a model failure.
    """
    documents = _schema_documents(contracts_dir)
    if CATALOG_SCHEMA_ID not in documents:
        raise InitError(
            ExitCode.CONFIG,
            f"no {CATALOG_SCHEMA_ID} schema in {contracts_dir / SCHEMA_SUBDIR}: "
            "set CONTRACTS_DIR to the contracts package",
            STEP,
        )
    return documents


def _pointer(document: Any, pointer: str) -> Any:
    """Resolve a JSON pointer inside one schema document."""
    node = document
    for token in pointer.split("/"):
        if token:
            node = node[token.replace("~1", "/").replace("~0", "~")]
    return node


def _inline(node: Any, document_id: str, documents: Mapping[str, Any], seen: frozenset[str]) -> Any:
    """Return ``node`` with every ``$ref`` replaced by what it points at.

    ``document_id`` is the schema the node lives in, which is what makes a local
    ``#/$defs/...`` inside an inlined document resolve against that document and
    not against the one that referenced it. The API resolves no external
    ``$ref``, and the catalog schema points into two other documents.
    """
    if isinstance(node, list):
        return [_inline(item, document_id, documents, seen) for item in node]
    if not isinstance(node, dict):
        return node
    reference = node.get("$ref")
    if isinstance(reference, str):
        key = f"{document_id}|{reference}"
        if key in seen:
            raise ValueError(f"the contract schemas reference {reference} in a cycle")
        base, _, pointer = reference.partition("#")
        target_id = base or document_id
        resolved = _inline(
            _pointer(documents[target_id], pointer), target_id, documents, seen | {key}
        )
        siblings = {
            name: _inline(value, document_id, documents, seen)
            for name, value in node.items()
            if name != "$ref"
        }
        # The referring node's own title and description win: `fault_id` says
        # more about the field than the `identifier` grammar it points at.
        return {**resolved, **siblings}
    return {
        name: _inline(value, document_id, documents, seen)
        for name, value in node.items()
        if name not in _SCHEMA_KEYWORDS
    }


def _nullable_union(node: Mapping[str, Any]) -> dict[str, Any]:
    """``type: [X, "null"]`` as the ``anyOf`` the structured-output grammar takes.

    The keywords of the node belong to the non-null branch, so ``bit``'s
    ``minimum`` and ``threshold``'s ``properties`` stay with the value they
    constrain and the ``null`` branch is bare.
    """
    annotations = {name: node[name] for name in _ANNOTATIONS if name in node}
    rest = {
        name: value for name, value in node.items() if name not in _ANNOTATIONS and name != "type"
    }
    branches = [
        {"type": "null"} if kind == "null" else {"type": kind, **rest} for kind in node["type"]
    ]
    return {**annotations, "anyOf": branches}


def _exclusive_branches(node: Mapping[str, Any]) -> dict[str, Any]:
    """An object ``oneOf`` of mutually exclusive keys as an ``anyOf`` of objects.

    ``signal_move`` states "exactly one of ``signal`` and ``behaviour``" as a
    ``oneOf`` of two branches that only name the required key. The grammar has
    no ``oneOf``, so each branch becomes the whole object with the other
    branches' keys removed; with every object closed, that is the same rule.

    Raises:
        ValueError: for a ``oneOf`` of any other shape, which this schema has
            not got and which would need a rule of its own.
    """
    branches = node["oneOf"]
    if not all(set(branch) <= {"properties", "required"} for branch in branches):
        raise ValueError("only a oneOf of key-exclusive object branches can be rewritten")
    properties: Mapping[str, Any] = node.get("properties", {})
    keyed = [
        set(branch.get("properties", {})) | set(branch.get("required", [])) for branch in branches
    ]
    exclusive = set().union(*keyed)
    annotations = {name: node[name] for name in _ANNOTATIONS if name in node}
    base = {
        name: value
        for name, value in node.items()
        if name not in _ANNOTATIONS and name not in {"oneOf", "properties", "required"}
    }
    variants = []
    for branch, keys in zip(branches, keyed, strict=True):
        own = {name: schema for name, schema in properties.items() if name not in exclusive - keys}
        required = [*node.get("required", []), *branch.get("required", [])]
        variants.append({**base, "properties": own, "required": list(dict.fromkeys(required))})
    return {**annotations, "anyOf": variants}


def _grammar_compatible(node: Any) -> Any:
    """Rewrite the two constructs the grammar lacks, everywhere in ``node``."""
    if isinstance(node, list):
        return [_grammar_compatible(item) for item in node]
    if not isinstance(node, dict):
        return node
    if isinstance(node.get("type"), list):
        node = _nullable_union(node)
    elif "oneOf" in node:
        node = _exclusive_branches(node)
    return {
        name: value if name in _VALUE_KEYWORDS else _grammar_compatible(value)
        for name, value in node.items()
    }


def load_output_schema(contracts_dir: Path) -> dict[str, Any]:
    """``LLM_OUTPUT_SCHEMA``: the contracts ``catalog`` schema, API-ready.

    The structured-output format takes one self-contained schema, so the
    ``$ref``s into ``common.schema.json`` and ``catalog-entry.schema.json`` are
    inlined, type unions and the ``oneOf`` of ``signal_move`` become ``anyOf``,
    and the SDK's own :func:`anthropic.transform_schema` does the rest: it
    closes every object with ``additionalProperties: false`` and moves the
    constraints the grammar cannot enforce (``pattern``, ``minimum``,
    ``maxItems`` …) into the descriptions. The answer is validated against the
    original schema afterwards, so nothing those constraints say is lost.

    Args:
        contracts_dir: ``CONTRACTS_DIR``; its ``schemas/v1`` holds the schemas.

    Returns:
        A new schema dictionary on every call.

    Raises:
        InitError: exit code 2 when the directory holds no catalog schema.
    """
    documents = _catalog_documents(contracts_dir)
    inlined = _inline(documents[CATALOG_SCHEMA_ID], CATALOG_SCHEMA_ID, documents, frozenset())
    return anthropic.transform_schema(_grammar_compatible(inlined))


# --------------------------------------------------------------------------
# The payload: the chapters that carry the tables, plus the draft
# --------------------------------------------------------------------------


def _heading_offset(text: str, heading: Heading, start: int) -> int:
    """Where the line of ``heading`` starts in ``text`` at or after ``start``, or -1."""
    line = f"{heading.ref} {heading.title}"
    if start == 0 and text.startswith(line):
        return 0
    found = text.find(f"\n{line}", start)
    return found + 1 if found >= 0 else -1


def _chapters(doc: ManualDoc) -> list[tuple[Heading, str]]:
    """Every top-level chapter with its text, in document order.

    A chapter runs from its heading line to the next chapter heading that can
    be found; a heading the text does not print as a line starts no chapter.
    """
    located: list[tuple[Heading, int]] = []
    cursor = 0
    for heading in (item for item in doc.headings if item.level == 1):
        offset = _heading_offset(doc.full_text, heading, cursor)
        if offset >= 0:
            located.append((heading, offset))
            cursor = offset + 1
    ends = [offset for _, offset in located[1:]] + [len(doc.full_text)]
    return [
        (heading, doc.full_text[start:end].strip())
        for (heading, start), end in zip(located, ends, strict=True)
    ]


def _manual_excerpt(doc: ManualDoc) -> str:
    """The troubleshooting and alarm chapters, in document order.

    The whole text is the fallback: a manual whose chapter headings the locator
    cannot find should send too much rather than nothing.
    """
    wanted = {
        table.section_ref.split(".")[0] for table in doc.tables if table.kind in _PAYLOAD_KINDS
    }
    chapters = [text for heading, text in _chapters(doc) if heading.ref in wanted and text]
    return "\n\n".join(chapters) if chapters else doc.full_text


def build_payload(doc: ManualDoc, draft: Catalog) -> str:
    """The single user message: the chapters, the draft and the task."""
    document = to_catalog_document(draft, doc)
    return (
        "<manual>\n"
        f"{_manual_excerpt(doc)}\n"
        "</manual>\n\n"
        "<draft_catalog>\n"
        f"{json.dumps(document, ensure_ascii=False, sort_keys=True)}\n"
        "</draft_catalog>\n\n"
        f"{_INSTRUCTIONS}"
    )


# --------------------------------------------------------------------------
# Local validation of the answer, against the schema it was constrained by
# --------------------------------------------------------------------------


def _answer_validator(contracts_dir: Path) -> Draft202012Validator:
    """A validator for the original, unrelaxed contracts ``catalog`` schema."""
    documents = _catalog_documents(contracts_dir)
    return Draft202012Validator(documents[CATALOG_SCHEMA_ID], registry=load_registry(contracts_dir))


def _validated_answer(
    answer: Any, draft_document: Mapping[str, Any], validator: Draft202012Validator
) -> dict[str, Any]:
    """Validate the stored arrays of the answer, before any field is read.

    They are validated inside the draft's own document, so the parts of the
    answer the structurer does not read cannot reject it. A ``pattern`` failure
    is left to rule (c) for fault ids and rejects nothing for any other
    identifier, as validation downgrades it on the deterministic path.

    Raises:
        ValueError: when the answer is not an object, lacks a stored array or
            breaks the schema in any other way.
    """
    if not isinstance(answer, Mapping):
        raise ValueError("the answer is not a JSON object")
    missing = [key for key in STORED_KEYS if key not in answer]
    if missing:
        raise ValueError(f"the answer has no {', '.join(missing)}")
    candidate = {**draft_document, **{key: answer[key] for key in STORED_KEYS}}
    blocking = (error for error in validator.iter_errors(candidate) if error.validator != "pattern")
    error = next(blocking, None)
    if error is not None:
        path = "/".join(str(step) for step in error.absolute_path) or "<document>"
        raise ValueError(f"{path}: {error.message}")
    return candidate


# --------------------------------------------------------------------------
# The answer: back into the value model
# --------------------------------------------------------------------------


def _text_of(content: Iterable[Any]) -> str:
    """The first ``text`` block of a response.

    Raises:
        ValueError: when the answer carries no text block at all.
    """
    for block in content:
        if getattr(block, "type", None) == "text":
            return str(block.text)
    raise ValueError("the answer carries no text block")


def _optional_str(value: Any) -> str | None:
    """An optional string field that already passed the schema."""
    return value if isinstance(value, str) else None


def _move(move: Mapping[str, Any]) -> SignalMove:
    """One contracts ``signal_move`` back into the value model.

    ``note`` is not part of the contract shape; it is rebuilt from ``onset``
    and ``phase`` the way :func:`fdp_init.manual.profiles.parse_move_sentence`
    builds it, so a move read back from the model compares equal to the same
    move read off the table.
    """
    is_behaviour = "behaviour" in move
    onset = _optional_str(move.get("onset"))
    phase = _optional_str(move.get("phase"))
    return SignalMove(
        signal_id=str(move["behaviour"] if is_behaviour else move["signal"]),
        direction=str(move["direction"]),
        note=", ".join(part for part in (onset, phase) if part) or None,
        is_behaviour=is_behaviour,
        onset=onset,
        phase=phase,
        text=str(move.get("text", "")),
    )


def _entry_condition(entry: Mapping[str, Any], condition_id: str) -> Mapping[str, Any]:
    """The ``entry_condition`` of ``entry`` that names one condition, or ``{}``."""
    for occurrence in entry["conditions"]:
        if occurrence["condition_id"] == condition_id:
            return dict(occurrence)
    return {}


def _cause(
    entry: Mapping[str, Any],
    condition: Mapping[str, Any],
    ordinal: int,
    *,
    first: bool,
    drafted: Cause | None,
) -> Cause:
    """One ``Cause`` occurrence, rebuilt from a catalog entry.

    ``entries`` folds every occurrence of a fault id into one entry: its
    ``summary``, ``checks``, ``remedy`` and ``signal_moves`` are the first
    occurrence's, and a later occurrence keeps only its own wording, as the
    ``note`` of its ``entry_condition``. Reading back is the same fold in
    reverse: the note is the occurrence's description, and a later occurrence
    the table reader also found keeps the checks, remedy and moves of its own
    row, which the entry has no place for. The section is the condition's, as
    the table reader sets it; the pages are a property of the PDF, taken from
    the drafted occurrence when there is one.
    """
    occurrence = _entry_condition(entry, str(condition["id"]))
    manual_ref: Mapping[str, Any] = entry["manual_ref"]
    page = int(manual_ref.get("page") or manual_ref.get("page_start") or 1)
    own_row = drafted if drafted is not None and not first else None
    remedy = own_row.remedy if own_row else str(entry["remedy"])
    return Cause(
        fault_id=str(entry["fault_id"]),
        title=str(entry["name"]),
        description=str(occurrence.get("note") or entry["summary"]),
        subsystem=str(entry["subsystem"]),
        benign=bool(entry["benign"]),
        checks=list(own_row.checks) if own_row else [str(check) for check in entry["checks"]],
        remedy=remedy,
        remedy_steps=list(own_row.remedy_steps) if own_row else split_steps(remedy),
        signal_moves=(
            list(own_row.signal_moves)
            if own_row
            else [_move(move) for move in entry["signal_moves"]]
        ),
        alarm_codes=[str(code) for code in occurrence.get("alarms", [])],
        manual_section=str(condition.get("section") or manual_ref["section"]),
        page_start=drafted.page_start if drafted else page,
        page_end=drafted.page_end if drafted else page,
        ordinal=ordinal,
    )


def _declared_entries(causes: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    """The entries of the answer by fault id.

    Raises:
        ValueError: when a fault id is declared twice.
    """
    declared: dict[str, Mapping[str, Any]] = {}
    for entry in causes:
        fault_id = str(entry["fault_id"])
        if fault_id in declared:
            raise ValueError(f"the answer declares the cause {fault_id} twice")
        declared[fault_id] = entry
    return declared


def _condition(
    document: Mapping[str, Any],
    declared: Mapping[str, Mapping[str, Any]],
    first_listed: Mapping[str, str],
    draft: Catalog,
) -> Condition:
    """One ``Condition`` with the causes the answer lists under it.

    ``first_listed`` maps each fault id to the condition that lists it first,
    which is the occurrence its catalog entry describes.

    Raises:
        ValueError: when the condition names a cause the answer never declares.
    """
    condition_id = str(document["id"])
    drafted_condition = next(
        (item for item in draft.conditions if item.condition_id == condition_id), None
    )
    drafted_causes = (
        {cause.fault_id: cause for cause in drafted_condition.causes} if drafted_condition else {}
    )
    causes: list[Cause] = []
    for ordinal, reference in enumerate(document["causes"]):
        fault_id = str(reference["fault_id"])
        entry = declared.get(fault_id)
        if entry is None:
            raise ValueError(f"condition {condition_id} names the undeclared cause {fault_id}")
        causes.append(
            _cause(
                entry,
                document,
                ordinal,
                first=first_listed[fault_id] == condition_id,
                drafted=drafted_causes.get(fault_id),
            )
        )
    pages = [page for cause in causes for page in (cause.page_start, cause.page_end)] or [1]
    return Condition(
        condition_id=condition_id,
        title=str(document["title"]),
        description=str(document.get("symptom", "")),
        symptoms=[str(symptom) for symptom in document.get("symptoms", [])],
        manual_section=str(document.get("section", "")),
        page_start=drafted_condition.page_start if drafted_condition else min(pages),
        page_end=drafted_condition.page_end if drafted_condition else max(pages),
        causes=causes,
    )


def _alarm(document: Mapping[str, Any]) -> Alarm:
    """One ``catalog_alarm`` back into the value model."""
    threshold: Mapping[str, Any] | None = document.get("threshold")
    delay = document.get("delay_s")
    bit = document["bit"]
    return Alarm(
        code=str(document["code"]),
        kind=str(document["type"]),
        title=str(document["title"]),
        trigger_text=str(document.get("text", "")),
        threshold=float(threshold["value"]) if threshold else None,
        threshold_unit=_optional_str(threshold.get("unit")) if threshold else None,
        delay_s=int(delay) if delay is not None else None,
        reset_rule=_optional_str(document.get("reset")),
        bit=int(bit) if bit is not None else None,
        manual_section=str(document.get("section", "")),
    )


def _signal(document: Mapping[str, Any], drafted: Signal | None) -> Signal:
    """One ``catalog_signal`` back into the value model.

    ``normal_band`` is a free-form object in the contracts, which a closed
    grammar can only express as ``{}``; the bands the table reader found are
    therefore kept whenever the answer carries none.
    """
    span = document.get("range")
    bands = {
        state: [float(bound) for bound in band]
        for state, band in dict(document.get("normal_band", {})).items()
        if isinstance(band, list)
    }
    return Signal(
        signal_id=str(document["id"]),
        description=str(document.get("name", "")),
        unit=str(document["unit"]),
        kind=str(document.get("kind") or document["group"]),
        metropt_column=_optional_str(document["metropt_column"]),
        range_min=float(span[0]) if span else None,
        range_max=float(span[1]) if span else None,
        normal_bands=bands or (dict(drafted.normal_bands) if drafted else {}),
        manual_section=str(document.get("section", "")),
        panel_label=str(document.get("panel_label", "")),
        subsystem=str(document["subsystem"]),
    )


def catalog_from_document(document: Mapping[str, Any], draft: Catalog) -> Catalog:
    """Map a validated ``catalog`` document back onto the value model.

    Membership comes from ``conditions[].causes[]``, the order the manual
    lists causes in; ``causes[]`` supplies what each cause says. ``sections``
    are kept from the draft: the ``catalog`` document carries no heading tree,
    and the tree is a property of the PDF rather than of the reconciliation.

    Args:
        document: The model's answer after :func:`_validated_answer`.
        draft: The deterministic catalog, for what the document cannot carry.

    Returns:
        The catalog the acceptance rules are then run against.

    Raises:
        ValueError: when a cause is declared twice, declared under no
            condition, or named by a condition without being declared.
    """
    declared = _declared_entries(document["causes"])
    first_listed: dict[str, str] = {}
    for condition in document["conditions"]:
        for reference in condition["causes"]:
            first_listed.setdefault(str(reference["fault_id"]), str(condition["id"]))
    conditions = [
        _condition(item, declared, first_listed, draft) for item in document["conditions"]
    ]
    listed = {cause.fault_id for condition in conditions for cause in condition.causes}
    orphans = [fault_id for fault_id in declared if fault_id not in listed]
    if orphans:
        raise ValueError(f"the answer declares {orphans[0]} under no condition")
    drafted_signals = {signal.signal_id: signal for signal in draft.signals}
    return Catalog(
        source=SOURCE_LLM,
        conditions=conditions,
        alarms=[_alarm(item) for item in document["alarms"]],
        signals=[
            _signal(item, drafted_signals.get(str(item["id"]))) for item in document["signals"]
        ],
        sections=list(draft.sections),
    )


# --------------------------------------------------------------------------
# The acceptance rules
# --------------------------------------------------------------------------


def _resolved_section(section: str, drafted: str | None, refs: frozenset[str], what: str) -> str:
    """Rule (e) for one reference: keep a known section, else take the draft's.

    The draft's value is taken even when it is empty, because an empty section
    is what the table reader stored for that row; the answer can then never be
    worse than the draft.

    Raises:
        ValueError: when neither the answer nor the draft names a known heading.
    """
    if section in refs:
        return section
    if drafted is not None and (drafted in refs or not drafted):
        return drafted
    raise ValueError(f"{what} references the unknown section {section!r}")


def _resolve_sections(catalog: Catalog, draft: Catalog, doc: ManualDoc) -> Catalog:
    """Every ``manual_section`` of the answer, checked against ``doc.headings``.

    A section the manual has not got is replaced by the draft's for the same
    cause, condition, alarm or signal (rule (e)); a cause looks for its own
    occurrence first and then for any occurrence of its fault id.

    Raises:
        ValueError: when a reference is unknown and the draft cannot fill it,
            which is rule (b) failing.
    """
    refs = frozenset(heading.ref for heading in doc.headings)
    by_pair = {
        (condition.condition_id, cause.fault_id): cause.manual_section
        for condition in draft.conditions
        for cause in condition.causes
    }
    by_fault: dict[str, str] = {}
    for cause in draft.causes:
        by_fault.setdefault(cause.fault_id, cause.manual_section)
    drafted_conditions = {item.condition_id: item.manual_section for item in draft.conditions}
    conditions = [
        replace(
            condition,
            manual_section=_resolved_section(
                condition.manual_section,
                drafted_conditions.get(condition.condition_id),
                refs,
                f"condition {condition.condition_id}",
            ),
            causes=[
                replace(
                    cause,
                    manual_section=_resolved_section(
                        cause.manual_section,
                        by_pair.get((condition.condition_id, cause.fault_id))
                        or by_fault.get(cause.fault_id),
                        refs,
                        f"cause {cause.fault_id}",
                    ),
                )
                for cause in condition.causes
            ],
        )
        for condition in catalog.conditions
    ]
    drafted_alarms = {alarm.code: alarm.manual_section for alarm in draft.alarms}
    drafted_signals = {signal.signal_id: signal.manual_section for signal in draft.signals}
    return replace(
        catalog,
        conditions=conditions,
        alarms=[
            replace(
                alarm,
                manual_section=_resolved_section(
                    alarm.manual_section,
                    drafted_alarms.get(alarm.code),
                    refs,
                    f"alarm {alarm.code}",
                ),
            )
            for alarm in catalog.alarms
        ],
        signals=[
            replace(
                signal,
                manual_section=_resolved_section(
                    signal.manual_section,
                    drafted_signals.get(signal.signal_id),
                    refs,
                    f"signal {signal.signal_id}",
                ),
            )
            for signal in catalog.signals
        ],
    )


def _unknown_ids(catalog: Catalog, draft: Catalog, doc: ManualDoc) -> list[str]:
    """Rule (c): fault ids that break the grammar or that the manual never prints.

    An id counts as printed when the id grammar finds it as a whole token of
    ``full_text`` — ``oil_filter`` is not printed because ``oil_filter_clogged``
    is — or when the table reader read it off a row, which covers an id a
    hyphenated line break split in the running text.
    """
    pattern = fault_id_re()
    printed = {match.group(0) for match in pattern.finditer(doc.full_text)} | set(draft.fault_ids)
    return [
        fault_id
        for fault_id in catalog.fault_ids
        if pattern.fullmatch(fault_id) is None or fault_id not in printed
    ]


def _recall(catalog: Catalog, draft: Catalog) -> float:
    """Rule (d): the share of the draft's distinct fault ids the answer kept."""
    wanted = set(draft.fault_ids)
    if not wanted:
        return 1.0
    return len(wanted & set(catalog.fault_ids)) / len(wanted)


def _usage_of(response: Any) -> dict[str, Any]:
    """``response.model`` and the token counts, for the report."""
    usage = getattr(response, "usage", None)
    return {
        "model": str(getattr(response, "model", "")),
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
    }


_NAMED_ERRORS: Final[tuple[tuple[type[anthropic.AnthropicError], str], ...]] = (
    (anthropic.AuthenticationError, FALLBACK_AUTH),
    (anthropic.RateLimitError, FALLBACK_RATE_LIMIT),
    (anthropic.APITimeoutError, FALLBACK_TIMEOUT),
)
"""The SDK classes mapped ahead of the generic status mapping."""

_TRANSPORT_ERRORS: Final[tuple[tuple[type[anthropic.AnthropicError], str], ...]] = (
    (anthropic.APIConnectionError, FALLBACK_CONNECTION),
    (anthropic.APIResponseValidationError, FALLBACK_INVALID_OUTPUT),
)
"""The failures that carry no HTTP status of their own."""


def _exception_reason(error: anthropic.AnthropicError) -> str:
    """Map an SDK failure to a fallback reason, most specific first.

    ``AuthenticationError`` and ``RateLimitError`` derive from
    ``APIStatusError``, and ``APITimeoutError`` from ``APIConnectionError``, so
    the order of the checks is the mapping.
    """
    for kind, reason in _NAMED_ERRORS:
        if isinstance(error, kind):
            return reason
    if isinstance(error, anthropic.APIStatusError):
        return status_reason(error.status_code)
    for kind, reason in _TRANSPORT_ERRORS:
        if isinstance(error, kind):
            return reason
    return FALLBACK_SDK_ERROR


class MessagesClient(Protocol):
    """What the structurer needs of a client: ``messages.create`` and ``close``.

    ``anthropic.Anthropic`` is one; a unit test hands in a fake of the same
    shape.
    """

    @property
    def messages(self) -> Any:
        """The resource whose ``create`` sends ``POST /v1/messages``."""
        ...

    def close(self) -> None:
        """Release the connection pool."""
        ...


ClientFactory = Callable[[], MessagesClient]
"""Builds the client for one request."""


class AnthropicStructurer:
    """Reconciles the deterministic draft with Claude.

    ``client_factory`` exists for the tests: the default builds the real
    ``anthropic.Anthropic`` from the settings, and a test hands in a fake with
    the same ``messages.create``. Nothing else about the class differs between
    the two, so what the tests exercise is the production path.
    """

    name = STRUCTURER_NAME

    def __init__(self, settings: Settings, *, client_factory: ClientFactory | None = None) -> None:
        """Keep the settings and how to build the client; build nothing yet."""
        self._settings = settings
        self._client_factory = client_factory or self._default_client

    def _default_client(self) -> anthropic.Anthropic:
        """The real client. The key reaches this constructor and nothing else.

        ``LLM_BASE_URL`` unset leaves ``base_url`` to the SDK's default; the
        contracts mock sets it in the integration tests.
        """
        return anthropic.Anthropic(
            api_key=self._settings.llm_api_key,
            base_url=self._settings.llm_base_url,
            timeout=self._settings.llm_timeout_s,
            max_retries=CLIENT_RETRIES,
        )

    def structure(self, doc: ManualDoc, draft: Catalog) -> StructureResult:
        """Return the catalog to store, never raising for a provider reason.

        Args:
            doc: The extracted manual, which is both the payload and the text
                every returned identifier is checked against.
            draft: The deterministic catalog.

        Returns:
            The model's catalog when every acceptance rule holds, the
            draft with ``fallback_reason`` set otherwise.

        Raises:
            InitError: exit code 2 when ``CONTRACTS_DIR`` holds no catalog
                schema, which fails the deterministic path the same way.
        """
        schema = load_output_schema(self._settings.contracts_dir)
        payload = build_payload(doc, draft)
        try:
            response = self._send(schema, payload)
        except anthropic.AnthropicError as error:
            reason = _exception_reason(error)
            self._log_fallback(
                "the catalog model call failed",
                reason,
                error_type=type(error).__name__,
                status_code=getattr(error, "status_code", None),
            )
            return StructureResult(catalog=draft, source=draft.source, fallback_reason=reason)
        usage = _usage_of(response)
        catalog, rejection = self._accept(response, doc, draft)
        if catalog is None:
            return StructureResult(
                catalog=draft, source=draft.source, fallback_reason=rejection, usage=usage
            )
        log.info(
            "the catalog model reconciled the draft",
            extra={
                "step": STEP,
                "llm_model": usage["model"],
                "input_tokens": usage["input_tokens"],
                "output_tokens": usage["output_tokens"],
                "causes": len(catalog.fault_ids),
            },
        )
        return StructureResult(catalog=catalog, source=SOURCE_LLM, usage=usage)

    def _send(self, schema: dict[str, Any], payload: str) -> Any:
        """The one call: no thinking override, no prefill, no fallbacks beta."""
        client = self._client_factory()
        try:
            return client.messages.create(
                model=self._settings.llm_model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": payload}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
            )
        finally:
            client.close()

    def _accept(
        self, response: Any, doc: ManualDoc, draft: Catalog
    ) -> tuple[Catalog | None, str | None]:
        """Run the acceptance rules in order.

        Returns:
            The catalog to store and ``None``, or ``None`` and the reason the
            answer was rejected.
        """
        stop_reason = str(getattr(response, "stop_reason", None) or "")
        if stop_reason != "end_turn":
            reason = _STOP_REASONS.get(stop_reason) or stop_reason_fallback(stop_reason)
            self._log_fallback(
                "the catalog model did not finish its answer",
                reason,
                stop_reason=stop_reason,
                **_stop_details(getattr(response, "stop_details", None)),
            )
            return None, reason
        try:
            answer = _validated_answer(
                json.loads(_text_of(response.content)),
                to_catalog_document(draft, doc),
                _answer_validator(self._settings.contracts_dir),
            )
            catalog = _resolve_sections(catalog_from_document(answer, draft), draft, doc)
        except ValueError as error:
            return None, self._rejected(FALLBACK_INVALID_OUTPUT, str(error))
        report = validate_catalog(catalog, self._settings.contracts_dir, doc)
        if report.structural_errors or report.invalid_entries:
            detail = (report.structural_errors or [entry[2] for entry in report.invalid_entries])[0]
            return None, self._rejected(FALLBACK_INVALID_OUTPUT, detail)
        unknown = _unknown_ids(catalog, draft, doc)
        if unknown:
            detail = f"{len(unknown)} fault id(s) are not in the manual, starting with {unknown[0]}"
            return None, self._rejected(FALLBACK_UNKNOWN_IDS, detail)
        recall = _recall(catalog, draft)
        if recall < MIN_ID_RECALL:
            detail = f"the answer kept {recall:.0%} of the draft's fault ids"
            return None, self._rejected(FALLBACK_MISSING_IDS, detail)
        return catalog, None

    def _rejected(self, reason: str, detail: str) -> str:
        """Log why the answer was rejected; the answer itself is never logged."""
        self._log_fallback("the catalog model answer was rejected", reason, detail=detail)
        return reason

    def _log_fallback(self, what: str, reason: str, **fields: Any) -> None:
        """One warning per fallback, naming the reason and the model."""
        log.warning(
            f"{what}; the catalog is read from the fault tables",
            extra={
                "step": STEP,
                "fallback_reason": reason,
                "llm_model": self._settings.llm_model,
                **fields,
            },
        )


def _stop_details(details: Any) -> dict[str, Any]:
    """``response.stop_details`` as log fields, when the API sent any."""
    if details is None:
        return {}
    return {
        "stop_details_type": getattr(details, "type", None),
        "stop_details_category": getattr(details, "category", None),
        "stop_details_explanation": getattr(details, "explanation", None),
    }
