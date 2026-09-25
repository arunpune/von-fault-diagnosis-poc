// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the ops client is entitled to, and what it refuses before it opens a
// socket. `test/integration/db-roles.test.ts` proves the entitlement against a
// real broker; this file keeps the topic set and the credential check honest
// without one.

import { ACL, topics } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { createLogger } from "../log.ts";
import { Secret } from "../config/secret.ts";
import {
  createOpsClient,
  opsTopics,
  OpsCredentialError,
  OPS_MQTT_USERNAME,
  OPS_PASSWORD_VARIABLE,
} from "./ops-client.ts";

const UNIT = "cau-7";
const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

describe("opsTopics", () => {
  it("names the four overlay topics and the two control topics", () => {
    expect(opsTopics(UNIT)).toEqual({
      catalog: topics.gtCatalog(UNIT),
      injection: topics.gtInjection(UNIT),
      injectionActive: topics.gtInjectionActive(UNIT),
      marker: topics.gtMarker(UNIT),
      controlAck: topics.controlAck(UNIT),
      controlCmd: topics.controlCmd(UNIT),
    });
  });

  it("falls back to the contracts' default unit", () => {
    expect(opsTopics()).toEqual(opsTopics(UNIT));
  });

  it("stays inside what the broker grants this credential", () => {
    const granted = ACL[OPS_MQTT_USERNAME];
    const readable = granted.read.map((filter) => filter.split("{unit_id}").join(UNIT));
    const writable = granted.write.map((filter) => filter.split("{unit_id}").join(UNIT));

    expect(readable).toContain(topics.controlAck(UNIT));
    expect(writable).toEqual([topics.controlCmd(UNIT)]);
    // The four overlay topics are covered by the one wildcard the list grants.
    expect(readable.some((filter) => filter.endsWith("/#"))).toBe(true);
  });
});

describe("createOpsClient", () => {
  it("refuses a missing credential before it opens a socket", async () => {
    await expect(
      createOpsClient({ url: "mqtt://127.0.0.1:1", password: new Secret("") }, { logger }),
    ).rejects.toBeInstanceOf(OpsCredentialError);
  });

  it("names the variable an operator has to set", async () => {
    await expect(
      createOpsClient({ url: "mqtt://127.0.0.1:1", password: new Secret("") }, { logger }),
    ).rejects.toThrow(OPS_PASSWORD_VARIABLE);
  });
});
