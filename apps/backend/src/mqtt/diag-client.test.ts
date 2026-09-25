// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the diagnosis client may touch, and what it refuses before it opens a
// socket. `test/integration/mqtt-acl.test.ts` proves the same entitlement
// against a real broker; this file keeps the topic set and the credential
// check honest without one.

import { ACL, topics } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { loadEnv } from "../config/env.ts";
import { Secret } from "../config/secret.ts";
import { createLogger } from "../log.ts";
import { topicMatches } from "./client.ts";
import {
  createDiagClient,
  DIAG_PASSWORD_VARIABLE,
  DiagCredentialError,
  diagTopics,
} from "./diag-client.ts";

const UNIT = "cau-7";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

/** A port nothing listens on: a client that tried to connect would fail with a socket error. */
const CLOSED_BROKER = "mqtt://127.0.0.1:1";

/** The filters the access list grants the diagnosis user, for this unit. */
function granted(kind: "read" | "write"): string[] {
  return ACL["backend-diag"][kind].map((filter) => filter.split("{unit_id}").join(UNIT));
}

describe("diagTopics", () => {
  const unitTopics = diagTopics(UNIT);

  it("names the contracts' topics of the unit", () => {
    expect(unitTopics).toMatchObject({
      telemetry: topics.telemetrySamples(UNIT),
      statusSim: topics.statusSim(UNIT),
      statusGateway: topics.statusGateway(UNIT),
      statusBackend: topics.statusBackend(UNIT),
      eventsSuspect: topics.eventsSuspect(UNIT),
      decisions: topics.decisions(UNIT),
      alertsTicket: topics.alertsTicket(UNIT),
      alertsSystem: topics.alertsSystem(UNIT),
    });
  });

  it("subscribes one filter that covers the simulator's and the gateway's status", () => {
    expect(unitTopics.status).toBe(`plant/${UNIT}/status/#`);
    expect(topicMatches(unitTopics.status, unitTopics.statusSim)).toBe(true);
    expect(topicMatches(unitTopics.status, unitTopics.statusGateway)).toBe(true);
  });

  it("subscribes only what the broker lets this user read", () => {
    expect(granted("read")).toContain(unitTopics.status);
    expect(granted("read").some((allowed) => topicMatches(allowed, unitTopics.telemetry))).toBe(
      true,
    );
  });

  it("publishes only where the broker lets this user write", () => {
    for (const topic of [
      unitTopics.eventsSuspect,
      unitTopics.decisions,
      unitTopics.alertsTicket,
      unitTopics.alertsSystem,
      unitTopics.statusBackend,
    ]) {
      expect(granted("write").some((allowed) => topicMatches(allowed, topic))).toBe(true);
    }
  });

  it("never names the command topic", () => {
    expect(Object.values(unitTopics)).not.toContain(topics.controlCmd(UNIT));
  });
});

describe("createDiagClient", () => {
  const env = loadEnv({ MQTT_URL: CLOSED_BROKER, LOG_LEVEL: "silent" });

  it("refuses a missing password before it opens a socket", async () => {
    const attempt = createDiagClient({ ...env, mqttDiagPassword: new Secret("") }, { logger });
    await expect(attempt).rejects.toBeInstanceOf(DiagCredentialError);
    await expect(attempt).rejects.toThrow(DIAG_PASSWORD_VARIABLE);
  });

  it("refuses a missing user name before it opens a socket", async () => {
    await expect(
      createDiagClient({ ...env, mqttDiagUsername: "" }, { logger }),
    ).rejects.toBeInstanceOf(DiagCredentialError);
  });
});
