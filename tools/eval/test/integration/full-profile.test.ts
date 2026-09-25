// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One month of the `full` profile, through the real host and the real
// pipeline, over the real MetroPT-3 CSV.
//
// The profile's own scenario, `metropt3_full`, replays seven months and is
// bound to the four headline failures; February carries none of them, so the
// month is replayed as the same scenario with its range cut to February and
// its ground truth to the negative it is — the first month, the one the
// normal bands come from. Everything else is the profile's:
// `--profile full`, the CSV source that `METROPT_CSV` names, the calendar-month
// progress of `src/runner/full.ts`, and `run.json` written and validated as
// `make eval` writes it.
//
// It asserts a schema-valid report and the month's rows, and reads the
// throughput against the 1,500 samples/s the full profile needs: the figure is
// always printed, and a lower one is printed as such without failing the test,
// because a machine's speed is a reading, not a defect. It needs the 218 MB
// CSV, so it runs only when `METROPT_CSV` is set and skips otherwise, CI
// included.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.ts";
import type { LogFields, Logger } from "../../src/log.ts";
import { validateReport } from "../../src/report/json.ts";
import { runScenario } from "../../src/runner/host.ts";
import type { ScenarioRun } from "../../src/runner/host.ts";
import { executeRun } from "../../src/runner/run.ts";
import { loadAll } from "../../src/scenario/index.ts";
import type { Scenario } from "../../src/scenario/index.ts";

/** The rate the full profile needs the pipeline to sustain. */
const MIN_SAMPLES_PER_SECOND = 1_500;

/** The rows of February 2020 in the published file (the month line of the whole-recording run). */
const FEBRUARY_SAMPLES = 214_850;

const csv = process.env["METROPT_CSV"];
const runnable = csv !== undefined && csv !== "";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-full-"));
  directories.push(directory);
  return directory;
}

/** `metropt3_full`, cut to February 2020 and bound, as February is, to no failure. */
function februaryOfTheFullProfile(): Scenario {
  const full = loadAll().find((scenario) => scenario.id === "metropt3_full");
  if (full === undefined) throw new Error("no committed metropt3_full scenario");
  return {
    ...full,
    title: "The whole MetroPT-3 recording, its first month",
    group: "negative",
    positive: false,
    replay: { from: "2020-02-01T00:00:00.000Z", to: "2020-03-01T00:00:00.000Z" },
    ground_truth: { kind: "negative" },
    expect: {
      tickets: "none",
      fault: "benign_or_none",
      max_false_tickets: full.expect.max_false_tickets,
      pass_level: "detection",
    },
    notes: "full-profile.test.ts: metropt3_full over February only.",
  };
}

/** A logger that keeps its lines, for the month progress. */
function recordingLogger(): { readonly log: Logger; readonly lines: [string, LogFields][] } {
  const lines: [string, LogFields][] = [];
  const keep = (message: string, fields?: LogFields) => {
    lines.push([message, fields ?? {}]);
  };
  return { lines, log: { level: "info", debug: keep, info: keep, warn: keep } };
}

describe.skipIf(!runnable)("the full profile over one month of the real CSV", () => {
  it("replays February 2020 through the pipeline and writes a schema-valid report", async () => {
    const scenariosDir = temporaryDirectory();
    const out = temporaryDirectory();
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(
      join(scenariosDir, "metropt3_full.json"),
      `${JSON.stringify(februaryOfTheFullProfile(), null, 2)}\n`,
      "utf8",
    );

    const cfg = loadConfig(
      ["--profile", "full", "--backends", "rules", "--scenario", "metropt3_full", "--out", out],
      { METROPT_CSV: csv, EVAL_JEV_MODE: "mock" },
    );
    const { log, lines } = recordingLogger();
    const runs: ScenarioRun[] = [];
    const code = await executeRun(cfg, {
      log,
      scenariosDir,
      stdout: { write: () => true },
      runScenario: async (bound, handle, hostCfg, catalog, options) => {
        const run = await runScenario(bound, handle, hostCfg, catalog, options);
        runs.push(run);
        return run;
      },
    });
    expect(code).toBe(0);

    const report = validateReport(JSON.parse(readFileSync(join(out, "latest.json"), "utf8")));
    expect(report.run.profile).toBe("full");
    const [scenario] = report.scenarios;
    expect(scenario?.id).toBe("metropt3_full");
    expect(scenario?.replay.samples).toBe(FEBRUARY_SAMPLES);
    expect(report.full_recording).toBeUndefined();

    const months = lines.filter(([message]) => message === "month").map(([, fields]) => fields);
    expect(months).toEqual([
      expect.objectContaining({
        scenario: "metropt3_full",
        month: "2020-02",
        samples: FEBRUARY_SAMPLES,
      }),
    ]);

    const rate = runs[0]?.stats.samplesPerS ?? null;
    expect(rate).not.toBeNull();
    const figure = `${Math.round(rate ?? 0).toLocaleString("en-US")} samples/s`;
    if ((rate ?? 0) >= MIN_SAMPLES_PER_SECOND) {
      console.info(
        `full-profile: February 2020 at ${figure} (the full profile needs ${MIN_SAMPLES_PER_SECOND})`,
      );
    } else {
      console.warn(
        `full-profile: February 2020 at ${figure}, below the ${MIN_SAMPLES_PER_SECOND} samples/s ` +
          "the full profile needs",
      );
    }
  });
});
