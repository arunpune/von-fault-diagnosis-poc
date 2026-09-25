// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The running service's diagnosis credential, held to the broker's access
 * list.
 *
 * `db-roles.test.ts` proves the access list with clients of its own. This
 * file proves it for the client the service actually runs: `startApp` is up,
 * and the test reaches into the connection its diagnosis side uses.
 *
 *   * Asked to subscribe the ground-truth root, the broker grants the
 *     subscription and delivers nothing on it for two seconds, while the
 *     read-only `eval` credential receives the retained catalog on the same
 *     filter (non-delivery beside a positive control).
 *   * A publish onto the replay command topic under the diagnosis credential
 *     is refused with PUBACK 0x87 (MQTT 5), and reaches no simulator
 *     subscriber within half a second, while the overlay's credential does.
 *   * `createDiagClient` refuses to start without a user name or password.
 */

import { topics } from "@fdp/contracts";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "../../src/config/secret.ts";
import { createLogger } from "../../src/log.ts";
import { createDiagClient, DiagCredentialError } from "../../src/mqtt/diag-client.ts";
import { startStack, type MqttUser, type TestStack } from "../helpers/containers.ts";
import { connectAs, disconnect, publishJson, subscribeGranted } from "../helpers/mqtt.ts";
import { gtCatalog } from "../helpers/overlay.ts";
import { sleep, startAppOn, UNIT, type AppUnderTest } from "../helpers/runtime.ts";
import { withSlack } from "../helpers/timing.ts";

/** PUBACK reason code 0x87, "Not authorized" (MQTT 5 §3.4.2.1). */
const NOT_AUTHORIZED = 135;

/** How long a non-delivery assertion listens on a subscription. */
const SUBSCRIBE_SILENCE_MS = 2_000;

/** How long a refused publication is given to show up anyway. */
const PUBLISH_SILENCE_MS = 500;

const GROUND_TRUTH_ROOT = "gt/#";

let stack: TestStack;
let service: AppUnderTest;

/** Start keeping the topics a client receives; call before subscribing (the retained race). */
function collect(client: MqttClient): string[] {
  const seen: string[] = [];
  client.on("message", (topic) => {
    seen.push(topic);
  });
  return seen;
}

/** A client of `user` speaking MQTT 5, so a refused publish comes back as a reason code. */
function connectV5(user: MqttUser): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(stack.mqtt.url, {
      clientId: `test-v5-${user}-${Math.random().toString(36).slice(2, 10)}`,
      username: user,
      password: stack.mqtt.credentials[user],
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: withSlack(10_000),
    });
    client.once("error", (error) => {
      client.end(true, () => {
        reject(error);
      });
    });
    client.once("connect", () => {
      resolve(client);
    });
  });
}

beforeAll(async () => {
  stack = await startStack({ migrate: true });
  const sim = await connectAs(stack.mqtt, "sim");
  try {
    await publishJson(sim, topics.gtCatalog(UNIT), gtCatalog(), { retain: true });
  } finally {
    await disconnect(sim);
  }
  service = await startAppOn(stack, { env: { DECISION_BACKEND: "rules" } });
}, 240_000);

afterAll(async () => {
  await service?.stop();
  await stack?.stop();
});

describe("the running diagnosis client on the ground-truth root", () => {
  it("is granted the subscription and receives nothing, while eval receives the catalog", async () => {
    const diag = service.app.diag.client.raw;
    const evaluation = await connectAs(stack.mqtt, "eval");
    try {
      const denied = collect(diag);
      const granted = collect(evaluation);
      expect((await diag.subscribeAsync(GROUND_TRUTH_ROOT, { qos: 1 }))[0]?.qos).toBe(1);
      expect(await subscribeGranted(evaluation, GROUND_TRUTH_ROOT)).toBe(1);

      await sleep(withSlack(SUBSCRIBE_SILENCE_MS));

      expect(denied.filter((topic) => topic.startsWith("gt/"))).toEqual([]);
      expect(granted).toContain(topics.gtCatalog(UNIT));
    } finally {
      await diag.unsubscribeAsync(GROUND_TRUTH_ROOT);
      await disconnect(evaluation);
    }
  }, 60_000);
});

describe("the diagnosis credential on the command topic", () => {
  it("is refused with PUBACK 0x87 and reaches no simulator", async () => {
    const simulator = await connectAs(stack.mqtt, "sim");
    const diagV5 = await connectV5("backend-diag");
    try {
      const received = collect(simulator);
      expect(await subscribeGranted(simulator, topics.controlCmd(UNIT))).toBe(1);

      await expect(
        diagV5.publishAsync(topics.controlCmd(UNIT), JSON.stringify({ probe: "diag-v5" }), {
          qos: 1,
        }),
      ).rejects.toMatchObject({ code: NOT_AUTHORIZED });
      // The running client speaks MQTT 3.1.1, where the broker drops the
      // message without a reason code; the silence is the proof.
      await service.app.diag.client.raw.publishAsync(
        topics.controlCmd(UNIT),
        JSON.stringify({ probe: "diag-running" }),
        { qos: 1 },
      );
      await sleep(withSlack(PUBLISH_SILENCE_MS));
      expect(received).toEqual([]);
    } finally {
      await disconnect(diagV5);
      await disconnect(simulator);
    }
  }, 60_000);

  it("lets the overlay's credential reach the same simulator (the positive control)", async () => {
    const simulator = await connectAs(stack.mqtt, "sim");
    const ops = await connectV5("backend-ops");
    try {
      const received = collect(simulator);
      expect(await subscribeGranted(simulator, topics.controlCmd(UNIT))).toBe(1);

      await ops.publishAsync(topics.controlCmd(UNIT), JSON.stringify({ probe: "ops" }), {
        qos: 1,
      });
      await sleep(withSlack(PUBLISH_SILENCE_MS));
      expect(received).toEqual([topics.controlCmd(UNIT)]);
    } finally {
      await disconnect(ops);
      await disconnect(simulator);
    }
  }, 60_000);
});

describe("createDiagClient at start-up", () => {
  const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

  it("throws before connecting when the password is missing", async () => {
    await expect(
      createDiagClient({ ...service.env, mqttDiagPassword: new Secret("") }, { logger }),
    ).rejects.toBeInstanceOf(DiagCredentialError);
  });

  it("throws before connecting when the user name is missing", async () => {
    await expect(
      createDiagClient({ ...service.env, mqttDiagUsername: "" }, { logger }),
    ).rejects.toBeInstanceOf(DiagCredentialError);
  });

  it("connects with the credential the password file carries", async () => {
    const client = await createDiagClient(service.env, { logger, clientId: "diag-acl-probe" });
    try {
      expect(client.connected()).toBe(true);
    } finally {
      await client.close();
    }
  });
});
