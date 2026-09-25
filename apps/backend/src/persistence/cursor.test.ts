// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The keyset cursor helpers. Paging over real rows, ties included, runs against
// the schema in test/integration/persistence.test.ts.

import { describe, expect, it } from "vitest";

import {
  clampLimit,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  InvalidCursorError,
  MAX_PAGE_LIMIT,
  pageParams,
  toPage,
  type KeyedRow,
} from "./cursor.ts";

const KEY = { simTs: "2020-06-05T11:00:00.123456Z", id: "42" };

/** A token built by hand, to feed the decoder what the encoder never writes. */
function token(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a key through an opaque base64url token", () => {
    const cursor = encodeCursor(KEY);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(KEY.simTs);
    expect(decodeCursor(cursor)).toEqual(KEY);
  });

  it("keeps the largest bigint row key exactly", () => {
    const key = { simTs: KEY.simTs, id: "9223372036854775807" };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it.each([
    ["an empty string", ""],
    ["characters outside base64url", "abc+/="],
    ["bytes that are not JSON", Buffer.from("not json").toString("base64url")],
    ["an object instead of the pair", token({ simTs: KEY.simTs, id: KEY.id })],
    ["a pair with a third element", token([KEY.simTs, KEY.id, 1])],
    ["a millisecond instant", token(["2020-06-05T11:00:00.123Z", "42"])],
    ["an impossible date", token(["2020-13-45T11:00:00.000000Z", "42"])],
    ["a numeric row key", token([KEY.simTs, 42])],
    ["a zero row key", token([KEY.simTs, "0"])],
    ["a negative row key", token([KEY.simTs, "-1"])],
    ["a row key with a leading zero", token([KEY.simTs, "042"])],
    ["a row key beyond bigint", token([KEY.simTs, "9223372036854775808"])],
  ])("refuses %s", (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});

describe("clampLimit", () => {
  it("falls back to the default when the caller does not say", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("truncates and clamps to 1…max", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(12.9)).toBe(12);
    expect(clampLimit(MAX_PAGE_LIMIT + 1)).toBe(MAX_PAGE_LIMIT);
  });

  it("takes the bounds of another list", () => {
    const bounds = { fallback: 100, max: 1_000 };
    expect(clampLimit(undefined, bounds)).toBe(100);
    expect(clampLimit(5_000, bounds)).toBe(1_000);
  });
});

describe("pageParams", () => {
  it("asks for one row more than the page, from the top on the first page", () => {
    expect(pageParams(undefined, 25)).toEqual([null, null, 26]);
  });

  it("starts below the key of a cursor", () => {
    expect(pageParams(encodeCursor(KEY), 25)).toEqual([KEY.simTs, KEY.id, 26]);
  });

  it("refuses a cursor it did not issue before any statement runs", () => {
    expect(() => pageParams("garbage!", 25)).toThrow(InvalidCursorError);
  });
});

describe("toPage", () => {
  const rows: (KeyedRow & { value: string })[] = [
    { cursor_id: "9", cursor_ts: "2020-06-05T11:00:03.000000Z", value: "c" },
    { cursor_id: "8", cursor_ts: "2020-06-05T11:00:02.000000Z", value: "b" },
    { cursor_id: "7", cursor_ts: "2020-06-05T11:00:02.000000Z", value: "a" },
  ];

  it("drops the look-ahead row and points the cursor at the last row kept", () => {
    const page = toPage(rows, 2, (row) => row.value);
    expect(page.items).toEqual(["c", "b"]);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeCursor(page.next_cursor!)).toEqual({
      simTs: "2020-06-05T11:00:02.000000Z",
      id: "8",
    });
  });

  it("has no next page when the statement returned no look-ahead row", () => {
    expect(toPage(rows, 3, (row) => row.value)).toEqual({
      items: ["c", "b", "a"],
      next_cursor: null,
    });
    expect(toPage([], 3, (row: KeyedRow) => row.cursor_id)).toEqual({
      items: [],
      next_cursor: null,
    });
  });
});
