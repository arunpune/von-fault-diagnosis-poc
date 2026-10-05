// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario pass rules and the core-10 gate, with detection level read on
// suspect events.
//
// The case that matters most is the last one: a backend that never opens a
// ticket passes all four negatives and abstain cases of the core-10 and must
// still fail, because the gate asks for ≥ 5 of the 6 positives as well as ≥ 8
// of the 10 scenarios.

import { describe, expect, it } from "vitest";

import {
  CORE_10_POSITIVE_SCENARIO_IDS,
  CORE_10_SCENARIO_IDS,
  coreGate,
  scoreScenario,
  summarise,
} from "./summary.ts";
import { TEST_PRICES, at, decision, excluded, suspect, ticket, window } from "./fixtures.ts";
import type { ScenarioBinding, ScenarioMetrics, SuspectRecord } from "./types.ts";

const WINDOW = window({
  id: "W",
  from: at(120),
  to: at(480),
  leadFrom: at(120),
  accepted: ["air_leak_downstream"],
  onset: at(120),
});

function positiveBinding(overrides: Partial<ScenarioBinding> = {}): ScenarioBinding {
  return {
    id: "f3_air_leak_jun05",
    group: "recording_positive",
    split: "test",
    replay: { from: at(0), to: at(1440) },
    warmupMin: 60,
    windows: [WINDOW],
    excluded: [],
    benignFaultIds: new Set(["high_ambient_temperature"]),
    expect: {
      tickets: "at_least_one",
      fault: "accepted",
      withinMin: 120,
      maxFalseTickets: 0,
      passLevel: "diagnosis",
    },
    ...overrides,
  };
}

function score(
  binding: ScenarioBinding,
  tickets: Parameters<typeof scoreScenario>[1],
  suspects: readonly SuspectRecord[] = [],
) {
  return scoreScenario(binding, tickets, [], [], TEST_PRICES, { backend: "rules", suspects });
}

/** A suspect event at `minutes` after the epoch. */
function raised(eventId: string, minutes: number | Date): SuspectRecord {
  return suspect({ eventId, simTs: minutes instanceof Date ? minutes : at(minutes) });
}

