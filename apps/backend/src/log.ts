// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured logging.
 *
 * JSON to stdout, one line per event, with the redaction list below applied
 * to every record. Redaction is the second line of defence: the two API keys
 * are wrapped in `Secret`, which already prints `[redacted]` wherever it is
 * interpolated or serialised, and this list catches the shapes that arrive
 * from outside — request headers, SDK option objects, connection settings.
 *
 * Every module takes a child logger so a line says which part of the backend
 * wrote it, and the decision path logs identifiers and counters, never bodies.
 */

import { pino, type Logger, type LoggerOptions } from "pino";

import type { Env } from "./config/env.ts";

/**
 * Paths pino replaces with `[redacted]` before a record is written.
 * `*.` matches one level, which is what the SDK option
 * objects and the Fastify request object need.
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "headers.authorization",
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.authorization",
];

export type { Logger };

/** What a logger needs to know about the process it describes. */
export interface LoggerConfig {
  readonly logLevel: Env["logLevel"];
  readonly unitId: string;
  readonly version: string;
}

/**
 * The root logger of the process.
 *
 * `destination` exists for tests: they pass a writable stream and read the
 * lines back, so the redaction list is asserted against real output rather
 * than against the options object.
 */
export function createLogger(config: LoggerConfig, destination?: NodeJS.WritableStream): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: { unit_id: config.unitId, version: config.version },
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

/** A child logger tagged with the module that writes through it. */
export function moduleLogger(logger: Logger, module: string): Logger {
  return logger.child({ module });
}
