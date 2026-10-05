// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The full profile's month progress and its whole-recording summary (E6).
//
// The months are pinned on plain dates and a fake timer; the summary on the
// committed `metropt3_full` scenario, bound against the committed ground truth
// and scored by the real metrics, with tickets written by hand. The loop's
// wiring is driven with its seams stubbed, as `run.test.ts` does, so none of
// this needs the dataset: the real whole-recording replay is
// `test/integration/full-profile.test.ts`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionBackend } from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import type { BackendHandle } from "../backends/types.ts";
import type { EvalCatalog } from "../config.ts";
import { loadConfig } from "../config.ts";
import type { LogFields, Logger } from "../log.ts";
import { TEST_PRICES, ticket } from "../metrics/fixtures.ts";
import { scoreScenario } from "../metrics/index.ts";
import type { TicketRecord } from "../metrics/index.ts";
import { buildRunReport, validateReport } from "../report/json.ts";
import { renderMarkdown } from "../report/markdown.ts";
import { bindScenario, loadAll } from "../scenario/index.ts";
import type { BoundScenario } from "../scenario/index.ts";
import { createMonthTracker, fullRecordingSummary, monthChunks } from "./full.ts";
import { createFakeWallClock } from "./host.ts";
import type { HostOptions, ScenarioRun } from "./host.ts";
import { runEvaluation, toBinding } from "./run.ts";
import type { ScenarioResult } from "./types.ts";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-full-"));
  directories.push(directory);
  return directory;
}

/** A logger that keeps its `info` lines, for the month progress. */
function recordingLogger(): { readonly log: Logger; readonly lines: LogFields[] } {
  const lines: LogFields[] = [];
  return {
    lines,
    log: {
      level: "info",
      debug: () => undefined,
      info: (_message, fields) => lines.push(fields ?? {}),
      warn: () => undefined,
    },
  };
}

function utc(text: string): Date {
  return new Date(text);
}

describe("monthChunks", () => {
  it("cuts the recording into its seven calendar months", () => {
    const chunks = monthChunks({
      from: utc("2020-02-01T00:00:00.000Z"),
      to: utc("2020-09-01T00:00:00.000Z"),
    });
    expect(chunks.map((chunk) => chunk.month)).toEqual([
      "2020-02",
      "2020-03",
      "2020-04",
      "2020-05",
      "2020-06",
      "2020-07",
      "2020-08",
    ]);
    expect(chunks[0]?.to.toISOString()).toBe("2020-03-01T00:00:00.000Z");
    expect(chunks[6]?.to.toISOString()).toBe("2020-09-01T00:00:00.000Z");
  });

  it("clips the first and the last month to the range", () => {
    const chunks = monthChunks({
      from: utc("2020-02-20T12:00:00.000Z"),
      to: utc("2020-03-05T00:00:00.000Z"),
    });
    expect(chunks.map((c) => [c.month, c.from.toISOString(), c.to.toISOString()])).toEqual([
      ["2020-02", "2020-02-20T12:00:00.000Z", "2020-03-01T00:00:00.000Z"],
      ["2020-03", "2020-03-01T00:00:00.000Z", "2020-03-05T00:00:00.000Z"],
    ]);
  });

  it("refuses an empty range", () => {
    const at = utc("2020-02-01T00:00:00.000Z");
    expect(() => monthChunks({ from: at, to: at })).toThrow(RangeError);
  });
});

describe("createMonthTracker", () => {
  it("closes each month as the stream crosses into the next and logs its throughput", () => {
    const { log, lines } = recordingLogger();
    let clock = 0;
    const tracker = createMonthTracker(
      { from: utc("2020-02-01T00:00:00.000Z"), to: utc("2020-05-01T00:00:00.000Z") },
      { log, fields: { scenario: "metropt3_full", backend: "rules" }, elapsedMs: () => clock },
    );

    tracker.onBatch({ simTs: "2020-02-01T00:04:00.000Z", samples: 25 });
    clock += 10;
    tracker.onBatch({ simTs: "2020-02-29T23:59:50.000Z", samples: 25 });
    clock += 10;
    // March is skipped altogether: the stream jumps from February into April.
    tracker.onBatch({ simTs: "2020-04-02T00:00:00.000Z", samples: 10 });
    clock += 5;

    expect(lines).toEqual([
      {
        scenario: "metropt3_full",
        backend: "rules",
        month: "2020-02",
        samples: 50,
        samples_per_s: 2500,
      },
    ]);
    const months = tracker.finish();
    expect(months.map((month) => [month.month, month.samples])).toEqual([
      ["2020-02", 50],
      ["2020-04", 10],
    ]);
    expect(months[1]?.samplesPerS).toBe(2000);
    expect(lines).toHaveLength(2);
  });

  it("reports no throughput for a month that took no measurable time", () => {
    const { log } = recordingLogger();
    const tracker = createMonthTracker(
      { from: utc("2020-02-01T00:00:00.000Z"), to: utc("2020-03-01T00:00:00.000Z") },
      { log, elapsedMs: () => 0 },
    );
    tracker.onBatch({ simTs: "2020-02-03T00:00:00.000Z", samples: 3 });
    expect(tracker.finish()).toEqual([
      { month: "2020-02", samples: 3, wallMs: 0, samplesPerS: null },
    ]);
  });
});

