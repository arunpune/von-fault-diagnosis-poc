// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `run.json`: built from a hand-made run, validated by its own schema, and
// free of anything a report must never carry; the optional `tuning` and
// `exit_eval` blocks, built from a second one; and the design-target block,
// from a third.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CORE_10_SCENARIO_IDS } from "../metrics/index.ts";
import { writeEventLog } from "./events.ts";
import {
  SAMPLE_DIGEST,
  SAMPLE_E3_RUN_ID,
  SAMPLE_KEY,
  SAMPLE_PROVENANCE,
  SAMPLE_RAW_MARKER,
  SAMPLE_RUN_ID,
  SAMPLE_STATE_MARKER,
  sampleConfig,
  sampleDesignRunResult,
  sampleExitEvalRunResult,
  sampleRunResult,
} from "./fixtures.ts";
import {
  LATEST_JSON_NAME,
  REPORT_SCHEMA_PATH,
  RUN_JSON_NAME,
  ReportSchemaError,
  buildRunReport,
  renderRunJson,
  validateReport,
  writeRunJson,
} from "./json.ts";
import { collectProvenance, gitSha, groundTruthProvenance } from "./provenance.ts";
import { REPORT_SCHEMA_ID } from "./types.ts";
import type { RunReport } from "./types.ts";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-eval-report-"));
  directories.push(directory);
  return directory;
}

const out = temporaryDirectory();
const runDir = join(out, SAMPLE_RUN_ID);
const report: RunReport = buildRunReport({
  result: sampleRunResult(runDir),
  cfg: sampleConfig(),
  provenance: SAMPLE_PROVENANCE,
});

function scenario(id: string, backend: string) {
  const found = report.scenarios.find((entry) => entry.id === id && entry.backend === backend);
  if (found === undefined) throw new Error(`no ${id} × ${backend} in the sample report`);
  return found;
}

describe("the report schema", () => {
  it("is the one the builder names", () => {
    const schema = JSON.parse(readFileSync(REPORT_SCHEMA_PATH, "utf8")) as { $id: string };
    expect(schema.$id).toBe(REPORT_SCHEMA_ID);
  });

  it("accepts a built report", () => {
    expect(validateReport(report)).toBe(report);
  });

  it("accepts a report whose JSON text was read back", () => {
    expect(() => validateReport(JSON.parse(renderRunJson(report)))).not.toThrow();
  });

  it("refuses a member the schema does not declare, naming where it is", () => {
    const polluted = { ...report, run: { ...report.run, api_key: SAMPLE_KEY } };
    expect(() => validateReport(polluted)).toThrow(ReportSchemaError);
    try {
      validateReport(polluted);
    } catch (error) {
      expect((error as ReportSchemaError).issues.join(" ")).toMatch(/\/run/);
    }
  });

  it("still accepts an older report, without its detection-level members", () => {
    if (report.summary === null) throw new Error("the sample run is scored");
    const older = {
      ...report,
      scenarios: report.scenarios.map((entry) => {
        const metrics = { ...entry.metrics };
        delete metrics.detection;
        const pass = { ...entry.pass };
        delete pass.review_diagnosis;
        const older = { ...entry, metrics, pass };
        delete older.suspect_events;
        return older;
      }),
      summary: {
        ...report.summary,
        backends: report.summary.backends.map((backend) => {
          const older = { ...backend };
          delete older.metropt3_detection;
          return older;
        }),
      },
    };
    expect(() => validateReport(older)).not.toThrow();
  });

  it("refuses a MetroPT-3 check that is not labelled in-sample", () => {
    if (report.summary === null) throw new Error("the sample run is scored");
    const unlabelled = {
      ...report,
      summary: {
        ...report.summary,
        metropt3_check: { ...report.summary.metropt3_check, in_sample: false },
      },
    };
    expect(() => validateReport(unlabelled)).toThrow(ReportSchemaError);
  });
});

