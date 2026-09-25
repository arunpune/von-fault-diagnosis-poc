// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rules twin's calibration on the manual's catalog.
 *
 * `index.test.ts` keeps the calibration on the twelve hand-made causes of
 * the shared fixture, which other suites rest on. This file asks the same
 * question of the manual's own 39 causes (`test/fixtures/catalog/man`) and of
 * events the real detector raised over synthetic frames written from the
 * manual and machine.yaml (`test/fixtures/synthetic/calibration.ts`).
 *
 * The candidates are the causes the manual files under the event's condition,
 * plus the benign cause that matches the event best when it is not already
 * among them (retrieval always keeps one benign entry), so the table
 * measures the twin and the matcher, not retrieval.
 *
 * The cases are the calibration's and the manual's:
 *
 * - signature-A-like and oil-cooler-like events, in every machine state, reach
 *   at least review on the matching cause;
 * - baseline, depot and a hot room end at `log` or on a benign cause;
 * - the same oil-cooler evidence has the same leader in every machine state;
 * - before the low-pressure switch closes a leak and a busy plant cannot be
 *   told apart from one event, so the twin does not commit to the leak;
 * - after the switch closes, today's decision is recorded as it is.
 *
 * A case that fails today is an `it.fails` whose title names what goes wrong
 * and the change expected to fix it — per-phase evidence, or the onset of a
 * movement and how resting states score — so the suite stays green.
 * Vitest turns an `it.fails` red the moment its assertion passes: the change
 * that makes it pass flips it to `it`, and nothing else may. No expectation
 * here was weakened to pass, and nothing was tuned to make one fail: the
 * frames follow the manual, and the figures in the titles are what the twin
 * does with them today.
 */

import { SIGNALS, isValid, type CatalogEntry, type SuspectEvent } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  asCandidates,
  benignCauses,
  causesUnder,
  manEntry,
} from "../../../test/fixtures/catalog/man/index.ts";
import {
  baselineBusierHour,
  coldNightOilCooler,
  depot,
  downstreamLeak,
  hotRoom,
  oilCoolerByMode,
  referenceOperationEvents,
  signatureA,
  type CalibrationEvent,
  type RunningMode,
} from "../../../test/fixtures/synthetic/calibration.ts";
import { REGISTRY } from "../../detection/index.ts";
import { gate, type GateConfig, type GateOutcome } from "../../gate/index.ts";
import { matchContextOf, observedFromEvent, scoreSignalMoves } from "../../retrieval/match.ts";
import type { DecisionOutput } from "../types.ts";
import { createRulesBackend } from "./index.ts";

/** The default gate thresholds, which the calibration is stated against. */
const GATE: GateConfig = { ticketMin: 0.85, reviewMin: 0.6 };

const twin = createRulesBackend({
  severityHints: Object.fromEntries(REGISTRY.map((rule) => [rule.id, rule.severity_hint])),
  labels: Object.fromEntries(SIGNALS.map((signal) => [signal.tag, signal.name])),
  now: () => 0,
});

const SIGNATURE_A = signatureA();
const DOWNSTREAM = downstreamLeak();
const OIL_COOLER = oilCoolerByMode();
const COLD_NIGHT = coldNightOilCooler();
const HOT_ROOM = hotRoom();
const BASELINE = baselineBusierHour();
const DEPOT = depot();

const MODES: readonly RunningMode[] = ["off", "unloaded", "loaded"];

const EVERY_EVENT: readonly CalibrationEvent[] = [
  SIGNATURE_A,
  DOWNSTREAM.beforeSwitch,
  DOWNSTREAM.afterSwitch,
  ...MODES.map((mode) => OIL_COOLER[mode]),
  COLD_NIGHT,
  HOT_ROOM,
  BASELINE,
  DEPOT,
];

/**
 * The benign cause that matches the event best on the signal moves, as stage 1
 * of retrieval scores it; ties keep the catalog's order.
 */
