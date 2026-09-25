// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The golden tests over `fixtures/metrics/`.
//
// The table tests next to each module pin one rule at a time; these pin whole
// hand-made runs whose answers were worked out by hand and committed beside
// them. A change that keeps every unit test green and still moves a headline
// number has to move one of these files, which makes it visible in a diff.
//
// Floats are compared with a tolerance of 1e-12 and counts exactly, as the
// task's own rule asks: no floating-point comparison without a tolerance,
// except for the integer counters.

import { describe, expect, it } from "vitest";

import { matchTickets } from "./match.ts";
import { precisionRecall } from "./precision.ts";
import { scoreScenario } from "./summary.ts";
import { sweep } from "./sweep.ts";
import { readExpected, readFixture, readSweepFixture } from "./fixtures.ts";
import type { MatchResult } from "./match.ts";
import type { FaultScore } from "./precision.ts";

/** How close a computed float must be to the committed one (the cost rule's twelve digits). */
const TOLERANCE_DIGITS = 12;

function expectNumber(actual: number | null | undefined, expected: unknown, what: string): void {
  if (expected === null) {
    expect(actual, what).toBeNull();
    return;
  }
  expect(typeof expected, `${what} in the expected document`).toBe("number");
  expect(actual, what).not.toBeNull();
  expect(actual as number, what).toBeCloseTo(expected as number, TOLERANCE_DIGITS);
}

function record(value: unknown, what: string): Record<string, unknown> {
  expect(typeof value, what).toBe("object");
  return value as Record<string, unknown>;
}

function ticketIds(match: MatchResult): Record<string, string[]> {
  return {
    tp: match.tp.map(({ ticket }) => ticket.ticketId),
    fp: match.fp.map((entry) => entry.ticketId),
    misdiagnosed: match.misdiagnosed.map(({ ticket }) => ticket.ticketId),
    recovered: match.recovered.map(({ ticket }) => ticket.ticketId),
    duplicates: match.duplicates.map(({ ticket }) => ticket.ticketId),
    ignored: match.ignored.map((entry) => entry.ticketId),
    benign: match.benign.map((entry) => entry.ticketId),
    fn: match.fn.map((entry) => entry.id),
  };
}

function checkFaultScore(actual: FaultScore | undefined, expected: unknown, what: string): void {
  const wanted = record(expected, what);
  expect(actual, what).toBeDefined();
  expect(actual?.tp, `${what}.tp`).toBe(wanted["tp"]);
  expect(actual?.fp, `${what}.fp`).toBe(wanted["fp"]);
  expect(actual?.fn, `${what}.fn`).toBe(wanted["fn"]);
  expect(actual?.windows, `${what}.windows`).toBe(wanted["windows"]);
  expectNumber(actual?.precision ?? null, wanted["precision"], `${what}.precision`);
  expectNumber(actual?.recall ?? null, wanted["recall"], `${what}.recall`);
}

/** The hand-made scenario runs, each with its expected metrics beside it. */
const SCENARIO_FIXTURES = [
  "recorded-leak-recovered",
  "injected-review-only",
  "negative-false-ticket",
  "depot-abstention",
] as const;

