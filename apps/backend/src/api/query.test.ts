// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BadRequestError } from "./errors.ts";
import {
  booleanParam,
  enumParam,
  identifierListParam,
  identifierParam,
  instantParam,
  isoParam,
  positiveIntParam,
  textParam,
} from "./query.ts";

/** The parameter a helper refused, or `undefined` when it did not throw. */
function refused(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    if (error instanceof BadRequestError) return error.parameter;
    throw error;
  }
}

describe("textParam", () => {
  it("treats an absent and an empty parameter alike", () => {
    expect(textParam({}, "before")).toBeUndefined();
    expect(textParam({ before: "" }, "before")).toBeUndefined();
    expect(textParam({ before: "abc" }, "before")).toBe("abc");
  });

  it("refuses a parameter given more than once", () => {
    expect(refused(() => textParam({ before: ["a", "b"] }, "before"))).toBe("before");
  });
});

describe("positiveIntParam", () => {
  it.each([
    ["1", 1],
    ["200", 200],
  ])("reads %s", (value, expected) => {
    expect(positiveIntParam({ limit: value }, "limit")).toBe(expected);
  });

  it.each(["0", "-1", "1.5", "1e3", "01", "ten", "99999999999"])("refuses %s", (value) => {
    expect(refused(() => positiveIntParam({ limit: value }, "limit"))).toBe("limit");
  });

  it("refuses a value above the maximum", () => {
    expect(refused(() => positiveIntParam({ points: "2001" }, "points", 2000))).toBe("points");
    expect(positiveIntParam({ points: "2000" }, "points", 2000)).toBe(2000);
  });
});

describe("instantParam and isoParam", () => {
  it("reads an iso_ts instant", () => {
    expect(instantParam({ from: "2020-06-05T09:49:00.000Z" }, "from")).toBe(
      Date.parse("2020-06-05T09:49:00.000Z"),
    );
    expect(isoParam({ to: "2020-06-05T09:49:00.000Z" }, "to")).toBe("2020-06-05T09:49:00.000Z");
  });

  it.each(["2020-06-05", "2020-06-05T09:49:00Z", "2020-02-30T00:00:00.000Z", "yesterday"])(
    "refuses %s",
    (value) => {
      expect(refused(() => instantParam({ from: value }, "from"))).toBe("from");
      expect(refused(() => isoParam({ from: value }, "from"))).toBe("from");
    },
  );
});

describe("booleanParam", () => {
  it("reads true and false and nothing else", () => {
    expect(booleanParam({ active: "true" }, "active")).toBe(true);
    expect(booleanParam({ active: "false" }, "active")).toBe(false);
    expect(refused(() => booleanParam({ active: "1" }, "active"))).toBe("active");
  });
});

describe("enumParam", () => {
  it("reads a word of the list and refuses any other", () => {
    expect(enumParam({ status: "open" }, "status", ["open", "closed"])).toBe("open");
    expect(refused(() => enumParam({ status: "Open" }, "status", ["open", "closed"]))).toBe(
      "status",
    );
  });
});

describe("identifierParam and identifierListParam", () => {
  it("reads contract identifiers", () => {
    expect(identifierParam({ symptom_key: "continuous_load" }, "symptom_key")).toBe(
      "continuous_load",
    );
    expect(identifierListParam({ signals: "line_pressure, oil_temperature,," }, "signals")).toEqual(
      ["line_pressure", "oil_temperature"],
    );
  });

  it.each(["Line_pressure", "x", "line-pressure", "9lives"])("refuses %s", (value) => {
    expect(refused(() => identifierParam({ id: value }, "id"))).toBe("id");
    expect(refused(() => identifierListParam({ ids: `ok_one,${value}` }, "ids"))).toBe("ids");
  });
});
