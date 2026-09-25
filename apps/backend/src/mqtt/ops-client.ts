// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The privileged broker client of the overlay.
 *
 * It is the second of the two credentials this process holds, and the only one
 * the broker lets near the recorded truth: the access-control list of
 * `infra/mosquitto/acl` gives this user read on the overlay root and on the
 * simulator's acknowledgements, and write on the command topic. The diagnosis
 * client of `mqtt/diag-client.ts` has none of that, which is what makes
 * the isolation of the recorded truth a property of the deployment rather than
 * of the code.
 *
 * Nothing here reads the environment. `overlay/config.ts` is the only reader of
 * the password and hands it over as {@link OpsMqttConfig}, the way
 * `db/gt.ts` takes its own credential — so the typed environment the diagnosis
 * side passes around cannot carry either of them.
 *
 * A missing password is refused at start-up rather than at the first publish:
 * an unauthenticated overlay would connect, subscribe and then quietly record
 * nothing, and "quietly records nothing" is the one failure the overlay
 * recorder must never have.
 */

import { topics, type SchemaName } from "@fdp/contracts";

import type { Secret } from "../config/secret.ts";
import type { Logger } from "../log.ts";
import { connect, type FdpMqttClient, type MessageHandler } from "./client.ts";

/** The broker credential of the overlay (docs/api.md#broker-acl); only this module names it. */
export const OPS_MQTT_USERNAME = "backend-ops";

/** Names the connection in the broker log, as `<service>-<hostname>`. */
export const OPS_SERVICE = "backend-ops";

/** What `overlay/config.ts` builds and hands over. */
export interface OpsMqttConfig {
  readonly url: string;
  /** The password of {@link OPS_MQTT_USERNAME}; empty means "not configured". */
  readonly password: Secret;
}

/**
 * The part of the broker adapter the overlay uses.
 *
 * The recorder and the control passthrough take this narrower port rather than
 * the whole {@link FdpMqttClient}, so their unit tests drive them with a plain
 * object instead of a live socket. `FdpMqttClient` satisfies it structurally.
 */
export interface OpsClient {
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
  close(): Promise<void>;
}

/** Thrown at start-up when the overlay has no broker credential to connect with. */
export class OpsCredentialError extends Error {
  constructor(variable: string) {
    super(
      `the overlay broker credential is missing: set ${variable} so the ${OPS_MQTT_USERNAME} ` +
        "user can subscribe to the recorded truth",
    );
    this.name = "OpsCredentialError";
  }
}

/** The environment variable {@link OpsCredentialError} names; `overlay/config.ts` reads it. */
export const OPS_PASSWORD_VARIABLE = "MQTT_BACKEND_OPS_PASSWORD";

export interface OpsClientOptions {
  readonly logger: Logger;
  /** Injected by the tests that need a second client id for the same user. */
  readonly clientId?: string;
  readonly connectTimeoutMs?: number;
}

/** The five topics this credential is entitled to, for one unit. */
export interface OpsTopics {
  readonly catalog: string;
  readonly injection: string;
  readonly injectionActive: string;
  readonly marker: string;
  readonly controlAck: string;
  readonly controlCmd: string;
}

/** The topics of {@link OPS_MQTT_USERNAME}; the contracts' default unit when none is named. */
export function opsTopics(unitId?: string): OpsTopics {
  return {
    catalog: topics.gtCatalog(unitId),
    injection: topics.gtInjection(unitId),
    injectionActive: topics.gtInjectionActive(unitId),
    marker: topics.gtMarker(unitId),
    controlAck: topics.controlAck(unitId),
    controlCmd: topics.controlCmd(unitId),
  };
}

/**
 * Connect as {@link OPS_MQTT_USERNAME}, or throw.
 *
 * @throws OpsCredentialError before any socket is opened, when the password is
 * empty — the case an operator has to fix rather than retry.
 */
export async function createOpsClient(
  config: OpsMqttConfig,
  options: OpsClientOptions,
): Promise<FdpMqttClient> {
  if (config.password.isEmpty) throw new OpsCredentialError(OPS_PASSWORD_VARIABLE);
  return connect({
    url: config.url,
    credentials: { username: OPS_MQTT_USERNAME, password: config.password.reveal() },
    service: OPS_SERVICE,
    logger: options.logger,
    clientId: options.clientId,
    connectTimeoutMs: options.connectTimeoutMs,
  });
}
