# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The environment contract of ``fdp-init``.

:class:`Settings` is built once with :meth:`Settings.from_env` and never
re-read. Relative paths resolve against ``INIT_ROOT_DIR`` — ``/`` in the image,
the repository root in development — so a README value such as
``MANUAL_PATH=data/byo-manual/x.pdf`` works in both worlds.

Every optional variable treats an empty string as unset, because Compose
renders ``${VAR:-}`` as ``''``. Anything unparseable raises
:class:`~fdp_init.errors.InitError` with :attr:`~fdp_init.errors.ExitCode.CONFIG`
before the first network or database call.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, fields
from pathlib import Path
from urllib.parse import urlsplit

from fdp_init.errors import ExitCode, InitError

STEP = "config"

UCI_METROPT_URL = "https://archive.ics.uci.edu/static/public/791/metropt+3+dataset.zip"
"""The fallback download URL (MetroPT-3 arrives by download only);
``.env.example`` replaces the primary URL once the project mirror is published."""

CANONICAL_METROPT_CSV = "data/metropt3/MetroPT3(AirCompressor).csv"
"""The only file name the dataset step downloads into."""

FAULT_ID_PATTERN = r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b"
"""Snake_case identifier with at least one underscore, so ordinary words never
match."""

ALARM_CODE_PATTERN = r"\b[WXSM][0-9]{3}\b"
"""Controller message code, for example ``W104``."""

LOG_LEVELS = ("debug", "info", "warning", "error")
LOG_FORMATS = ("json", "text")

MQTT_SCHEME_PORTS = {"mqtt": 1883, "mqtts": 8883}

SECRET_FIELDS = frozenset({"llm_api_key", "postgres_password"})
"""Field names :meth:`Settings.__repr__` masks."""

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})

_WORKSPACE_MARKER = "[tool.uv.workspace]"


def _fail(message: str) -> InitError:
    """Build the configuration error every helper below raises."""
    return InitError(ExitCode.CONFIG, message, STEP)


