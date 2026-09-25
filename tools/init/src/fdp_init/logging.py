# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""Structured logging that cannot print a key.

One JSON object per line on stdout — ``ts``, ``level``, ``logger``, ``msg``,
``step`` and whatever ``extra`` the call site passed — or a plain line when
``LOG_FORMAT=text``. Every record passes :class:`RedactingFilter` first, which
masks the value of any ``*_API_KEY`` / ``*_PASSWORD`` / ``*_TOKEN`` variable
that is set in the environment, any ``sk-ant-…`` token and any ``Bearer …``
header, in the message, in the extras and in the traceback: secrets come from
the environment and never reach a log line.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import traceback
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

from fdp_init.config import Settings

MASK = "***"

SECRET_NAME_SUFFIXES = ("_API_KEY", "_PASSWORD", "_TOKEN")
"""Environment variables whose *value* is masked wherever it appears."""

MIN_SECRET_LENGTH = 8
"""Shorter values are too common as substrings to mask safely."""

THIRD_PARTY_LOGGERS = (
    "anthropic",
    "filelock",
    "httpcore",
    "httpx",
    "huggingface_hub",
    "onnxruntime",
    "requests",
    "tokenizers",
    "urllib3",
)
"""Capped at WARNING so a library never narrates over the init log."""

_HANDLER_TAG = "_fdp_init_handler"

_TOKEN_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-+/=]+"),
)

_STANDARD_RECORD_KEYS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)
"""Attributes :mod:`logging` sets itself; everything else on a record is an
extra the call site passed."""

_EXTRA_EXCLUDED = _STANDARD_RECORD_KEYS | {"step"}


class Redactor:
    """Replaces known secrets with :data:`MASK`.

    The literal values come from the environment at construction time plus
    whatever ``extra`` the caller adds — the secrets already parsed into
    :class:`~fdp_init.config.Settings`, which may have reached the process
    through a file rather than the environment. A masked value is caught
    wherever it surfaces: a settings dump, an SDK error message, a traceback
    frame.

    Args:
        environ: The environment to read secret values from; ``os.environ``
            by default.
        extra: Further literals to mask, ``None`` entries ignored.
    """

    def __init__(
        self,
        environ: Mapping[str, str] | None = None,
        extra: Iterable[str | None] = (),
    ) -> None:
        env = os.environ if environ is None else environ
        candidates = {
            value for name, value in env.items() if name.upper().endswith(SECRET_NAME_SUFFIXES)
        }
        candidates.update(value for value in extra if value)
        literals = sorted(
            (value for value in candidates if len(value) >= MIN_SECRET_LENGTH),
            key=len,
            reverse=True,
        )
        self._patterns: tuple[re.Pattern[str], ...] = (
            *_TOKEN_PATTERNS,
            *(re.compile(re.escape(value)) for value in literals),
        )

    def __call__(self, text: str) -> str:
        """Return ``text`` with every known secret replaced."""
        for pattern in self._patterns:
            text = pattern.sub(self._replace, text)
        return text

    @staticmethod
    def _replace(match: re.Match[str]) -> str:
        """Keep the ``Bearer`` scheme readable; mask everything else whole."""
        found = match.group(0)
        if found[:6].lower() == "bearer":
            return f"{found[:6]} {MASK}"
        return MASK


class RedactingFilter(logging.Filter):
    """Rewrites a record in place so no handler can emit a secret."""

    def __init__(self, redactor: Redactor | None = None) -> None:
        super().__init__()
        self._redact = redactor or Redactor()

    def filter(self, record: logging.LogRecord) -> bool:
        """Redact the message, the extras and the traceback. Never drops."""
        record.msg = self._redact(record.getMessage())
        record.args = ()
        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_KEYS:
                continue
            if isinstance(value, str):
                record.__dict__[key] = self._redact(value)
            elif not isinstance(value, bool | int | float | type(None)):
                record.__dict__[key] = self._redact(str(value))
        if record.exc_info is not None and record.exc_text is None:
            record.exc_text = self._redact("".join(traceback.format_exception(*record.exc_info)))
        elif record.exc_text is not None:
            record.exc_text = self._redact(record.exc_text)
        if record.stack_info is not None:
            record.stack_info = self._redact(record.stack_info)
        return True


def _timestamp(created: float) -> str:
    """ISO 8601 in UTC with milliseconds, the shape the report uses."""
    moment = datetime.fromtimestamp(created, tz=UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _extras(record: logging.LogRecord) -> dict[str, Any]:
    """The fields the call site passed through ``extra``."""
    return {key: value for key, value in record.__dict__.items() if key not in _EXTRA_EXCLUDED}


class JsonFormatter(logging.Formatter):
    """One JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        """Render the record; ``step`` is always present, ``null`` when unset."""
        payload: dict[str, Any] = {
            "ts": _timestamp(record.created),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "step": getattr(record, "step", None),
        }
        payload.update(_extras(record))
        if record.exc_text:
            payload["exc"] = record.exc_text
        if record.stack_info:
            payload["stack"] = record.stack_info
        return json.dumps(payload, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    """Human-readable lines for ``LOG_FORMAT=text`` during local runs."""

    def format(self, record: logging.LogRecord) -> str:
        """Render ``ts level logger [step] msg key=value …``."""
        step = getattr(record, "step", None)
        head = f"{_timestamp(record.created)} {record.levelname.lower():<7} {record.name}"
        if step:
            head = f"{head} [{step}]"
        extras = " ".join(f"{key}={value!r}" for key, value in sorted(_extras(record).items()))
        line = f"{head} {record.getMessage()}"
        if extras:
            line = f"{line} {extras}"
        if record.exc_text:
            line = f"{line}\n{record.exc_text}"
        if record.stack_info:
            line = f"{line}\n{record.stack_info}"
        return line


def _remove_own_handlers(logger: logging.Logger) -> None:
    """Drop the handlers a previous :func:`configure_logging` installed."""
    for handler in list(logger.handlers):
        if getattr(handler, _HANDLER_TAG, False):
            logger.removeHandler(handler)
            handler.close()


def configure_logging(settings: Settings) -> logging.Logger:
    """Install the stdout handler and return the ``fdp_init`` logger.

    Idempotent: a second call replaces the handler it installed before, so
    tests and ``fdp-init`` sub-commands can call it freely. The root logger
    keeps the handler at WARNING, which caps every library that has no level
    of its own; :data:`THIRD_PARTY_LOGGERS` are pinned explicitly because some
    of them raise their own level on import.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if settings.log_format == "json" else TextFormatter())
    handler.addFilter(
        RedactingFilter(Redactor(extra=(settings.llm_api_key, settings.postgres_password)))
    )
    setattr(handler, _HANDLER_TAG, True)

    root = logging.getLogger()
    _remove_own_handlers(root)
    root.addHandler(handler)
    root.setLevel(logging.WARNING)

    for name in THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    logger = logging.getLogger("fdp_init")
    logger.setLevel(settings.log_level.upper())
    logger.propagate = True
    return logger