describe("the run block", () => {
  it("restates the run, its configuration and its provenance", () => {
    expect(report.schema).toBe(REPORT_SCHEMA_ID);
    expect(report.run).toMatchObject({
      id: SAMPLE_RUN_ID,
      mode: "in_process",
      profile: "core",
      scenario_filter: [],
      started_wall_ts: "2026-09-22T12:00:00.000Z",
      finished_wall_ts: "2026-09-22T12:01:30.000Z",
      git_sha: SAMPLE_PROVENANCE.git_sha,
      backend_version: "1.0.0",
      ground_truth: SAMPLE_PROVENANCE.ground_truth,
      thresholds: {
        ticket_min: 0.85,
        review_min: 0.6,
        decision_interval_sim_min: 30,
        episode_clear_sim_min: 120,
        persist_sim_min: 1,
      },
      rules_disabled: ["flow_pulses_missing"],
      prices: { jev_input_per_mtok: 0.042, as_of: "2026-09-19" },
      seed: null,
    });
  });

  it("names the catalog source and its digest", () => {
    expect(report.run.catalog).toEqual({
      source: "reference",
      name: "reference",
      sha256: "e".repeat(64),
      entries: 0,
      faults: 0,
    });
  });

  it("names the alarm registry the replay evaluated", () => {
    expect(["manual", "provisional"]).toContain(report.run.alarm_registry.source);
    expect(report.run.alarm_registry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists the backends with their mode, a mock one as not informative", () => {
    const counters = {
      calls: 3,
      failures: 0,
      failure_reasons: [],
      cassette_hits: 0,
      cassette_misses: 0,
      cassette_miss_digests: [],
      cassette_reused: 0,
      rate_limit: null,
    };
    expect(report.backends).toEqual([
      { name: "rules", model: "rules-v1", mode: "-", informative: true, ...counters },
      { name: "jev", model: "jev-1.13.0", mode: "mock", informative: false, ...counters },
    ]);
  });

  it("carries a cassette backend's hits, misses and missed digests, and a live one's queue", () => {
    const sample = sampleRunResult(runDir);
    const [rules, jev] = sample.backends;
    if (rules === undefined || jev === undefined) {
      throw new Error("the sample run has two backends");
    }
    const cassette = {
      ...jev,
      mode: "cassette" as const,
      informative: true,
      stats: {
        calls: 3,
        failures: 0,
        cassetteHits: 2,
        cassetteMisses: 1,
        cassetteMissDigests: [SAMPLE_DIGEST],
        cassetteReused: 1,
      },
    };
    const live = {
      ...rules,
      name: "llm" as const,
      model: "claude-opus-5",
      mode: "live" as const,
      stats: {
        calls: 3,
        failures: 1,
        cassetteMisses: 0,
        rateLimit: { calls: 5, retries: 1, waitedMs: 60_100 },
      },
    };
    const built = buildRunReport({
      result: { ...sample, backends: [rules, cassette, live] },
      cfg: sampleConfig(),
      provenance: SAMPLE_PROVENANCE,
    });
    expect(validateReport(built)).toBe(built);
    expect(built.backends[1]).toMatchObject({
      mode: "cassette",
      cassette_hits: 2,
      cassette_misses: 1,
      cassette_miss_digests: [SAMPLE_DIGEST],
      cassette_reused: 1,
      rate_limit: null,
    });
    expect(built.backends[2]).toMatchObject({
      mode: "live",
      cassette_hits: 0,
      rate_limit: { calls: 5, retries: 1, waited_ms: 60_100 },
    });
  });

  it("still validates a report written before cassette_reused existed", () => {
    const older = JSON.parse(JSON.stringify(report)) as { backends: Record<string, unknown>[] };
    for (const backend of older.backends) delete backend["cassette_reused"];
    expect(() => validateReport(older)).not.toThrow();
  });
});

describe("a scenario entry", () => {
  const entry = scenario("inject_oil_cooler_fouling", "rules");

  it("gives every ticket its outcome and the window it was scored against", () => {
    expect(
      entry.tickets.map(({ ticket_id, verdict, window_id }) => [ticket_id, verdict, window_id]),
    ).toEqual([
      ["t-warmup", "warmup", null],
      ["t-wrong", "misdiagnosed", "oil_cooler_fouling"],
      ["t-right", "recovered", "oil_cooler_fouling"],
      ["t-again", "duplicate", "oil_cooler_fouling"],
      ["t-benign", "benign", null],
      ["t-excluded", "ignored", null],
      ["t-false", "fp", null],
    ]);
  });

  it("marks what was still open at the end of the replay", () => {
    const open = entry.tickets.filter((ticket) => ticket.open_at_end).map((t) => t.ticket_id);
    expect(open).not.toContain("t-wrong");
    expect(open).toContain("t-false");
    expect(entry.tickets.find((ticket) => ticket.ticket_id === "t-wrong")?.closed_sim_ts).toBe(
      "2020-02-03T06:40:00.000Z",
    );
  });

  it("keeps what re-scoring needs: windows, excluded windows, benign causes and decisions", () => {
    expect(entry.windows).toEqual([
      expect.objectContaining({
        id: "oil_cooler_fouling",
        from: "2020-02-03T02:00:00.000Z",
        lead_from: "2020-02-03T02:00:00.000Z",
        accepted: ["oil_cooler_fouled"],
        benign: false,
        headline: false,
      }),
    ]);
    expect(entry.excluded).toContainEqual({
      id: "repair@2020-02-03T20:00:00.000Z",
      from: "2020-02-03T20:00:00.000Z",
      to: "2020-02-03T21:00:00.000Z",
      reason: "repair",
    });
    expect(entry.benign_fault_ids).toContain("high_ambient_temperature");
    expect(entry.decisions.map((decision) => decision.choice)).toEqual([
      "dryer_purge_leak",
      "oil_cooler_fouled",
      "none_of_these",
    ]);
    expect(entry.replay.covered_machine_days).toBeGreaterThan(0);
  });

  it("carries a decision's state only as its digest", () => {
    const [, second] = entry.decisions;
    expect(second?.state_digest).toBe(SAMPLE_DIGEST);
    expect(entry.decisions[0]?.state_digest).toBeNull();
  });

  it("summarises the decisions by choice and gate", () => {
    expect(entry.decisions_summary).toEqual({
      count: 3,
      failed: 0,
      abstained: 1,
      by_choice: { dryer_purge_leak: 1, oil_cooler_fouled: 1, none_of_these: 1 },
      by_gate: { ticket: 2, review: 0, log: 1 },
    });
  });

  it("records the first raise of every alarm code and the metrics at both levels", () => {
    expect(entry.alarms).toEqual({
      raised: 1,
      first_by_code: [{ code: "W104", sim_ts: "2020-02-03T07:00:00.000Z" }],
    });
    expect(entry.metrics.match.review).toMatchObject({
      tp: 1,
      recovered: 1,
      misdiagnosed: 1,
      duplicates: 1,
      benign: 1,
      ignored: 1,
    });
    expect(entry.metrics.precision_recall.ticket.level).toBe("ticket");
    expect(entry.metrics.lead_times).toEqual([
      expect.objectContaining({
        window_id: "oil_cooler_fouling",
        native_code: "W104",
        lead_minutes: 240,
        qualifier: "",
      }),
    ]);
  });

  it("names its event log relative to the run directory", () => {
    expect(entry.events_file).toBe("scenarios/inject_oil_cooler_fouling.rules.jsonl");
  });

  it("marks a diagnostic scenario as reported, not scored", () => {
    expect(scenario("august_oil_level_aug10", "jev").scored).toBe(false);
    expect(entry.scored).toBe(true);
  });
});

describe("the summary and the gate", () => {
  it("pools only the scored scenarios, per backend", () => {
    expect(report.summary?.headline_backend).toBe("rules");
    expect(report.summary?.backends.map((backend) => [backend.backend, backend.scenarios])).toEqual(
      [
        ["jev", 1],
        ["rules", 1],
      ],
    );
    expect(report.summary?.metropt3_check.in_sample).toBe(true);
  });

  it("writes every comparison row with an llm column, null when it did not run", () => {
    expect(report.summary?.comparison.length).toBeGreaterThan(0);
    for (const row of report.summary?.comparison ?? []) expect(row.llm).toBeNull();
  });

  it("prints both counts of the core-10 gate and the per-backend n/10", () => {
    // Two false tickets break the oil-cooler scenario's allowance of none, at either level.
    expect(report.gate).toMatchObject({
      backend: "rules",
      level: "detection",
      enforced: true,
      complete: false,
      verdict: "attainable",
      pass: true,
      passed: 0,
      scored: 1,
      total: 10,
      positives_passed: 0,
      positives_scored: 1,
      positives_total: 6,
      failed: ["inject_oil_cooler_fouling"],
      core10: { rules_detection: "0/10", jev_diagnosis: "0/10" },
    });
    expect(report.gate?.missing).toHaveLength(9);
  });
});

describe("writeRunJson", () => {
  it("writes run.json and copies it to latest.json beside the run directories", () => {
    const outDir = temporaryDirectory();
    const directory = join(outDir, SAMPLE_RUN_ID);
    const built = buildRunReport({
      result: sampleRunResult(directory),
      cfg: sampleConfig(),
      provenance: SAMPLE_PROVENANCE,
    });
    mkdirSync(directory, { recursive: true });

    const written = writeRunJson(built, directory, outDir);
    expect(written.runJson).toBe(join(directory, RUN_JSON_NAME));
    expect(written.latest).toBe(join(outDir, LATEST_JSON_NAME));
    const text = readFileSync(written.runJson, "utf8");
    expect(readFileSync(written.latest, "utf8")).toBe(text);
    expect(JSON.parse(text)).toEqual(JSON.parse(renderRunJson(built)));
  });

  it("writes nothing when the report does not validate", () => {
    const outDir = temporaryDirectory();
    const broken = { ...report, schema: "urn:fdp:eval:report:v0" } as unknown as RunReport;
    expect(() => writeRunJson(broken, outDir, outDir)).toThrow(ReportSchemaError);
    expect(() => readFileSync(join(outDir, RUN_JSON_NAME))).toThrow();
  });
});

describe("no secret reaches a written file", () => {
  it("run.json and the event logs carry no key, bearer token, raw body or state", () => {
    const outDir = temporaryDirectory();
    const result = sampleRunResult(outDir);
    const built = buildRunReport({ result, cfg: sampleConfig(), provenance: SAMPLE_PROVENANCE });
    const { runJson } = writeRunJson(built, outDir, outDir);
    const texts = [readFileSync(runJson, "utf8")];
    for (const entry of result.results) {
      const path = join(outDir, `${entry.bound.scenario.id}.${entry.run.backend}.jsonl`);
      writeEventLog(path, entry.run.events);
      texts.push(readFileSync(path, "utf8"));
    }
    for (const text of texts) {
      expect(text).not.toContain(SAMPLE_KEY);
      expect(text).not.toContain("Bearer");
      expect(text).not.toContain(SAMPLE_RAW_MARKER);
      expect(text).not.toContain(SAMPLE_STATE_MARKER);
    }
    expect(texts.some((text) => text.includes(SAMPLE_DIGEST))).toBe(true);
  });
});

describe("the tuning and exit_eval blocks", () => {
  const e3Report = buildRunReport({
    result: sampleExitEvalRunResult(join(out, SAMPLE_E3_RUN_ID)),
    cfg: sampleConfig(),
    provenance: SAMPLE_PROVENANCE,
  });
  const exitEval = e3Report.exit_eval;
  if (exitEval === undefined) throw new Error("the E3 sample carries an exit_eval block");

  it("validate, and a run without --tuning and --exit-eval writes neither and stays valid", () => {
    expect(validateReport(e3Report)).toBe(e3Report);
    expect(() => validateReport(JSON.parse(renderRunJson(e3Report)))).not.toThrow();
    expect(report).not.toHaveProperty("exit_eval");
    expect(report).not.toHaveProperty("tuning");
    expect(validateReport(report)).toBe(report);
  });

  it("record the tuning list and the slices it shares with the core-10", () => {
    expect(e3Report.run.profile).toBe("tuning");
    expect(e3Report.tuning?.scenarios).toHaveLength(10);
    expect(e3Report.tuning?.shared_slices.map((entry) => entry.scenario)).toEqual([
      "inject_dryer_tower_switching_failure",
      "inject_intake_valve_sticking",
      "inject_motor_overload",
      "inject_separator_drain_blocked",
    ]);
    expect(e3Report.tuning?.shared_slices[0]).toEqual({
      scenario: "inject_dryer_tower_switching_failure",
      slice: "baseline-feb03",
      core10: [
        "baseline_feb03_normal",
        "inject_air_leak_downstream",
        "inject_high_ambient_benign",
        "inject_oil_cooler_fouling",
        "inject_oil_temperature_sensor_fault",
      ],
    });
  });

  it("name the verdict, the broken conditions and what each uncovered one needed", () => {
    const unreplayed = CORE_10_SCENARIO_IDS.filter(
      (id) => id !== "baseline_feb03_normal" && id !== "depot_lps_jul31",
    );
    expect(exitEval).toMatchObject({
      name: "e3",
      backend: "rules",
      verdict: "fail",
      failed: ["negatives_no_suspect", "depot_no_ticket"],
    });
    expect(exitEval.not_covered).toEqual([
      { condition: "core10_counts", missing: unreplayed },
      { condition: "metropt3_check", missing: ["F1", "F2", "F3", "F4"] },
      {
        condition: "abstain_non_benign",
        missing: ["inject_high_ambient_benign", "inject_oil_temperature_sensor_fault"],
      },
    ]);
    expect(exitEval.conditions.core10_counts).toEqual({
      status: "not_covered",
      level: "detection",
      gate_verdict: "attainable",
      passed: 2,
      total: 10,
      positives_passed: 0,
      positives_total: 6,
      failed: [],
      not_replayed: unreplayed,
    });
    expect(exitEval.conditions.metropt3_check).toEqual({
      status: "not_covered",
      level: "detection",
      detected: [],
      missed: [],
      not_replayed: ["F1", "F2", "F3", "F4"],
      in_sample: true,
    });
  });

  it("record the rules backend's diagnosis baseline beside the conditions, never gated", () => {
    const unreplayed = CORE_10_SCENARIO_IDS.filter(
      (id) => id !== "baseline_feb03_normal" && id !== "depot_lps_jul31",
    );
    expect(exitEval.baseline).toEqual({
      gated: false,
      review_diagnosis: {
        level: "review_diagnosis",
        passed: 2,
        total: 10,
        positives_passed: 0,
        positives_total: 6,
        failed: [],
        not_replayed: unreplayed,
      },
      diagnosis: {
        level: "diagnosis",
        passed: 2,
        total: 10,
        positives_passed: 0,
        positives_total: 6,
        failed: [],
        not_replayed: unreplayed,
      },
      metropt3_check: {
        level: "review",
        detected: [],
        missed: [],
        not_replayed: ["F1", "F2", "F3", "F4"],
        in_sample: true,
      },
    });
  });

  it("give each breaking suspect event and ticket exactly as scenarios[] reports it", () => {
    const negatives = exitEval.conditions.negatives_no_suspect;
    expect(negatives.status).toBe("fail");
    expect(
      negatives.scenarios.map((entry) => [entry.scenario, entry.status, entry.replay]),
    ).toEqual([
      ["baseline_feb03_normal", "fail", "whole"],
      ["frozen_logger_jun22", "pass", "whole"],
    ]);
    const baseline = e3Report.scenarios.find((entry) => entry.id === "baseline_feb03_normal");
    expect(negatives.scenarios[0]?.tickets).toEqual([]);
    expect(negatives.scenarios[0]?.suspects).toEqual(baseline?.suspect_events);
    expect(negatives.scenarios[0]?.suspects).toEqual([
      { event_id: "s-early", sim_ts: "2020-02-03T00:20:00.000Z", symptom_key: "frequent_cycling" },
    ]);
    expect(baseline?.pass).toMatchObject({ detection: true, review_diagnosis: true });
    expect(baseline?.metrics.detection).toEqual({
      suspects: 0,
      warmup_suspects: 1,
      outside_windows: 0,
      windows: [],
    });

    const abstain = exitEval.conditions.abstain_non_benign;
    expect(abstain.scenarios.map((entry) => [entry.scenario, entry.status])).toEqual([
      ["inject_high_ambient_benign", "not_covered"],
      ["inject_oil_temperature_sensor_fault", "not_covered"],
    ]);

    const depot = exitEval.conditions.depot_no_ticket;
    expect(depot).toMatchObject({ scenario: "depot_lps_jul31", status: "fail", replay: "whole" });
    expect(depot.tickets).toEqual(
      e3Report.scenarios.find((entry) => entry.id === "depot_lps_jul31")?.tickets,
    );
    expect(depot.tickets.map((entry) => entry.ticket_id)).toEqual(["t-depot"]);
    expect(depot.suspects).toEqual([]);
  });

  it("refuse an exit_eval block the schema does not describe", () => {
    const partial = { ...e3Report, exit_eval: { ...exitEval, verdict: "partial" } };
    expect(() => validateReport(partial)).toThrow(ReportSchemaError);
    const extra = {
      ...e3Report,
      exit_eval: { ...exitEval, conditions: { ...exitEval.conditions, lead_time: {} } },
    };
    expect(() => validateReport(extra)).toThrow(ReportSchemaError);
    const unlabelled = {
      ...e3Report,
      exit_eval: {
        ...exitEval,
        conditions: {
          ...exitEval.conditions,
          metropt3_check: { ...exitEval.conditions.metropt3_check, in_sample: false },
        },
      },
    };
    expect(() => validateReport(unlabelled)).toThrow(ReportSchemaError);
  });
});

describe("the design-target block", () => {
  const designReport = buildRunReport({
    result: sampleDesignRunResult(join(out, "design")),
    cfg: sampleConfig(),
    provenance: SAMPLE_PROVENANCE,
  });
  const may19 = designReport.scenarios.find((entry) => entry.id === "unlabelled_leak_may19");

  it("validates, and a run whose scenarios carry no target writes none", () => {
    expect(validateReport(designReport)).toBe(designReport);
    expect(report).not.toHaveProperty("design_targets");
  });

  it("carries the scenario file's target beside its scenario entry", () => {
    expect(may19?.design_target).toEqual({
      accepted: ["dryer_purge_leak", "downstream_air_leak"],
      provenance: expect.stringContaining("inferred from the signature-A analysis, unverified"),
    });
    expect(may19?.scored).toBe(false);
  });

  it("reads the tickets inside the unlabelled episode, marked never gated", () => {
    expect(designReport.design_targets).toEqual([
      {
        scenario: "unlabelled_leak_may19",
        backend: "rules",
        gated: false,
        accepted: ["dryer_purge_leak", "downstream_air_leak"],
        provenance: expect.stringContaining("unverified"),
        episodes: [{ from: "2020-05-19T22:22:17.000Z", to: "2020-05-20T23:02:33.000Z" }],
        review: {
          on_target: 1,
          off_target: 1,
          benign: 0,
          outside: 1,
          first: {
            ticket_id: "t-silencer",
            opened_sim_ts: "2020-05-19T23:00:00.000Z",
            fault_at_open: "purge_silencer_damaged",
          },
          met: false,
        },
        ticket: {
          on_target: 1,
          off_target: 0,
          benign: 0,
          outside: 1,
          first: {
            ticket_id: "t-purge",
            opened_sim_ts: "2020-05-20T02:00:00.000Z",
            fault_at_open: "dryer_purge_leak",
          },
          met: true,
        },
        decisions: {
          total: 3,
          on_target: 1,
          by_choice: { purge_silencer_damaged: 1, dryer_purge_leak: 1, none_of_these: 1 },
        },
      },
    ]);
  });

  it("leaves the summary and the gate as they would be without the target", () => {
    const stripped = sampleDesignRunResult(join(out, "design"));
    const plain = buildRunReport({
      result: { ...stripped, designTargets: undefined } as unknown as typeof stripped,
      cfg: sampleConfig(),
      provenance: SAMPLE_PROVENANCE,
    });
    expect(plain.summary).toEqual(designReport.summary);
    expect(plain.gate).toEqual(designReport.gate);
  });

  it("refuses a reading that claims to be gated", () => {
    const readings = designReport.design_targets ?? [];
    const gated = {
      ...designReport,
      design_targets: readings.map((reading) => ({ ...reading, gated: true })),
    };
    expect(() => validateReport(gated)).toThrow(ReportSchemaError);
  });
});

describe("provenance", () => {
  it("names the commit when the checkout has one", () => {
    const sha = gitSha();
    if (sha !== null) expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is null rather than an error outside a repository", () => {
    expect(gitSha(tmpdir())).toBeNull();
  });

  it("digests the ground-truth data it scores against", () => {
    const truth = groundTruthProvenance();
    expect(truth.package_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(truth.failures_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(truth.injections_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("collects the runtime and the backend version", () => {
    const provenance = collectProvenance();
    expect(provenance.node).toBe(process.version);
    expect(provenance.backend_version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
