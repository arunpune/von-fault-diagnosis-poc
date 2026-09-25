// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay's own configuration.
 *
 * `PG_GT_PASSWORD` and `MQTT_BACKEND_OPS_PASSWORD` are read here and nowhere
 * else. `config/env.ts` parses the rest of the environment and its {@link
 * import("../config/env.ts").Env} type carries neither of them, so a diagnosis
 * module cannot reach the privileged credentials even by accident — the arch
 * test asserts that at compile time, ESLint and dependency-cruiser keep
 * `process.env` and this file inside their two allowed places.
 *
 * The non-secret parts of the connection are read again rather than taken from
 * `Env`: that would be an import from the diagnosis side into the overlay, and
 * the two variables above would then travel in a value the diagnosis side
 * holds. Both modules read the same Compose variables with the same defaults
 * (an empty interpolation is an unset variable, and the URL is composed from
 * the parts, with `DATABASE_URL_GT` as a development override).
 */

import process from "node:process";

import { DEFAULT_UNIT_ID } from "@fdp/contracts";

import { Secret } from "../config/secret.ts";
import { type OpsMqttConfig } from "../mqtt/ops-client.ts";
import type { OverlayDbConfig } from "./repo.ts";

/** What the overlay needs to reach its database, its broker and its unit. */
export interface OverlayConfig {
  readonly unitId: string;
  readonly db: OverlayDbConfig;
  readonly mqtt: OpsMqttConfig;
}

/** Thrown when a variable of the overlay is present but unusable. */
export class OverlayConfigError extends Error {
  constructor(message: string) {
    super(`invalid overlay configuration: ${message}`);
    this.name = "OverlayConfigError";
  }
}

/** `""` means "not set", so an empty Compose interpolation falls back. */
function text(source: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = source[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/** A TCP port, or the reason it is not one. */
function port(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new OverlayConfigError(`${name}: expected a TCP port between 0 and 65535, got ${raw}`);
  }
  return parsed;
}

/**
 * A credential, wrapped so it prints as `[redacted]` wherever it travels.
 *
 * An unset variable becomes an empty {@link Secret} rather than an error: the
 * module that needs it says so at start-up with a message naming the variable
 * — `createOpsClient` for the broker, the pool's own connection failure for the
 * database — which is a better error than one raised here for a process that
 * may never open either.
 */
function secret(source: NodeJS.ProcessEnv, name: string): Secret {
  return new Secret(text(source, name, ""));
}

/**
 * Read the overlay's configuration out of `source` (the process environment).
 *
 * @throws OverlayConfigError naming the variable that is wrong.
 */
export function loadOverlayConfig(source: NodeJS.ProcessEnv = process.env): OverlayConfig {
  const url = text(source, "DATABASE_URL_GT", "");
  return {
    unitId: text(source, "UNIT_ID", DEFAULT_UNIT_ID),
    db: {
      host: text(source, "PG_HOST", "localhost"),
      port: port(source, "PG_PORT", 5432),
      database: text(source, "POSTGRES_DB", "fdp"),
      password: secret(source, "PG_GT_PASSWORD"),
      ...(url === "" ? {} : { url: new Secret(url) }),
    },
    mqtt: {
      url: text(source, "MQTT_URL", "mqtt://mqtt:1883"),
      password: secret(source, "MQTT_BACKEND_OPS_PASSWORD"),
    },
  };
}
