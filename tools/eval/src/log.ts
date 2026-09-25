// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The harness logger: three levels, stderr only, and a redactor between every
// field and the stream.
//
// stderr because stdout carries the summary table a caller may pipe, and a log
// line must never land in it. Redaction because keys are read from the
// environment and never printed: the one way a key reaches a log is a caller
// passing a configuration object along with a message, so every field is walked
// and any value under a key-, token-, password- or authorization-shaped name is
// replaced before it is formatted.
//
// No timestamp is written. A log line is not evidence — the report carries the
// wall times — and leaving the clock out keeps the output of a run
// byte-identical, as everything else about a run is.

/** The levels, from quietest caller intent to loudest. */
export const LOG_LEVELS = ["debug", "info", "warn"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Structured context for one line; keys are rendered in insertion order. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

/** Field names whose value never reaches the stream: secrets come from the environment only. */
export const SECRET_KEY_PATTERN = /key|token|password|authorization/i;

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** How deep the redactor walks before it gives up and prints a placeholder. */
const MAX_DEPTH = 8;

/** The placeholder for a value that is nested deeper than `MAX_DEPTH` or already being walked. */
const ELIDED = "[elided]";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2 };

const DEFAULT_LEVEL: LogLevel = "info";

/** A writable sink; `process.stderr` satisfies it, and so does a test double. */
export interface LogStream {
  write(chunk: string): unknown;
}

export interface LoggerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stream?: LogStream;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** True for an object the redactor may walk field by field. */
function isWalkable(value: object): boolean {
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return ELIDED;
  if (!isWalkable(value)) return value;

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : walk(item, depth + 1, seen);
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}

/**
 * A copy of `value` in which every field under a secret-shaped key is replaced.
 *
 * Only plain objects and arrays are walked: anything with its own prototype (a Date, an
 * Error, a database client) is left untouched, because walking it would rebuild it as a
 * plain object and change how it prints.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

function renderText(level: LogLevel, message: string, fields: LogFields): string {
  const parts = [`${level} ${message}`];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${JSON.stringify(value) ?? "undefined"}`);
  }
  return `${parts.join(" ")}\n`;
}

function renderJson(level: LogLevel, message: string, fields: LogFields): string {
  return `${JSON.stringify({ level, msg: message, ...fields })}\n`;
}

/**
 * Builds the logger.
 *
 * `EVAL_LOG_JSON=1` switches the format to one JSON object per line, for a CI job that
 * collects the output; `EVAL_LOG_LEVEL` (`debug | info | warn`, default `info`) sets the
 * threshold. An unreadable level is a caller's typo, not a reason to fail a run, so it falls
 * back to the default and says so on the first line.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const stream = options.stream ?? process.stderr;
  const json = env["EVAL_LOG_JSON"] === "1";
  const render = json ? renderJson : renderText;

  const requested = env["EVAL_LOG_LEVEL"];
  const level: LogLevel =
    requested !== undefined && isLogLevel(requested) ? requested : DEFAULT_LEVEL;
  const threshold = LEVEL_ORDER[level];

  function write(at: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[at] < threshold) return;
    stream.write(render(at, message, redact(fields ?? {}) as LogFields));
  }

  if (requested !== undefined && !isLogLevel(requested)) {
    stream.write(
      render("warn", "EVAL_LOG_LEVEL is not a level; using the default", {
        requested,
        level,
      }),
    );
  }

  return {
    level,
    debug: (message, fields) => {
      write("debug", message, fields);
    },
    info: (message, fields) => {
      write("info", message, fields);
    },
    warn: (message, fields) => {
      write("warn", message, fields);
    },
  };
}
