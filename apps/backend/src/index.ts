// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The process entry point.
 *
 * It parses the environment, hands it to `startApp`, and turns every start-up
 * failure into one fatal log line and exit code 1: a wrong variable names the
 * variable, a database init has not prepared says "run init first", a missing
 * model file names the path. The composition itself — the start-up steps, each
 * with its own log line — is `app.ts`.
 *
 * SIGTERM and SIGINT shut the service down in reverse start-up order, bounded by ten
 * seconds, so a `docker compose down` never waits on a stuck connection.
 */

import process from "node:process";

import { startApp, type RunningApp } from "./app.ts";
import { ConfigError, loadEnv, type Env } from "./config/env.ts";
import { MigrationStateError } from "./db/pool.ts";
import { createLogger, type Logger } from "./log.ts";
import { VERSION } from "./pipeline/index.ts";

/** Exit codes, so an operator and the compose healthcheck read the same numbers. */
export const EXIT_CONFIG = 1;

/** The signals that mean "stop now". */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Parse the environment, or exit naming what is wrong (no logger exists yet). */
function environment(): Env {
  try {
    return loadEnv();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // The message names variables, never values.
      process.stderr.write(`backend: ${error.message}\n`);
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
}

/** One fatal line naming why the service could not start. */
function reportStartFailure(logger: Logger, error: unknown): void {
  if (error instanceof MigrationStateError) {
    logger.fatal({ required: error.required, found: error.found }, error.message);
    return;
  }
  if (error instanceof Error) {
    logger.fatal({ err: error, cause_name: error.name }, `start-up failed: ${error.message}`);
    return;
  }
  logger.fatal({ err: error }, "start-up failed");
}

/** Shut down once on the first stop signal, then exit 0. */
function stopOnSignal(app: RunningApp, logger: Logger): void {
  let stopping = false;
  for (const signal of STOP_SIGNALS) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, "stop signal received");
      void app.stop().then(() => {
        process.exit(0);
      });
    });
  }
}

async function main(): Promise<void> {
  const env = environment();
  const logger = createLogger({ logLevel: env.logLevel, unitId: env.unitId, version: VERSION });
  logger.info({ decision_backend: env.decisionBackend, port: env.port }, "configuration loaded");

  let app: RunningApp;
  try {
    app = await startApp(env, { logger });
  } catch (error: unknown) {
    reportStartFailure(logger, error);
    process.exit(EXIT_CONFIG);
  }
  stopOnSignal(app, logger);
}

await main();
