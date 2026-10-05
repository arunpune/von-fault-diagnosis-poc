// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The environment, parsed once into a typed value (apps/backend/README.md lists
 * every variable).
 *
 * This module and `src/overlay/config.ts` are the only two places in the
 * package allowed to read `process.env`; ESLint enforces that. The
 * split matters: the overlay's credentials — the privileged database password
 * and the privileged broker password — are read by that other module alone, so
 * a diagnosis module cannot reach them even by accident. {@link Env} therefore
 * carries no key of that kind, and `test/arch/imports.test.ts` proves it at
 * compile time.
 *
 * Two shapes reach the pools. Compose passes the connection in parts —
 * `PG_HOST`, `PG_PORT`, `POSTGRES_DB`, `PG_APP_PASSWORD` — and this module
 * composes the URL from them; `DATABASE_URL_APP` stays as a development
 * override for a database that is not the Compose one.
 *
 * An empty string is an unset variable for every optional value: the
 * Compose file writes `${VAR:-}` for variables a user may leave blank, and an
 * empty interpolation must not shadow the default declared here.
 */

import process from "node:process";

import { z } from "zod";

import { Secret } from "./secret.ts";

/** The role the diagnosis side connects as (db/README.md, "Roles"). */
export const APP_DB_ROLE = "app_rw";

/** The broker credential the diagnosis side connects as (docs/api.md, "Broker ACL"). */
export const DIAG_MQTT_USERNAME = "backend-diag";

/** The model identifier the rules backend reports; it calls nothing. */
export const RULES_MODEL = "rules-v1";

/** Aliases such as `von-latest` are refused: a run must name the version it used. */
const VON_MODEL_PATTERN = /^von-\d+\.\d+\.\d+$/;

/** `""` means "not set" for every optional variable. */
const optional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

/** A string variable with a default; an empty interpolation falls back. */
function text(fallback: string): z.ZodType<string> {
  return optional.transform((value) => value ?? fallback);
}

/** A closed set of words, with a default for the unset case. */
function word<T extends string>(values: readonly T[], fallback: T): z.ZodType<T> {
  return optional.transform((value, ctx) => {
    if (value === undefined) return fallback;
    if (!values.includes(value as T)) {
      ctx.addIssue({
        code: "custom",
        message: `expected one of ${values.join(", ")}, got ${value}`,
      });
      return z.NEVER;
    }
    return value as T;
  });
}

/** The same closed set, but unset stays unset so the caller can derive a default. */
function optionalWord<T extends string>(values: readonly T[]): z.ZodType<T | undefined> {
  return optional.transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (!values.includes(value as T)) {
      ctx.addIssue({
        code: "custom",
        message: `expected one of ${values.join(", ")}, got ${value}`,
      });
      return z.NEVER;
    }
    return value as T;
  });
}

const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = {
  "1": true,
  "0": false,
  true: true,
  false: false,
  yes: true,
  no: false,
};

function bool(fallback: boolean): z.ZodType<boolean> {
  return optional.transform((value, ctx) => {
    if (value === undefined) return fallback;
    const parsed = BOOLEAN_WORDS[value.trim().toLowerCase()];
    if (parsed === undefined) {
      ctx.addIssue({ code: "custom", message: `expected true or false, got ${value}` });
      return z.NEVER;
    }
    return parsed;
  });
}

function number(fallback: number, check: (value: number) => boolean, expected: string) {
  return optional.transform((value, ctx) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !check(parsed)) {
      ctx.addIssue({ code: "custom", message: `expected ${expected}, got ${value}` });
      return z.NEVER;
    }
    return parsed;
  });
}

const positiveInt = (fallback: number) =>
  number(fallback, (value) => Number.isInteger(value) && value > 0, "a positive integer");
/** A TCP port; 0 means "any free port", which is how the tests bind. */
const port = (fallback: number) =>
  number(
    fallback,
    (value) => Number.isInteger(value) && value >= 0 && value <= 65535,
    "a TCP port between 0 and 65535",
  );
const nonNegative = (fallback: number) =>
  number(fallback, (value) => value >= 0, "a number at or above zero");
