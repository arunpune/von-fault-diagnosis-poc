// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval sweep`: the grid, the guard, the merges it recovers and — the
// assertion the command exists for — a real run swept at its own thresholds
// giving back exactly what the run reported.
//
// The real run is the smoke profile, replayed in process over the cut slices
// as the smoke E2E replays it (rules and a mock Jev, whose episodes merge),
// and swept with `--allow-test-split`, because the smoke replays core-10
// scenarios and is never a tuning signal: here it only proves the re-gating.
// It skips when the slices are not cut and fails instead under
// FDP_REQUIRE_DATASET=1. The guard and the grid are proved on hand-made runs.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import {
  SAMPLE_PROVENANCE,
  sampleConfig,
  sampleDesignRunResult,
  sampleExitEvalRunResult,
} from "../report/fixtures.ts";
import { buildRunReport, renderRunJson } from "../report/json.ts";
import type { ReportDecision, ReportScenario, ReportTicket, RunReport } from "../report/types.ts";
import { executeRun } from "../runner/run.ts";
import { datasetRequired, sliceIsCut } from "../slices.ts";
import {
  DEFAULT_GRID,
  SWEEP_JSON_NAME,
  SWEEP_MD_NAME,
  SweepUsageError,
  backendThresholds,
  executeSweep,
  mergeTargets,
  parseGrid,
  renderSweepMarkdown,
  runDirectoryOf,
  sweepDocument,
  sweepReport,
} from "./sweep.ts";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-sweep-"));
  directories.push(directory);
  return directory;
}