function boundScenario(id: string, profile: "full" | "core"): BoundScenario {
  const scenario = loadAll().find((entry) => entry.id === id);
  if (scenario === undefined) throw new Error(`no committed scenario ${id}`);
  return bindScenario(scenario, { profile });
}

function run(bound: BoundScenario, backend: "rules" | "von"): ScenarioRun {
  return {
    scenarioId: bound.scenario.id,
    backend,
    model: backend === "rules" ? "rules-v1" : "von-1.13.0",
    mode: backend === "rules" ? "-" : "mock",
    seed: bound.scenario.seed,
    events: [],
    alarms: [],
    firstAlarms: [],
    alarmTransitions: [],
    stats: {
      samples: 0,
      batches: 0,
      discontinuities: 0,
      wallMs: 0,
      samplesPerS: null,
      decisions: 0,
      failures: 0,
    },
  };
}

/** A pair of the run, scored by the real metrics over hand-written tickets. */
function result(bound: BoundScenario, tickets: readonly TicketRecord[]): ScenarioResult {
  const binding = toBinding(bound);
  return {
    bound,
    binding,
    run: run(bound, "rules"),
    summary: {
      tickets,
      decisions: [],
      failedDecisions: 0,
      suspects: 0,
      episodes: { opened: tickets.length, merged: 0, closed: 0, aborted: 0 },
      openAtEnd: [],
    },
    metrics: scoreScenario(binding, tickets, [], [], TEST_PRICES, { backend: "rules" }),
    scored: true,
    eventLog: `scenarios/${bound.scenario.id}.rules.jsonl`,
  };
}

/** One ticket per case E6 separates: detected at each level, false at each level, unlabelled. */
const RECORDING_TICKETS: readonly TicketRecord[] = [
  ticket({
    ticketId: "t-f3",
    openedSimTs: utc("2020-06-05T11:00:00.000Z"),
    faultAtOpen: "dryer_purge_leak",
  }),
  ticket({
    ticketId: "t-f1-review",
    openedSimTs: utc("2020-04-18T02:00:00.000Z"),
    faultAtOpen: "downstream_air_leak",
    maxLevel: "review",
  }),
  ticket({
    ticketId: "t-unlabelled",
    openedSimTs: utc("2020-03-12T01:00:00.000Z"),
    faultAtOpen: "dryer_purge_leak",
    maxLevel: "review",
  }),
  ticket({
    ticketId: "t-false",
    openedSimTs: utc("2020-02-10T12:00:00.000Z"),
    faultAtOpen: "airend_bearing_wear",
  }),
  ticket({
    ticketId: "t-false-review",
    openedSimTs: utc("2020-02-11T12:00:00.000Z"),
    faultAtOpen: "airend_bearing_wear",
    maxLevel: "review",
  }),
];

describe("fullRecordingSummary", () => {
  const recording = result(boundScenario("metropt3_full", "full"), RECORDING_TICKETS);
  const baseline = result(boundScenario("baseline_feb03_normal", "core"), []);
  const [summary, ...rest] = fullRecordingSummary([baseline, recording]);

  it("reads only the pairs that replayed the whole recording", () => {
    expect(rest).toEqual([]);
    expect(summary?.scenarioId).toBe("metropt3_full");
    expect(summary?.replay.from.toISOString()).toBe("2020-02-01T00:00:00.000Z");
  });

  it("checks the four headline failures at ticket and at review level", () => {
    expect(summary?.metropt3.ticket).toMatchObject({
      level: "ticket",
      detected: ["F3"],
      missed: ["F1", "F2", "F4"],
      pass: false,
      in_sample: true,
    });
    expect(summary?.metropt3.review).toMatchObject({
      level: "review",
      detected: ["F1", "F3"],
      missed: ["F2", "F4"],
    });
  });

  it("divides the false tickets of each level by the recording's negative time", () => {
    const negative = recording.metrics.rates.negativeMachineDays;
    expect(negative).toBeGreaterThan(100);
    expect(summary?.negativeMachineDays).toBe(negative);
    expect(summary?.falseTickets).toEqual({ ticket: 1, review: 2 });
    expect(summary?.falseTicketsPerMachineDay).toEqual({
      ticket: 1 / negative,
      review: 2 / negative,
    });
  });

  it("lists the detection inside an unlabelled episode apart, with its episode", () => {
    expect(
      summary?.unlabelled.map((entry) => [
        entry.ticket.ticketId,
        entry.episodeFrom.toISOString(),
        entry.episodeTo.toISOString(),
      ]),
    ).toEqual([["t-unlabelled", "2020-03-12T00:16:06.000Z", "2020-03-12T11:49:50.000Z"]]);
    // Never a false positive: the scorer ignored it inside its excluded window.
    expect(recording.metrics.match.review.ignored.map((t) => t.ticketId)).toEqual(["t-unlabelled"]);
  });
});