describe("scoreScenario", () => {
  it("passes every level when detection fired in time and the first ticket is correct and in time", () => {
    const result = score(
      positiveBinding(),
      [ticket({ ticketId: "t1", openedSimTs: at(150) })],
      [raised("s1", 130)],
    );
    expect(result.pass).toEqual({
      detection: true,
      reviewDiagnosis: true,
      diagnosis: true,
      reasons: [],
    });
  });

  it("diagnoses at review level but not at diagnosis level when a wrong ticket came first", () => {
    const result = score(
      positiveBinding({ expect: { ...positiveBinding().expect, maxFalseTickets: 1 } }),
      [
        ticket({ ticketId: "t1", openedSimTs: at(150), faultAtOpen: "oil_cooler_fouling" }),
        ticket({ ticketId: "t2", openedSimTs: at(180) }),
      ],
      [raised("s1", 140)],
    );

    expect(result.pass.detection).toBe(true);
    expect(result.pass.reviewDiagnosis).toBe(true);
    expect(result.pass.diagnosis).toBe(false);
    expect(result.match.ticket.recovered).toHaveLength(1);
  });

  it("fails review diagnosis when the budget ran out before the first correct ticket", () => {
    const result = score(
      positiveBinding(),
      [ticket({ ticketId: "t1", openedSimTs: at(260) })],
      [raised("s1", 130)],
    );
    expect(result.pass.detection).toBe(true);
    expect(result.pass.reviewDiagnosis).toBe(false);
    expect(result.pass.reasons).toEqual([
      "review diagnosis: the first true positive opened after the budget ended at 2020-02-03T04:00:00.000Z",
    ]);
  });

  it("starts the budget at the end of the warmup when the onset is earlier", () => {
    const early = positiveBinding({
      windows: [window({ ...WINDOW, from: at(0), leadFrom: at(0), onset: at(0) })],
      warmupMin: 120,
    });
    // Warmup ends at 120, so the budget runs to 240 even though the onset was at 0.
    const result = score(
      early,
      [ticket({ ticketId: "t1", openedSimTs: at(200) })],
      [raised("s1", 230)],
    );
    expect(result.pass.detection).toBe(true);
    expect(result.pass.reviewDiagnosis).toBe(true);
    expect(result.detection.windows[0]?.deadline).toEqual(at(240));
  });

  describe("detection level: suspect events, not tickets", () => {
    it("passes a positive on a suspect event in its span within the budget, with no ticket at all", () => {
      const result = score(positiveBinding(), [], [raised("s1", 125)]);
      expect(result.pass.detection).toBe(true);
      expect(result.pass.reviewDiagnosis).toBe(false);
      expect(result.pass.diagnosis).toBe(false);
      expect(result.detection).toEqual({
        suspects: 1,
        warmupSuspects: 0,
        outsideWindows: 0,
        windows: [
          {
            windowId: "W",
            headline: false,
            first: raised("s1", 125),
            deadline: at(240),
            detected: true,
          },
        ],
      });
    });

    it("never reads a ticket: a correct ticket without a suspect event does not detect", () => {
      const result = score(positiveBinding(), [ticket({ ticketId: "t1", openedSimTs: at(150) })]);
      expect(result.pass.detection).toBe(false);
      expect(result.pass.reviewDiagnosis).toBe(true);
      expect(result.pass.reasons).toEqual([
        "detection: no suspect event after the warmup in the credited span of a positive window",
      ]);
    });

    it("fails a positive whose first suspect event in the span came after the budget", () => {
      const result = score(positiveBinding(), [], [raised("late", 260)]);
      expect(result.detection.windows[0]).toMatchObject({ detected: false, deadline: at(240) });
      expect(result.pass.detection).toBe(false);
      expect(result.pass.reasons[0]).toBe(
        "detection: the first suspect event in the span, at 2020-02-03T04:20:00.000Z, came after the budget ended at 2020-02-03T04:00:00.000Z",
      );
    });

    it("counts the budget's last instant in time, as it does for a ticket", () => {
      expect(score(positiveBinding(), [], [raised("edge", 240)]).pass.detection).toBe(true);
    });

    it("does not count a suspect event before the span, in the warmup or after the window", () => {
      const result = score(
        positiveBinding(),
        [],
        [raised("warm", 30), raised("before", 100), raised("after", 480)],
      );
      expect(result.pass.detection).toBe(false);
      expect(result.detection).toMatchObject({
        suspects: 2,
        warmupSuspects: 1,
        outsideWindows: 2,
      });
    });

    it("credits a suspect event between a known onset and the labelled start (the credited span)", () => {
      const onset = new Date(at(108).getTime() + 30_000);
      const binding = positiveBinding({
        windows: [window({ ...WINDOW, onset })],
        warmupMin: 0,
      });
      const early = score(binding, [], [raised("s1", new Date(onset.getTime() + 2 * 60_000))]);
      expect(early.pass.detection).toBe(true);
      const tooEarly = score(binding, [], [raised("s0", new Date(onset.getTime() - 60_000))]);
      expect(tooEarly.pass.detection).toBe(false);
    });

    it("passes a positive when any of its windows is detected in time", () => {
      const second = window({ id: "W2", from: at(600), to: at(700), onset: at(600) });
      const binding = positiveBinding({
        windows: [WINDOW, second],
        expect: {
          tickets: "at_least_one",
          fault: "accepted",
          maxFalseTickets: 0,
          passLevel: "diagnosis",
        },
      });
      const result = score(binding, [], [raised("s2", 650)]);
      expect(result.detection.windows.map((entry) => entry.detected)).toEqual([false, true]);
      expect(result.pass.detection).toBe(true);
    });

    it("fails a normal-operation negative on one suspect event after the warmup", () => {
      const negative = positiveBinding({
        id: "baseline_feb03_normal",
        group: "negative",
        windows: [],
        expect: { tickets: "none", fault: "any", maxFalseTickets: 0, passLevel: "detection" },
      });
      const quiet = score(negative, []);
      expect(quiet.pass).toMatchObject({ detection: true, reviewDiagnosis: true });

      const raising = score(negative, [], [raised("s1", 300)]);
      expect(raising.pass.detection).toBe(false);
      expect(raising.pass.reviewDiagnosis).toBe(true);
      expect(raising.pass.reasons).toEqual([
        "detection: 1 suspect event(s) in a normal-operation case that expects none",
      ]);
    });

    it("leaves a negative's warmup and excluded-window suspect events to the E3 check", () => {
      const negative = positiveBinding({
        id: "frozen_logger_jun22",
        group: "negative",
        windows: [],
        excluded: [excluded({ id: "frozen", from: at(400), to: at(500), reason: "frozen_logger" })],
        expect: { tickets: "none", fault: "any", maxFalseTickets: 0, passLevel: "detection" },
      });
      const result = score(negative, [], [raised("warm", 30), raised("frozen", 450)]);
      expect(result.pass.detection).toBe(true);
      expect(result.detection).toMatchObject({
        suspects: 1,
        warmupSuspects: 1,
        outsideWindows: 0,
      });
    });

    it("keeps the ticket rule for an abstain case, whatever detection raised", () => {
      const abstain = positiveBinding({
        id: "inject_high_ambient_benign",
        group: "abstain",
        windows: [
          window({ id: "hot", from: at(120), to: at(480), benign: true, accepted: ["hot"] }),
        ],
        benignFaultIds: new Set(["high_ambient_temperature"]),
        expect: {
          tickets: "none",
          fault: "benign_or_none",
          maxFalseTickets: 0,
          passLevel: "diagnosis",
        },
      });
      const benign = score(
        abstain,
        [ticket({ ticketId: "b1", openedSimTs: at(200), faultAtOpen: "high_ambient_temperature" })],
        [raised("s1", 150), raised("s2", 190)],
      );
      expect(benign.pass).toMatchObject({ detection: true, reviewDiagnosis: true });

      const wrong = score(
        abstain,
        [ticket({ ticketId: "t1", openedSimTs: at(200), faultAtOpen: "oil_cooler_fouled" })],
        [raised("s1", 150)],
      );
      expect(wrong.pass).toMatchObject({ detection: false, reviewDiagnosis: false });
      expect(wrong.pass.reasons).toEqual([
        "detection: 1 non-benign ticket(s) in a case that expects none",
        "review diagnosis: 1 non-benign ticket(s) in a case that expects none",
      ]);
    });

    it("fails a positive with no window to detect in", () => {
      const result = score(positiveBinding({ windows: [] }), [], [raised("s1", 150)]);
      expect(result.pass.detection).toBe(false);
      expect(result.pass.reasons[0]).toBe("detection: no positive window to detect in");
    });
  });

  describe("a known onset before the labelled start", () => {
    // F3's shape: labelled start at 120, the data turning at 108.5, no precursor. The budget
    // already runs from the onset; the span now opens there too.
    const onset = new Date(at(108).getTime() + 30_000);
    const binding = positiveBinding({
      windows: [window({ ...WINDOW, onset })],
      warmupMin: 0,
    });

    it("scores a correct ticket at onset + 2 min as a true positive, and passes", () => {
      const opened = new Date(onset.getTime() + 2 * 60_000);
      const result = score(
        binding,
        [ticket({ ticketId: "t1", openedSimTs: opened })],
        [raised("s1", opened)],
      );
      expect(result.match.ticket.tp.map((match) => match.ticket.ticketId)).toEqual(["t1"]);
      expect(result.pass).toEqual({
        detection: true,
        reviewDiagnosis: true,
        diagnosis: true,
        reasons: [],
      });
      expect(result.leadTimes[0]?.latencyMinutes).toBe(2);
    });

    it("still scores a correct ticket at onset − 1 min as a false positive", () => {
      const opened = new Date(onset.getTime() - 60_000);
      const result = score(binding, [ticket({ ticketId: "t1", openedSimTs: opened })]);
      expect(result.match.review.fp.map((entry) => entry.ticketId)).toEqual(["t1"]);
      expect(result.match.review.fn.map((entry) => entry.id)).toEqual(["W"]);
      expect(result.pass.reviewDiagnosis).toBe(false);
    });

    // A consequence of the span, not a credit: the diagnosis rule's "first ticket inside the
    // window" reads the same span, so a benign ticket-level ticket opened in [onset, start)
    // is now that first ticket and fails diagnosis, although a correct ticket follows after
    // the start. Before the span moved to the onset the benign ticket sat outside the window and
    // the scenario passed. Whether benign tickets in [onset, start) should be left out of that
    // rule is an open question; this pins today's behaviour.
    it("fails diagnosis when a benign ticket at onset + 2 min precedes a correct one", () => {
      const benign = new Date(onset.getTime() + 2 * 60_000);
      const result = score(
        binding,
        [
          ticket({ ticketId: "b1", openedSimTs: benign, faultAtOpen: "high_ambient_temperature" }),
          ticket({ ticketId: "t1", openedSimTs: at(125) }),
        ],
        [raised("s1", benign)],
      );
      expect(result.match.ticket.benign.map((entry) => entry.ticketId)).toEqual(["b1"]);
      expect(result.match.ticket.tp.map((match) => match.ticket.ticketId)).toEqual(["t1"]);
      expect(result.pass).toEqual({
        detection: true,
        reviewDiagnosis: true,
        diagnosis: false,
        reasons: [
          "diagnosis: the first ticket in the window names high_ambient_temperature, which is not accepted",
        ],
      });
    });

    it("still passes when the same benign ticket opens at onset − 1 min, outside the span", () => {
      const benign = new Date(onset.getTime() - 60_000);
      const result = score(
        binding,
        [
          ticket({ ticketId: "b1", openedSimTs: benign, faultAtOpen: "high_ambient_temperature" }),
          ticket({ ticketId: "t1", openedSimTs: at(125) }),
        ],
        [raised("s1", at(124))],
      );
      expect(result.pass).toEqual({
        detection: true,
        reviewDiagnosis: true,
        diagnosis: true,
        reasons: [],
      });
    });
  });

  it("replays but does not score a ticket opened inside the warmup", () => {
    const result = score(positiveBinding(), [
      ticket({ ticketId: "warm", openedSimTs: at(30), faultAtOpen: "motor_overload" }),
      ticket({ ticketId: "t1", openedSimTs: at(150) }),
    ]);

    expect(result.warmupTickets.map((entry) => entry.ticketId)).toEqual(["warm"]);
    expect(result.tickets.map((entry) => entry.ticketId)).toEqual(["t1"]);
    expect(result.pass.reviewDiagnosis).toBe(true);
  });

  it("fails a negative's review diagnosis with one non-benign ticket and passes it with a benign one", () => {
    const negative = positiveBinding({
      id: "baseline_feb03_normal",
      group: "negative",
      windows: [],
      expect: {
        tickets: "none",
        fault: "any",
        maxFalseTickets: 0,
        passLevel: "detection",
      },
    });

    const wrong = score(negative, [
      ticket({ ticketId: "t1", openedSimTs: at(300), faultAtOpen: "air_leak_downstream" }),
    ]);
    expect(wrong.pass).toMatchObject({ reviewDiagnosis: false, diagnosis: false });

    const benign = score(negative, [
      ticket({ ticketId: "t1", openedSimTs: at(300), faultAtOpen: "high_ambient_temperature" }),
    ]);
    expect(benign.pass).toMatchObject({ reviewDiagnosis: true, diagnosis: true });
  });

  it("judges an abstain case and reports its abstention result", () => {
    const abstain = positiveBinding({
      id: "depot_lps_jul31",
      group: "abstain",
      windows: [
        window({ id: "depot", from: at(120), to: at(180), benign: true, accepted: ["depot"] }),
      ],
      benignFaultIds: new Set(["depot"]),
      expect: {
        tickets: "none",
        fault: "benign_or_none",
        maxFalseTickets: 0,
        passLevel: "detection",
      },
    });

    const result = scoreScenario(
      abstain,
      [ticket({ ticketId: "t1", openedSimTs: at(150), faultAtOpen: "depot", maxLevel: "review" })],
      [
        decision({
          decisionId: "d1",
          simTs: at(150),
          choice: "depot",
          gate: "review",
          benignChoice: true,
        }),
      ],
      [],
      TEST_PRICES,
      { backend: "rules" },
    );

    expect(result.abstention).toMatchObject({ correct: 1, total: 1, accuracy: 1 });
    expect(result.pass.detection).toBe(true);
  });

  it("leaves abstention null outside an abstain case", () => {
    expect(score(positiveBinding(), []).abstention).toBeNull();
  });

  it("marks a recording positive and a negative correctly", () => {
    expect(score(positiveBinding(), []).positive).toBe(true);
    expect(score(positiveBinding({ group: "negative" }), []).positive).toBe(false);
    expect(score(positiveBinding({ group: "negative", positive: true }), []).positive).toBe(true);
  });
});

