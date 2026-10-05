// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The referential checks JSON Schema cannot express. The fixture harness of `schemas.test.ts`
// proves the six diagnosis and catalog schemas accept and reject the right documents; this file
// proves the accepted ones also add up:
//
//   (a) a decision's probabilities, gate outcome and cost agree with each other,
//   (b) the catalog document's ids and cross-references resolve,
//   (c) a signal move uses a direction its target kind allows.
//
// Every number here is arithmetic the backend performs, so a fixture that drifts from the
// documented formula fails before any consumer is written against it.

import { describe, expect, it } from "vitest";

import type { Catalog, CatalogEntry, Decision, SignalMove } from "../src/generated/types.ts";
import { fixturesFor } from "../src/testing.ts";

/** Absolute tolerance for a probability vector that was rounded for readability. */
const PROBABILITY_EPSILON = 1e-6;

/** Absolute tolerance for the cost, which the ledger stores as numeric(16,10). */
const COST_EPSILON = 1e-12;

/** The severity levels in score order; `score` is the index of `level`. */
const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;

/**
 * The directions each target kind may take.
 *
 * The schema deliberately accepts the union — which directions suit which target is a
 * referential rule, not a shape rule — so the table lives here.
 */
const DIRECTIONS = {
  analog: new Set([
    "rises",
    "falls",
    "high",
    "low",
    "unchanged",
    "fluctuates",
    "near_zero",
    "not_venting",
  ]),
  digital: new Set(["on", "off", "stays_on", "stays_off", "toggles", "no_pulse"]),
  behaviour: new Set([
    "higher",
    "lower",
    "longer",
    "shorter",
    "faster",
    "slower",
    "not_reached",
    "unchanged",
  ]),
} as const;

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function argmaxKey(probabilities: Record<string, number>): string {
  let best = "";
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/** The outcome the confidence gate owes this decision (docs/decision-backends.md#the-gate). */
function expectedOutcome(decision: Decision): "ticket" | "review" | "log" {
  const named = decision.choice !== "none_of_these";
  if (named && decision.confidence >= decision.gate.ticket_min_confidence) return "ticket";
  if (named && decision.confidence >= decision.gate.review_min_confidence) return "review";
  return "log";
}

/** An explicit "no catalog cause fits" is an abstention; genuine uncertainty is not. */
function expectedAbstained(decision: Decision): boolean {
  return (
    decision.choice === "none_of_these" &&
    decision.confidence >= decision.gate.review_min_confidence
  );
}

const decisions = fixturesFor("decision").valid.map((fixture) => ({
  file: fixture.file,
  decision: fixture.data as Decision,
}));

const catalogEntries = fixturesFor("catalog-entry").valid.map((fixture) => ({
  file: fixture.file,
  entry: fixture.data as CatalogEntry,
}));

const catalogs = fixturesFor("catalog").valid.map((fixture) => ({
  file: fixture.file,
  catalog: fixture.data as Catalog,
}));

describe("decision fixtures", () => {
  it("ships the backends, gate outcomes and statuses the pipeline produces", () => {
    expect(decisions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(decisions.map(({ decision }) => decision.backend))).toEqual(
      new Set(["von", "llm", "rules"]),
    );
    expect(new Set(decisions.map(({ decision }) => decision.gate.outcome))).toEqual(
      new Set(["ticket", "review", "log"]),
    );
    expect(new Set(decisions.map(({ decision }) => decision.status))).toEqual(
      new Set(["ok", "failed"]),
    );
  });

  it.each(decisions)("$file has a probability vector over its candidates", ({ decision }) => {
    const keys = Object.keys(decision.probabilities);
    expect(sum(Object.values(decision.probabilities))).toBeCloseTo(1, 6);
    expect(Math.abs(sum(Object.values(decision.probabilities)) - 1)).toBeLessThan(
      PROBABILITY_EPSILON,
    );
    expect(keys).toContain("none_of_these");
    expect(keys).toContain(decision.choice);

    const faultIds = decision.candidates.map((candidate) => candidate.fault_id);
    expect(new Set(faultIds).size).toBe(faultIds.length);
    expect(faultIds.filter((faultId) => !keys.includes(faultId))).toEqual([]);
    expect(Object.keys(decision.support).filter((faultId) => !faultIds.includes(faultId))).toEqual(
      [],
    );
  });

  it.each(decisions)("$file agrees with the confidence gate", ({ decision }) => {
    expect(decision.gate.outcome).toBe(expectedOutcome(decision));
    expect(decision.gate.abstained).toBe(expectedAbstained(decision));
    expect(decision.gate.review_min_confidence).toBeLessThanOrEqual(
      decision.gate.ticket_min_confidence,
    );
  });

  it.each(decisions)("$file prices its own token usage", ({ decision }) => {
    const expected =
      (decision.usage.input_tokens * decision.cost.price_input_per_mtok +
        decision.usage.output_tokens * decision.cost.price_output_per_mtok) /
      1e6;
    expect(Math.abs(decision.cost.usd - expected)).toBeLessThan(COST_EPSILON);
  });

  it.each(decisions)("$file maps its severity score to its severity level", ({ decision }) => {
    const { severity } = decision;
    expect(Math.abs(sum(Object.values(severity.probabilities)) - 1)).toBeLessThan(
      PROBABILITY_EPSILON,
    );
    expect(Number(argmaxKey(severity.probabilities))).toBe(severity.score);
    expect(SEVERITY_LEVELS[severity.score]).toBe(severity.level);
  });

  it("carries the rules backend's gating confidence, not a probability", () => {
    const rules = decisions.find(({ decision }) => decision.backend === "rules");
    expect(rules).toBeDefined();
    if (rules === undefined) return;
    // `confidence = s1 · clamp((s1 − s2) / 0.3, 0, 1)` over the candidate supports
    // (docs/decision-backends.md#why-the-confidence-is-a-margin), so it is independent of how many
    // candidates retrieval returned and is not the top probability.
    const [s1, s2] = [0.72, 0.45];
    const expected = s1 * Math.min(Math.max((s1 - s2) / 0.3, 0), 1);
    expect(rules.decision.confidence).toBeCloseTo(expected, 12);
    expect(rules.decision.model).toBe("rules-v1");
    expect(rules.decision.support).toEqual({});
    expect(rules.decision.confidence).not.toBeCloseTo(
      rules.decision.probabilities[rules.decision.choice] ?? 0,
      3,
    );
  });

  it("keeps a failed call out of the ticket path", () => {
    const failed = decisions.find(({ decision }) => decision.status === "failed");
    expect(failed).toBeDefined();
    if (failed === undefined) return;
    const { decision } = failed;
    expect(decision.error).not.toBeNull();
    expect(decision.choice).toBe("none_of_these");
    expect(decision.confidence).toBe(0);
    expect(decision.candidates).toEqual([]);
    expect(decision.gate.outcome).toBe("log");
    expect(decision.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(decision.cost.usd).toBe(0);
  });
});

/** The miniature document the other fixtures are cut from; also the signal registry below. */
const mini = catalogs.find(({ file }) => file === "valid-mini.json")?.catalog;

describe("catalog/valid-mini.json", () => {
  it("carries the whole signal registry and the CAU-7 machine block", () => {
    expect(mini).toBeDefined();
    if (mini === undefined) return;
    expect(mini.schema).toBe("urn:fdp:schema:catalog:v1");
    expect(mini.machine).toEqual({
      name: "CAU-7 Compressed-Air Unit",
      short_name: "CAU-7",
      controller: "CTRL-7",
    });
    expect(mini.signals).toHaveLength(16);
    expect(mini.signals.filter((signal) => signal.group === "analog")).toHaveLength(7);
    expect(mini.signals.filter((signal) => signal.group === "digital")).toHaveLength(8);
    expect(mini.signals.filter((signal) => signal.group === "extra")).toHaveLength(1);
    expect(mini.conditions).toHaveLength(3);
    expect(mini.causes).toHaveLength(3);
    expect(mini.alarms).toHaveLength(3);
    expect(mini.maintenance).toHaveLength(2);
    expect(mini.parameters).toHaveLength(2);
  });
});

describe.each(catalogs)("$file", ({ catalog }) => {
  const faultIds = catalog.causes.map((cause) => cause.fault_id);
  const conditionIds = catalog.conditions.map((condition) => condition.id);
  const alarmCodes = new Set(catalog.alarms.map((alarm) => alarm.code));
  const maintenanceIds = new Set(catalog.maintenance.map((task) => task.id));

  it("names every cause and every condition once", () => {
    expect(new Set(faultIds).size).toBe(faultIds.length);
    expect(new Set(conditionIds).size).toBe(conditionIds.length);
    expect(new Set(catalog.signals.map((signal) => signal.id)).size).toBe(catalog.signals.length);
    expect(alarmCodes.size).toBe(catalog.alarms.length);
  });

  it("resolves every cross-reference between conditions and causes", () => {
    const fromConditions = catalog.conditions.flatMap((condition) =>
      condition.causes.map((cause) => cause.fault_id),
    );
    expect(fromConditions.filter((faultId) => !faultIds.includes(faultId))).toEqual([]);

    const fromCauses = catalog.causes.flatMap((cause) =>
      cause.conditions.map((condition) => condition.condition_id),
    );
    expect(fromCauses.filter((conditionId) => !conditionIds.includes(conditionId))).toEqual([]);

    // Every cause of the document shares at least one condition, so a reader that joins the
    // two lists always has an edge to follow.
    const shared = conditionIds.filter(
      (conditionId) =>
        catalog.causes.filter((cause) =>
          cause.conditions.some((condition) => condition.condition_id === conditionId),
        ).length === catalog.causes.length,
    );
    expect(shared.length).toBeGreaterThan(0);
  });

  it("resolves every alarm and maintenance reference", () => {
    const referencedAlarms = [
      ...catalog.conditions.flatMap((condition) => condition.alarms),
      ...catalog.causes.flatMap((cause) => [
        ...cause.related_alarms,
        ...cause.conditions.flatMap((condition) => condition.alarms),
      ]),
    ];
    expect(referencedAlarms.filter((code) => !alarmCodes.has(code))).toEqual([]);

    const referencedTasks = catalog.causes.flatMap((cause) => cause.maintenance);
    expect(referencedTasks.filter((id) => !maintenanceIds.has(id))).toEqual([]);
  });
});

describe("signal moves", () => {
  /** Tag id to register group, read from the miniature catalog's signal registry. */
  const groups = new Map<string, "analog" | "digital" | "extra">(
    (mini?.signals ?? []).map((signal) => [signal.id, signal.group] as const),
  );

  const moves: { file: string; faultId: string; move: SignalMove }[] = [
    ...catalogEntries.map(({ file, entry }) => ({ file, entry })),
    ...catalogs.flatMap(({ file, catalog }) => catalog.causes.map((entry) => ({ file, entry }))),
  ].flatMap(({ file, entry }) =>
    entry.signal_moves.map((move) => ({ file, faultId: entry.fault_id, move })),
  );

  it("reads a registry with both kinds of tag and some behaviours", () => {
    expect(groups.size).toBe(16);
    expect(moves.length).toBeGreaterThan(10);
    expect(moves.some(({ move }) => move.signal !== undefined)).toBe(true);
    expect(moves.some(({ move }) => move.behaviour !== undefined)).toBe(true);
  });

  it("uses a direction its target kind allows", () => {
    const offenders = moves
      .map(({ file, faultId, move }) => {
        const target = move.signal ?? move.behaviour ?? "";
        const kind =
          move.signal === undefined ? "behaviour" : (groups.get(move.signal) ?? "unknown");
        const allowed =
          kind === "behaviour"
            ? DIRECTIONS.behaviour
            : kind === "digital"
              ? DIRECTIONS.digital
              : kind === "unknown"
                ? undefined
                : DIRECTIONS.analog;
        if (allowed !== undefined && allowed.has(move.direction)) return undefined;
        return `${file} ${faultId}: ${target} (${kind}) cannot ${move.direction}`;
      })
      .filter((offender) => offender !== undefined);
    expect(offenders).toEqual([]);
  });

  it("renders every move it claims to have rendered", () => {
    for (const { file, entry } of catalogEntries) {
      expect({ file, rendered: entry.signal_moves_text.length }).toEqual({
        file,
        rendered: entry.signal_moves.length,
      });
      const texts = entry.signal_moves.map((move) => move.text);
      expect({ file, texts }).toEqual({ file, texts: entry.signal_moves_text });
    }
  });
});
