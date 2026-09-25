// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { REDACTED, Secret } from "../config/secret.ts";
import { overlayConnectionString, OVERLAY_DB_ROLE } from "./gt.ts";

const CONFIG = {
  host: "postgres",
  port: 5432,
  database: "fdp",
  password: new Secret("overlay-password"),
};

describe("overlayConnectionString", () => {
  it("composes the URL from the parts the overlay configuration hands over", () => {
    expect(overlayConnectionString(CONFIG).reveal()).toBe(
      `postgres://${OVERLAY_DB_ROLE}:overlay-password@postgres:5432/fdp`,
    );
  });

  it("percent-encodes a password that would otherwise break the URL", () => {
    expect(
      overlayConnectionString({ ...CONFIG, password: new Secret("p@ss/word") }).reveal(),
    ).toContain("p%40ss%2Fword");
  });

  it("prefers an explicit override", () => {
    const url = new Secret("postgres://elsewhere/db");
    expect(overlayConnectionString({ ...CONFIG, url }).reveal()).toBe("postgres://elsewhere/db");
  });

  it("stays redacted wherever it is printed", () => {
    const composed = overlayConnectionString(CONFIG);
    expect(String(composed)).toBe(REDACTED);
    expect(JSON.stringify({ url: composed })).not.toContain("overlay-password");
  });
});