const probability = (fallback: number) =>
  number(fallback, (value) => value >= 0 && value <= 1, "a number between 0 and 1");

const secret = optional.transform((value) => (value === undefined ? null : new Secret(value)));

const DECISION_BACKENDS = ["von", "llm", "rules"] as const;

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const SCHEMA = z.object({
  NODE_ENV: text("development"),
  PORT: port(3000),
  LOG_LEVEL: word(LOG_LEVELS, "info"),
  UNIT_ID: text("cau-7"),

  MQTT_URL: text("mqtt://mqtt:1883"),
  MQTT_BACKEND_DIAG_PASSWORD: text(DIAG_MQTT_USERNAME),

  PG_HOST: text("localhost"),
  PG_PORT: port(5432),
  POSTGRES_DB: text("fdp"),
  PG_APP_PASSWORD: text(APP_DB_ROLE),
  DATABASE_URL_APP: optional,

  DECISION_BACKEND: optionalWord(DECISION_BACKENDS),
  TYPESAFE_API_KEY: secret,
  TYPESAFE_BASE_URL: text("https://api.typesafe.ai"),
  VON_MODEL: optional.transform((value, ctx) => {
    const resolved = value ?? "von-1.13.0";
    if (!VON_MODEL_PATTERN.test(resolved)) {
      ctx.addIssue({
        code: "custom",
        message: `expected a pinned version matching ${VON_MODEL_PATTERN.source}, got ${resolved}`,
      });
      return z.NEVER;
    }
    return resolved;
  }),
  LLM_PROVIDER: text("anthropic"),
  LLM_API_KEY: secret,
  LLM_MODEL: text("claude-opus-5"),
  LLM_BASE_URL: optional,

  VON_PRICE_INPUT_PER_MTOK: nonNegative(0.042),
  LLM_PRICE_INPUT_PER_MTOK: nonNegative(5),
  LLM_PRICE_OUTPUT_PER_MTOK: nonNegative(25),
  PRICES_AS_OF: text("2026-09-19"),

  GATE_TICKET_MIN_CONFIDENCE: probability(0.85),
  GATE_REVIEW_MIN_CONFIDENCE: probability(0.6),
  GATE_PERSIST_SIM_MIN: nonNegative(1),
  // Von's own pair: the pre-registered choice (tools/eval/records/von-thresholds-choice.md),
  // not GATE_*.
  VON_GATE_TICKET_MIN_CONFIDENCE: probability(0.85),
  VON_GATE_REVIEW_MIN_CONFIDENCE: probability(0.65),

  DECISION_INTERVAL_SIM_MIN: positiveInt(30),
  EPISODE_CLEAR_SIM_MIN: positiveInt(120),

  HEARTBEAT_TELEMETRY_TIMEOUT_S: positiveInt(15),
  HEARTBEAT_DECISION_TIMEOUT_S: positiveInt(60),

  TELEMETRY_RETENTION_SIM_DAYS: positiveInt(365),

  MODEL_CACHE_DIR: text("/models"),
  EMBEDDER_ALLOW_DOWNLOAD: bool(false),
  RULES_DISABLED: optional,
  WS_TELEMETRY_INTERVAL_MS: positiveInt(250),
});

/** Which answer engine a run uses, and where its prices come from. */
export type DecisionBackendName = (typeof DECISION_BACKENDS)[number];

/** A ticket threshold and a review threshold, as one backend's gate applies them. */
export interface GateThresholdPair {
  readonly ticketMinConfidence: number;
  readonly reviewMinConfidence: number;
}

/** The typed environment of the diagnosis side. It holds no overlay credential. */
export interface Env {
  /**
   * `NODE_ENV`; the image sets `production`. The REST surface answers
   * cross-origin requests only outside production.
   */
  readonly nodeEnv: string;
  readonly port: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  readonly unitId: string;

  readonly mqttUrl: string;
  readonly mqttDiagUsername: string;
  readonly mqttDiagPassword: Secret;

  /** `postgres://app_rw:…@host:port/db`, composed from the parts Compose passes. */
  readonly databaseUrlApp: string;