describe.each(SCENARIO_FIXTURES)("fixtures/metrics/%s", (name) => {
  const fixture = readFixture(name);
  const expected = readExpected(name);
  const metrics = scoreScenario(
    fixture.binding,
    fixture.tickets,
    fixture.decisions,
    fixture.alarms,
    fixture.prices,
    {
      backend: fixture.backend,
      nativeAlarmCodes: fixture.nativeAlarmCodes,
      reviewMin: fixture.reviewMin,
      suspects: fixture.suspects,
    },
  );

  it("is the run the expected document describes", () => {
    expect(metrics.scenarioId).toBe(fixture.binding.id);
    expect(fixture.id).toBe(expected["id"]);
  });

  it("scores the tickets the warmup left", () => {
    expect(metrics.tickets).toHaveLength(expected["scored_tickets"] as number);
    expect(metrics.warmupTickets).toHaveLength(expected["warmup_tickets"] as number);
    expect(metrics.openAtEnd).toBe(expected["open_at_end"]);
  });

  it("classifies every ticket at both levels", () => {
    const wanted = record(expected["match"], "match");
    expect(ticketIds(metrics.match.ticket)).toEqual(wanted["ticket"]);
    expect(ticketIds(metrics.match.review)).toEqual(wanted["review"]);
  });

  it("reproduces the per-fault, micro and macro figures", () => {
    const wanted = record(expected["precision_recall"], "precision_recall");
    for (const level of ["ticket", "review"] as const) {
      const scores = metrics.precisionRecall[level];
      const want = record(wanted[level], `precision_recall.${level}`);

      checkFaultScore(scores.micro, want["micro"], `${level}.micro`);
      const macro = record(want["macro"], `${level}.macro`);
      expectNumber(scores.macro.precision, macro["precision"], `${level}.macro.precision`);
      expectNumber(scores.macro.recall, macro["recall"], `${level}.macro.recall`);

      const perFault = record(want["per_fault"], `${level}.per_fault`);
      expect(Object.keys(scores.perFault).sort()).toEqual(Object.keys(perFault).sort());
      for (const [fault, score] of Object.entries(perFault)) {
        checkFaultScore(scores.perFault[fault], score, `${level}.per_fault.${fault}`);
      }
    }
  });

  it("reproduces the lead times", () => {
    const wanted = expected["lead_times"] as Record<string, unknown>[];
    expect(metrics.leadTimes).toHaveLength(wanted.length);

    metrics.leadTimes.forEach((lead, index) => {
      const want = record(wanted[index], `lead_times[${index}]`);
      expect(lead.windowId).toBe(want["window_id"]);
      expect(lead.fault).toBe(want["fault"]);
      expect(lead.firstCorrectTicket.toISOString()).toBe(want["first_correct_ticket"]);
      expect(lead.nativeCode).toBe(want["native_code"]);
      expect(lead.nativeFirst?.toISOString()).toBe(want["native_first"]);
      expectNumber(lead.leadMinutes ?? null, want["lead_minutes"], "lead_minutes");
      expectNumber(lead.latencyMinutes, want["latency_minutes"], "latency_minutes");
      expect(lead.qualifier).toBe(want["qualifier"]);
    });
  });

  it("reproduces the machine-day arithmetic", () => {
    const wanted = record(expected["rates"], "rates");
    expect(metrics.rates.tickets).toBe(wanted["tickets"]);
    expect(metrics.rates.falseTickets).toBe(wanted["false_tickets"]);
    expectNumber(
      metrics.rates.coveredMachineDays,
      wanted["covered_machine_days"],
      "covered_machine_days",
    );
    expectNumber(
      metrics.rates.negativeMachineDays,
      wanted["negative_machine_days"],
      "negative_machine_days",
    );
    expectNumber(
      metrics.rates.ticketsPerMachineDay,
      wanted["tickets_per_machine_day"],
      "tickets_per_machine_day",
    );
    expectNumber(
      metrics.rates.falseTicketsPerMachineDay,
      wanted["false_tickets_per_machine_day"],
      "false_tickets_per_machine_day",
    );
  });

  it("reproduces the abstention verdict", () => {
    const wanted = expected["abstention"];
    if (wanted === null) {
      expect(metrics.abstention).toBeNull();
      return;
    }
    const want = record(wanted, "abstention");
    expect(metrics.abstention?.correct).toBe(want["correct"]);
    expect(metrics.abstention?.total).toBe(want["total"]);
    expect(metrics.abstention?.decisions).toBe(want["decisions"]);
    expect(metrics.abstention?.explicit).toBe(want["explicit"]);
    expectNumber(metrics.abstention?.accuracy ?? null, want["accuracy"], "accuracy");
    expectNumber(metrics.abstention?.explicitRate ?? null, want["explicit_rate"], "explicit_rate");
  });

  it("reproduces the cost to 1e-12", () => {
    const wanted = record(expected["cost"], "cost");
    expect(metrics.cost.calls).toBe(wanted["calls"]);
    expect(metrics.cost.input_tokens).toBe(wanted["input_tokens"]);
    expect(metrics.cost.output_tokens).toBe(wanted["output_tokens"]);
    expectNumber(metrics.cost.usd, wanted["usd"], "usd");
    expectNumber(metrics.cost.perDecision, wanted["per_decision"], "per_decision");
    expectNumber(metrics.cost.perTicket, wanted["per_ticket"], "per_ticket");
  });

  it("reads the suspect events at detection level", () => {
    const wanted = record(expected["detection"], "detection");
    const { detection } = metrics;
    expect(detection.suspects).toBe(wanted["suspects"]);
    expect(detection.warmupSuspects).toBe(wanted["warmup_suspects"]);
    expect(detection.outsideWindows).toBe(wanted["outside_windows"]);
    const windows = wanted["windows"] as Record<string, unknown>[];
    expect(detection.windows).toHaveLength(windows.length);
    detection.windows.forEach((window, index) => {
      const want = record(windows[index], `detection.windows[${index}]`);
      expect(window.windowId).toBe(want["window_id"]);
      expect(window.headline).toBe(want["headline"]);
      expect(window.first?.eventId ?? null).toBe(want["first_suspect"]);
      expect(window.deadline?.toISOString() ?? null).toBe(want["deadline"]);
      expect(window.detected).toBe(want["detected"]);
    });
  });

  it("reproduces the pass verdict at every level", () => {
    const wanted = record(expected["pass"], "pass");
    expect(metrics.pass.detection).toBe(wanted["detection"]);
    expect(metrics.pass.reviewDiagnosis).toBe(wanted["review_diagnosis"]);
    expect(metrics.pass.diagnosis).toBe(wanted["diagnosis"]);
  });
});