def _raw(environ: Mapping[str, str], name: str) -> str | None:
    """The value of ``name``, or ``None`` when unset or empty."""
    value = environ.get(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _text(environ: Mapping[str, str], name: str, default: str) -> str:
    """A string variable with a default."""
    return _raw(environ, name) or default


def _int(environ: Mapping[str, str], name: str, default: int, *, minimum: int = 1) -> int:
    """An integer variable, at least ``minimum``."""
    raw = _raw(environ, name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise _fail(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise _fail(f"{name} must be >= {minimum}, got {value}")
    return value


def _float(environ: Mapping[str, str], name: str, default: float) -> float:
    """A positive number of seconds."""
    raw = _raw(environ, name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise _fail(f"{name} must be a number of seconds, got {raw!r}") from exc
    if value <= 0:
        raise _fail(f"{name} must be > 0, got {value}")
    return value


def _bool(environ: Mapping[str, str], name: str, default: bool) -> bool:
    """A switch written as ``1``/``0``, ``true``/``false``, ``yes``/``no``."""
    raw = _raw(environ, name)
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise _fail(f"{name} must be one of 1/0/true/false/yes/no/on/off, got {raw!r}")


def _choice(environ: Mapping[str, str], name: str, default: str, allowed: tuple[str, ...]) -> str:
    """A lower-cased value out of a closed set."""
    value = _text(environ, name, default).lower()
    if value not in allowed:
        raise _fail(f"{name} must be one of {', '.join(allowed)}, got {value!r}")
    return value


def _path(environ: Mapping[str, str], name: str, default: str, root: Path) -> Path:
    """A path variable, resolved against ``INIT_ROOT_DIR`` when relative."""
    raw = _text(environ, name, default)
    candidate = Path(raw)
    return candidate if candidate.is_absolute() else root / candidate


def find_root(start: Path | None = None) -> Path:
    """Return the repository root: the directory whose ``pyproject.toml``
    declares the uv workspace.

    Used only when ``INIT_ROOT_DIR`` is unset, which is the development case;
    the image sets it to ``/``. The current directory is the last resort.
    """
    here = (start or Path(__file__)).resolve()
    for candidate in here.parents:
        marker = candidate / "pyproject.toml"
        try:
            if marker.is_file() and _WORKSPACE_MARKER in marker.read_text(encoding="utf-8"):
                return candidate
        except OSError:  # unreadable parent: keep walking up
            continue
    return Path.cwd()


def _root_dir(environ: Mapping[str, str]) -> Path:
    """``INIT_ROOT_DIR`` if set, else the repository root."""
    raw = _raw(environ, "INIT_ROOT_DIR")
    if raw is None:
        return find_root()
    root = Path(raw)
    if not root.is_absolute():
        raise _fail(f"INIT_ROOT_DIR must be an absolute path, got {raw!r}")
    return root


def _mqtt_endpoint(url: str) -> tuple[str, int]:
    """Split ``mqtt://host:port`` into the host and port the wait dials."""
    parts = urlsplit(url)
    if parts.scheme not in MQTT_SCHEME_PORTS:
        raise _fail(f"MQTT_URL must use the mqtt:// or mqtts:// scheme, got {url!r}")
    try:
        port = parts.port
    except ValueError as exc:
        raise _fail(f"MQTT_URL has an invalid port: {url!r}") from exc
    if not parts.hostname:
        raise _fail(f"MQTT_URL has no host: {url!r}")
    return parts.hostname, port or MQTT_SCHEME_PORTS[parts.scheme]


def _default_ort_threads() -> int:
    """``min(4, cpu_count)``."""
    return min(4, os.cpu_count() or 1)


@dataclass(frozen=True, slots=True, repr=False)
class Settings:
    """Every variable, validated and resolved.

    Built by :meth:`from_env`; the constructor is not meant to be called with
    partial values. Use :func:`dataclasses.replace` to derive a variant.
    """

    root_dir: Path
    postgres_host: str
    postgres_port: int
    postgres_user: str
    postgres_password: str
    postgres_db: str
    mqtt_url: str
    mqtt_host: str
    mqtt_port: int
    metropt_csv: Path
    metropt_url: str
    metropt_fallback_url: str
    sha256sums_path: Path
    manual_path: Path
    model_cache_dir: Path
    contracts_dir: Path
    migrations_dir: Path
    llm_provider: str
    llm_api_key: str | None
    llm_model: str
    llm_base_url: str | None
    wait_timeout_s: float
    download_timeout_s: float
    download_retries: int
    force_ingest: bool
    skip_dataset: bool
    skip_manual: bool
    report_dir: Path
    embed_batch_size: int
    ort_threads: int
    llm_timeout_s: float
    fault_id_pattern: str
    condition_id_pattern: str
    alarm_code_pattern: str
    log_level: str
    log_format: str

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Build the settings from a mapping, ``os.environ`` by default.

        Raises:
            InitError: with :attr:`~fdp_init.errors.ExitCode.CONFIG` when a
                value cannot be parsed or is out of range.
        """
        env = os.environ if environ is None else environ
        root = _root_dir(env)
        mqtt_url = _text(env, "MQTT_URL", "mqtt://mqtt:1883")
        mqtt_host, mqtt_port = _mqtt_endpoint(mqtt_url)
        fault_pattern = _text(env, "CATALOG_FAULT_ID_PATTERN", FAULT_ID_PATTERN)
        return cls(
            root_dir=root,
            postgres_host=_text(env, "POSTGRES_HOST", "postgres"),
            postgres_port=_int(env, "POSTGRES_PORT", 5432, minimum=1),
            postgres_user=_text(env, "POSTGRES_USER", "fdp_admin"),
            postgres_password=_text(env, "POSTGRES_PASSWORD", "fdp_admin"),
            postgres_db=_text(env, "POSTGRES_DB", "fdp"),
            mqtt_url=mqtt_url,
            mqtt_host=mqtt_host,
            mqtt_port=mqtt_port,
            metropt_csv=_path(env, "METROPT_CSV", CANONICAL_METROPT_CSV, root),
            metropt_url=_text(env, "METROPT_URL", UCI_METROPT_URL),
            metropt_fallback_url=_text(env, "METROPT_FALLBACK_URL", UCI_METROPT_URL),
            sha256sums_path=_path(env, "SHA256SUMS_PATH", "data/SHA256SUMS", root),
            manual_path=_path(env, "MANUAL_PATH", "data/manual/cau-7-realistic.pdf", root),
            model_cache_dir=_path(env, "MODEL_CACHE_DIR", "data/models", root),
            contracts_dir=_path(env, "CONTRACTS_DIR", "packages/contracts", root),
            migrations_dir=_path(env, "MIGRATIONS_DIR", "db/migrations", root),
            llm_provider=_text(env, "LLM_PROVIDER", "anthropic"),
            llm_api_key=_raw(env, "LLM_API_KEY"),
            llm_model=_text(env, "LLM_MODEL", "claude-opus-5"),
            llm_base_url=_raw(env, "LLM_BASE_URL"),
            wait_timeout_s=_float(env, "INIT_WAIT_TIMEOUT_S", 120.0),
            download_timeout_s=_float(env, "INIT_DOWNLOAD_TIMEOUT_S", 3600.0),
            download_retries=_int(env, "INIT_DOWNLOAD_RETRIES", 5),
            force_ingest=_bool(env, "INIT_FORCE_INGEST", False),
            skip_dataset=_bool(env, "INIT_SKIP_DATASET", False),
            skip_manual=_bool(env, "INIT_SKIP_MANUAL", False),
            report_dir=_path(env, "INIT_REPORT_DIR", "reports", root),
            embed_batch_size=_int(env, "INIT_EMBED_BATCH_SIZE", 32),
            ort_threads=_int(env, "INIT_ORT_THREADS", _default_ort_threads()),
            llm_timeout_s=_float(env, "INIT_LLM_TIMEOUT_S", 120.0),
            fault_id_pattern=fault_pattern,
            condition_id_pattern=_text(env, "CATALOG_CONDITION_ID_PATTERN", fault_pattern),
            alarm_code_pattern=_text(env, "CATALOG_ALARM_CODE_PATTERN", ALARM_CODE_PATTERN),
            log_level=_choice(env, "LOG_LEVEL", "info", LOG_LEVELS),
            log_format=_choice(env, "LOG_FORMAT", "json", LOG_FORMATS),
        )

    @property
    def catalog_mode(self) -> str:
        """``llm`` when the optional structurer is configured, else ``tables``.

        Part of the idempotency key.
        """
        return "llm" if self.llm_provider == "anthropic" and self.llm_api_key else "tables"

    def __repr__(self) -> str:
        """Every field, with the secrets masked."""
        parts = []
        for field in fields(self):
            value = getattr(self, field.name)
            if field.name in SECRET_FIELDS and value:
                value = "***"
            parts.append(f"{field.name}={value!r}")
        return f"Settings({', '.join(parts)})"
