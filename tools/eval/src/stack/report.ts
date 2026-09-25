// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Stack mode's report: the same `run.json` and `report.md` an in-process run
// writes, with `run.mode: "stack"`, plus what only a stack has to say.
//
// A scored stack is handed to the in-process writers as a `RunResult` — one
// scenario, `stack_replay`, one pair per backend — so its report validates
// against the same schema and reads the same way, and nothing about a stack
// can drift from how a run is written. What the writers have no field for
// goes beside them: `stack.json` and a closing "Stack inputs" section of
// report.md name the replayed segments, the markers and the presets and
// failures they resolve to, every scoring window and where it came from, the
// thresholds and their source, and the cost ledger. That is what E5 reads to
// see the jump to the F3 preset and the oil-cooler injection window.
//
// A stack run never touches `latest.json`: that file is the newest in-process
// run, the one `sweep` and CI read, and a stack run is neither.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { allDecisionsFailed } from "../backends/types.ts";
import type { EvalCatalog, GateThresholds } from "../config.ts";
import { summarise as summariseRun } from "../metrics/index.ts";
import type { AlarmRegistry } from "../replay/index.ts";
import { renderConsoleSummary } from "../report/console.ts";
import { RUN_JSON_NAME, buildRunReport, renderRunJson, validateReport } from "../report/json.ts";
import type { ReportConfig } from "../report/json.ts";
import { REPORT_MD_NAME, renderMarkdown } from "../report/markdown.ts";
import type { Provenance } from "../report/provenance.ts";
import type { RunReport } from "../report/types.ts";
import { headlineBackend, judgeRunGate } from "../runner/run.ts";
import type { BackendRecord, RunResult } from "../runner/types.ts";
import type { StackRange } from "./db.ts";
import { STACK_PROFILE } from "./score.ts";
import type { StackScore } from "./score.ts";

/** The stack-only record beside `run.json`. */
export const STACK_JSON_NAME = "stack.json";

/** The `schema` member of `stack.json`. */
export const STACK_SCHEMA_ID = "urn:fdp:eval:stack:v1";

/** What the stack's run is written with, beside the score itself. */
export interface StackRunInput {
  readonly score: StackScore;
  readonly runId: string;
  readonly runDir: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly catalog: EvalCatalog;
  readonly alarmRegistry: AlarmRegistry | undefined;
  readonly range: StackRange;
  readonly thresholdsSource: "decisions" | "environment";
  readonly config: ReportConfig;
  readonly provenance: Provenance;
}

/** The files a stack run wrote. */
export interface StackRunFiles {
  readonly report: RunReport;
  readonly runJson: string;
  readonly reportMd: string;
  readonly stackJson: string;
}

function backendRecord(entry: StackScore["backends"][number]): BackendRecord {
  const stats = { calls: entry.decisionRows, failures: entry.failures, cassetteMisses: 0 };
  return {
    name: entry.backend,
    model: entry.model,
    mode: "-",
    informative: !allDecisionsFailed(stats),
    stats,
  };
}

/** The scored stack as the record the in-process writers read. */
export function stackRunResult(input: StackRunInput): RunResult {
  const { score } = input;
  const backends = score.backends.map(backendRecord);
  const results = score.backends.map((entry) => entry.result);
  const headline = headlineBackend(backends);
  const summary = summariseRun(
    results.map((result) => result.metrics),
    headline === undefined ? {} : { headlineBackend: headline },
  );
  return {
    runId: input.runId,
    runDir: input.runDir,
    profile: STACK_PROFILE,
    mode: "stack",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    catalog: input.catalog,
    alarmRegistry: input.alarmRegistry,
    backends,
    results,
    summary,
    gate: judgeRunGate(summary.gate, backends),
  };
}

function iso(value: Date): string {
  return value.toISOString();
}

/** `stack.json`: what the stack replayed and where every scoring window came from. */
export function stackDocument(input: StackRunInput, thresholds: GateThresholds): unknown {
  const { score } = input;
  return {
    schema: STACK_SCHEMA_ID,
    run_id: input.runId,
    unit_id: score.unitId,
    range: {
      from: input.range.from === undefined ? null : iso(input.range.from),
      to: input.range.to === undefined ? null : iso(input.range.to),
    },
    coverage: {
      replay: { from: iso(score.coverage.replay.from), to: iso(score.coverage.replay.to) },
      segments: score.coverage.segments.map((segment) => ({
        from: iso(segment.from),
        to: iso(segment.to),
      })),
      holes: score.coverage.holes.length,
      minutes: score.coverage.minutes,
      samples: score.coverage.samples,
    },
    markers: score.markers.map((marker) => ({
      kind: marker.kind,
      preset_id: marker.presetId,
      failure_id: marker.failureId,
      sim_ts_from: iso(marker.simTsFrom),
      sim_ts_to: iso(marker.simTsTo),
      wall_ts: iso(marker.wallTs),
    })),
    windows: score.windows.map((entry) => ({
      id: entry.window.id,
      kind: entry.kind,
      from: iso(entry.window.from),
      to: iso(entry.window.to),
      accepted: [...entry.window.accepted],
      benign: entry.window.benign,
      reached_by_jump: entry.reachedByJump,
    })),
    thresholds: {
      ticket_min: thresholds.ticketMin,
      review_min: thresholds.reviewMin,
      source: input.thresholdsSource,
    },
    ledger: score.ledger.map((row) => ({ ...row })),
  };
}

