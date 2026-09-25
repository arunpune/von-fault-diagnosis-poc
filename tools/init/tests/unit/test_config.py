# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""``Settings.from_env`` — defaults, overrides, path resolution, exit 2."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from fdp_init.config import CANONICAL_METROPT_CSV, UCI_METROPT_URL, Settings, find_root
from fdp_init.errors import ExitCode, InitError

Env = Callable[..., dict[str, str]]

_FIELD_OF = {
    "POSTGRES_HOST": "postgres_host",
    "MQTT_URL": "mqtt_url",
    "METROPT_URL": "metropt_url",
    "LOG_LEVEL": "log_level",
    "LLM_API_KEY": "llm_api_key",
    "INIT_FORCE_INGEST": "force_ingest",
}


def test_defaults_match_the_plan(env: Env, tmp_path: Path) -> None:
    settings = Settings.from_env(env())

    assert settings.postgres_host == "postgres"
    assert settings.postgres_port == 5432
    assert settings.postgres_user == "fdp_admin"
    assert settings.postgres_db == "fdp"
    assert settings.mqtt_url == "mqtt://mqtt:1883"
    assert (settings.mqtt_host, settings.mqtt_port) == ("mqtt", 1883)
    assert settings.metropt_csv == tmp_path / CANONICAL_METROPT_CSV
    assert settings.metropt_url == UCI_METROPT_URL
    assert settings.metropt_fallback_url == UCI_METROPT_URL
    assert settings.manual_path == tmp_path / "data/manual/cau-7-realistic.pdf"
    assert settings.wait_timeout_s == 120.0
    assert settings.download_timeout_s == 3600.0
    assert settings.download_retries == 5
    assert settings.embed_batch_size == 32
    assert settings.llm_model == "claude-opus-5"
    assert settings.llm_api_key is None
    assert settings.log_level == "info"
    assert settings.log_format == "json"
    assert settings.force_ingest is False
    assert settings.skip_dataset is False
    assert settings.skip_manual is False
    assert 1 <= settings.ort_threads <= 4


def test_overrides_are_parsed(env: Env) -> None:
    settings = Settings.from_env(
        env(
            POSTGRES_HOST="db.internal",
            POSTGRES_PORT="6543",
            MQTT_URL="mqtts://broker:8884",
            INIT_WAIT_TIMEOUT_S="2.5",
            INIT_DOWNLOAD_RETRIES="2",
            INIT_FORCE_INGEST="true",
            INIT_SKIP_DATASET="yes",
            LOG_LEVEL="DEBUG",
            LOG_FORMAT="text",
        )
    )

    assert settings.postgres_host == "db.internal"
    assert settings.postgres_port == 6543
    assert (settings.mqtt_host, settings.mqtt_port) == ("broker", 8884)
    assert settings.wait_timeout_s == 2.5
    assert settings.download_retries == 2
    assert settings.force_ingest is True
    assert settings.skip_dataset is True
    assert settings.log_level == "debug"
    assert settings.log_format == "text"


def test_mqtts_default_port(env: Env) -> None:
    settings = Settings.from_env(env(MQTT_URL="mqtts://broker"))

    assert settings.mqtt_port == 8883


@pytest.mark.parametrize(
    "name",
    ["POSTGRES_HOST", "MQTT_URL", "METROPT_URL", "LOG_LEVEL", "LLM_API_KEY", "INIT_FORCE_INGEST"],
)
def test_empty_values_are_unset(env: Env, name: str) -> None:
    """Compose renders ``${VAR:-}`` as ``''``."""
    settings = Settings.from_env(env(**{name: ""}))
    default = Settings.from_env(env())

    assert getattr(settings, _FIELD_OF[name]) == getattr(default, _FIELD_OF[name])


def test_relative_paths_resolve_against_the_root(env: Env, tmp_path: Path) -> None:
    settings = Settings.from_env(env(MANUAL_PATH="data/byo-manual/x.pdf"))

    assert settings.manual_path == tmp_path / "data/byo-manual/x.pdf"


def test_absolute_paths_are_kept(env: Env) -> None:
    settings = Settings.from_env(env(METROPT_CSV="/data/fixtures/ci-slice.csv"))

    assert settings.metropt_csv == Path("/data/fixtures/ci-slice.csv")


def test_report_dir_follows_the_root(env: Env, tmp_path: Path) -> None:
    """``INIT_ROOT_DIR=/`` in the image makes the default ``/reports``."""
    assert Settings.from_env(env()).report_dir == tmp_path / "reports"
    assert Settings.from_env({"INIT_ROOT_DIR": "/"}).report_dir == Path("/reports")


def test_condition_pattern_follows_the_fault_pattern(env: Env) -> None:
    settings = Settings.from_env(env(CATALOG_FAULT_ID_PATTERN=r"F-\d{3}"))

    assert settings.condition_id_pattern == r"F-\d{3}"


def test_catalog_mode_needs_a_key(env: Env) -> None:
    assert Settings.from_env(env()).catalog_mode == "tables"
    assert Settings.from_env(env(LLM_API_KEY="sk-ant-x")).catalog_mode == "llm"
    assert Settings.from_env(env(LLM_API_KEY="sk-ant-x", LLM_PROVIDER="none")).catalog_mode == (
        "tables"
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("POSTGRES_PORT", "not-a-number"),
        ("POSTGRES_PORT", "0"),
        ("INIT_WAIT_TIMEOUT_S", "-1"),
        ("INIT_WAIT_TIMEOUT_S", "soon"),
        ("INIT_FORCE_INGEST", "maybe"),
        ("LOG_LEVEL", "chatty"),
        ("LOG_FORMAT", "xml"),
        ("MQTT_URL", "http://broker:1883"),
        ("MQTT_URL", "mqtt://broker:not-a-port"),
        ("MQTT_URL", "mqtt://"),
        ("INIT_ROOT_DIR", "relative/root"),
        ("INIT_EMBED_BATCH_SIZE", "0"),
    ],
)
def test_invalid_values_exit_two(env: Env, name: str, value: str) -> None:
    with pytest.raises(InitError) as caught:
        Settings.from_env(env(**{name: value}))

    assert caught.value.exit_code is ExitCode.CONFIG
    assert caught.value.step == "config"
    assert name in caught.value.message


def test_repr_masks_the_secrets(env: Env) -> None:
    settings = Settings.from_env(
        env(LLM_API_KEY="sk-ant-test-0123456789", POSTGRES_PASSWORD="hunter2-hunter2")
    )
    dumped = repr(settings)

    assert "sk-ant-test-0123456789" not in dumped
    assert "hunter2-hunter2" not in dumped
    assert dumped.count("'***'") == 2
    assert "postgres_host='postgres'" in dumped


def test_find_root_finds_the_workspace() -> None:
    """The dev fallback locates the repository by its uv workspace marker."""
    root = find_root()

    assert (root / "pyproject.toml").is_file()
    assert "[tool.uv.workspace]" in (root / "pyproject.toml").read_text(encoding="utf-8")