describe("fixtures/metrics/sweep-run", () => {
  const fixture = readSweepFixture("sweep-run");
  const expected = readExpected("sweep-run");
  const rows = sweep(fixture.run, fixture.grid);

  it("scores every grid point plus the run's own pair", () => {
    const wanted = expected["rows"] as Record<string, unknown>[];
    expect(rows).toHaveLength(wanted.length);

    rows.forEach((row, index) => {
      const want = record(wanted[index], `rows[${index}]`);
      expectNumber(row.ticketMin, want["ticket_min"], `rows[${index}].ticket_min`);
      expectNumber(row.reviewMin, want["review_min"], `rows[${index}].review_min`);
      expect(row.approximate).toBe(want["approximate"]);
      expect(row.tickets.map((entry) => entry.ticketId)).toEqual(want["tickets"]);
      expect(row.abstained).toBe(want["abstained"]);

      for (const level of ["ticket", "review"] as const) {
        const levelWant = record(want[level], `rows[${index}].${level}`);
        const micro = row.precisionRecall[level].micro;
        expect(micro.tp, `rows[${index}].${level}.tp`).toBe(levelWant["tp"]);
        expect(micro.fp, `rows[${index}].${level}.fp`).toBe(levelWant["fp"]);
        expect(micro.fn, `rows[${index}].${level}.fn`).toBe(levelWant["fn"]);
        expectNumber(micro.precision, levelWant["precision"], `rows[${index}].${level}.precision`);
        expectNumber(micro.recall, levelWant["recall"], `rows[${index}].${level}.recall`);
      }

      expectNumber(
        row.rates.ticketsPerMachineDay,
        want["tickets_per_machine_day"],
        `rows[${index}].tickets_per_machine_day`,
      );
      expectNumber(
        row.rates.falseTicketsPerMachineDay,
        want["false_tickets_per_machine_day"],
        `rows[${index}].false_tickets_per_machine_day`,
      );
    });
  });

  it("reproduces the tickets the run itself opened, at the run's own thresholds", () => {
    const own = rows.find(
      (row) =>
        row.ticketMin === fixture.run.thresholds.ticketMin &&
        row.reviewMin === fixture.run.thresholds.reviewMin,
    );
    expect(own?.tickets).toEqual(fixture.runTickets);
  });

  it("reproduces the run's own precision and recall exactly", () => {
    const own = rows.find(
      (row) =>
        row.ticketMin === fixture.run.thresholds.ticketMin &&
        row.reviewMin === fixture.run.thresholds.reviewMin,
    );
    const fromTheRun = precisionRecall(
      matchTickets(
        fixture.run.windows,
        fixture.run.excluded,
        fixture.runTickets,
        fixture.run.benignFaultIds,
        "ticket",
      ),
      "ticket",
    );
    expect(own?.precisionRecall.ticket).toEqual(fromTheRun);
  });
});
