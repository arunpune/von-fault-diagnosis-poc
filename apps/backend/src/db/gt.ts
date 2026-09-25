// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay pool: the one door to the recorded truth (see the isolation
 * section of docs/architecture.md).
 *
 * `overlay/repo.ts` is its only importer; `.dependency-cruiser.cjs` and the
 * ESLint configuration both refuse an import of this module from a diagnosis
 * module, and `test/arch/imports.test.ts` proves the rules bite.
 *
 * The credential does not come from `config/env.ts`: that value is read by
 * `overlay/config.ts` alone and handed here as a plain configuration object,
 * so the typed environment the diagnosis side passes around cannot carry it.
 * Composing the URL is this module's job, which keeps the password in
 * one call chain.
 */

import { Secret } from "../config/secret.ts";
import { createPool, type Pool, type PoolLogger } from "./pool.ts";

/** The privileged role of the overlay (db/README.md); only this module ever names it. */
export const OVERLAY_DB_ROLE = "gt_rw";

/** Shows up in `pg_stat_activity` beside every statement this pool runs. */
export const OVERLAY_APPLICATION_NAME = "fdp-backend-overlay";

/**
 * What `overlay/config.ts` builds and hands over.
 *
 * Either the parts Compose passes, or a ready-made connection string for a
 * development database that is not the Compose one.
 */
export interface OverlayDbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly password: Secret;
  /** A complete connection string, which wins over the parts above. */
  readonly url?: Secret;
}

/** `postgres://gt_rw:…@host:port/database`, from the parts or from the override. */
export function overlayConnectionString(config: OverlayDbConfig): Secret {
  if (config.url !== undefined) return config.url;
  const password = encodeURIComponent(config.password.reveal());
  return new Secret(
    `postgres://${OVERLAY_DB_ROLE}:${password}@${config.host}:${config.port}/${config.database}`,
  );
}

/**
 * The pool the overlay recorder and the overlay read routes share; `logger`
 * hears of a connection the server ended while the pool held it idle.
 */
export function createGtPool(config: OverlayDbConfig, logger: PoolLogger): Pool {
  return createPool(overlayConnectionString(config).reveal(), {
    applicationName: OVERLAY_APPLICATION_NAME,
    logger,
  });
}