describe("the full profile in the loop", () => {
  const SILENT: DecisionBackend = {
    name: "rules",
    model: "rules-v1",
    decide: () => Promise.reject(new Error("the stubbed host never decides")),
  };
  const handle: BackendHandle = {
    name: "rules",
    model: "rules-v1",
    mode: "-",
    backend: SILENT,
    stats: { calls: 0, failures: 0, cassetteMisses: 0 },
    close: () => Promise.resolve(),
  };
  const catalog: EvalCatalog = {
    source: "reference",
    name: "reference",
    sha256: "0".repeat(64),
    entries: [],
    conditions: [],
  };

  it("streams the recording with month progress and adds its summary to the report", async () => {
    const out = temporaryDirectory();
    const cfg = loadConfig(
      ["--profile", "full", "--backends", "rules", "--scenario", "metropt3_full", "--out", out],
      {},
    );
    const { log, lines } = recordingLogger();
    const seen: HostOptions[] = [];

    const outcome = await runEvaluation(cfg, {
      log,
      wall: createFakeWallClock(),
      loadCatalog: () => Promise.resolve(catalog),
      selectBackends: () => Promise.resolve([handle]),
      requireRows: () => undefined,
      runScenario: (bound, backend, _cfg, _catalog, options) => {
        seen.push(options);
        options.onBatch?.({ simTs: "2020-02-01T00:04:00.000Z", samples: 25 });
        options.onBatch?.({ simTs: "2020-03-01T00:04:00.000Z", samples: 25 });
        return Promise.resolve(run(bound, backend.name === "rules" ? "rules" : "von"));
      },
    });

    expect(seen).toHaveLength(1);
    expect(typeof seen[0]?.onBatch).toBe("function");
    expect(lines.filter((fields) => fields["month"] !== undefined).map((f) => f["month"])).toEqual([
      "2020-02",
      "2020-03",
    ]);
    expect(outcome.fullRecording?.map((entry) => entry.scenarioId)).toEqual(["metropt3_full"]);

    const report = validateReport(
      buildRunReport({
        result: outcome,
        cfg,
        provenance: {
          git_sha: null,
          node: "v24.18.0",
          backend_version: "1.0.0",
          ground_truth: {
            package_version: "1.0.0",
            failures_sha256: "c".repeat(64),
            injections_sha256: null,
          },
        },
      }),
    );
    expect(report.full_recording?.[0]).toMatchObject({
      scenario: "metropt3_full",
      backend: "rules",
      metropt3_check: { ticket: { detected: [], missed: ["F1", "F2", "F3", "F4"] } },
      unlabelled_detections: [],
    });
    expect(renderMarkdown(report)).toContain("**Whole recording (E6, in-sample)**");
  });

  it("gives a slice no month progress and a run without the recording no summary", async () => {
    const out = temporaryDirectory();
    const cfg = loadConfig(
      ["--profile", "smoke", "--backends", "rules", "--scenario", "depot_lps_jul31", "--out", out],
      {},
    );
    const seen: HostOptions[] = [];
    const outcome = await runEvaluation(cfg, {
      log: recordingLogger().log,
      wall: createFakeWallClock(),
      loadCatalog: () => Promise.resolve(catalog),
      selectBackends: () => Promise.resolve([handle]),
      requireRows: () => undefined,
      runScenario: (bound, _backend, _cfg, _catalog, options) => {
        seen.push(options);
        return Promise.resolve(run(bound, "rules"));
      },
    });
    expect(seen[0]?.onBatch).toBeUndefined();
    expect(outcome.fullRecording).toBeUndefined();
  });
});
