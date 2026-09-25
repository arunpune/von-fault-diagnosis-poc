// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ConfigError, decisionModel, gateThresholds, loadEnv, RULES_MODEL } from "./env.ts";
import { REDACTED, Secret } from "./secret.ts";

/** The variables Compose always passes, as Compose passes them (compose.yaml). */
const COMPOSE: NodeJS.ProcessEnv = {
  PORT: "3000",
  UNIT_ID: "cau-7",
  MQTT_URL: "mqtt://mqtt:1883",
  MQTT_BACKEND_DIAG_PASSWORD: "backend-diag",
  PG_HOST: "postgres",
  PG_PORT: "5432",
  POSTGRES_DB: "fdp",
  PG_APP_PASSWORD: "app_rw",
};

describe("loadEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    const env = loadEnv({});
    expect(env.port).toBe(3000);
    expect(env.logLevel).toBe("info");
    expect(env.unitId).toBe("cau-7");
    expect(env.mqttUrl).toBe("mqtt://mqtt:1883");
    expect(env.databaseUrlApp).toBe("postgres://app_rw:app_rw@localhost:5432/fdp");
    expect(env.gate).toEqual({
      ticketMinConfidence: 0.85,
      reviewMinConfidence: 0.6,
      persistSimMin: 1,
      // Jev's own pair: the pre-registered choice (tools/eval/records/jev-thresholds-choice.md).
      jev: { ticketMinConfidence: 0.85, reviewMinConfidence: 0.65 },
    });
    expect(env.decisionIntervalSimMin).toBe(30);
    expect(env.episodeClearSimMin).toBe(120);
    expect(env.heartbeatTelemetryTimeoutS).toBe(15);
    expect(env.heartbeatDecisionTimeoutS).toBe(60);
    expect(env.telemetryRetentionSimDays).toBe(365);
    expect(env.modelCacheDir).toBe("/models");
    expect(env.embedderAllowDownload).toBe(false);
    expect(env.rulesDisabled).toEqual(["flow_pulses_missing"]);
    expect(env.wsTelemetryIntervalMs).toBe(250);
    expect(env.nodeEnv).toBe("development");
  });

  it("composes the pool URL from the parts Compose passes", () => {
    const env = loadEnv({ ...COMPOSE, PG_APP_PASSWORD: "s3cr3t" });
    expect(env.databaseUrlApp).toBe("postgres://app_rw:s3cr3t@postgres:5432/fdp");
  });

  it("percent-encodes a password that would otherwise break the URL", () => {
    const env = loadEnv({ ...COMPOSE, PG_APP_PASSWORD: "p@ss/word" });
    expect(env.databaseUrlApp).toBe("postgres://app_rw:p%40ss%2Fword@postgres:5432/fdp");
  });

  it("lets DATABASE_URL_APP override the composed URL for local development", () => {
    const env = loadEnv({
      ...COMPOSE,
      DATABASE_URL_APP: "postgres://app_rw:app_rw@127.0.0.1:55432/other",
    });
    expect(env.databaseUrlApp).toBe("postgres://app_rw:app_rw@127.0.0.1:55432/other");
  });

  it("treats an empty string as unset", () => {
    const env = loadEnv({ ...COMPOSE, DECISION_BACKEND: "", LOG_LEVEL: "", DATABASE_URL_APP: "" });
    expect(env.decisionBackend).toBe("rules");
    expect(env.logLevel).toBe("info");
    expect(env.databaseUrlApp).toBe("postgres://app_rw:app_rw@postgres:5432/fdp");
  });

  it("picks jev when a TypeSafe key is set and rules when it is not", () => {
    expect(loadEnv({ ...COMPOSE }).decisionBackend).toBe("rules");
    expect(loadEnv({ ...COMPOSE, TYPESAFE_API_KEY: "tk-test" }).decisionBackend).toBe("jev");
  });

  it("refuses a decision backend whose key is missing, naming the variable", () => {
    expect(() => loadEnv({ ...COMPOSE, DECISION_BACKEND: "jev" })).toThrow(
      /TYPESAFE_API_KEY is not set/,
    );
    expect(() => loadEnv({ ...COMPOSE, DECISION_BACKEND: "llm" })).toThrow(
      /LLM_API_KEY is not set/,
    );
  });

  it("refuses a provider the llm backend cannot reach", () => {
    expect(() =>
      loadEnv({
        ...COMPOSE,
        DECISION_BACKEND: "llm",
        LLM_API_KEY: "lk-test",
        LLM_PROVIDER: "somewhere-else",
      }),
    ).toThrow(/only anthropic is implemented/);
  });

  it("refuses a Jev model alias and accepts a pinned version", () => {
    expect(() => loadEnv({ ...COMPOSE, JEV_MODEL: "jev-latest" })).toThrow(ConfigError);
    expect(() => loadEnv({ ...COMPOSE, JEV_MODEL: "jev-1.13" })).toThrow(ConfigError);
    expect(loadEnv({ ...COMPOSE, JEV_MODEL: "jev-2.0.1" }).jevModel).toBe("jev-2.0.1");
  });

  it("refuses a review threshold above the ticket threshold", () => {
    expect(() =>
      loadEnv({ ...COMPOSE, GATE_REVIEW_MIN_CONFIDENCE: "0.9", GATE_TICKET_MIN_CONFIDENCE: "0.8" }),
    ).toThrow(/never sits above the ticket threshold/);
  });

  it("gives Jev its own default pair, the pre-registered choice, independent of GATE_*", () => {
    // Nothing set: Jev is gated at the choice recorded in
    // tools/eval/records/jev-thresholds-choice.md.
    expect(loadEnv({ ...COMPOSE }).gate.jev).toEqual({
      ticketMinConfidence: 0.85,
      reviewMinConfidence: 0.65,
    });
    // An empty interpolation is unset, so it takes the default, whatever GATE_* says.
    const moved = loadEnv({
      ...COMPOSE,
      GATE_TICKET_MIN_CONFIDENCE: "0.9",
      GATE_REVIEW_MIN_CONFIDENCE: "0.7",
      JEV_GATE_TICKET_MIN_CONFIDENCE: "",
      JEV_GATE_REVIEW_MIN_CONFIDENCE: "",
    }).gate;
    expect(moved.jev).toEqual({ ticketMinConfidence: 0.85, reviewMinConfidence: 0.65 });
    expect(moved).toMatchObject({ ticketMinConfidence: 0.9, reviewMinConfidence: 0.7 });
    // Each variable overrides its own threshold only, and never the global pair.
    const env = loadEnv({ ...COMPOSE, JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.7" });
    expect(env.gate.jev).toEqual({ ticketMinConfidence: 0.85, reviewMinConfidence: 0.7 });
    expect(env.gate.reviewMinConfidence).toBe(0.6);
    expect(
      loadEnv({
        ...COMPOSE,
        JEV_GATE_TICKET_MIN_CONFIDENCE: "0.95",
        JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.5",
      }).gate.jev,
    ).toEqual({ ticketMinConfidence: 0.95, reviewMinConfidence: 0.5 });
    // The pair the tuning recordings were made at can still be set explicitly.
    expect(loadEnv({ ...COMPOSE, JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.6" }).gate.jev).toEqual({
      ticketMinConfidence: 0.85,
      reviewMinConfidence: 0.6,
    });
  });

  it("refuses a Jev pair whose review threshold sits above its ticket threshold", () => {
    // The Jev review threshold is checked against the Jev ticket threshold it resolves to.
    expect(() => loadEnv({ ...COMPOSE, JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.9" })).toThrow(
      /Jev's review threshold 0\.9 is above its ticket threshold 0\.85/,
    );
    expect(() =>
      loadEnv({
        ...COMPOSE,
        JEV_GATE_TICKET_MIN_CONFIDENCE: "0.7",
        JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.75",
      }),
    ).toThrow(ConfigError);
    expect(() => loadEnv({ ...COMPOSE, JEV_GATE_TICKET_MIN_CONFIDENCE: "1.5" })).toThrow(
      /JEV_GATE_TICKET_MIN_CONFIDENCE/,
    );
    expect(() => loadEnv({ ...COMPOSE, JEV_GATE_REVIEW_MIN_CONFIDENCE: "most" })).toThrow(
      /JEV_GATE_REVIEW_MIN_CONFIDENCE/,
    );
    // A Jev ticket threshold set alone below the default review threshold is refused, naming both.
    expect(() => loadEnv({ ...COMPOSE, JEV_GATE_TICKET_MIN_CONFIDENCE: "0.6" })).toThrow(
      /Jev's review threshold 0\.65 is above its ticket threshold 0\.6 \(JEV_GATE_REVIEW_MIN_CONFIDENCE, default 0\.65, and JEV_GATE_TICKET_MIN_CONFIDENCE, default 0\.85\)/,
    );
    // Equal thresholds are allowed.
    expect(
      loadEnv({
        ...COMPOSE,
        JEV_GATE_TICKET_MIN_CONFIDENCE: "0.65",
        JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.65",
      }).gate.jev,
    ).toEqual({ ticketMinConfidence: 0.65, reviewMinConfidence: 0.65 });
    // A GATE_* pair set for the rules backend never moves Jev's, so it never stops start-up.
    expect(
      loadEnv({
        ...COMPOSE,
        GATE_TICKET_MIN_CONFIDENCE: "0.6",
        GATE_REVIEW_MIN_CONFIDENCE: "0.5",
      }).gate.jev,
    ).toEqual({ ticketMinConfidence: 0.85, reviewMinConfidence: 0.65 });
  });

  it("gates Jev at the pre-registered choice and rules and llm at GATE_* by default", () => {
    const { gate } = loadEnv({ ...COMPOSE });
    expect(gateThresholds(gate, "jev")).toEqual({
      ticketMinConfidence: 0.85,
      reviewMinConfidence: 0.65,
    });
    for (const backend of ["rules", "llm"] as const) {
      expect(gateThresholds(gate, backend)).toEqual({
        ticketMinConfidence: 0.85,
        reviewMinConfidence: 0.6,
      });
    }
  });

  it("gates each backend with its own pair: Jev with JEV_GATE_*, rules and llm with GATE_*", () => {
    const { gate } = loadEnv({
      ...COMPOSE,
      JEV_GATE_TICKET_MIN_CONFIDENCE: "0.9",
      JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.65",
    });
    expect(gateThresholds(gate, "jev")).toEqual({
      ticketMinConfidence: 0.9,
      reviewMinConfidence: 0.65,
    });
    for (const backend of ["rules", "llm"] as const) {
      expect(gateThresholds(gate, backend)).toEqual({
        ticketMinConfidence: 0.85,
        reviewMinConfidence: 0.6,
      });
    }
  });

  it("reads the persistence before the ticket, and 0 switches it off", () => {
    expect(loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "5" }).gate.persistSimMin).toBe(5);
    expect(loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "1.5" }).gate.persistSimMin).toBe(1.5);
    expect(loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "0" }).gate.persistSimMin).toBe(0);
    expect(loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "" }).gate.persistSimMin).toBe(1);
    expect(() => loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "-1" })).toThrow(
      /GATE_PERSIST_SIM_MIN/,
    );
    expect(() => loadEnv({ ...COMPOSE, GATE_PERSIST_SIM_MIN: "two" })).toThrow(ConfigError);
  });

  it("accepts port 0, the ephemeral port the tests bind", () => {
    expect(loadEnv({ ...COMPOSE, PORT: "0" }).port).toBe(0);
    expect(() => loadEnv({ ...COMPOSE, PORT: "70000" })).toThrow(ConfigError);
  });

  it("names every wrong variable in one error", () => {
    let caught: unknown;
    try {
      loadEnv({ ...COMPOSE, PORT: "zero", GATE_TICKET_MIN_CONFIDENCE: "9" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const issues = (caught as ConfigError).issues.join(" ");
    expect(issues).toContain("PORT");
    expect(issues).toContain("GATE_TICKET_MIN_CONFIDENCE");
  });

  it("reads the rules registry as a comma list and ignores blanks", () => {
    expect(loadEnv({ ...COMPOSE, RULES_DISABLED: "a, b ,,c" }).rulesDisabled).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(loadEnv({ ...COMPOSE, RULES_DISABLED: "" }).rulesDisabled).toEqual([
      "flow_pulses_missing",
    ]);
  });

  it("reads the boolean words Compose and a shell may produce", () => {
    for (const [value, expected] of [
      ["true", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
    ] as const) {
      expect(loadEnv({ ...COMPOSE, EMBEDDER_ALLOW_DOWNLOAD: value }).embedderAllowDownload).toBe(
        expected,
      );
    }
    expect(() => loadEnv({ ...COMPOSE, EMBEDDER_ALLOW_DOWNLOAD: "maybe" })).toThrow(ConfigError);
  });

  it("wraps the two keys so no line of output can carry them", () => {
    const env = loadEnv({ ...COMPOSE, TYPESAFE_API_KEY: "tk-secret", LLM_API_KEY: "lk-secret" });
    expect(env.typesafeApiKey).toBeInstanceOf(Secret);
    expect(`${String(env.typesafeApiKey)}`).toBe(REDACTED);
    expect(JSON.stringify(env)).not.toContain("tk-secret");
    expect(JSON.stringify(env)).not.toContain("lk-secret");
    expect(env.typesafeApiKey?.reveal()).toBe("tk-secret");
  });

  it("carries no credential of the overlay", () => {
    const env = loadEnv({
      ...COMPOSE,
      PG_GT_PASSWORD: "gt-password",
      DATABASE_URL_GT: "postgres://elsewhere",
      MQTT_BACKEND_OPS_PASSWORD: "ops-password",
    });
    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain("gt-password");
    expect(serialised).not.toContain("ops-password");
    expect(serialised).not.toContain("elsewhere");
    for (const key of Object.keys(env)) {
      expect(key.toLowerCase()).not.toMatch(/(^|[^a-z])(gt|ops)([^a-z]|$)/);
    }
  });
});

describe("decisionModel", () => {
  it("reports the model the selected backend will call", () => {
    expect(decisionModel(loadEnv({ ...COMPOSE }))).toBe(RULES_MODEL);
    expect(decisionModel(loadEnv({ ...COMPOSE, TYPESAFE_API_KEY: "tk" }))).toBe("jev-1.13.0");
    expect(decisionModel(loadEnv({ ...COMPOSE, DECISION_BACKEND: "llm", LLM_API_KEY: "lk" }))).toBe(
      "claude-opus-5",
    );
  });
});