/** A scored scenario with only the fields the gate reads. */
function scored(id: string, backend: string, pass: boolean): ScenarioMetrics {
  const positive = CORE_10_POSITIVE_SCENARIO_IDS.includes(id);
  const binding = positiveBinding({
    id,
    group: positive ? "recording_positive" : "negative",
    windows: positive ? [WINDOW] : [],
    expect: positive
      ? positiveBinding().expect
      : { tickets: "none", fault: "any", maxFalseTickets: 0, passLevel: "detection" },
  });
  const tickets = positive && pass ? [ticket({ ticketId: `t-${id}`, openedSimTs: at(150) })] : [];
  const failing =
    !positive && !pass
      ? [ticket({ ticketId: `t-${id}`, openedSimTs: at(300), faultAtOpen: "motor_overload" })]
      : [];

  return scoreScenario(binding, [...tickets, ...failing], [], [], TEST_PRICES, { backend });
}

describe("coreGate", () => {
  it("passes at 8 of 10 with 5 of 6 positives", () => {
    const failing = new Set(["inject_air_leak_downstream", "depot_lps_jul31"]);
    const metrics = CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", !failing.has(id)));
    const result = coreGate(metrics, "rules", "diagnosis");

    expect(result).toMatchObject({ passed: 8, positivesPassed: 5, pass: true });
  });

  it("fails at 7 of 10", () => {
    const failing = new Set([
      "inject_air_leak_downstream",
      "depot_lps_jul31",
      "baseline_feb03_normal",
    ]);
    const metrics = CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", !failing.has(id)));
    expect(coreGate(metrics, "rules", "diagnosis").pass).toBe(false);
  });

  it("fails a backend that never opens a ticket, however clean its negatives", () => {
    const metrics = CORE_10_SCENARIO_IDS.map((id) =>
      scored(id, "rules", !CORE_10_POSITIVE_SCENARIO_IDS.includes(id)),
    );
    const result = coreGate(metrics, "rules", "diagnosis");

    expect(result.positivesPassed).toBe(0);
    expect(result.passed).toBe(4);
    expect(result.pass).toBe(false);
    expect(result.failed).toEqual([...CORE_10_POSITIVE_SCENARIO_IDS]);
  });

  it("fails on 8 of 10 with only 4 of 6 positives", () => {
    // Two positives fail and every negative passes: eight of ten, but four of six.
    const failing = new Set(["f1_air_leak_apr18", "f2_air_leak_may30"]);
    const metrics = CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", !failing.has(id)));
    const result = coreGate(metrics, "rules", "diagnosis");

    expect(result).toMatchObject({ passed: 8, positivesPassed: 4, pass: false });
  });

  it("counts a core-10 scenario the run never scored as a failure", () => {
    const metrics = CORE_10_SCENARIO_IDS.slice(0, 9).map((id) => scored(id, "rules", true));
    const result = coreGate(metrics, "rules", "diagnosis");

    expect(result.missing).toEqual(["depot_lps_jul31"]);
    expect(result.passed).toBe(9);
  });

  it("reads each level from its own flag: detection from the suspect events, the baseline from tickets", () => {
    // Every positive ticketed correctly and in time, but detection raised nothing: the ticket
    // levels pass, detection does not — the two readings detection-level E3 keeps apart.
    const metrics = CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", true));
    expect(coreGate(metrics, "rules", "review_diagnosis")).toMatchObject({
      level: "review_diagnosis",
      passed: 10,
      positivesPassed: 6,
      pass: true,
    });
    expect(coreGate(metrics, "rules", "detection")).toMatchObject({
      level: "detection",
      passed: 4,
      positivesPassed: 0,
      pass: false,
    });
  });
});

