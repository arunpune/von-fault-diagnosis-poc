// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The diagnosis pool.
 *
 * It connects as `app_rw`, which has no privilege at all on the overlay's
 * schema: keeping ground truth out of reach is a property of the credential,
 * not of the code that uses it, so a mistake in a repository cannot read data
 * it should not see.
 */

import type { Env } from "../config/env.ts";
import { createPool, type Pool, type PoolLogger } from "./pool.ts";

/** Shows up in `pg_stat_activity` beside every statement this pool runs. */
export const APP_APPLICATION_NAME = "fdp-backend-app";

/**
 * The pool every diagnosis repository writes through; `logger` hears of a
 * connection the server ended while the pool held it idle.
 */
export function createAppPool(env: Env, logger: PoolLogger): Pool {
  return createPool(env.databaseUrlApp, { applicationName: APP_APPLICATION_NAME, logger });
}