/** The closing section of a stack run's report.md. */
export function stackSection(input: StackRunInput, thresholds: GateThresholds): string {
  const { score } = input;
  const lines = [
    "## Stack inputs",
    "",
    `Unit \`${score.unitId}\`; replayed ${score.coverage.minutes} telemetry minutes (${score.coverage.samples} samples) in ${score.coverage.segments.length} segment(s):`,
    "",
    ...score.coverage.segments.map((segment) => `- ${iso(segment.from)} → ${iso(segment.to)}`),
    "",
    score.markers.length === 0 ? "Markers: none." : `Markers (${score.markers.length}):`,
    ...score.markers.map(
      (marker) =>
        `- ${marker.kind} ${iso(marker.simTsFrom)} → ${iso(marker.simTsTo)}` +
        (marker.presetId === null ? "" : ` to preset \`${marker.presetId}\``) +
        (marker.failureId === null ? "" : ` (failure ${marker.failureId})`),
    ),
    "",
    score.windows.length === 0 ? "Scoring windows: none." : "Scoring windows:",
    ...score.windows.map(
      (entry) =>
        `- ${entry.kind} \`${entry.window.id}\` ${iso(entry.window.from)} → ${iso(entry.window.to)}; accepted ${entry.window.accepted.join(", ")}` +
        `${entry.window.benign ? " (benign)" : ""}${entry.reachedByJump ? "; reached by a jump" : ""}`,
    ),
    "",
    `Gate thresholds: ticket ≥ ${thresholds.ticketMin}, review ≥ ${thresholds.reviewMin}, read from the ${input.thresholdsSource === "decisions" ? "stack's decision messages" : "environment (no decision states them)"}.`,
    "",
    score.ledger.length === 0 ? "Cost ledger: empty." : "Cost ledger:",
    ...score.ledger.map(
      (row) =>
        `- ${row.backend} \`${row.model}\`: ${row.calls} call(s), ${row.input_tokens} input and ${row.output_tokens} output tokens, $${row.cost_usd.toFixed(10)} at $${row.price_input_per_mtok}/$${row.price_output_per_mtok} per Mtok (prices as of ${row.prices_as_of})`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** One JSON line per ticket and decision of one backend: the stack pair's event log. */
function eventLog(entry: StackScore["backends"][number]): string {
  const { summary } = entry.result;
  const lines = [
    ...summary.tickets.map((ticket) => ({ type: "ticket", ...ticket })),
    ...summary.decisions.map((decision) => ({ type: "decision", ...decision })),
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
}

/**
 * Writes a scored stack: `run.json` (validated first), `report.md`, `stack.json` and one event
 * log per backend under `scenarios/`. `latest.json` is left alone.
 *
 * @throws ReportSchemaError before anything is written when the report does not validate.
 */
export function writeStackRun(input: StackRunInput, scenariosDir: string): StackRunFiles {
  const result = stackRunResult(input);
  const report = validateReport(
    buildRunReport({ result, cfg: input.config, provenance: input.provenance }),
  );
  const thresholds = input.config.gate;

  const runJson = join(input.runDir, RUN_JSON_NAME);
  writeFileSync(runJson, renderRunJson(report), "utf8");
  const reportMd = join(input.runDir, REPORT_MD_NAME);
  writeFileSync(reportMd, `${renderMarkdown(report)}\n${stackSection(input, thresholds)}`, "utf8");
  const stackJson = join(input.runDir, STACK_JSON_NAME);
  writeFileSync(
    stackJson,
    `${JSON.stringify(stackDocument(input, thresholds), null, 2)}\n`,
    "utf8",
  );
  for (const entry of input.score.backends) {
    writeFileSync(
      join(scenariosDir, `${entry.result.run.scenarioId}.${entry.backend}.jsonl`),
      eventLog(entry),
      "utf8",
    );
  }
  return { report, runJson, reportMd, stackJson };
}

/** The console summary of a stack run: the in-process table, then the stack's own lines. */
export function renderStackConsole(files: StackRunFiles, input: StackRunInput): string {
  const { score } = input;
  const jumps = score.markers.filter((marker) => marker.kind === "jump");
  const lines = [
    `stack: ${score.coverage.segments.length} replayed segment(s), ${score.coverage.minutes} minutes; ` +
      `${jumps.length} jump(s)${jumps.length === 0 ? "" : ` to ${jumps.map((marker) => marker.presetId ?? "-").join(", ")}`}`,
    ...score.windows.map(
      (entry) =>
        `stack window: ${entry.kind} ${entry.window.id} (${entry.window.accepted.join(", ")})${entry.reachedByJump ? ", reached by a jump" : ""}`,
    ),
    `stack.json: ${files.stackJson}`,
  ];
  return (
    renderConsoleSummary(files.report, { runJson: files.runJson, reportMd: files.reportMd }) +
    `${lines.join("\n")}\n`
  );
}
