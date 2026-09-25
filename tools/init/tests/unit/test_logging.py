# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""JSON log shape and redaction (secrets via the environment only).

The key used here is invented and has the shape of a real one on purpose: if
the filter ever regresses, these tests print the difference rather than a key.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator

import pytest

from fdp_init.config import Settings
from fdp_init.logging import MASK, Redactor, configure_logging

Env = Callable[..., dict[str, str]]

FAKE_KEY = "sk-ant-test-0123456789"
FAKE_PASSWORD = "swordfish-swordfish"


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """Give every test a clean root logger and hand it back afterwards."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    package_level = logging.getLogger("fdp_init").level
    yield
    root.handlers = handlers
    root.setLevel(level)
    logging.getLogger("fdp_init").setLevel(package_level)


def _emit(
    settings: Settings,
    message: str,
    *,
    extra: dict[str, object] | None = None,
    error: BaseException | None = None,
) -> None:
    """Log one record through the configured handler."""
    logger = configure_logging(settings)
    if error is None:
        logger.info(message, extra=extra or {})
        return
    try:
        raise error
    except BaseException:
        logger.exception(message, extra=extra or {})


def test_json_shape(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    settings = Settings.from_env(env())

    _emit(settings, "dataset ready", extra={"step": "dataset", "bytes": 12})

    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["level"] == "info"
    assert payload["logger"] == "fdp_init"
    assert payload["msg"] == "dataset ready"
    assert payload["step"] == "dataset"
    assert payload["bytes"] == 12
    assert payload["ts"].endswith("Z")


def test_step_is_always_present(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    _emit(Settings.from_env(env()), "no step here")

    assert json.loads(capsys.readouterr().out.strip())["step"] is None


def test_text_format(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    settings = Settings.from_env(env(LOG_FORMAT="text"))

    _emit(settings, "waiting", extra={"step": "wait", "dependency": "mqtt"})

    line = capsys.readouterr().out.strip()
    assert "[wait]" in line
    assert "waiting" in line
    assert "dependency='mqtt'" in line


def test_key_never_reaches_stdout(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    """A settings dump, a message and a traceback all carry the key."""
    environ = env(LLM_API_KEY=FAKE_KEY, POSTGRES_PASSWORD=FAKE_PASSWORD)
    settings = Settings.from_env(environ)

    _emit(
        settings,
        f"calling the structurer with {FAKE_KEY}",
        extra={"step": "ingest", "settings": settings, "header": f"Bearer {FAKE_KEY}"},
        error=RuntimeError(f"401 for key {FAKE_KEY} and password {FAKE_PASSWORD}"),
    )

    out = capsys.readouterr().out
    assert FAKE_KEY not in out
    assert FAKE_PASSWORD not in out
    payload = json.loads(out.strip())
    assert MASK in payload["msg"]
    assert payload["header"] == f"Bearer {MASK}"
    assert MASK in payload["exc"]
    assert "RuntimeError" in payload["exc"]
    assert MASK in payload["settings"]


def test_redactor_masks_env_values_and_tokens() -> None:
    redactor = Redactor({"SOME_TOKEN": "0123456789abcdef", "SHORT_TOKEN": "abc"})

    assert redactor("value 0123456789abcdef here") == f"value {MASK} here"
    assert redactor("short abc stays") == "short abc stays"
    assert redactor("Authorization: Bearer abc.def-123") == f"Authorization: Bearer {MASK}"
    assert redactor("sk-ant-api03-xyz") == MASK


def test_third_party_loggers_are_capped(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    configure_logging(Settings.from_env(env(LOG_LEVEL="debug")))

    logging.getLogger("anthropic").info("request body")
    logging.getLogger("urllib3").debug("connection pool")
    logging.getLogger("anthropic").warning("rate limited")

    lines = [line for line in capsys.readouterr().out.splitlines() if line]
    assert len(lines) == 1
    assert json.loads(lines[0])["msg"] == "rate limited"


def test_configure_is_idempotent(env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    settings = Settings.from_env(env())

    configure_logging(settings)
    logger = configure_logging(settings)
    logger.info("once")

    assert len(capsys.readouterr().out.strip().splitlines()) == 1