function bestBenign(event: SuspectEvent): CatalogEntry | undefined {
  const observed = observedFromEvent(event.observations);
  const context = matchContextOf(event);
  let best: { entry: CatalogEntry; score: number } | undefined;
  for (const entry of benignCauses()) {
    const { score } = scoreSignalMoves(observed, entry.signal_moves, context);
    if (best === undefined || score > best.score) best = { entry, score };
  }
  return best?.entry;
}

/** The causes filed under the event's condition, plus the best benign cause. */
function candidateCauses(event: SuspectEvent): CatalogEntry[] {
  const filed = causesUnder(event.symptom_key);
  const benign = bestBenign(event);
  if (benign === undefined || filed.some((entry) => entry.fault_id === benign.fault_id)) {
    return filed;
  }
  return [...filed, benign];
}

async function decide(calibration: CalibrationEvent): Promise<DecisionOutput> {
  const { event } = calibration;
  return twin.decide({
    event,
    candidates: asCandidates(candidateCauses(event)),
    unit_id: event.unit_id,
  });
}

function outcomeOf(output: DecisionOutput): GateOutcome {
  return gate(output, GATE).outcome;
}

/** The candidates sharing the best support, by fault id. */
function leaders(output: DecisionOutput): string[] {
  const supports = Object.entries(output.support).map(([id, value]) => [id, value ?? 0] as const);
  const best = Math.max(...supports.map(([, value]) => value));
  return supports
    .filter(([, value]) => value === best)
    .map(([id]) => id)
    .sort();
}

/** The positive expectation: at least review, on the cause the frames were written from. */
function expectReviewOn(output: DecisionOutput, faultId: string): void {
  expect(output.choice).toBe(faultId);
  expect(outcomeOf(output)).not.toBe("log");
}

/** The negative expectation: only logged, or decided on a benign cause. */
function expectLogOrBenign(output: DecisionOutput): void {
  const benign = output.choice !== "none_of_these" && manEntry(output.choice).benign;
  expect(outcomeOf(output) === "log" || benign, `${output.choice} at ${outcomeOf(output)}`).toBe(
    true,
  );
}

function observation(calibration: CalibrationEvent, signal: string) {
  const found = calibration.event.observations.find((candidate) => candidate.signal === signal);
  if (found === undefined) throw new Error(`${calibration.name}: no ${signal} observation`);
  return found;
}