const QUIET: Logger = {
  level: "warn",
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

const SINK = { write: () => true };

/** The hand-made tuning run of the report tests, as `run.json`. */
function tuningReport(): RunReport {
  const result = sampleExitEvalRunResult(temporaryDirectory());
  return buildRunReport({ result, cfg: sampleConfig(), provenance: SAMPLE_PROVENANCE });
}

describe("parseGrid", () => {
  it("pairs every ticket floor with every review floor at or below it", () => {
    const pairs = parseGrid(DEFAULT_GRID);
    expect(pairs).toHaveLength(46);
    expect(pairs).toContainEqual([0.85, 0.6]);
    expect(pairs).toContainEqual([0.6, 0.6]);
    expect(pairs).not.toContainEqual([0.6, 0.65]);
    // Rounded, so 0.6 + 5 × 0.05 is the 0.85 a run stores.
    expect(pairs.flat().every((value) => value === Number(value.toFixed(2)))).toBe(true);
  });

  it.each([
    ["0.6:0.95x0.5:0.8", "not from:to:step"],
    ["0.6:0.95:0.05", "is not <ticket"],
    ["0.9:0.6:0.05x0.5:0.8:0.05", "must run upwards"],
    ["0.6:1.2:0.05x0.5:0.8:0.05", "must run upwards"],
    ["0.6:0.9:0x0.5:0.8:0.05", "must run upwards"],
    ["a:b:cx0.5:0.8:0.05", "not from:to:step"],
  ])("refuses %s", (text, problem) => {
    expect(() => parseGrid(text)).toThrow(SweepUsageError);
    expect(() => parseGrid(text)).toThrow(problem);
  });
});

describe("the notice of sweep.md", () => {
  it("names every reason a row is approximate: the merges, and the persistence rule", () => {
    // Since GATE_PERSIST_SIM_MIN, whether an episode is decided depends on whether it
    // owns a ticket, so the decisions a run took depend on its gate: a re-gating keeps
    // them as they were, which is a second approximation beside the held merges.
    const tuning = tuningReport();
    const dev: RunReport = {
      ...tuning,
      scenarios: tuning.scenarios.map((scenario) => ({ ...scenario, split: "dev" })),
    };
    const page = renderSweepMarkdown(sweepReport(dev, parseGrid("0.8:0.9:0.05x0.6:0.6:0.05")));
    expect(page).toContain("episode merges are held as the run made them");
    expect(page).toContain("GATE_PERSIST_SIM_MIN");
    expect(page).toContain("decisions are held as the run took them");
  });
});

describe("the tuning-list guard", () => {
  const tuning = tuningReport();

  it("refuses a run that is not a tuning run unless told to report it", () => {
    const core: RunReport = { ...tuning, run: { ...tuning.run, profile: "core" } };
    expect(() => sweepReport(core, parseGrid(DEFAULT_GRID))).toThrow(/tuning list only/);
    expect(
      sweepReport(core, parseGrid(DEFAULT_GRID), { allowTestSplit: true }).allowTestSplit,
    ).toBe(true);
  });

  it("refuses a run of the held-out set outright, by its profile or by a scenario's split", () => {
    const heldout: RunReport = { ...tuning, run: { ...tuning.run, profile: "heldout" } };
    expect(() => sweepReport(heldout, parseGrid(DEFAULT_GRID), { allowTestSplit: true })).toThrow(
      /held-out set/,
    );
    const dev: RunReport = {
      ...tuning,
      scenarios: tuning.scenarios.map((scenario, index) => ({
        ...scenario,
        split: index === 0 ? "heldout" : "dev",
      })),
    };
    expect(() => sweepReport(dev, parseGrid(DEFAULT_GRID), { allowTestSplit: true })).toThrow(
      SweepUsageError,
    );
  });

  it("refuses a stack run outright", () => {
    const stack: RunReport = { ...tuning, run: { ...tuning.run, mode: "stack", profile: "stack" } };
    expect(() => sweepReport(stack, parseGrid(DEFAULT_GRID), { allowTestSplit: true })).toThrow(
      /stack run/,
    );
  });

  it("refuses a test-split scenario even inside a tuning run, as sweep() itself would", () => {
    // The sample tuning run carries core-10 scenarios, which a real `--tuning` run cannot.
    expect(() => sweepReport(tuning, parseGrid(DEFAULT_GRID))).toThrow(SweepUsageError);
    expect(() => sweepReport(tuning, parseGrid(DEFAULT_GRID))).toThrow(
      /test-split scenarios \(baseline_feb03_normal, depot_lps_jul31\)/,
    );
  });

  it("sweeps a tuning run and says when a row does not give the run back", () => {
    const dev: RunReport = {
      ...tuning,
      scenarios: tuning.scenarios.map((scenario) => ({ ...scenario, split: "dev" })),
    };
    const result = sweepReport(dev, parseGrid("0.8:0.9:0.05x0.6:0.6:0.05"));
    expect(result.backends.map((entry) => entry.backend)).toEqual(["rules"]);
    const [rules] = result.backends;
    expect(rules?.rows.map((row) => [row.ticketMin, row.reviewMin])).toEqual([
      [0.8, 0.6],
      [0.85, 0.6],
      [0.9, 0.6],
    ]);
    // The sample run's tickets are written by hand, not opened by its decisions, so re-gating
    // cannot give them back — and the self-check says so rather than printing a clean table.
    expect(rules?.own.reproduces).toBe(false);
    expect(rules?.own.differences.length).toBeGreaterThan(0);
  });

  it("re-gates a backend around the pair its gate applied, when the run recorded one", () => {
    const dev: RunReport = {
      ...tuning,
      scenarios: tuning.scenarios.map((scenario) => ({ ...scenario, split: "dev" })),
      backends: tuning.backends.map((backend) => ({
        ...backend,
        thresholds: { ticket_min: 0.9, review_min: 0.7 },
      })),
    };
    expect(backendThresholds(dev, "rules")).toEqual({ ticketMin: 0.9, reviewMin: 0.7 });
    // A report from before backends had their own pair falls back to the global one.
    expect(backendThresholds(tuning, "rules")).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
    const [rules] = sweepReport(dev, parseGrid("0.8:0.8:0.05x0.6:0.6:0.05")).backends;
    expect(rules?.own).toMatchObject({ ticketMin: 0.9, reviewMin: 0.7 });
    // The backend's own pair is always a row, whether or not the grid names it.
    expect(rules?.rows.map((row) => [row.ticketMin, row.reviewMin])).toEqual([
      [0.8, 0.6],
      [0.9, 0.7],
    ]);
  });
});

describe("the design target", () => {
  const designReport = buildRunReport({
    result: sampleDesignRunResult(temporaryDirectory()),
    cfg: sampleConfig(),
    provenance: SAMPLE_PROVENANCE,
  });
  const grid = parseGrid("0.8:0.9:0.05x0.6:0.7:0.1");

  /** The same run with every design target taken out of it. */
  function withoutTargets(source: RunReport): RunReport {
    return {
      ...source,
      scenarios: source.scenarios.map((scenario) => {
        const copy = { ...scenario };
        delete copy.design_target;
        return copy;
      }),
    };
  }

  it("is read at every pair beside the rows, marked never counted", () => {
    const result = sweepReport(designReport, grid);
    expect(result.designTargets).toHaveLength(1);
    const [design] = result.designTargets;
    expect(design).toMatchObject({
      backend: "rules",
      scenario: "unlabelled_leak_may19",
      accepted: ["dryer_purge_leak", "downstream_air_leak"],
      gated: false,
    });
    expect(design?.rows.map((row) => [row.ticketMin, row.reviewMin])).toEqual(
      result.backends[0]?.rows.map((row) => [row.ticketMin, row.reviewMin]),
    );
  });

  it("follows the gate: the review item opens only where the review floor lets it", () => {
    const [design] = sweepReport(designReport, grid).designTargets;
    const at = (ticketMin: number, reviewMin: number) =>
      design?.rows.find((row) => row.ticketMin === ticketMin && row.reviewMin === reviewMin);
    // The silencer decision's 0.7 opens a review item at a 0.6 or 0.7 floor, and never a ticket.
    expect(at(0.85, 0.6)?.review.first?.faultAtOpen).toBe("purge_silencer_damaged");
    expect(at(0.85, 0.6)?.review.met).toBe(false);
    expect(at(0.85, 0.6)?.ticket.first?.faultAtOpen).toBe("dryer_purge_leak");
    expect(at(0.85, 0.6)?.ticket.met).toBe(true);
    // At a 0.9 ticket floor the purge decision's 0.9 still tickets; at 0.95 it would not.
    expect(at(0.9, 0.7)?.ticket.met).toBe(true);
  });

  it("changes no row: the figures are those of the run without the target", () => {
    const withTarget = sweepReport(designReport, grid);
    const without = sweepReport(withoutTargets(designReport), grid);
    expect(without.designTargets).toEqual([]);
    expect(withTarget.backends).toEqual(without.backends);
  });

  it("is written to sweep.md in a section of its own and to sweep.json", () => {
    const result = sweepReport(designReport, grid);
    const page = renderSweepMarkdown(result);
    expect(page).toContain("## Design targets: reported, never counted");
    expect(page).toContain("the pre-registered threshold selection leaves its scenario out");
    expect(page).toContain("| 0.85 | 0.60 | purge_silencer_damaged (off target) | 1 / 1 |");
    const document = sweepDocument(result) as {
      design_targets: { gated: boolean; rows: { review: { met: boolean } }[] }[];
    };
    expect(document.design_targets[0]?.gated).toBe(false);
    expect(renderSweepMarkdown(sweepReport(withoutTargets(designReport), grid))).not.toContain(
      "Design targets",
    );
  });
});

function decision(fields: Partial<ReportDecision> & { decision_id: string }): ReportDecision {
  return {
    episode_id: "e-1",
    sim_ts: "2020-02-03T03:00:00.000Z",
    choice: "oil_cooler_fouled",
    confidence: 0.9,
    gate: "ticket",
    abstained: false,
    benign_choice: false,
    usage: { input_tokens: 0, output_tokens: 0 },
    backend: "jev",
    state_digest: null,
    ...fields,
  };
}

function reportTicket(fields: Partial<ReportTicket> & { ticket_id: string }): ReportTicket {
  return {
    episode_id: "e-1",
    opened_sim_ts: "2020-02-03T03:00:00.000Z",
    fault_at_open: "oil_cooler_fouled",
    fault_latest: "oil_cooler_fouled",
    max_level: "ticket",
    closed_sim_ts: null,
    open_at_end: true,
    verdict: "tp",
    window_id: null,
    ...fields,
  };
}

describe("mergeTargets", () => {
  it("maps an episode with a passed decision and no ticket to the live ticket naming its fault", () => {
    const scenario = {
      tickets: [
        reportTicket({ ticket_id: "t-1" }),
        reportTicket({
          ticket_id: "t-old",
          episode_id: "e-old",
          opened_sim_ts: "2020-02-03T01:00:00.000Z",
          closed_sim_ts: "2020-02-03T02:00:00.000Z",
        }),
      ],
      decisions: [
        decision({ decision_id: "d-1" }),
        decision({ decision_id: "d-2", episode_id: "e-2", sim_ts: "2020-02-03T04:00:00.000Z" }),
        // Gated to log: this episode would never have opened a ticket, so it was never merged.
        decision({
          decision_id: "d-3",
          episode_id: "e-3",
          sim_ts: "2020-02-03T04:30:00.000Z",
          gate: "log",
          confidence: 0.3,
        }),
        // A fault no live ticket names: left alone, and re-gated as its own episode.
        decision({
          decision_id: "d-4",
          episode_id: "e-4",
          sim_ts: "2020-02-03T05:00:00.000Z",
          choice: "airend_bearing_wear",
        }),
      ],
    } as unknown as ReportScenario;
    expect([...mergeTargets(scenario)]).toEqual([["e-2", "e-1"]]);
  });
});

describe("runDirectoryOf", () => {
  it("writes beside run.json, and for latest.json into the run directory it names", () => {
    const out = temporaryDirectory();
    expect(runDirectoryOf(join(out, "20260922-120000-tuning", "run.json"), "x")).toBe(
      join(out, "20260922-120000-tuning"),
    );
    expect(runDirectoryOf(join(out, "latest.json"), "20260922-120000-tuning")).toBe(out);
  });
});

describe("executeSweep", () => {
  it("names a missing or foreign file as a usage error", () => {
    const out = temporaryDirectory();
    const grid = parseGrid(DEFAULT_GRID);
    expect(() =>
      executeSweep({ runPath: join(out, "latest.json"), grid, allowTestSplit: false }, SINK),
    ).toThrow(/does not exist/);
    const foreign = join(out, "run.json");
    writeFileSync(foreign, "{}\n", "utf8");
    expect(() => executeSweep({ runPath: foreign, grid, allowTestSplit: false }, SINK)).toThrow(
      /is not a run.json/,
    );
  });
});

const SMOKE_SLICES = ["baseline-feb03", "depot-jul31", "f3-jun05"];
const smokeSlicesCut = SMOKE_SLICES.every((slice) => sliceIsCut(slice));

describe("the smoke profile, swept at its own thresholds", () => {
  it("can run, or its absence is allowed", () => {
    expect(smokeSlicesCut || !datasetRequired(), "the smoke slices are not cut").toBe(true);
  });

  it.skipIf(!smokeSlicesCut)(
    "gives back the run's own figures for both backends and writes sweep.json and sweep.md",
    async () => {
      const out = temporaryDirectory();
      const cfg = loadConfig(["--profile", "smoke", "--backends", "rules,jev", "--out", out], {
        EVAL_JEV_MODE: "mock",
      });
      expect(await executeRun(cfg, { log: QUIET, stdout: SINK })).toBe(0);
      const latest = join(out, "latest.json");
      const stored = JSON.parse(readFileSync(latest, "utf8")) as RunReport;
      expect(renderRunJson(stored)).toBe(readFileSync(latest, "utf8"));

      const printed: string[] = [];
      const { result, json, md } = executeSweep(
        { runPath: latest, grid: parseGrid(DEFAULT_GRID), allowTestSplit: true },
        { write: (chunk: string) => printed.push(chunk) },
      );

      expect(result.backends.map((entry) => entry.backend)).toEqual(["rules", "jev"]);
      const merged = result.backends.reduce((total, entry) => total + entry.mergedEpisodes, 0);
      expect(merged, "the mock Jev merges episodes, which the sweep must recover").toBeGreaterThan(
        0,
      );
      for (const entry of result.backends) {
        // Each backend is swept around the pair it ran at: rules at GATE_* (0.60 / 0.85), Jev at
        // its own default, the pre-registered choice (0.65 / 0.85).
        const pair = entry.backend === "jev" ? cfg.jevGate : cfg.gate;
        expect(entry.own, `${entry.backend}: ${entry.own.differences.join("; ")}`).toMatchObject({
          ticketMin: 0.85,
          reviewMin: entry.backend === "jev" ? 0.65 : 0.6,
          reproduces: true,
        });
        const own = entry.rows.find(
          (row) => row.ticketMin === pair.ticketMin && row.reviewMin === pair.reviewMin,
        );
        const summary = stored.summary?.backends.find(
          (backend) => backend.backend === entry.backend,
        );
        expect(own?.precision.ticket).toBe(summary?.precision_recall.ticket.micro.precision);
        expect(own?.recall.review).toBe(summary?.precision_recall.review.micro.recall);
        expect(own?.falseTicketsPerMachineDay).toBe(summary?.rates.false_tickets_per_machine_day);
        expect(own?.abstentionAccuracy).toBe(summary?.abstention.accuracy);
      }

      const runDir = join(out, stored.run.id);
      expect(json).toBe(join(runDir, SWEEP_JSON_NAME));
      expect(md).toBe(join(runDir, SWEEP_MD_NAME));
      expect(existsSync(json) && existsSync(md)).toBe(true);
      const document = JSON.parse(readFileSync(json, "utf8")) as {
        run: { id: string };
        approximate: boolean;
        backends: { own: { reproduces: boolean } }[];
      };
      expect(document.run.id).toBe(stored.run.id);
      expect(document.approximate).toBe(true);
      expect(document.backends.every((entry) => entry.own.reproduces)).toBe(true);
      const page = readFileSync(md, "utf8");
      expect(page).toContain("never a basis for a threshold");
      expect(page).toContain("no threshold is lowered to pass E3");
      expect(printed.join("")).toContain("reproduces the run's summary");
    },
  );
});
