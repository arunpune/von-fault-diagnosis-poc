// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The diagnosis broker client.
 *
 * Every message the diagnosis side reads or writes on the broker goes through
 * this one connection, under the `backend-diag` credential. The broker's access
 * list gives that user read on the unit's telemetry and status topics and write
 * on the events, decisions, alerts and backend-status topics — and nothing on
 * the overlay root or the command topic. That is what makes the isolation of
 * ground truth a property of the deployment: whatever the code asks for, this
 * credential cannot see the recorded truth or move the replay, and
 * `test/integration/mqtt-acl.test.ts` proves it against a real broker.
 *
 * The client is a thin, typed face over `mqtt/client.ts`:
 *
 *   * inbound, it subscribes the telemetry topic and the unit's status subtree
 *     and hands each validated payload to the handler of its topic; the
 *     adapter has already dropped (and counted) anything off-contract;
 *   * outbound, it has one method per message the backend publishes, each
 *     naming its schema and its topic, so a caller cannot publish a decision
 *     on the ticket topic or forget to retain the status.
 *
 * A missing credential is refused before a socket is opened: a
 * diagnosis client that connected anonymously would still receive telemetry,
 * and its publications would vanish without a word.
 */

import { topics, type SchemaName } from "@fdp/contracts";
import type {
  AlertSystem,
  Decision,
  StatusBackend,
  StatusGateway,
  StatusSim,
  SuspectEvent,
  TelemetrySamples,
  Ticket,
} from "@fdp/contracts";

import type { Env } from "../config/env.ts";
import type { Logger } from "../log.ts";
import { connect, type DropCounters, type FdpMqttClient } from "./client.ts";

/** Names the connection in the broker log, as `<service>-<hostname>`. */
export const DIAG_SERVICE = "backend-diag";

/** The variable an operator sets when the password is missing. */
export const DIAG_PASSWORD_VARIABLE = "MQTT_BACKEND_DIAG_PASSWORD";

/** The part of the environment this client reads. */
export type DiagMqttConfig = Pick<
  Env,
  "mqttUrl" | "mqttDiagUsername" | "mqttDiagPassword" | "unitId"
>;

/** Thrown at start-up when the diagnosis client has no credential to connect with. */
export class DiagCredentialError extends Error {
  constructor(missing: "username" | "password") {
    super(
      missing === "username"
        ? "the diagnosis broker credential has no user name; the backend connects as a fixed user " +
            "and this is a configuration bug"
        : `the diagnosis broker credential is missing: set ${DIAG_PASSWORD_VARIABLE}`,
    );
    this.name = "DiagCredentialError";
  }
}

/** Every topic of one unit this client reads or writes. */
export interface DiagTopics {
  readonly telemetry: string;
  /** The unit's status subtree, one filter for the simulator's and the gateway's status. */
  readonly status: string;
  readonly statusSim: string;
  readonly statusGateway: string;
  readonly statusBackend: string;
  readonly eventsSuspect: string;
  readonly decisions: string;
  readonly alertsTicket: string;
  readonly alertsSystem: string;
}

/** The topics of the diagnosis credential for one unit. */
export function diagTopics(unitId: string): DiagTopics {
  const statusSim = topics.statusSim(unitId);
  return {
    telemetry: topics.telemetrySamples(unitId),
    status: `${statusSim.slice(0, statusSim.lastIndexOf("/"))}/#`,
    statusSim,
    statusGateway: topics.statusGateway(unitId),
    statusBackend: topics.statusBackend(unitId),
    eventsSuspect: topics.eventsSuspect(unitId),
    decisions: topics.decisions(unitId),
    alertsTicket: topics.alertsTicket(unitId),
    alertsSystem: topics.alertsSystem(unitId),
  };
}

/** Where the validated inbound messages go, one handler per kind. */
export interface DiagInbound {
  /** One `telemetry-samples` batch; the returned promise is the handler's own business. */
  telemetry(batch: TelemetrySamples): void | Promise<void>;
  statusSim(message: StatusSim): void;
  statusGateway(message: StatusGateway): void;
}

export interface DiagClient {
  /** The broker adapter underneath, for its counters and for the isolation tests. */
  readonly client: FdpMqttClient;
  readonly topics: DiagTopics;
  /** True between CONNACK and the close that follows it. */
  connected(): boolean;
  /** Subscribe the telemetry topic and the status subtree. */
  subscribe(inbound: DiagInbound): Promise<void>;
  publishSuspect(event: SuspectEvent): Promise<void>;
  publishDecision(decision: Decision): Promise<void>;
  publishTicket(ticket: Ticket): Promise<void>;
  publishSystemAlert(alert: AlertSystem): Promise<void>;
  /** Retained, so a late subscriber sees the backend's current status at once. */
  publishStatus(status: StatusBackend): Promise<void>;
  /** Inbound payloads dropped so far, by topic filter. */
  drops(): Readonly<Record<string, DropCounters>>;
  close(): Promise<void>;
}

export interface DiagClientOptions {
  readonly logger: Logger;
  /** Injected by the tests that run two clients of the same user. */
  readonly clientId?: string;
  readonly connectTimeoutMs?: number;
}

/**
 * Connect as the diagnosis user, or throw.
 *
 * @throws DiagCredentialError before any socket is opened, when the user name
 * or the password is empty.
 */
export async function createDiagClient(
  config: DiagMqttConfig,
  options: DiagClientOptions,
): Promise<DiagClient> {
  if (config.mqttDiagUsername.trim() === "") throw new DiagCredentialError("username");
  if (config.mqttDiagPassword.isEmpty) throw new DiagCredentialError("password");

  const client = await connect({
    url: config.mqttUrl,
    credentials: {
      username: config.mqttDiagUsername,
      password: config.mqttDiagPassword.reveal(),
    },
    service: DIAG_SERVICE,
    logger: options.logger,
    clientId: options.clientId,
    connectTimeoutMs: options.connectTimeoutMs,
  });
  const unitTopics = diagTopics(config.unitId);

  function publish(schema: SchemaName, topic: string, payload: unknown, retain = false) {
    return client.publishJson(schema, topic, payload, { retain });
  }

  return {
    client,
    topics: unitTopics,
    connected: () => client.connected(),

    async subscribe(inbound) {
      await client.subscribeValidated(unitTopics.telemetry, ({ payload }) =>
        inbound.telemetry(payload as TelemetrySamples),
      );
      // The subtree also carries this backend's own retained status, which
      // validates and is ignored: only the other two publishers matter here.
      await client.subscribeValidated(unitTopics.status, ({ topic, payload }) => {
        if (topic === unitTopics.statusSim) inbound.statusSim(payload as StatusSim);
        else if (topic === unitTopics.statusGateway)
          inbound.statusGateway(payload as StatusGateway);
      });
    },

    publishSuspect: (event) => publish("suspect-event", unitTopics.eventsSuspect, event),
    publishDecision: (decision) => publish("decision", unitTopics.decisions, decision),
    publishTicket: (ticket) => publish("ticket", unitTopics.alertsTicket, ticket),
    publishSystemAlert: (alert) => publish("alert-system", unitTopics.alertsSystem, alert),
    publishStatus: (status) => publish("status-backend", unitTopics.statusBackend, status, true),

    drops: () => client.drops(),
    close: () => client.close(),
  };
}
