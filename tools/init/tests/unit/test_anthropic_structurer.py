# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The optional Claude structurer with a fake client.

No network: the client is an object with ``messages.create`` and ``close``,
handed in through ``client_factory``, and every answer is a real
``anthropic.types.Message`` so the structurer reads the same attributes it
reads in production. The draft the fake echoes back is the clean fixture's
own deterministic catalog, which makes "accepted" the baseline and every
fallback a single, visible edit away from it.

``tests/integration/test_anthropic_mock.py`` covers the same paths over a real
socket with the real SDK.
"""

from __future__ import annotations

import copy
import json
import logging
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import anthropic
import httpx2
import pytest
from anthropic.types import Message
from jsonschema import Draft202012Validator

from fdp_init.catalog import anthropic_structurer as structurer_module
from fdp_init.catalog.anthropic_structurer import (
    CLIENT_RETRIES,
    MAX_TOKENS,
    SYSTEM_PROMPT,
    AnthropicStructurer,
    build_payload,
    load_output_schema,
)
from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import SOURCE_LLM, SOURCE_TABLES, Catalog, entries, to_catalog_document
from fdp_init.catalog.provider import (
    FALLBACK_SDK_MISSING,
    DeterministicStructurer,
    StructureResult,
    select_structurer,
)
from fdp_init.config import Settings
from fdp_init.errors import InitError
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ManualDoc

pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
CONTRACTS = FIXTURES / "contracts"
CLEAN_PDF = FIXTURES / "mini-manual" / "mini-manual-clean.pdf"

DUMMY_KEY = "sk-ant-unit-test-dummy-key-0123456789"
"""Never a real key: the value the log assertions look for."""

MODEL = "claude-opus-5"
USAGE = {"input_tokens": 4321, "output_tokens": 1234}

REQUEST = httpx2.Request("POST", "https://api.invalid/v1/messages")


# --------------------------------------------------------------------------
# Fixtures and the fake client
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def doc() -> ManualDoc:
    return extract_manual(CLEAN_PDF)


@pytest.fixture(scope="module")
def draft(doc: ManualDoc) -> Catalog:
    return build_catalog(doc)


@pytest.fixture
def settings(env: Callable[..., dict[str, str]]) -> Settings:
    return Settings.from_env(env(LLM_API_KEY=DUMMY_KEY, CONTRACTS_DIR=str(CONTRACTS)))


@pytest.fixture
def answer(doc: ManualDoc, draft: Catalog) -> dict[str, Any]:
    """What a model that changes nothing would return: the draft's own document."""
    return to_catalog_document(draft, doc)


class FakeMessages:
    """``client.messages``: records every call, then answers or raises."""

    def __init__(self, outcome: Message | BaseException) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, Any]] = []

    def create(self, **params: Any) -> Message:
        self.calls.append(params)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class FakeClient:
    """The two things the structurer uses of ``anthropic.Anthropic``."""

    def __init__(self, outcome: Message | BaseException) -> None:
        self.messages = FakeMessages(outcome)
        self.closed = False

    def close(self) -> None:
        self.closed = True


def message(
    text: str | None = None,
    *,
    stop_reason: str = "end_turn",
    stop_details: dict[str, Any] | None = None,
) -> Message:
    """A real SDK ``Message`` with one text block, or none when ``text`` is None."""
    content = [] if text is None else [{"type": "text", "text": text, "citations": None}]
    return Message.model_validate(
        {
            "id": "msg_unit_000001",
            "type": "message",
            "role": "assistant",
            "model": MODEL,
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "stop_details": stop_details,
            "usage": USAGE,
        }
    )


def run(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    outcome: Message | BaseException,
) -> tuple[StructureResult, FakeClient]:
    client = FakeClient(outcome)
    result = AnthropicStructurer(settings, client_factory=lambda: client).structure(doc, draft)
    return result, client


def answering(document: Any) -> Message:
    return message(json.dumps(document))


