// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isSeverityLevel,
  SEVERITY_LEVELS,
  severityColor,
  severityLabel,
  severityRank,
  severityTone,
} from "@/lib/severity";

describe("severity", () => {
  it("lists the four contract levels, lowest first", () => {
    expect(SEVERITY_LEVELS).toEqual(["low", "medium", "high", "critical"]);
    expect(SEVERITY_LEVELS.map(severityRank)).toEqual([0, 1, 2, 3]);
  });

  it("gives each level its word, its tone classes and its colour token", () => {
    expect(severityLabel("high")).toBe("high");
    expect(severityTone("high")).toBe("border-severity-high text-severity-high");
    expect(severityColor("critical")).toBe("var(--severity-critical)");
  });

  it("keeps an unknown level readable in the lowest tone", () => {
    expect(isSeverityLevel("catastrophic")).toBe(false);
    expect(isSeverityLevel("toString")).toBe(false);
    expect(isSeverityLevel(2)).toBe(false);
    expect(severityLabel("catastrophic")).toBe("catastrophic");
    expect(severityTone("catastrophic")).toBe(severityTone("low"));
    expect(severityColor("catastrophic")).toBe("var(--severity-low)");
    expect(severityRank("catastrophic")).toBe(-1);
  });
});