describe("summarise", () => {
  it("summarises every backend and puts Von's gate in the headline", () => {
    const metrics = [
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", true)),
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "von", true)),
    ];
    const summary = summarise(metrics);

    expect(summary.backends.map((entry) => entry.backend)).toEqual(["von", "rules"]);
    expect(summary.gate.backend).toBe("von");
    expect(summary.gate.pass).toBe(true);
    expect(summary.core10).toEqual(CORE_10_SCENARIO_IDS);
  });

  it("asks the rules baseline for detection and Von for diagnosis by default", () => {
    const metrics = [
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", true)),
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "von", true)),
    ];
    const summary = summarise(metrics);

    expect(summary.backends.find((entry) => entry.backend === "rules")?.gate.level).toBe(
      "detection",
    );
    expect(summary.backends.find((entry) => entry.backend === "von")?.gate.level).toBe("diagnosis");
  });

  it("labels the MetroPT-3 check in-sample", () => {
    const summary = summarise(CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", true)));
    expect(summary.metropt3Check.in_sample).toBe(true);
  });

  it("reads every backend's MetroPT-3 check at detection level beside the ticket one", () => {
    const headline = window({ ...WINDOW, headline: true, id: "F3" });
    const binding = positiveBinding({ windows: [headline] });
    const detected = scoreScenario(binding, [], [], [], TEST_PRICES, {
      backend: "rules",
      suspects: [raised("s1", 130)],
    });
    const summary = summarise([detected]);
    const rules = summary.backends[0];
    expect(rules?.metropt3Detection).toEqual({
      level: "detection",
      detected: ["F3"],
      missed: [],
      pass: true,
      in_sample: true,
    });
    expect(rules?.metropt3Check).toMatchObject({ level: "review", detected: [], missed: ["F3"] });
  });

  it("builds a comparison table with one row per metric", () => {
    const summary = summarise([
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "rules", true)),
      ...CORE_10_SCENARIO_IDS.map((id) => scored(id, "von", false)),
    ]);
    const recall = summary.comparison.find((row) => row.metric === "recall (ticket, micro)");

    expect(recall?.rules).toBe(1);
    expect(recall?.von).toBe(0);
    expect(recall?.delta).toBe(-1);
  });

  it("refuses to summarise nothing", () => {
    expect(() => summarise([])).toThrow(TypeError);
  });
});
