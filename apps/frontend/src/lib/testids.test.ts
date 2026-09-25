// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { tid } from "@/lib/testids";

describe("the test id registry", () => {
  it("builds the dynamic ids the tours select by", () => {
    expect(tid.status.clock).toBe("status-clock");
    expect(tid.recorder.lane("TP3")).toBe("recorder-lane-TP3");
    expect(tid.recorder.band("F3")).toBe("recorder-band-F3");
    expect(tid.recorder.marker("jump-2020-06-05T06:00:00.000Z")).toBe(
      "recorder-marker-jump-2020-06-05T06:00:00.000Z",
    );
    expect(tid.sim.jumpItem("f3_air_leak_jun05")).toBe("sim-jump-f3_air_leak_jun05");
    expect(tid.sim.injectItem("oil_cooler_fouling")).toBe("sim-inject-oil_cooler_fouling");
    expect(tid.alerts.item("decision-6a0c")).toBe("alert-decision-6a0c");
    expect(tid.alerts.banner("telemetry_silent")).toBe("alert-banner-telemetry_silent");
    expect(tid.decision.candidate("dryer_purge_leak")).toBe("decision-candidate-dryer_purge_leak");
    expect(tid.tickets.row("8d7e60")).toBe("ticket-row-8d7e60");
    expect(tid.review.row("8d7e60")).toBe("review-row-8d7e60");
    expect(tid.events.row("3d4a1f")).toBe("event-row-3d4a1f");
    expect(tid.cost.row("6a0c8e")).toBe("cost-row-6a0c8e");
  });

  it("matches the tab ids the shell renders", () => {
    expect([tid.tickets.tab, tid.review.tab, tid.events.tab, tid.cost.tab]).toEqual([
      "tab-tickets",
      "tab-review",
      "tab-events",
      "tab-cost",
    ]);
  });
});