def assert_fallback(result: StructureResult, draft: Catalog, reason: str) -> None:
    assert result.fallback_reason == reason
    assert result.source == SOURCE_TABLES
    assert result.catalog is draft


def drop_cause(document: dict[str, Any], fault_id: str) -> None:
    """Remove a cause from the answer everywhere it is mentioned."""
    document["causes"] = [entry for entry in document["causes"] if entry["fault_id"] != fault_id]
    for condition in document["conditions"]:
        condition["causes"] = [ref for ref in condition["causes"] if ref["fault_id"] != fault_id]


def rename_cause(document: dict[str, Any], old: str, new: str) -> None:
    """Rename a fault id consistently across the answer."""
    for entry in document["causes"]:
        if entry["fault_id"] == old:
            entry["fault_id"] = new
    for condition in document["conditions"]:
        for ref in condition["causes"]:
            if ref["fault_id"] == old:
                ref["fault_id"] = new


def entry_of(document: dict[str, Any], fault_id: str) -> dict[str, Any]:
    return next(entry for entry in document["causes"] if entry["fault_id"] == fault_id)


def condition_of(document: dict[str, Any], condition_id: str) -> dict[str, Any]:
    return next(item for item in document["conditions"] if item["id"] == condition_id)


# --------------------------------------------------------------------------
# The accepted path and the request it sends
# --------------------------------------------------------------------------