describe("the calibration events are detection-shaped", () => {
  it("never puts the reference operation in front of the twin: detection raises nothing", () => {
    expect(referenceOperationEvents()).toEqual([]);
  });

  it("are valid suspect events, each with a candidate list from the manual's catalog", () => {
    for (const calibration of EVERY_EVENT) {
      expect(isValid("suspect-event", calibration.event), calibration.name).toBe(true);
      expect(candidateCauses(calibration.event).length, calibration.name).toBeGreaterThan(2);
    }
  });

  it("show signature A: purge line high while loaded, no cut-out, a long run, low current", () => {
    expect(SIGNATURE_A.event.symptom_key).toBe("continuous_load");
    expect(SIGNATURE_A.event.co_symptoms).toContain("purge_pressure_high");
    expect(SIGNATURE_A.event.machine_state.mode).toBe("loaded");
    expect(observation(SIGNATURE_A, "dryer_purge_pressure").level).toBe("far_above");
    expect(observation(SIGNATURE_A, "cut_out_reached").level).toBe("far_below");
    expect(observation(SIGNATURE_A, "loaded_run_duration").level).toBe("far_above");
    expect(observation(SIGNATURE_A, "motor_current").level).toBe("below");
    expect(observation(SIGNATURE_A, "low_pressure_switch").level).toBe("normal");
  });

  it("show the leak before the switch: faster decay, more cycles, the switch still open", () => {
    const before = DOWNSTREAM.beforeSwitch;
    expect(before.event.rule_ids).not.toContain("low_pressure_switch");
    expect(observation(before, "unloaded_pressure_decay").level).toBe("far_above");
    expect(observation(before, "load_cycle_rate").level).toBe("far_above");
    expect(observation(before, "low_pressure_switch").level).toBe("normal");
  });

  it("show the leak after the switch: the line sinking while loaded, the switch closed", () => {
    const after = DOWNSTREAM.afterSwitch;
    expect(after.event.symptom_key).toBe("low_line_pressure");
    expect(after.event.rule_ids).toContain("low_pressure_switch");
    expect(after.event.machine_state.mode).toBe("loaded");
    expect(observation(after, "line_pressure")).toMatchObject({ level: "far_below" });
    expect(observation(after, "low_pressure_switch").level).toBe("far_above");
  });

  it.each(MODES)("show the fouled cooler while %s: hot oil, the usual room and duty", (mode) => {
    const cooler = OIL_COOLER[mode];
    expect(cooler.event.symptom_key).toBe("oil_temperature_high");
    expect(cooler.event.machine_state.mode).toBe(mode);
    expect(cooler.event.ambient).toBe("mild");
    expect(observation(cooler, "oil_temperature").level).toBe("far_above");
    expect(observation(cooler, "ambient_temperature")).toMatchObject({
      level: "normal",
      trend: "flat",
    });
    expect(observation(cooler, "load_cycle_rate").level).toBe("normal");
  });

  it("show the same cooler on a cold night: only the room differs", () => {
    expect(COLD_NIGHT.event.machine_state.mode).toBe("off");
    expect(COLD_NIGHT.event.ambient).toBe("cold");
    expect(observation(COLD_NIGHT, "oil_temperature").level).toBe("far_above");
    expect(observation(COLD_NIGHT, "ambient_temperature").level).toBe("below");
  });

  it("show a hot room: the cooling air and the oil both far above, the duty unchanged", () => {
    expect(HOT_ROOM.event.symptom_key).toBe("oil_temperature_high");
    expect(HOT_ROOM.event.ambient).toBe("hot");
    expect(observation(HOT_ROOM, "ambient_temperature").level).toBe("far_above");
    expect(observation(HOT_ROOM, "oil_temperature").level).toBe("far_above");
    expect(observation(HOT_ROOM, "load_cycle_rate").level).toBe("normal");
  });

  it("show the baseline hour: one rule at its threshold and nothing else", () => {
    expect(BASELINE.event.rule_ids).toEqual(["frequent_cycling"]);
    expect(BASELINE.event.co_symptoms).toEqual([]);
  });

  it("show the depot: the switch closed with the motor running against an emptied line", () => {
    expect(DEPOT.event.rule_ids).toEqual(["low_pressure_switch"]);
    expect(DEPOT.event.machine_state.mode).not.toBe("off");
    expect(observation(DEPOT, "line_pressure").level).toBe("far_below");
    expect(observation(DEPOT, "low_pressure_switch").level).toBe("far_above");
  });
});

