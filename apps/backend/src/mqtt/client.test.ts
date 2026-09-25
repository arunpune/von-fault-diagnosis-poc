// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The routing and naming rules of the broker adapter. Connecting, validating
// and publishing run against a real broker in test/integration/smoke.test.ts.

import { hostname } from "node:os";

import { describe, expect, it } from "vitest";

import { clientIdFor, PROTOCOL_VERSION, QOS, topicMatches } from "./client.ts";

describe("topicMatches", () => {
  it("matches an exact topic", () => {
    expect(topicMatches("plant/cau-7/decisions", "plant/cau-7/decisions")).toBe(true);
    expect(topicMatches("plant/cau-7/decisions", "plant/cau-7/events")).toBe(false);
  });

  it("takes one level for +", () => {
    expect(topicMatches("plant/+/decisions", "plant/cau-7/decisions")).toBe(true);
    expect(topicMatches("plant/+/decisions", "plant/cau-7/a/decisions")).toBe(false);
    expect(topicMatches("plant/+", "plant")).toBe(false);
  });

  it("takes the rest for #, including the level the filter sits on", () => {
    expect(topicMatches("plant/cau-7/status/#", "plant/cau-7/status/sim")).toBe(true);
    expect(topicMatches("plant/cau-7/status/#", "plant/cau-7/status/a/b")).toBe(true);
    expect(topicMatches("plant/cau-7/status/#", "plant/cau-7/telemetry/samples")).toBe(false);
    expect(topicMatches("#", "plant/cau-7/decisions")).toBe(true);
  });

  it("refuses a shorter or longer topic than a wildcard-free filter", () => {
    expect(topicMatches("plant/cau-7", "plant/cau-7/decisions")).toBe(false);
    expect(topicMatches("plant/cau-7/decisions", "plant/cau-7")).toBe(false);
  });

  it("keeps the broker's own tree out of a wildcard subscription", () => {
    expect(topicMatches("#", "$SYS/broker/uptime")).toBe(false);
    expect(topicMatches("+/broker/uptime", "$SYS/broker/uptime")).toBe(false);
    expect(topicMatches("$SYS/#", "$SYS/broker/uptime")).toBe(true);
  });
});

describe("clientIdFor", () => {
  it("names the service and the host, so the broker log says who connected", () => {
    expect(clientIdFor("backend-diag")).toBe(`backend-diag-${hostname()}`);
  });
});

describe("protocol constants", () => {
  it("speaks MQTT 3.1.1 at least once", () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(QOS).toBe(1);
  });
});
