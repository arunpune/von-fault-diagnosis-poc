# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The structurer over a real socket, against the contracts Anthropic mock.

The real Python ``anthropic`` client, built by the production code path from
``LLM_API_KEY`` and ``LLM_BASE_URL``, talks to the contracts' mock Messages server,
started once per scenario with ``pnpm --silent --filter @fdp/contracts
mock-anthropic --port 0``: its first stdout line is the URL, the ones after it
are ``<method> <path> -> <status>``, which is how a test here counts the SDK's
retries. The mock validates every request against its committed request
schema and answers 422 otherwise, so an accepted answer is also a valid
request; one test additionally validates the captured bytes itself.

No Docker is involved; the marker is ``integration`` because the test needs
the Node workspace (``make install``) and spawns processes. It skips with a
reason when ``packages/contracts/node_modules`` or ``pnpm`` is missing.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty, Queue
from typing import Any

import anthropic
import pytest
from jsonschema import Draft202012Validator

from fdp_init.catalog.anthropic_structurer import (
    MAX_TOKENS,
    SYSTEM_PROMPT,
    AnthropicStructurer,
    build_payload,
    load_output_schema,
)
from fdp_init.catalog.deterministic import build_catalog
from fdp_init.catalog.model import SOURCE_LLM, SOURCE_TABLES, Catalog, to_catalog_document
from fdp_init.catalog.provider import StructureResult
from fdp_init.config import Settings
from fdp_init.logging import THIRD_PARTY_LOGGERS, configure_logging
from fdp_init.manual.extract import extract_manual
from fdp_init.manual.model import ManualDoc

pytestmark = pytest.mark.integration

ROOT = Path(__file__).resolve().parents[4]
"""The repository root: ``tools/init/tests/integration`` is four levels down."""

CONTRACTS = ROOT / "packages" / "contracts"
REQUEST_SCHEMA = CONTRACTS / "mock" / "schemas" / "anthropic-messages-request.schema.json"
CLEAN_PDF = ROOT / "tools" / "init" / "tests" / "fixtures" / "mini-manual" / "mini-manual-clean.pdf"

DUMMY_KEY = "sk-ant-integration-dummy-key-0123456789"
"""Never a real key; the mock accepts any non-empty one unless told otherwise."""

MODEL = "claude-opus-5"
URL_LINE = re.compile(r"^fdp-anthropic-mock listening on (http://\S+)$")
START_TIMEOUT_S = 60.0
STOP_TIMEOUT_S = 10.0

FAST_RETRY = "0.01"
"""``retry-after`` the queued failures carry, so the SDK's two retries take milliseconds."""

SDK_ENVIRONMENT = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
"""What the SDK would read on its own; removed so only ``Settings`` configures it."""


# --------------------------------------------------------------------------
# The mock process
# --------------------------------------------------------------------------


@dataclass
class MockProcess:
    """One running ``fdp-anthropic-mock`` and everything it printed so far."""

    url: str
    process: subprocess.Popen[str]
    lines: list[str] = field(default_factory=list)

    def request_lines(self) -> list[str]:
        """The body-free request log, oldest first."""
        return [line for line in self.lines if line.startswith("POST ")]


@pytest.fixture(scope="module")
def mock_command() -> list[str]:
    """``pnpm … mock-anthropic --port 0``, or a skip when the workspace is not installed."""
    if not (CONTRACTS / "node_modules").is_dir():
        pytest.skip("packages/contracts/node_modules is missing: run `make install` first")
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        pytest.skip("pnpm is not on PATH; the contracts Anthropic mock needs it")
    return [pnpm, "--silent", "--filter", "@fdp/contracts", "mock-anthropic", "--port", "0"]


def _pump(stream: Any, sink: list[str], first: Queue[str]) -> None:
    """Copy the child's stdout into ``sink``, handing the first line to ``first``."""
    for raw in stream:
        line = raw.rstrip("\n")
        if not sink:
            first.put(line)
        sink.append(line)


def _stop(process: subprocess.Popen[str]) -> None:
    """Signal the whole process group: pnpm does not forward SIGTERM to node."""
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=STOP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=STOP_TIMEOUT_S)


