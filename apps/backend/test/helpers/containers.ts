// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The two containers the integration tests run against.
 *
 * PostgreSQL comes from `@fdp/db-migrate/testing`, so these tests use the same
 * image, the same roles script and the same migrations the Compose stack runs.
 * Mosquitto is started here from `infra/mosquitto/`, with the committed
 * configuration, access-control list and credential file copied in, so the
 * access rules the tests assert are the rules the stack ships (five
 * credentials, the read-only `eval` user among them).
 *
 * Nothing is shared between two calls but the images: host ports are random
 * and both containers carry an `fdp.worktree` label naming the working copy
 * they were started from, so several worktrees can run their suites at once.
 * Every wall-clock bound is stretched by `FDP_TIMING_SLACK`.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

import {
  startPostgres,
  type PgTestStack,
  type StartPostgresOptions,
} from "@fdp/db-migrate/testing";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

import { REPO_ROOT } from "./fixtures.ts";
import { withSlack } from "./timing.ts";

/** The broker image the stack runs, as `infra/mosquitto/Dockerfile` pins it. */
export const MOSQUITTO_IMAGE = "eclipse-mosquitto:2.0.22";

/** Where `infra/mosquitto` sits, and where the image expects its configuration. */
const MOSQUITTO_CONFIG_DIR = join(REPO_ROOT, "infra", "mosquitto");
const CONTAINER_CONFIG_DIR = "/mosquitto/config";

/** The credential file `mosquitto.conf` names, and the plain list beside it. */
const PASSWORD_FILE = "passwd";
const PASSWORD_SOURCE = "passwd.txt";

export type MqttUser = "gateway" | "sim" | "backend-diag" | "backend-ops" | "eval";

export interface MqttTestBroker {
  /** `mqtt://127.0.0.1:<random port>`, ready for `connectAs`. */
  url: string;
  host: string;
  port: number;
  /** The five credentials of `infra/mosquitto/passwd.txt`, by user name. */
  credentials: Readonly<Record<MqttUser, string>>;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export interface TestStack {
  pg: PgTestStack;
  mqtt: MqttTestBroker;
  /** Stops both containers; safe to call twice. */
  stop(): Promise<void>;
}

export interface StartStackOptions {
  /** Apply `db/migrations` once PostgreSQL is up. Default true. */
  migrate?: boolean;
  /** Override the PostgreSQL image, for a deliberate version test. */
  postgresImage?: StartPostgresOptions["image"];
}

/** The label every container of this suite carries, so a stray one is traceable. */
function labels(): Record<string, string> {
  return { "fdp.worktree": basename(process.cwd()) };
}

/**
 * The credentials of `infra/mosquitto/passwd.txt`.
 *
 * Reading the committed file rather than repeating it keeps the tests in step
 * with the broker: a credential added there is a credential the tests can use.
 */
export function mosquittoCredentials(): Record<MqttUser, string> {
  const text = readFileSync(join(MOSQUITTO_CONFIG_DIR, PASSWORD_SOURCE), "utf8");
  const credentials: Partial<Record<MqttUser, string>> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) throw new Error(`${PASSWORD_SOURCE} has a line that is not user:password`);
    credentials[trimmed.slice(0, separator) as MqttUser] = trimmed.slice(separator + 1);
  }
  return credentials as Record<MqttUser, string>;
}

/**
 * Start Mosquitto with the committed configuration on a random host port.
 *
 * The committed `passwd` file is rendered from `passwd.txt` with the default
 * passwords, which is what the broker image's own entrypoint would produce
 * without an override, so copying it in gives the tests the stack's five
 * credentials without building the broker image.
 */
export async function startMosquitto(): Promise<MqttTestBroker> {
  const container = await new GenericContainer(MOSQUITTO_IMAGE)
    .withLabels(labels())
    .withExposedPorts(1883)
    // Copied, not bind-mounted: the image's entry point chowns /mosquitto to
    // the user it drops to, which it cannot do on a read-only mount, and a
    // credential file it does not own makes the broker refuse to read it.
    .withCopyFilesToContainer(
      ["mosquitto.conf", "acl", PASSWORD_FILE].map((name) => ({
        source: join(MOSQUITTO_CONFIG_DIR, name),
        target: `${CONTAINER_CONFIG_DIR}/${name}`,
        mode: 0o600,
      })),
    )
    // The committed configuration logs at error, warning and notice only, so
    // the broker never writes the "running" line a log wait would look for;
    // the listening port is the signal that it is up.
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(withSlack(60_000))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(1883);
  return {
    url: `mqtt://${host}:${port}`,
    host,
    port,
    credentials: mosquittoCredentials(),
    container,
    stop: async () => {
      await container.stop();
    },
  };
}

/** PostgreSQL and Mosquitto, both ready, both on random host ports. */
export async function startStack(options: StartStackOptions = {}): Promise<TestStack> {
  const pg = await startPostgres({ migrate: options.migrate, image: options.postgresImage });
  let mqtt: MqttTestBroker;
  try {
    mqtt = await startMosquitto();
  } catch (error) {
    await pg.stop();
    throw error;
  }

  let stopped = false;
  return {
    pg,
    mqtt,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.allSettled([mqtt.stop(), pg.stop()]);
    },
  };
}