  readonly decisionBackend: DecisionBackendName;
  readonly typesafeApiKey: Secret | null;
  readonly typesafeBaseUrl: string;
  readonly vonModel: string;
  readonly llmProvider: string;
  readonly llmApiKey: Secret | null;
  readonly llmModel: string;
  readonly llmBaseUrl: string | null;

  readonly prices: {
    readonly vonInputPerMtok: number;
    readonly llmInputPerMtok: number;
    readonly llmOutputPerMtok: number;
    readonly asOf: string;
  };

  readonly gate: {
    /** `GATE_TICKET_MIN_CONFIDENCE`: the ticket threshold of the rules and llm backends. */
    readonly ticketMinConfidence: number;
    /** `GATE_REVIEW_MIN_CONFIDENCE`: the review threshold of the rules and llm backends. */
    readonly reviewMinConfidence: number;
    /**
     * `GATE_PERSIST_SIM_MIN`: sim minutes a symptom's evidence must have held
     * without a break before an episode that owns no ticket is decided.
     */
    readonly persistSimMin: number;
    /**
     * Von's own pair: `VON_GATE_TICKET_MIN_CONFIDENCE` (default 0.85) and
     * `VON_GATE_REVIEW_MIN_CONFIDENCE` (default 0.65), the pre-registered choice
     * (tools/eval/records/von-thresholds-choice.md). The defaults do not follow `GATE_*`.
     */
    readonly von: GateThresholdPair;
  };

  readonly decisionIntervalSimMin: number;
  readonly episodeClearSimMin: number;

  readonly heartbeatTelemetryTimeoutS: number;
  readonly heartbeatDecisionTimeoutS: number;

  readonly telemetryRetentionSimDays: number;

  readonly modelCacheDir: string;
  readonly embedderAllowDownload: boolean;
  readonly rulesDisabled: readonly string[];
  readonly wsTelemetryIntervalMs: number;
}

