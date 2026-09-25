// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { digestOf, newId, sha256, stableStringify } from "./ids.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("is a version 4 UUID and does not repeat", () => {
    const ids = new Set(Array.from({ length: 256 }, () => newId()));
    expect(ids.size).toBe(256);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe("sha256", () => {
  it("agrees with the published digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes bytes and their string form the same", () => {
    expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
  });
});

describe("stableStringify", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1, 2], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,1,2]},"b":1}',
    );
  });

  it("drops undefined properties the way JSON.stringify does", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("writes a Date as its ISO instant", () => {
    expect(stableStringify({ at: new Date("2026-09-21T00:00:00.000Z") })).toBe(
      '{"at":"2026-09-21T00:00:00.000Z"}',
    );
  });
});

describe("digestOf", () => {
  it("is blind to property order, which is what makes state_digest comparable", () => {
    expect(digestOf({ choice: "none_of_these", confidence: 0.4 })).toBe(
      digestOf({ confidence: 0.4, choice: "none_of_these" }),
    );
  });

  it("changes when a value changes", () => {
    expect(digestOf({ confidence: 0.4 })).not.toBe(digestOf({ confidence: 0.41 }));
  });

  it("is the digest of the sorted JSON, not of some other encoding", () => {
    expect(digestOf({ b: 1, a: 2 })).toBe(sha256('{"a":2,"b":1}'));
  });
});
