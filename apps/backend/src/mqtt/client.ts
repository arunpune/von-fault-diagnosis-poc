// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The broker adapter.
 *
 * One helper serves both credentials of the backend: `mqtt/diag-client.ts`
 * and `mqtt/ops-client.ts` each configure it with their own
 * user, and the broker's access-control list decides what that user may see.
 * Nothing in this file names a credential, so nothing here has to be trusted
 * with one.
 *
 * Two guarantees the callers rely on:
 *
 *   * every inbound payload is validated against the schema its topic declares
 *     before a handler sees it, and an invalid payload is dropped with exactly
 *     one warning line and a counter, never with a throw that would take the
 *     connection down;
 *   * every outbound payload is validated before it is published, so a bug in
 *     a producer fails here rather than in a consumer of another language.
 *
 * MQTT 3.1.1 (`protocolVersion: 4`) and QoS 1 everywhere: the broker
 * configuration, the Go gateway and the simulator all speak that dialect.
 */

import { hostname } from "node:os";

import { assertValid, validateMqtt, type SchemaName } from "@fdp/contracts";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

import type { Logger } from "../log.ts";

/** MQTT 3.1.1: the dialect the whole stack speaks. */
export const PROTOCOL_VERSION = 4;

/** At-least-once for every subscription and every publish. */
export const QOS = 1;

/** How long `connect` waits for CONNACK before it reports a failure. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface MqttCredentials {
  readonly username: string;
  /** The plain password; the caller unwraps its `Secret` at this boundary. */
  readonly password: string;
}

export interface MqttClientOptions {
  readonly url: string;
  readonly credentials: MqttCredentials;
  /** Names the connection in the broker log: `<service>-<hostname>`. */
  readonly service: string;
  readonly logger: Logger;
  readonly connectTimeoutMs?: number;
  /** Injected by the tests that need a second client id for the same user. */
  readonly clientId?: string;
}

/** What a validated subscription hands to its handler. */
export interface ValidatedMessage {
  readonly topic: string;
  readonly payload: unknown;
}

export type MessageHandler = (message: ValidatedMessage) => void | Promise<void>;

/** Why a payload was dropped, counted per topic filter and shown by `/api/health`. */
export interface DropCounters {
  readonly invalid: number;
  readonly failed: number;
}

export interface FdpMqttClient {
  /** The underlying client, for the few places that need its events. */
  readonly raw: MqttClient;
  readonly clientId: string;
  /** True between CONNACK and the close that follows it. */
  connected(): boolean;
  /** Subscribe and hand the handler only payloads that match the topic's schema. */
  subscribeValidated(filter: string, handler: MessageHandler): Promise<void>;
  /** Validate against `schema`, then publish. Throws before the broker sees anything invalid. */
  publishJson(
    schema: SchemaName,
    topic: string,
    payload: unknown,
    options?: { retain?: boolean },
  ): Promise<void>;
  /** Payloads dropped so far, by topic filter. */
  drops(): Readonly<Record<string, DropCounters>>;
  close(): Promise<void>;
}

/** `<service>-<hostname>`, the identifier the broker logs. */
export function clientIdFor(service: string): string {
  return `${service}-${hostname()}`;
}

/**
 * Connect, and resolve once the broker has accepted the credentials.
 *
 * A refused connection rejects with the broker's reason instead of retrying
 * for ever: a wrong password is an operator problem and start-up must say so.
 */
export async function connect(options: MqttClientOptions): Promise<FdpMqttClient> {
  const clientId = options.clientId ?? clientIdFor(options.service);
  const logger = options.logger.child({ module: "mqtt", client_id: clientId });
  const clientOptions: IClientOptions = {
    clientId,
    username: options.credentials.username,
    password: options.credentials.password,
    protocolVersion: PROTOCOL_VERSION,
    clean: true,
    reconnectPeriod: 2_000,
    connectTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  };

  const client = await new Promise<MqttClient>((resolve, reject) => {
    const pending = mqtt.connect(options.url, clientOptions);
    const onError = (error: Error): void => {
      pending.removeListener("connect", onConnect);
      pending.end(true, () => {
        reject(error);
      });
    };
    const onConnect = (): void => {
      pending.removeListener("error", onError);
      resolve(pending);
    };
    pending.once("error", onError);
    pending.once("connect", onConnect);
  });

  const handlers = new Map<string, MessageHandler>();
  const counters = new Map<string, { invalid: number; failed: number }>();

  const counterFor = (filter: string): { invalid: number; failed: number } => {
    const existing = counters.get(filter);
    if (existing !== undefined) return existing;
    const created = { invalid: 0, failed: 0 };
    counters.set(filter, created);
    return created;
  };

  client.on("message", (topic, payload) => {
    for (const [filter, handler] of handlers) {
      if (!topicMatches(filter, topic)) continue;
      const counter = counterFor(filter);
      const result = validateMqtt(topic, payload);
      if (!result.ok) {
        counter.invalid += 1;
        const first = result.errors[0];
        logger.warn(
          { topic, issue: first?.text ?? "invalid", dropped_total: counter.invalid },
          "dropped an invalid payload",
        );
        continue;
      }
      void Promise.resolve(handler({ topic, payload: result.value })).catch((error: unknown) => {
        counter.failed += 1;
        logger.error({ topic, err: error }, "a message handler failed");
      });
    }
  });

  client.on("error", (error) => {
    logger.error({ err: error }, "broker connection error");
  });

  return {
    raw: client,
    clientId,
    connected: () => client.connected,

    async subscribeValidated(filter, handler) {
      handlers.set(filter, handler);
      counterFor(filter);
      await client.subscribeAsync(filter, { qos: QOS });
    },

    async publishJson(schema, topic, payload, publishOptions) {
      assertValid(schema, payload);
      await client.publishAsync(topic, JSON.stringify(payload), {
        qos: QOS,
        retain: publishOptions?.retain ?? false,
      });
    },

    drops() {
      return Object.fromEntries([...counters].map(([filter, counter]) => [filter, { ...counter }]));
    },

    async close() {
      handlers.clear();
      await client.endAsync();
    },
  };
}

/**
 * MQTT topic matching: `+` takes one level, `#` takes the rest.
 *
 * The client library dispatches every message to one listener, so the adapter
 * routes them itself; this is the routing rule of the MQTT specification, with
 * the `$`-prefix exclusion the broker applies to wildcard subscriptions.
 */
export function topicMatches(filter: string, topic: string): boolean {
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  if (topicParts[0]?.startsWith("$") === true && filterParts[0] !== topicParts[0]) return false;

  for (let index = 0; index < filterParts.length; index += 1) {
    const part = filterParts[index];
    if (part === "#") return index === filterParts.length - 1;
    if (index >= topicParts.length) return false;
    if (part === "+") continue;
    if (part !== topicParts[index]) return false;
  }
  return filterParts.length === topicParts.length;
}
