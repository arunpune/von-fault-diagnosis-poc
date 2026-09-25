// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  fmtManualRef,
  fmtNumber,
  fmtPct,
  fmtSpeed,
  fmtTokens,
  fmtUsd,
  fmtValue,
  humanize,
  NO_VALUE,
  shortId,
  unitLabel,
} from "@/lib/format";

describe("fmtValue", () => {
  it.each([
    [9.1134, "bar", "9.11 bar"],
    [9.1, "bar", "9.10 bar"],
    [76.14, "degC", "76.1 °C"],
    [76, "°C", "76.0 °C"],
    [5.6089, "A", "5.61 A"],
    [0.41, "bar/min", "0.41 bar/min"],
    [9, "1/h", "9.0 1/h"],
    [5322, "s", "5,322 s"],
    [1.23456, "rpm", "1.23 rpm"],
    [2, "rpm", "2 rpm"],
    [1.5, undefined, "1.5"],
    [1.5, null, "1.5"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(fmtValue(value, unit)).toBe(expected);
  });

  it("reads digital states as on and off", () => {
    expect(fmtValue(true)).toBe("on");
    expect(fmtValue(false, "")).toBe("off");
    expect(fmtValue(1, "bool")).toBe("on");
    expect(fmtValue(0, "bool")).toBe("off");
  });

  it("shows a dash for an absent or non-finite value", () => {
    expect(fmtValue(null, "bar")).toBe(NO_VALUE);
    expect(fmtValue(undefined)).toBe(NO_VALUE);
    expect(fmtValue(Number.NaN, "bar")).toBe(NO_VALUE);
    expect(fmtValue(Number.POSITIVE_INFINITY, "A")).toBe(NO_VALUE);
  });
});

describe("unitLabel", () => {
  it("spells the registry units for the screen", () => {
    expect(unitLabel("degC")).toBe("°C");
    expect(unitLabel("bool")).toBe("");
    expect(unitLabel("bar")).toBe("bar");
    expect(unitLabel(null)).toBe("");
    expect(unitLabel(undefined)).toBe("");
  });
});

describe("fmtUsd", () => {
  it.each([
    [0.000077028, "$0.000077"],
    [0.000126, "$0.000126"],
    [0.0318412, "$0.031841"],
    [0.01147, "$0.01147"],
    [0.0004, "$0.0004"],
    [0, "$0.00"],
    [12.5, "$12.50"],
    [1234.5, "$1,234.50"],
    [-0.25, "−$0.25"],
  ])("formats %s as %s", (usd, expected) => {
    expect(fmtUsd(usd)).toBe(expected);
  });

  it("shows a dash when there is no amount", () => {
    expect(fmtUsd(null)).toBe(NO_VALUE);
    expect(fmtUsd(undefined)).toBe(NO_VALUE);
    expect(fmtUsd(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("fmtPct", () => {
  it("rounds a fraction to a whole percentage with a space before the sign", () => {
    expect(fmtPct(0.913)).toBe("91 %");
    expect(fmtPct(0.85)).toBe("85 %");
    expect(fmtPct(0)).toBe("0 %");
    expect(fmtPct(1)).toBe("100 %");
  });

  it("shows a dash when there is no fraction", () => {
    expect(fmtPct(null)).toBe(NO_VALUE);
    expect(fmtPct(undefined)).toBe(NO_VALUE);
    expect(fmtPct(Number.NaN)).toBe(NO_VALUE);
  });
});

describe("counts, speeds and ids", () => {
  it("groups token counts by thousands", () => {
    expect(fmtTokens(74892)).toBe("74,892");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(1834.4)).toBe("1,834");
    expect(fmtTokens(null)).toBe(NO_VALUE);
    expect(fmtTokens(undefined)).toBe(NO_VALUE);
    expect(fmtTokens(Number.NaN)).toBe(NO_VALUE);
  });

  it("formats numbers with fixed decimals", () => {
    expect(fmtNumber(1234.567, 1)).toBe("1,234.6");
  });

  it("shows a replay speed with a multiplication sign", () => {
    expect(fmtSpeed(600)).toBe("600×");
    expect(fmtSpeed(3600)).toBe("3,600×");
  });

  it("keeps the last six characters of an id", () => {
    expect(shortId("2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60")).toBe("8d7e60");
    expect(shortId("F3")).toBe("F3");
    expect(shortId("abcdef")).toBe("abcdef");
  });

  it("turns identifiers into sentence-case phrases", () => {
    expect(humanize("dryer_purge_pressure")).toBe("Dryer purge pressure");
    expect(humanize("continuous_load")).toBe("Continuous load");
    expect(humanize("W102")).toBe("W102");
    expect(humanize("kebab-case-id")).toBe("Kebab case id");
    expect(humanize("__")).toBe("");
  });
});

describe("fmtManualRef", () => {
  it("cites the section, its title and the page", () => {
    expect(fmtManualRef({ section: "8.3", title: "Low line pressure", page: 41 })).toBe(
      "§8.3 Low line pressure, p. 41",
    );
  });

  it("cites a page range, and a range of one page as a page", () => {
    expect(fmtManualRef({ section: "8.3", page_start: 26, page_end: 28 })).toBe("§8.3, pp. 26–28");
    expect(fmtManualRef({ section: "8.3", page_start: 26, page_end: 26 })).toBe("§8.3, p. 26");
    expect(fmtManualRef({ section: "8.3", page_start: 26 })).toBe("§8.3, p. 26");
  });

  it("cites the section alone when nothing else is known", () => {
    expect(fmtManualRef({ section: "6.3", anchor: "reference-cycle" })).toBe("§6.3");
  });
});
