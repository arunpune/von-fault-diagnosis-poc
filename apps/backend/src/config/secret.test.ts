// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { REDACTED, Secret } from "./secret.ts";

describe("Secret", () => {
  const secret = new Secret("tk-live-do-not-print");

  it("prints as redacted however it is written out", () => {
    expect(String(secret)).toBe(REDACTED);
    expect(`${secret}`).toBe(REDACTED);
    expect(secret + "").toBe(REDACTED);
    expect(JSON.stringify(secret)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ apiKey: secret })).toBe(`{"apiKey":"${REDACTED}"}`);
    expect(inspect(secret)).toBe(REDACTED);
    expect(inspect({ nested: { apiKey: secret } }, { depth: 5 })).not.toContain("tk-live");
  });

  it("hands the plain value out only through reveal", () => {
    expect(secret.reveal()).toBe("tk-live-do-not-print");
    expect(new Secret("").isEmpty).toBe(true);
    expect(secret.isEmpty).toBe(false);
  });

  it("keeps the value off its own enumerable surface", () => {
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.values(secret)).toEqual([]);
  });
});
