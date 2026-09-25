// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The request digest a cassette is filed under: stable under key order and
// whitespace, sensitive to one changed word, and computed over exactly what
// `JSON.stringify` would put on the wire.

import { describe, expect, it } from "vitest";

import { canonicalJson, requestDigest, sha256Hex } from "./digest.ts";

/** A request shaped like the Jev backend's, small enough to read. */
const REQUEST = {
  model: "jev-1.13.0",
  state: {
    machine: "CAU-7 compressed-air unit",
    symptom: { key: "purge_pressure_high", detail: "dryer purge pressure stays high" },
    observations: [
      { signal: "Dryer purge pressure", movement: "high", window_min: 30 },
      { signal: "Line pressure", movement: "falling", window_min: 30 },
    ],
  },
  questions: {
    fault: { type: "choice", instructions: "Which candidate fits?", criteria: { a: "x" } },
    severity: { type: "score", instructions: "How serious?", criteria: ["low", "high"] },
  },
};

/** The same request with every object's keys in the opposite order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([key, item]) => [key, reversed(item)]));
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: true, e: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"e":null,"f":true}]},"b":1}',
    );
  });

  it("prints values exactly as JSON.stringify does", () => {
    const value = {
      big: 1e21,
      small: 1e-7,
      negativeZero: -0,
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      text: 'quote " and \\ and  ',
      when: new Date("2020-06-05T09:51:00.000Z"),
    };
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
    expect(canonicalJson(value)).toBe(
      '{"big":1e+21,"infinite":null,"negativeZero":0,"notANumber":null,"small":1e-7,' +
        `"text":${JSON.stringify(value.text)},"when":"2020-06-05T09:51:00.000Z"}`,
    );
  });

  it("drops what JSON.stringify drops and nulls what it nulls inside arrays", () => {
    const value = { kept: 1, gone: undefined, fn: () => 1, list: [undefined, () => 1, 2] };
    expect(canonicalJson(value)).toBe('{"kept":1,"list":[null,null,2]}');
  });

  it("refuses values that have no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"x":1},"b":[{"x":1}]}');
  });
});

describe("requestDigest", () => {
  const digest = requestDigest(REQUEST);

  it("is 64 lowercase hex digits: the sha256 of the canonical request", () => {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(sha256Hex(canonicalJson(REQUEST)));
  });

  it("does not depend on key order", () => {
    expect(requestDigest(reversed(REQUEST) as typeof REQUEST)).toBe(digest);
  });

  it("does not depend on whitespace in the text the request was parsed from", () => {
    const spaced = JSON.parse(JSON.stringify(REQUEST, null, 4)) as typeof REQUEST;
    const compact = JSON.parse(JSON.stringify(REQUEST)) as typeof REQUEST;
    expect(requestDigest(spaced)).toBe(digest);
    expect(requestDigest(compact)).toBe(digest);
  });

  it("changes when one word of the state changes", () => {
    const edited = structuredClone(REQUEST);
    edited.state.observations[1] = { ...REQUEST.state.observations[1]!, movement: "rising" };
    expect(requestDigest(edited)).not.toBe(digest);
  });

  it("changes with the model and with a question", () => {
    expect(requestDigest({ ...REQUEST, model: "jev-1.14.0" })).not.toBe(digest);
    const questions = { ...REQUEST.questions, extra: { type: "noul", instructions: "Is it?" } };
    expect(requestDigest({ ...REQUEST, questions })).not.toBe(digest);
  });

  it("reads only model, state and questions", () => {
    expect(requestDigest({ ...REQUEST, headers: { authorization: "x" } } as typeof REQUEST)).toBe(
      digest,
    );
  });
});
