# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
"""The canonical environment-variable list of the PoC.

The same names live in ``.env.example`` and in the README "Configuration"
table; ``fdp-checks env`` compares the three as sets, so a change that adds a
variable to both files stays green without touching this module.

Values Compose sets as literals (``PG_HOST``, ``PG_PORT``, ``POSTGRES_HOST``,
``POSTGRES_PORT``, ``MQTT_URL``, ``INIT_REPORT_DIR``, ``GT_DIR``,
``SIM_AUTOPLAY``, ``SIM_LOOP``, ``MODBUS_ADDR``) are compose-internal and are
deliberately absent.
"""

from __future__ import annotations

REQUIRED_VARS: frozenset[str] = frozenset(
    {
        # Decision backend
        "TYPESAFE_API_KEY",
        "TYPESAFE_BASE_URL",
        "JEV_MODEL",
        "DECISION_BACKEND",
        "LLM_PROVIDER",
        "LLM_API_KEY",
        "LLM_MODEL",
        "LLM_BASE_URL",
        # Prices (Cost panel)
        "JEV_PRICE_INPUT_PER_MTOK",
        "LLM_PRICE_INPUT_PER_MTOK",
        "LLM_PRICE_OUTPUT_PER_MTOK",
        "PRICES_AS_OF",
        # Data
        "METROPT_URL",
        "METROPT_FALLBACK_URL",
        "METROPT_CSV",
        "METROPT_CSV_HOST",
        "MANUAL_PATH",
        "MODEL_CACHE_DIR",
        # Init
        "INIT_WAIT_TIMEOUT_S",
        "INIT_DOWNLOAD_TIMEOUT_S",
        "INIT_FORCE_INGEST",
        # Simulation and ports
        "REPLAY_SPEED",
        "UI_PORT",
        "MQTT_PORT",
        "MODBUS_PORT",
        "POLL_INTERVAL_MS",
        # Postgres and broker credentials (non-secret PoC defaults)
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "POSTGRES_DB",
        "PG_APP_PASSWORD",
        "PG_GT_PASSWORD",
        "PG_EVAL_PASSWORD",
        "MQTT_GATEWAY_PASSWORD",
        "MQTT_SIM_PASSWORD",
        "MQTT_BACKEND_DIAG_PASSWORD",
        "MQTT_BACKEND_OPS_PASSWORD",
        "MQTT_EVAL_PASSWORD",
        # Backend tuning
        "HEARTBEAT_TELEMETRY_TIMEOUT_S",
        "HEARTBEAT_DECISION_TIMEOUT_S",
        "GATE_TICKET_MIN_CONFIDENCE",
        "GATE_REVIEW_MIN_CONFIDENCE",
        "GATE_PERSIST_SIM_MIN",
        "JEV_GATE_TICKET_MIN_CONFIDENCE",
        "JEV_GATE_REVIEW_MIN_CONFIDENCE",
        "DECISION_INTERVAL_SIM_MIN",
        "EPISODE_CLEAR_SIM_MIN",
        "TELEMETRY_RETENTION_SIM_DAYS",
        "LOG_LEVEL",
        "EMBEDDER_ALLOW_DOWNLOAD",
        "RULES_DISABLED",
        "WS_TELEMETRY_INTERVAL_MS",
        # Evaluation
        "EVAL_PROFILE",
        "EVAL_JEV_MODE",
    }
)
"""Every variable the PoC documents. Secrets come from the environment: no values in Git."""

SECRETS: frozenset[str] = frozenset({"TYPESAFE_API_KEY", "LLM_API_KEY"})
"""The only two variables that hold a credential; they carry no default."""
