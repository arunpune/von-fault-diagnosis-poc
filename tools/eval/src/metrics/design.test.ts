// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The design-target reading: what it counts, and that the scorer never
// sees it.

import { describe, expect, it } from "vitest";

import { UNLABELLED_EPISODE_REASON, designEpisodes, designReading } from "./design.ts";
import type { DesignInput } from "./design.ts";
import { TEST_PRICES, at, decision, excluded, suspect, ticket } from "./fixtures.ts";
import { scoreScenario } from "./summary.ts";
import type { ScenarioBinding } from "./types.ts";

const EPISODE = excluded({
  id: "unlabelled@episode",
  from: at(120),
  to: at(600),
  reason: UNLABELLED_EPISODE_REASON,
});

const REPAIR = excluded({ id: "repair@late", from: at(700), to: at(760), reason: "repair" });

const TARGET = {
  accepted: ["dryer_purge_leak", "downstream_air_leak"],
  provenance: "inferred from the signature-A analysis, unverified",
};

function input(fields: Partial<DesignInput> = {}): DesignInput {
  return {
    scenarioId: "unlabelled_leak_may19",
    backend: "rules",
    target: TARGET,
    excluded: [EPISODE, REPAIR],
    tickets: [],
    decisions: [],
    benignFaultIds: new Set(["high_air_demand"]),
    ...fields,
  };
}

describe("designEpisodes", () => {
  it("takes the unlabelled episodes among the excluded windows, and nothing else", () => {
    expect(designEpisodes([REPAIR, EPISODE])).toEqual([{ from: at(120), to: at(600) }]);
  });
});

describe("designReading", () => {
  const tickets = [
    ticket({ ticketId: "t-before", openedSimTs: at(90), faultAtOpen: "high_air_demand" }),
    ticket({
      ticketId: "t-silencer",
      openedSimTs: at(180),
      faultAtOpen: "purge_silencer_damaged",
      maxLevel: "review",
    }),
    ticket({ ticketId: "t-demand", openedSimTs: at(200), faultAtOpen: "high_air_demand" }),
    ticket({ ticketId: "t-purge", openedSimTs: at(300), faultAtOpen: "dryer_purge_leak" }),
  ];
  const decisions = [
    decision({ decisionId: "d1", simTs: at(180), choice: "purge_silencer_damaged" }),
    decision({ decisionId: "d2", simTs: at(300), choice: "dryer_purge_leak" }),
    decision({ decisionId: "d3", simTs: at(420), choice: "none_of_these" }),
    decision({ decisionId: "d4", simTs: at(650), choice: "dryer_purge_leak" }),
  ];
  const reading = designReading(input({ tickets, decisions }));

  it("reads the first review item inside the episode against the target", () => {
    expect(reading.review).toMatchObject({
      level: "review",
      onTarget: 1,
      offTarget: 1,
      benign: 1,
      outside: 1,
      met: false,
    });
    expect(reading.review.first?.ticketId).toBe("t-silencer");
  });

  it("reads the first ticket-level ticket apart, where a review item does not take part", () => {
    expect(reading.ticket).toMatchObject({ onTarget: 1, offTarget: 0, benign: 1, met: false });
    expect(reading.ticket.first?.ticketId).toBe("t-demand");
  });

  it("counts the decisions inside the episode by choice, an abstention never on target", () => {
    expect(reading.decisions).toEqual({
      total: 3,
      onTarget: 1,
      byChoice: { purge_silencer_damaged: 1, dryer_purge_leak: 1, none_of_these: 1 },
    });
  });

  it("is marked never gated and names the target it read", () => {
    expect(reading.gated).toBe(false);
    expect(reading.target).toEqual(TARGET);
    expect(reading.episodes).toEqual([{ from: at(120), to: at(600) }]);
  });

  it("meets the target when the first item inside the episode names an accepted cause", () => {
    const met = designReading(
      input({
        tickets: [
          ticket({ ticketId: "t1", openedSimTs: at(130), faultAtOpen: "downstream_air_leak" }),
        ],
      }),
    );
    expect(met.review.met).toBe(true);
    expect(met.ticket.met).toBe(true);
  });

  it("reads nothing inside when nothing opened there", () => {
    const empty = designReading(input());
    expect(empty.review).toEqual({
      level: "review",
      onTarget: 0,
      offTarget: 0,
      benign: 0,
      outside: 0,
      met: false,
    });
  });
});

describe("the scorer never reads a design target", () => {
  it("scores a design case exactly as it would without one: its episode stays excluded", () => {
    // A binding has no field for a design target, so the scorer cannot read one; this pins that
    // the tickets inside the episode stay ignored, never a true or a false positive.
    const binding: ScenarioBinding = {
      id: "unlabelled_leak_may19",
      group: "diagnostic",
      split: "dev",
      positive: true,
      replay: { from: at(0), to: at(900) },
      warmupMin: 60,
      windows: [],
      excluded: [EPISODE],
      benignFaultIds: new Set(),
      expect: { tickets: "at_least_one", fault: "any", maxFalseTickets: 0, passLevel: "detection" },
    };
    const onTarget = [
      ticket({ ticketId: "t1", openedSimTs: at(300), faultAtOpen: "dryer_purge_leak" }),
    ];
    const metrics = scoreScenario(binding, onTarget, [], [], TEST_PRICES, {
      backend: "rules",
      suspects: [suspect({ eventId: "s1", simTs: at(290) })],
    });
    expect(metrics.match.review.ignored.map((entry) => entry.ticketId)).toEqual(["t1"]);
    expect(metrics.match.review.tp).toEqual([]);
    expect(metrics.match.review.fp).toEqual([]);
    expect(metrics.pass).toMatchObject({ detection: false, reviewDiagnosis: false });
    expect(Object.keys(binding)).not.toContain("designTarget");
  });
});
