// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The backend image against the test stack.
 *
 * The image the Dockerfile builds is run the way Compose runs it, pointed at
 * the containers of this suite through the Docker host:
 *
 *   * against a database init has not prepared, with nothing but the two
 *     `DATABASE_URL_*` overrides, it exits 1 at once and says "run init
 *     first";
 *   * with the Compose environment — discrete `PG_*` parts, the two broker
 *     passwords, the model cache mounted read-only at `/models` and no
 *     download allowed — against a migrated database, it answers
 *     `GET /api/health` with 200 and publishes its retained `status/backend`.
 *
 * The model cache is what init leaves in the `model-cache` volume. Here it is
 * a host directory (`MODEL_CACHE_DIR`, else `<tmp>/fdp-models`) filled once
 * with the pinned, hash-verified files — the only download this suite may
 * make, and none at all once the cache is warm.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { startPostgres } from "@fdp/db-migrate/testing";
import { isValid, type ApiHealth, type StatusBackend } from "@fdp/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEmbedder } from "../../src/retrieval/embedder.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { BUILD_TIMEOUT_MS, buildBackendImage, removeImage } from "../helpers/image.ts";
import { observeBroker, sleep, UNIT, waitUntil } from "../helpers/runtime.ts";
import { withSlack } from "../helpers/timing.ts";

const run = promisify(execFile);

/** How the containers of this suite reach the ports testcontainers published on the host. */
const DOCKER_HOST = "host.docker.internal";

/** Linux has no `host.docker.internal` unless it is mapped; Docker Desktop has it already. */
const HOST_GATEWAY = `--add-host=${DOCKER_HOST}:host-gateway`;

/** How long a refused start may take: the process should give up at its first check. */
const FAIL_FAST_MS = 30_000;

const tag = `fdp-backend:it-image-${randomUUID().slice(0, 8)}`;

/** `-e NAME=value` pairs for `docker run`. */
function envFlags(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

beforeAll(async () => {
  await buildBackendImage(tag);
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  removeImage(tag);
});

describe("the backend image on a database init has not prepared", () => {
  it("exits 1 at once and says run init first", async () => {
    const pg = await startPostgres({ migrate: false });
    try {
      const url = (role: "app_rw" | "gt_rw"): string =>
        pg.urlFor(role).replace(`@${pg.host}:${pg.port}/`, `@${DOCKER_HOST}:${pg.port}/`);
      const started = Date.now();
      const outcome = await run(
        "docker",
        [
          "run",
          "--rm",
          HOST_GATEWAY,
          ...envFlags({ DATABASE_URL_APP: url("app_rw"), DATABASE_URL_GT: url("gt_rw") }),
          tag,
        ],
        { timeout: withSlack(FAIL_FAST_MS) },
      ).then(
        () => ({ code: 0, output: "" }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          code: error.code ?? -1,
          output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
        }),
      );

      expect(outcome.code).toBe(1);
      expect(outcome.output).toContain("run init first");
      expect(Date.now() - started).toBeLessThan(withSlack(FAIL_FAST_MS));
    } finally {
      await pg.stop();
    }
  }, 120_000);
});

describe("the backend image with the Compose environment", () => {
  let stack: TestStack;
  let cacheDir: string;
  const name = `fdp-it-image-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    stack = await startStack({ migrate: true });
    // What init leaves in the model-cache volume: the pinned files, verified.
    cacheDir = process.env.MODEL_CACHE_DIR ?? join(tmpdir(), "fdp-models");
    await createEmbedder({ cacheDir, allowDownload: true });
  }, 600_000);

  afterAll(async () => {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
    await stack?.stop();
  });

  it("answers /api/health with 200 and publishes its status retained", async () => {
    const env = {
      LOG_LEVEL: "info",
      UNIT_ID: UNIT,
      MQTT_URL: `mqtt://${DOCKER_HOST}:${stack.mqtt.port}`,
      MQTT_BACKEND_DIAG_PASSWORD: stack.mqtt.credentials["backend-diag"],
      MQTT_BACKEND_OPS_PASSWORD: stack.mqtt.credentials["backend-ops"],
      PG_HOST: DOCKER_HOST,
      PG_PORT: String(stack.pg.port),
      POSTGRES_DB: "fdp",
      PG_APP_PASSWORD: "app_rw",
      PG_GT_PASSWORD: "gt_rw",
      DECISION_BACKEND: "",
      TYPESAFE_API_KEY: "",
      MODEL_CACHE_DIR: "/models",
      EMBEDDER_ALLOW_DOWNLOAD: "false",
    };
    await run("docker", [
      "run",
      "--detach",
      "--name",
      name,
      HOST_GATEWAY,
      "--publish",
      "127.0.0.1::3000",
      "--volume",
      `${cacheDir}:/models:ro`,
      ...envFlags(env),
      tag,
    ]);
    const { stdout } = await run("docker", ["port", name, "3000/tcp"]);
    const port = /:(\d+)\s*$/m.exec(stdout.trim())?.[1];
    if (port === undefined) throw new Error(`no published port in ${stdout}`);

    let health: { status: number; body: ApiHealth } | undefined;
    await waitUntil(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          health = { status: response.status, body: (await response.json()) as ApiHealth };
          return response.status === 200;
        } catch {
          await sleep(250);
          return false;
        }
      },
      "GET /api/health 200 from the container",
      withSlack(90_000),
    );
    expect(health?.body).toMatchObject({
      status: "ok",
      backend: { name: "rules", model: "rules-v1" },
      db: { app: "ok", gt: "ok" },
      mqtt: { diag: "ok", ops: "ok" },
    });
    expect(isValid("api-health", health?.body)).toBe(true);

    // A client that connects afterwards still gets the backend's status: it is retained.
    const observer = await observeBroker(stack, `plant/${UNIT}/status/backend`);
    try {
      await waitUntil(
        () => observer.messages.length > 0,
        "the retained status/backend",
        withSlack(10_000),
      );
      const [status] = observer.on<StatusBackend>(`plant/${UNIT}/status/backend`);
      expect(isValid("status-backend", status)).toBe(true);
      expect(status?.backend).toEqual({ name: "rules", model: "rules-v1" });
    } finally {
      await observer.close();
    }
  }, 180_000);
});