@contextmanager
def running_mock(command: list[str], *args: str) -> Iterator[MockProcess]:
    """Start the mock with ``args`` and stop it, and its node child, afterwards."""
    process = subprocess.Popen(
        [*command, *args],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    lines: list[str] = []
    errors: list[str] = []
    first: Queue[str] = Queue()
    readers = [
        threading.Thread(target=_pump, args=(process.stdout, lines, first), daemon=True),
        threading.Thread(target=_pump, args=(process.stderr, errors, Queue()), daemon=True),
    ]
    for reader in readers:
        reader.start()
    try:
        try:
            line = first.get(timeout=START_TIMEOUT_S)
        except Empty:
            pytest.fail(f"the mock printed nothing within {START_TIMEOUT_S} s: {errors}")
        match = URL_LINE.match(line)
        if match is None:
            pytest.fail(f"the mock's first line is not its URL: {line!r}; stderr {errors}")
        yield MockProcess(url=match.group(1), process=process, lines=lines)
    finally:
        _stop(process)
        for reader in readers:
            reader.join(timeout=STOP_TIMEOUT_S)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _only_settings_configure_the_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in SDK_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(scope="module")
def doc() -> ManualDoc:
    return extract_manual(CLEAN_PDF)


@pytest.fixture(scope="module")
def draft(doc: ManualDoc) -> Catalog:
    return build_catalog(doc)


@pytest.fixture
def reply_file(tmp_path: Path) -> Callable[[Any], str]:
    """Write a ``--reply`` file and return its path."""

    def write(reply: Any) -> str:
        path = tmp_path / "reply.json"
        path.write_text(json.dumps(reply), encoding="utf-8")
        return str(path)

    return write


@pytest.fixture
def settings_for(env: Callable[..., dict[str, str]]) -> Callable[..., Settings]:
    """Settings pointing ``LLM_BASE_URL`` at a running mock."""

    def build(mock: MockProcess, **overrides: str) -> Settings:
        return Settings.from_env(
            env(
                LLM_API_KEY=DUMMY_KEY,
                LLM_BASE_URL=mock.url,
                CONTRACTS_DIR=str(CONTRACTS),
                **overrides,
            )
        )

    return build


def structure(settings: Settings, doc: ManualDoc, draft: Catalog) -> StructureResult:
    return AnthropicStructurer(settings).structure(doc, draft)


# --------------------------------------------------------------------------
# The scenarios
# --------------------------------------------------------------------------


def test_the_happy_path_goes_through_the_real_client(
    mock_command: list[str],
    reply_file: Callable[[Any], str],
    settings_for: Callable[..., Settings],
    doc: ManualDoc,
    draft: Catalog,
) -> None:
    reply = reply_file({"json": to_catalog_document(draft, doc)})
    with running_mock(mock_command, "--reply", reply) as mock:
        result = structure(settings_for(mock), doc, draft)

    assert result.source == SOURCE_LLM, result.fallback_reason
    assert result.catalog.conditions == draft.conditions
    assert result.usage is not None
    assert result.usage["model"] == MODEL
    assert result.usage["input_tokens"] > 0
    assert result.usage["output_tokens"] > 0
    assert mock.request_lines() == ["POST /v1/messages -> 200"]


def test_the_request_the_sdk_sends_validates_against_the_mock_schema(
    mock_command: list[str],
    reply_file: Callable[[Any], str],
    settings_for: Callable[..., Settings],
    doc: ManualDoc,
    draft: Catalog,
) -> None:
    sent: list[tuple[str, bytes, bool]] = []

    def record(request: Any) -> None:
        sent.append((request.url.path, request.read(), "x-api-key" in request.headers))

    reply = reply_file({"json": to_catalog_document(draft, doc)})
    with running_mock(mock_command, "--reply", reply) as mock:
        settings = settings_for(mock)

        def client() -> anthropic.Anthropic:
            return anthropic.Anthropic(
                api_key=settings.llm_api_key,
                base_url=settings.llm_base_url,
                max_retries=0,
                http_client=anthropic.DefaultHttpxClient(event_hooks={"request": [record]}),
            )

        result = AnthropicStructurer(settings, client_factory=client).structure(doc, draft)

    assert result.source == SOURCE_LLM, result.fallback_reason
    [(path, raw, keyed)] = sent
    assert path == "/v1/messages"
    assert keyed
    body = json.loads(raw)
    schema = json.loads(REQUEST_SCHEMA.read_text(encoding="utf-8"))
    assert list(Draft202012Validator(schema).iter_errors(body)) == []
    assert body["output_config"] == {
        "format": {"type": "json_schema", "schema": load_output_schema(CONTRACTS)}
    }
    assert body["model"] == MODEL
    assert body["max_tokens"] == MAX_TOKENS
    assert body["system"] == SYSTEM_PROMPT
    assert body["messages"] == [{"role": "user", "content": build_payload(doc, draft)}]
    assert not {"thinking", "betas", "fallbacks"} & set(body)


@pytest.mark.parametrize(
    ("args", "reply", "reason", "requests"),
    [
        pytest.param((), {"stopReason": "refusal"}, "refusal", ["200"], id="refusal"),
        pytest.param(
            (),
            {"stopReason": "max_tokens", "text": '{"schema": "urn:fdp'},
            "truncated",
            ["200"],
            id="max_tokens",
        ),
        pytest.param(("--api-key", "another-key"), None, "auth", ["401"], id="401"),
        pytest.param(
            ("--fail-next", f"429:3:{FAST_RETRY}"), None, "rate_limit", ["429"] * 3, id="429"
        ),
        pytest.param(
            ("--fail-next", f"529:3:{FAST_RETRY}"), None, "status_529", ["529"] * 3, id="529"
        ),
    ],
)
def test_each_failure_falls_back_with_its_reason(
    mock_command: list[str],
    reply_file: Callable[[Any], str],
    settings_for: Callable[..., Settings],
    doc: ManualDoc,
    draft: Catalog,
    args: tuple[str, ...],
    reply: dict[str, Any] | None,
    reason: str,
    requests: list[str],
) -> None:
    extra = ("--reply", reply_file(reply)) if reply is not None else ()
    with running_mock(mock_command, *args, *extra) as mock:
        result = structure(settings_for(mock), doc, draft)

    assert result.fallback_reason == reason
    assert result.source == SOURCE_TABLES
    assert result.catalog is draft
    # A 401 is not retried; 429 and 529 are, twice (max_retries=2), then given up.
    assert mock.request_lines() == [f"POST /v1/messages -> {status}" for status in requests]


def test_a_retried_overload_recovers(
    mock_command: list[str],
    reply_file: Callable[[Any], str],
    settings_for: Callable[..., Settings],
    doc: ManualDoc,
    draft: Catalog,
) -> None:
    reply = reply_file({"json": to_catalog_document(draft, doc)})
    with running_mock(mock_command, "--fail-next", f"529:1:{FAST_RETRY}", "--reply", reply) as mock:
        result = structure(settings_for(mock), doc, draft)

    assert result.source == SOURCE_LLM, result.fallback_reason
    assert mock.request_lines() == ["POST /v1/messages -> 529", "POST /v1/messages -> 200"]


# --------------------------------------------------------------------------
# What the init log shows, with the production logging configuration
# --------------------------------------------------------------------------


@pytest.fixture
def production_logging() -> Iterator[Callable[[Settings], None]]:
    """``configure_logging`` for one test, with the global logging state restored."""
    root = logging.getLogger()
    own = logging.getLogger("fdp_init")
    saved = (
        root.level,
        list(root.handlers),
        own.level,
        own.propagate,
        {name: logging.getLogger(name).level for name in THIRD_PARTY_LOGGERS},
    )
    yield configure_logging
    root_level, handlers, own_level, own_propagate, library_levels = saved
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
            handler.close()
    root.setLevel(root_level)
    own.setLevel(own_level)
    own.propagate = own_propagate
    for name, level in library_levels.items():
        logging.getLogger(name).setLevel(level)


def test_the_init_log_carries_neither_the_key_nor_a_body(
    mock_command: list[str],
    reply_file: Callable[[Any], str],
    settings_for: Callable[..., Settings],
    doc: ManualDoc,
    draft: Catalog,
    production_logging: Callable[[Settings], None],
    capsys: pytest.CaptureFixture[str],
) -> None:
    document = to_catalog_document(draft, doc)
    invalid = json.loads(json.dumps(document))
    invalid["causes"][0]["subsystem"] = "pneumatics"
    replies = [{"json": document}, {"json": invalid}, {"stopReason": "refusal"}]
    with running_mock(mock_command, "--reply", reply_file(replies)) as mock:
        settings = settings_for(mock, LOG_LEVEL="debug", LOG_FORMAT="json")
        production_logging(settings)
        outcomes = [structure(settings, doc, draft).fallback_reason for _ in replies]

    assert outcomes == [None, "invalid_output", "refusal"]
    output = capsys.readouterr().out
    records = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
    assert {record.get("fallback_reason") for record in records} >= {"invalid_output", "refusal"}
    assert DUMMY_KEY not in output
    for mark in (
        "<manual>",
        "<draft_catalog>",
        SYSTEM_PROMPT.splitlines()[0],
        document["causes"][0]["remedy"],
    ):
        assert mark not in output