def test_an_unchanged_answer_is_accepted_and_reads_back_as_the_draft(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    result, client = run(settings, doc, draft, answering(answer))

    assert result.source == SOURCE_LLM
    assert result.fallback_reason is None
    assert result.usage == {"model": MODEL, **USAGE}
    assert result.catalog.source == SOURCE_LLM
    # The per-cause fold reverses exactly: every occurrence, section, page and
    # move of the draft comes back, including the second downstream_air_leak.
    assert result.catalog.conditions == draft.conditions
    assert result.catalog.signals == draft.signals
    assert sorted(result.catalog.alarms, key=lambda alarm: alarm.code) == sorted(
        draft.alarms, key=lambda alarm: alarm.code
    )
    assert result.catalog.sections == draft.sections
    assert {entry["source"] for entry in entries(result.catalog)} == {SOURCE_LLM}
    assert client.closed


def test_the_request_is_one_structured_output_call_and_nothing_more(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    _, client = run(settings, doc, draft, answering(answer))

    [call] = client.messages.calls
    # No thinking override, no prefill, no fallbacks beta.
    assert set(call) == {"model", "max_tokens", "system", "messages", "output_config"}
    assert call["model"] == settings.llm_model == MODEL
    assert call["max_tokens"] == MAX_TOKENS == 16000
    assert call["system"] == SYSTEM_PROMPT
    assert call["messages"] == [{"role": "user", "content": build_payload(doc, draft)}]
    assert call["output_config"] == {
        "format": {"type": "json_schema", "schema": load_output_schema(CONTRACTS)}
    }


def test_a_reconciled_answer_is_what_is_stored(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    entry = entry_of(answer, "intake_filter_clogged")
    entry["checks"] = [*entry["checks"], "Read the filter restriction indicator."]
    entry["signal_moves"].append({"signal": "motor_current", "direction": "low", "phase": "loaded"})

    result, _ = run(settings, doc, draft, answering(answer))

    assert result.source == SOURCE_LLM
    cause = next(
        cause for cause in result.catalog.causes if cause.fault_id == "intake_filter_clogged"
    )
    assert cause.checks[-1] == "Read the filter restriction indicator."
    added = cause.signal_moves[-1]
    assert (added.signal_id, added.direction, added.phase, added.note) == (
        "motor_current",
        "low",
        "loaded",
        "loaded",
    )


def test_the_payload_carries_the_fault_chapters_and_the_draft(
    doc: ManualDoc, draft: Catalog
) -> None:
    payload = build_payload(doc, draft)
    manual = payload.split("<manual>\n", 1)[1].split("\n</manual>", 1)[0]
    drafted = payload.split("<draft_catalog>\n", 1)[1].split("\n</draft_catalog>", 1)[0]

    assert manual.startswith("3 Controller messages")
    assert "8 Problem solving" in manual
    assert "8.2.3 Oil temperature high" in manual
    assert "1 Safety" not in manual
    assert "9 Technical data" not in manual
    assert json.loads(drafted) == to_catalog_document(draft, doc)
    assert "Keep every identifier verbatim" in payload


# --------------------------------------------------------------------------
# The output schema
# --------------------------------------------------------------------------


def _walk(node: Any, path: str = "$") -> Iterator[tuple[str, dict[str, Any]]]:
    if isinstance(node, dict):
        yield path, node
        for key, value in node.items():
            yield from _walk(value, f"{path}/{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _walk(value, f"{path}/{index}")


def test_the_output_schema_uses_only_what_the_structured_output_grammar_takes() -> None:
    schema = load_output_schema(CONTRACTS)
    unsupported = {"$ref", "$defs", "oneOf", "pattern", "minimum", "maximum", "maxItems"}
    unsupported |= {"uniqueItems", "const"}

    for path, node in _walk(schema):
        if path.endswith(("/properties", "/enum")):
            continue  # property names and enum values, not keywords
        assert not unsupported & set(node), path
        assert not isinstance(node.get("type"), list), path
        if node.get("type") == "object":
            assert node.get("additionalProperties") is False, path
        assert node.get("minItems", 0) in (0, 1), path


def test_the_signal_move_one_of_becomes_two_closed_objects() -> None:
    schema = load_output_schema(CONTRACTS)
    moves = schema["properties"]["causes"]["items"]["properties"]["signal_moves"]["items"]

    signal, behaviour = moves["anyOf"]
    assert "signal" in signal["required"] and "behaviour" not in signal["properties"]
    assert "behaviour" in behaviour["required"] and "signal" not in behaviour["properties"]
    assert signal["additionalProperties"] is behaviour["additionalProperties"] is False


def test_the_draft_satisfies_the_output_schema(
    answer: dict[str, Any],
) -> None:
    # generated_from is open in the contracts and closed in the grammar; the
    # structurer never reads it back, so only its schema-known keys are kept.
    answer["generated_from"] = {key: answer["generated_from"][key] for key in ("file", "sha256")}
    errors = list(Draft202012Validator(load_output_schema(CONTRACTS)).iter_errors(answer))
    assert errors == []


def test_a_contracts_dir_without_the_catalog_schema_is_a_configuration_error(
    tmp_path: Path,
) -> None:
    with pytest.raises(InitError) as caught:
        load_output_schema(tmp_path)
    assert caught.value.exit_code == 2


# --------------------------------------------------------------------------
# Every rejection falls back with its reason
# --------------------------------------------------------------------------


def test_an_answer_missing_a_fifth_of_the_ids_falls_back(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    drop_cause(answer, "intake_filter_clogged")
    drop_cause(answer, "oil_filter_clogged")

    result, _ = run(settings, doc, draft, answering(answer))

    assert_fallback(result, draft, "missing_ids")
    assert result.usage == {"model": MODEL, **USAGE}


def _set_cause(field: str, value: object) -> Callable[[dict[str, Any]], None]:
    def edit(document: dict[str, Any]) -> None:
        entry_of(document, "oil_cooler_fouled")[field] = value

    return edit


def _set_first_move_direction(document: dict[str, Any]) -> None:
    entry_of(document, "oil_cooler_fouled")["signal_moves"][0]["direction"] = "up"


def _set_alarm_type(document: dict[str, Any]) -> None:
    document["alarms"][0]["type"] = "alert"


def _set_signal_group(document: dict[str, Any]) -> None:
    document["signals"][0]["group"] = "virtual"


def _drop_remedy(document: dict[str, Any]) -> None:
    del entry_of(document, "oil_cooler_fouled")["remedy"]


@pytest.mark.parametrize(
    "edit",
    [
        _set_cause("subsystem", "pneumatics"),
        _set_first_move_direction,
        _set_alarm_type,
        _set_signal_group,
        _set_cause("checks", "Clean it."),
        _drop_remedy,
    ],
    ids=["subsystem enum", "direction enum", "alarm type enum", "signal group", "type", "required"],
)
def test_a_schema_violation_falls_back_as_invalid_output(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    answer: dict[str, Any],
    edit: Callable[[dict[str, Any]], None],
) -> None:
    edit(answer)
    result, _ = run(settings, doc, draft, answering(answer))
    assert_fallback(result, draft, "invalid_output")


def test_a_refusal_falls_back_and_logs_its_stop_details(
    settings: Settings, doc: ManualDoc, draft: Catalog, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)
    refusal = message(
        stop_reason="refusal",
        stop_details={"type": "refusal", "category": "cyber", "explanation": "declined"},
    )

    result, _ = run(settings, doc, draft, refusal)

    assert_fallback(result, draft, "refusal")
    assert result.usage == {"model": MODEL, **USAGE}
    [record] = [item for item in caplog.records if getattr(item, "fallback_reason", "")]
    assert record.stop_reason == "refusal"  # type: ignore[attr-defined]
    assert record.stop_details_category == "cyber"  # type: ignore[attr-defined]


def test_max_tokens_falls_back_as_truncated(
    settings: Settings, doc: ManualDoc, draft: Catalog
) -> None:
    result, _ = run(settings, doc, draft, message('{"schema": "urn:fdp', stop_reason="max_tokens"))
    assert_fallback(result, draft, "truncated")


def test_an_unexpected_stop_reason_names_itself(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    result, _ = run(settings, doc, draft, message(json.dumps(answer), stop_reason="pause_turn"))
    assert_fallback(result, draft, "stop_pause_turn")


@pytest.mark.parametrize(
    "reply",
    [
        message(None),
        message("The catalog looks right to me."),
        message("[]"),
        message(json.dumps({"causes": [], "conditions": []})),
    ],
    ids=["no text block", "prose", "not an object", "no alarms or signals"],
)
def test_an_unreadable_answer_falls_back_as_invalid_output(
    settings: Settings, doc: ManualDoc, draft: Catalog, reply: Message
) -> None:
    result, _ = run(settings, doc, draft, reply)
    assert_fallback(result, draft, "invalid_output")


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("dryer_purge_leak", "ghost_valve_stuck"),  # not printed anywhere
        ("oil_filter_clogged", "oil_filter"),  # printed only inside a longer id
        ("oil_cooler_fouled", "Oil-Cooler"),  # outside the id grammar
    ],
)
def test_a_fault_id_the_manual_does_not_print_falls_back(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    answer: dict[str, Any],
    old: str,
    new: str,
) -> None:
    rename_cause(answer, old, new)
    result, _ = run(settings, doc, draft, answering(answer))
    assert_fallback(result, draft, "unknown_ids")


def _declare_twice(document: dict[str, Any]) -> None:
    document["causes"].append(copy.deepcopy(document["causes"][0]))


def _declare_orphan(document: dict[str, Any]) -> None:
    for condition in document["conditions"]:
        condition["causes"] = [
            ref for ref in condition["causes"] if ref["fault_id"] != "oil_filter_clogged"
        ]


def _name_undeclared(document: dict[str, Any]) -> None:
    document["causes"] = [
        entry for entry in document["causes"] if entry["fault_id"] != "oil_filter_clogged"
    ]


def _list_twice(document: dict[str, Any]) -> None:
    condition = condition_of(document, "oil_temperature_high")
    condition["causes"].append(copy.deepcopy(condition["causes"][0]))


@pytest.mark.parametrize(
    "edit",
    [_declare_twice, _declare_orphan, _name_undeclared, _list_twice],
    ids=["declared twice", "under no condition", "never declared", "listed twice"],
)
def test_an_inconsistent_answer_falls_back_as_invalid_output(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    answer: dict[str, Any],
    edit: Callable[[dict[str, Any]], None],
) -> None:
    edit(answer)
    result, _ = run(settings, doc, draft, answering(answer))
    assert_fallback(result, draft, "invalid_output")


def test_an_unknown_section_is_filled_from_the_draft(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    condition_of(answer, "low_line_pressure")["section"] = "12.9"
    entry_of(answer, "intake_filter_clogged")["manual_ref"]["section"] = "12.9"
    answer["alarms"][0]["section"] = "12.9"

    result, _ = run(settings, doc, draft, answering(answer))

    assert result.source == SOURCE_LLM
    assert result.catalog.conditions == draft.conditions
    assert sorted(result.catalog.alarms, key=lambda alarm: alarm.code) == sorted(
        draft.alarms, key=lambda alarm: alarm.code
    )


def test_a_section_neither_side_resolves_falls_back_as_invalid_output(
    settings: Settings, doc: ManualDoc, draft: Catalog, answer: dict[str, Any]
) -> None:
    extra = {**copy.deepcopy(answer["alarms"][0]), "code": "W999", "section": "12.9"}
    answer["alarms"].append(extra)

    result, _ = run(settings, doc, draft, answering(answer))

    assert_fallback(result, draft, "invalid_output")


# --------------------------------------------------------------------------
# SDK exceptions, most specific first
# --------------------------------------------------------------------------


def _status_error(kind: type[anthropic.APIStatusError], status: int) -> anthropic.APIStatusError:
    response = httpx2.Response(status, request=REQUEST)
    return kind(f"HTTP {status}", response=response, body=None)


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (_status_error(anthropic.AuthenticationError, 401), "auth"),
        (_status_error(anthropic.RateLimitError, 429), "rate_limit"),
        (anthropic.APITimeoutError(request=REQUEST), "timeout"),
        (_status_error(anthropic.InternalServerError, 500), "status_500"),
        (_status_error(anthropic.OverloadedError, 529), "status_529"),
        (_status_error(anthropic.APIStatusError, 418), "status_418"),
        (anthropic.APIConnectionError(request=REQUEST), "connection"),
        (
            anthropic.APIResponseValidationError(
                response=httpx2.Response(200, request=REQUEST), body=None
            ),
            "invalid_output",
        ),
        (anthropic.AnthropicError("the SDK gave up"), "sdk_error"),
    ],
    ids=lambda value: type(value).__name__ if isinstance(value, BaseException) else value,
)
def test_each_sdk_exception_maps_to_its_reason(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    error: anthropic.AnthropicError,
    reason: str,
) -> None:
    result, client = run(settings, doc, draft, error)

    assert_fallback(result, draft, reason)
    assert result.usage is None
    assert client.closed


def test_a_bug_is_not_reported_as_a_model_failure(
    settings: Settings, doc: ManualDoc, draft: Catalog
) -> None:
    with pytest.raises(RuntimeError, match="not an SDK failure"):
        run(settings, doc, draft, RuntimeError("not an SDK failure"))


# --------------------------------------------------------------------------
# The real client and the selection
# --------------------------------------------------------------------------


@pytest.mark.parametrize("base_url", ["http://127.0.0.1:9/mock", None])
def test_the_key_reaches_only_the_client_constructor(
    env: Callable[..., dict[str, str]],
    doc: ManualDoc,
    draft: Catalog,
    answer: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    base_url: str | None,
) -> None:
    overrides = {"LLM_API_KEY": DUMMY_KEY, "CONTRACTS_DIR": str(CONTRACTS)}
    if base_url:
        overrides["LLM_BASE_URL"] = base_url
    settings = Settings.from_env(env(**overrides))
    constructed: list[dict[str, Any]] = []

    def fake_anthropic(**options: Any) -> FakeClient:
        constructed.append(options)
        return FakeClient(answering(answer))

    monkeypatch.setattr(anthropic, "Anthropic", fake_anthropic)
    result = AnthropicStructurer(settings).structure(doc, draft)

    assert result.source == SOURCE_LLM
    assert constructed == [
        {
            "api_key": DUMMY_KEY,
            "base_url": base_url,
            "timeout": settings.llm_timeout_s,
            "max_retries": CLIENT_RETRIES,
        }
    ]


def test_settings_read_the_optional_base_url(env: Callable[..., dict[str, str]]) -> None:
    assert Settings.from_env(env()).llm_base_url is None
    assert Settings.from_env(env(LLM_BASE_URL="")).llm_base_url is None
    assert Settings.from_env(env(LLM_BASE_URL="http://127.0.0.1:9")).llm_base_url == (
        "http://127.0.0.1:9"
    )


def test_without_a_key_the_deterministic_structurer_is_selected(
    monkeypatch: pytest.MonkeyPatch, doc: ManualDoc, draft: Catalog
) -> None:
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    chosen = select_structurer(Settings.from_env())

    assert isinstance(chosen, DeterministicStructurer)
    result = chosen.structure(doc, draft)
    assert (result.catalog, result.source, result.fallback_reason) == (draft, SOURCE_TABLES, None)


def test_with_a_key_the_anthropic_structurer_is_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_API_KEY", DUMMY_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    assert isinstance(select_structurer(Settings.from_env()), AnthropicStructurer)

    monkeypatch.setenv("LLM_PROVIDER", "none")
    assert isinstance(select_structurer(Settings.from_env()), DeterministicStructurer)


def test_a_missing_sdk_degrades_to_the_draft_with_a_reason(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    doc: ManualDoc,
    draft: Catalog,
) -> None:
    monkeypatch.setenv("LLM_API_KEY", DUMMY_KEY)
    monkeypatch.setitem(sys.modules, "anthropic", None)
    monkeypatch.delitem(sys.modules, structurer_module.__name__)
    caplog.set_level(logging.WARNING)

    chosen = select_structurer(Settings.from_env())

    assert isinstance(chosen, DeterministicStructurer)
    result = chosen.structure(doc, draft)
    assert (result.source, result.fallback_reason) == (SOURCE_TABLES, FALLBACK_SDK_MISSING)
    assert any(
        getattr(record, "fallback_reason", None) == FALLBACK_SDK_MISSING
        for record in caplog.records
    )


def test_a_broken_import_of_our_own_is_not_a_missing_sdk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_API_KEY", DUMMY_KEY)
    monkeypatch.setitem(sys.modules, structurer_module.__name__, None)

    with pytest.raises(ModuleNotFoundError):
        select_structurer(Settings.from_env())


# --------------------------------------------------------------------------
# Logs never carry the key or a body
# --------------------------------------------------------------------------


def test_no_log_record_carries_the_key_or_a_body(
    settings: Settings,
    doc: ManualDoc,
    draft: Catalog,
    answer: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("LLM_API_KEY", DUMMY_KEY)
    invalid = copy.deepcopy(answer)
    entry_of(invalid, "oil_cooler_fouled")["subsystem"] = "pneumatics"

    select_structurer(Settings.from_env())
    for outcome in (
        answering(answer),
        answering(invalid),
        message(stop_reason="refusal"),
        _status_error(anthropic.AuthenticationError, 401),
    ):
        run(settings, doc, draft, outcome)

    assert caplog.records, "the scenarios above log their outcome"
    payload_marks = ("<manual>", "<draft_catalog>", SYSTEM_PROMPT.splitlines()[0])
    remedy = entry_of(answer, "oil_cooler_fouled")["remedy"]
    for record in caplog.records:
        rendered = f"{record.getMessage()} {record.__dict__!r}"
        assert DUMMY_KEY not in rendered
        assert not any(mark in rendered for mark in payload_marks)
        assert remedy not in rendered
