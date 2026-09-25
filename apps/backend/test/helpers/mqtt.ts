// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Talking to the test broker.
 *
 * `connectAs` is deliberately a raw client rather than the adapter of
 * `src/mqtt/client.ts`: the tests that assert the access rules need to see a
 * refused connection and a refused subscription as they come off the wire, and
 * the ones that assert what the backend published need a consumer that does no
 * validation of its own.
 */

import mqtt, { type MqttClient } from "mqtt";

import { topicMatches } from "../../src/mqtt/client.ts";
import type { MqttTestBroker, MqttUser } from "./containers.ts";
import { withSlack } from "./timing.ts";

/** MQTT 3.1.1, the dialect of the whole stack. */
const PROTOCOL_VERSION = 4;

/** SUBACK return code 0x80: the broker refused the subscription. */
export const SUBACK_FAILURE = 128;

export interface ConnectOptions {
  /** Unique per connection, so two clients of one user can coexist. */
  clientId?: string;
  timeoutMs?: number;
}

/**
 * Connect as one of the broker's five users, or reject with the broker's reason.
 *
 * `reconnectPeriod: 0` matters: a refused credential must surface as a
 * rejection here and not as an endless retry in the background.
 */
export async function connectAs(
  broker: MqttTestBroker,
  user: MqttUser,
  options: ConnectOptions = {},
): Promise<MqttClient> {
  const password = broker.credentials[user];
  if (password === undefined) throw new Error(`the test broker has no credential for ${user}`);

  return new Promise<MqttClient>((resolve, reject) => {
    const client = mqtt.connect(broker.url, {
      clientId: options.clientId ?? `test-${user}-${Math.random().toString(36).slice(2, 10)}`,
      username: user,
      password,
      protocolVersion: PROTOCOL_VERSION,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: options.timeoutMs ?? withSlack(10_000),
    });
    const onError = (error: Error): void => {
      client.removeListener("connect", onConnect);
      client.end(true, () => {
        reject(error);
      });
    };
    const onConnect = (): void => {
      client.removeListener("error", onError);
      resolve(client);
    };
    client.once("error", onError);
    client.once("connect", onConnect);
  });
}

/** Subscribe and report the broker's return code, 128 when it refused. */
export async function subscribeGranted(client: MqttClient, filter: string): Promise<number> {
  const granted = await client.subscribeAsync(filter, { qos: 1 });
  return granted[0]?.qos ?? SUBACK_FAILURE;
}

/**
 * Resolve with the first message on `filter` that `predicate` accepts.
 *
 * Deliberately not `async`: the listener is attached before the function
 * returns, so a caller that publishes on the next line cannot lose the race.
 * Subscribing is the caller's job, with {@link subscribeGranted}, and it has to
 * happen first — the broker delivers nothing before SUBACK.
 */
export function waitForMessage(
  client: MqttClient,
  filter: string,
  predicate: (payload: unknown, topic: string) => boolean = () => true,
  timeoutMs = withSlack(5_000),
): Promise<{ topic: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`no message matching ${filter} within ${timeoutMs} ms`));
    }, timeoutMs);

    const onMessage = (topic: string, raw: Buffer): void => {
      if (!topicMatches(filter, topic)) return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        return;
      }
      if (!predicate(payload, topic)) return;
      finish();
      resolve({ topic, payload });
    };

    function finish(): void {
      clearTimeout(timer);
      client.removeListener("message", onMessage);
    }

    client.on("message", onMessage);
  });
}

/** Publish one JSON payload and wait for the broker to acknowledge it. */
export async function publishJson(
  client: MqttClient,
  topic: string,
  payload: unknown,
  options: { retain?: boolean } = {},
): Promise<void> {
  await client.publishAsync(topic, JSON.stringify(payload), {
    qos: 1,
    retain: options.retain ?? false,
  });
}

/** End a client without waiting for in-flight messages. */
export async function disconnect(client: MqttClient): Promise<void> {
  await client.endAsync(true);
}