describe("the calibration on the manual's catalog: at least review on the matching cause", () => {
  // Today intake_filter_clogged leads 1.000 (review, wrong cause): its three
  // moves — motor current low, slower rise, longer runs — all show, while
  // dryer_purge_leak reaches 0.667 because its low-pressure switch `stays_off`
  // rests silent and its gradual oil rise has not shown yet. The
  // manual separates the two by onset and by the resting switch.
  it.fails(
    "signature A reaches review on dryer_purge_leak — fails: intake_filter_clogged 1.000 leads; fix: movement onset and resting-state scoring",
    async () => {
      expectReviewOn(await decide(SIGNATURE_A), "dryer_purge_leak");
    },
  );

  // Today, stopped and idling, oil_cooler_fouled, cooling_fan_failure and
  // oil_filter_clogged tie at 1.000 (confidence 0, log): they share oil
  // `rises`, `load_cycle_rate unchanged` and `motor_current unchanged`, and the
  // manual separates them by phase (the fan fails under load) and onset
  // (sudden, gradual), which the matcher does not read yet.
  it.fails.each(["off", "unloaded"] as const)(
    "the oil cooler while %s reaches review on oil_cooler_fouled — fails: three-way tie at 1.000; fix: per-phase evidence and movement onset",
    async (mode) => {
      expectReviewOn(await decide(OIL_COOLER[mode]), "oil_cooler_fouled");
    },
  );

  // Today, loaded, four causes tie at 0.625: the five-minute motor-current
  // trend still carries the cut-in, so it reads rising and contradicts every
  // `motor_current unchanged` (and matches wrong_oil_grade's `rises`). A
  // loaded-phase move judged on per-phase evidence would not see the step.
  it.fails(
    "the oil cooler while loaded reaches review on oil_cooler_fouled — fails: four-way tie at 0.625; fix: per-phase evidence, then movement onset",
    async () => {
      expectReviewOn(await decide(OIL_COOLER.loaded), "oil_cooler_fouled");
    },
  );

  // Today the ambient reads below normal under the fixed cold < 10 °C word
  // boundary, which contradicts `ambient_temperature unchanged` for the
  // cooler and the fan, and oil_filter_clogged — which names no ambient move —
  // leads alone at 1.000 and reaches the ticket threshold on the wrong cause.
  it.fails(
    "the cold-night oil cooler reaches review on oil_cooler_fouled — fails: ambient reads below normal, oil_filter_clogged tickets; fix: a relative ambient, then movement onset",
    async () => {
      expectReviewOn(await decide(COLD_NIGHT), "oil_cooler_fouled");
    },
  );
});

describe("the calibration on the manual's catalog: the same evidence, the same leader", () => {
  // Today stopped and idling share the leaders {cooling_fan_failure,
  // oil_cooler_fouled, oil_filter_clogged}; loaded they are
  // {cooling_fan_failure, oil_cooler_fouled, thermostatic_valve_stuck,
  // wrong_oil_grade}, because the state the event falls in decides which
  // evidence a loaded-phase move is judged on.
  it.fails(
    "the oil-cooler evidence has the same leader in every state — fails: the loaded picture differs; fix: per-phase evidence",
    async () => {
      const [off, unloaded, loaded] = await Promise.all(
        MODES.map(async (mode) => leaders(await decide(OIL_COOLER[mode]))),
      );
      expect(unloaded).toEqual(off);
      expect(loaded).toEqual(off);
    },
  );
});

describe("the calibration on the manual's catalog: only logged, or on a benign cause", () => {
  it("the baseline hour", async () => {
    expectLogOrBenign(await decide(BASELINE));
  });

  it("the depot", async () => {
    expectLogOrBenign(await decide(DEPOT));
  });

  it("the hot room", async () => {
    expectLogOrBenign(await decide(HOT_ROOM));
  });

  // The manual tells a leak from a busy plant by the time pattern — the loss
  // runs at night and at the weekend — which one event cannot show;
  // committing to the leak here would be a guess.
  it("the leak before the switch closes, where a busy plant looks the same", async () => {
    expectLogOrBenign(await decide(DOWNSTREAM.beforeSwitch));
  });
});

describe("the calibration on the manual's catalog: recorded as it is today", () => {
  // No calibration expectation covers this case; it records today's decision so a
  // change that moves it is seen. On these frames the recent cycles still show
  // the faster decay and the higher rate when the switch closes, so every one
  // of downstream_air_leak's six moves matches; high_air_demand and
  // intake_filter_clogged trail it. A change that moves these figures
  // updates them and says so.
  it("the leak after the switch closes: downstream_air_leak 1.000 over high_air_demand 0.800, review", async () => {
    const output = await decide(DOWNSTREAM.afterSwitch);
    expect(leaders(output)).toEqual(["downstream_air_leak"]);
    expect(output.support["downstream_air_leak"]).toBeCloseTo(1, 10);
    expect(output.support["high_air_demand"]).toBeCloseTo(0.8, 10);
    expect(output.support["intake_filter_clogged"]).toBeCloseTo(2 / 3, 10);
    expect(output.choice).toBe("downstream_air_leak");
    expect(outcomeOf(output)).toBe("review");
  });
});