/** Thrown when the environment cannot produce a usable {@link Env}. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** The rules registry is data: a comma-separated list, empty entries ignored. */
function ruleList(value: string | undefined): string[] {
  if (value === undefined) return ["flow_pulses_missing"];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function composeUrl(
  role: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  return `postgres://${role}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/**
 * Parse `source` (the process environment by default) into a typed {@link Env}.
 *
 * Throws {@link ConfigError} naming every variable that is wrong, so a start-up
 * failure is one message and not a chain of them. Values are never echoed for
 * the two keys: they are wrapped before they leave this function.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = SCHEMA.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  const raw = parsed.data;

  const typesafeApiKey = raw.TYPESAFE_API_KEY;
  const llmApiKey = raw.LLM_API_KEY;
  const decisionBackend: DecisionBackendName =
    raw.DECISION_BACKEND ?? (typesafeApiKey === null ? "rules" : "von");

  if (decisionBackend === "von" && typesafeApiKey === null) {
    throw new ConfigError(["DECISION_BACKEND is von but TYPESAFE_API_KEY is not set"]);
  }
  if (decisionBackend === "llm" && llmApiKey === null) {
    throw new ConfigError(["DECISION_BACKEND is llm but LLM_API_KEY is not set"]);
  }
  if (decisionBackend === "llm" && raw.LLM_PROVIDER !== "anthropic") {
    throw new ConfigError([
      `DECISION_BACKEND is llm but LLM_PROVIDER is ${raw.LLM_PROVIDER}; only anthropic is implemented`,
    ]);
  }
  if (raw.GATE_REVIEW_MIN_CONFIDENCE > raw.GATE_TICKET_MIN_CONFIDENCE) {
    throw new ConfigError([
      "GATE_REVIEW_MIN_CONFIDENCE is above GATE_TICKET_MIN_CONFIDENCE; a review threshold " +
        "never sits above the ticket threshold",
    ]);
  }
  const vonGate: GateThresholdPair = {
    ticketMinConfidence: raw.VON_GATE_TICKET_MIN_CONFIDENCE,
    reviewMinConfidence: raw.VON_GATE_REVIEW_MIN_CONFIDENCE,
  };
  if (vonGate.reviewMinConfidence > vonGate.ticketMinConfidence) {
    throw new ConfigError([
      `Von's review threshold ${vonGate.reviewMinConfidence} is above its ticket threshold ` +
        `${vonGate.ticketMinConfidence} (VON_GATE_REVIEW_MIN_CONFIDENCE, default 0.65, and ` +
        "VON_GATE_TICKET_MIN_CONFIDENCE, default 0.85); a review threshold never sits above " +
        "the ticket threshold",
    ]);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    unitId: raw.UNIT_ID,

    mqttUrl: raw.MQTT_URL,
    mqttDiagUsername: DIAG_MQTT_USERNAME,
    mqttDiagPassword: new Secret(raw.MQTT_BACKEND_DIAG_PASSWORD),

    databaseUrlApp:
      raw.DATABASE_URL_APP ??
      composeUrl(APP_DB_ROLE, raw.PG_APP_PASSWORD, raw.PG_HOST, raw.PG_PORT, raw.POSTGRES_DB),

    decisionBackend,
    typesafeApiKey,
    typesafeBaseUrl: raw.TYPESAFE_BASE_URL,
    vonModel: raw.VON_MODEL,
    llmProvider: raw.LLM_PROVIDER,
    llmApiKey,
    llmModel: raw.LLM_MODEL,
    llmBaseUrl: raw.LLM_BASE_URL ?? null,

    prices: {
      vonInputPerMtok: raw.VON_PRICE_INPUT_PER_MTOK,
      llmInputPerMtok: raw.LLM_PRICE_INPUT_PER_MTOK,
      llmOutputPerMtok: raw.LLM_PRICE_OUTPUT_PER_MTOK,
      asOf: raw.PRICES_AS_OF,
    },

    gate: {
      ticketMinConfidence: raw.GATE_TICKET_MIN_CONFIDENCE,
      reviewMinConfidence: raw.GATE_REVIEW_MIN_CONFIDENCE,
      persistSimMin: raw.GATE_PERSIST_SIM_MIN,
      von: vonGate,
    },

    decisionIntervalSimMin: raw.DECISION_INTERVAL_SIM_MIN,
    episodeClearSimMin: raw.EPISODE_CLEAR_SIM_MIN,

    heartbeatTelemetryTimeoutS: raw.HEARTBEAT_TELEMETRY_TIMEOUT_S,
    heartbeatDecisionTimeoutS: raw.HEARTBEAT_DECISION_TIMEOUT_S,

    telemetryRetentionSimDays: raw.TELEMETRY_RETENTION_SIM_DAYS,

    modelCacheDir: raw.MODEL_CACHE_DIR,
    embedderAllowDownload: raw.EMBEDDER_ALLOW_DOWNLOAD,
    rulesDisabled: ruleList(raw.RULES_DISABLED),
    wsTelemetryIntervalMs: raw.WS_TELEMETRY_INTERVAL_MS,
  };
}

/**
 * The two thresholds the gate applies to a backend's decisions.
 *
 * Von reports its own probability, a different quantity from the rules backend's calibrated
 * gating confidence, so it has its own pair, `VON_GATE_*`, whose defaults are the
 * pre-registered choice (review 0.65, ticket 0.85) and do not follow `GATE_*`. The rules backend
 * keeps `GATE_*`; so does the llm backend until it has been measured.
 */
export function gateThresholds(gate: Env["gate"], backend: DecisionBackendName): GateThresholdPair {
  if (backend === "von") return gate.von;
  return {
    ticketMinConfidence: gate.ticketMinConfidence,
    reviewMinConfidence: gate.reviewMinConfidence,
  };
}

/**
 * The model the selected backend will report.
 *
 * `decision/select.ts` builds the backend itself; the health and status
 * routes need the name before a decision has ever been taken, and both read it
 * from here so the two never disagree.
 */
export function decisionModel(env: Env): string {
  switch (env.decisionBackend) {
    case "von":
      return env.vonModel;
    case "llm":
      return env.llmModel;
    case "rules":
      return RULES_MODEL;
  }
}
