// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The summary `fdp-eval run` prints on stdout when it is done: one line per
// scenario with each backend's three pass flags (detection · review diagnosis ·
// diagnosis), the detection-level MetroPT-3 check of a backend gated at
// detection, one line per design-target reading marked never gated, a
// `WARNING:` line for every backend with failed decisions (a backend whose
// every decision failed is also marked not informative in its heading, and a
// gate it heads reads NOT SCORED), the gate with both of its counts, the
// cassette hits and misses or the live calls of every backend that reached a
// model that way, the in-sample MetroPT-3 check, the whole recording's own E6
// figures when the run replayed it, the tuning list's shared slices and the
// `--exit-eval` verdict when there are any, and where the reports are. Log
// lines go to stderr (`src/log.ts`), so this table is the only thing on stdout
// and can be piped.

import {
  FAILED_LABEL,
  MOCK_LABEL,
  everyDecisionFailed,
  exitEvalHeadline,
  failureWarning,
  headlineAnsweredNothing,
  passCell,
  verdictText,
} from "./markdown.ts";
import type { ReportBackend, RunReport } from "./types.ts";

/** Where the run's files were written, as the caller wants them printed. */
export interface WrittenFiles {
  readonly runJson: string;
  readonly reportMd: string;
}

function heading(backend: ReportBackend): string {
  const failed = everyDecisionFailed(backend);
  if (backend.mode === "-") return failed ? `${backend.name} (${FAILED_LABEL})` : backend.name;
  if (backend.mode === "mock") return `${backend.name} (${MOCK_LABEL})`;
  return `${backend.name} (${backend.mode}${failed ? ` — ${FAILED_LABEL}` : ""})`;
}

function gateLine(report: RunReport): string {
  const { gate } = report;
  if (gate === null) return "gate: not measured (no scenario was scored)";
  if (gate.verdict === "not_scored") {
    return `gate: NOT SCORED: every decision of ${gate.backend} failed; no core-10 scenario was scored at ${gate.level} level`;
  }
  const counts =
    `${gate.backend} at ${gate.level} level: ${gate.passed}/${gate.total} core-10, ` +
    `${gate.positives_passed}/${gate.positives_total} positives`;
  const scope = gate.complete
    ? ""
    : ` (partial: ${gate.scored} of ${gate.total} scored, ${gate.positives_scored} of ${gate.positives_total} positives)`;
  return `gate: ${verdictText(gate.verdict)}: ${counts}${scope}`;
}

/** A `WARNING:` line per backend whose decisions failed, printed right above the gate. */
function failureLines(report: RunReport): string[] {
  return report.backends.flatMap((backend) => {
    const warning = failureWarning(backend);
    return warning === undefined ? [] : [`WARNING: ${warning}`];
  });
}

function checkLine(report: RunReport): string | undefined {
  const check = report.summary?.metropt3_check;
  if (check === undefined) return undefined;
  if (headlineAnsweredNothing(report)) {
    return `MetroPT-3 check (in-sample): not measured, every decision of ${report.summary?.headline_backend ?? "the headline backend"} failed`;
  }
  const wanted = check.detected.length + check.missed.length;
  return `MetroPT-3 check (in-sample, ${check.level} level): ${check.detected.length}/${wanted} detected`;
}

/** The headline backend's detection-level MetroPT-3 check, when its gate is read there. */
function detectionCheckLine(report: RunReport): string | undefined {
  const summary = report.summary;
  if (summary === null || headlineAnsweredNothing(report)) return undefined;
  const headline = summary.backends.find((entry) => entry.backend === summary.headline_backend);
  const check = headline?.gate.level === "detection" ? headline.metropt3_detection : undefined;
  if (check === undefined) return undefined;
  const wanted = check.detected.length + check.missed.length;
  return `MetroPT-3 check (in-sample, detection level: a suspect event in the span, in time): ${check.detected.length}/${wanted} detected`;
}

/** One line per design-target reading, each marked as never gated. */
function designLines(report: RunReport): string[] {
  return (report.design_targets ?? []).map(
    (reading) =>
      `design target (reported only, never gated) ${reading.scenario} ${reading.backend}: ` +
      `${reading.accepted.join(" or ")}; first review item ${reading.review.first?.fault_at_open ?? "none"}` +
      ` (${reading.review.met ? "on target" : "not on target"}), first ticket-level ${reading.ticket.first?.fault_at_open ?? "none"}` +
      ` (${reading.ticket.met ? "on target" : "not on target"}); decisions inside ${reading.decisions.on_target}/${reading.decisions.total} on target`,
  );
}

/** How each cassette or live backend was reached: its hits and misses, or its live calls. */
function modeLines(report: RunReport): string[] {
  return report.backends.flatMap((backend) => {
    if (backend.mode === "cassette") {
      const reused = backend.cassette_reused ?? 0;
      const repeats =
        reused === 0 ? "" : `, ${reused} reused an earlier answer (fewer recorded than asked)`;
      return [
        `${backend.name}: cassette mode, ${backend.cassette_hits} hit(s), ${backend.cassette_misses} miss(es)${repeats}`,
      ];
    }
    if (backend.mode === "live") {
      const retries = backend.rate_limit?.retries ?? 0;
      return [
        `${backend.name}: live mode, ${backend.calls} call(s), ${backend.failures} failed, ${retries} rate-limit retr(ies)`,
      ];
    }
    return [];
  });
}

/** A tuning run's list and the slices it shares with the core-10, reported, never refused. */
function tuningLines(report: RunReport): string[] {
  const { tuning } = report;
  if (tuning === undefined) return [];
  const shared = tuning.shared_slices;
  return [
    `tuning list: ${tuning.scenarios.length} scenarios; ${shared.length} share a slice with the core-10 (allowed by the dev/test split, reported only)`,
    ...shared.map(
      (entry) => `  ${entry.scenario} shares ${entry.slice} with ${entry.core10.join(", ")}`,
    ),
  ];
}

/** One line per backend that replayed the whole recording (E6). */
function fullRecordingLines(report: RunReport): string[] {
  return (report.full_recording ?? []).map((entry) => {
    const { ticket, review } = entry.metropt3_check;
    const count = (check: typeof ticket) =>
      `${check.detected.length}/${check.detected.length + check.missed.length}`;
    const rate = (value: number | null) => (value === null ? "-" : value.toFixed(3));
    return (
      `whole recording (${entry.scenario}, ${entry.backend}): MetroPT-3 check ${count(ticket)} ticket, ` +
      `${count(review)} review; false tickets per machine-day ${rate(entry.false_tickets_per_machine_day.ticket)} ticket, ` +
      `${rate(entry.false_tickets_per_machine_day.review)} review over ${entry.negative_machine_days.toFixed(1)} negative machine-days; ` +
      `${entry.unlabelled_detections.length} detection(s) inside unlabelled episodes`
    );
  });
}

/** The text printed at the end of a run; each line ends with a newline. */
export function renderConsoleSummary(report: RunReport, files: WrittenFiles): string {
  const ids = [...new Set(report.scenarios.map((scenario) => scenario.id))];
  const columns = report.backends.map(heading);
  const idWidth = Math.max("scenario".length, ...ids.map((id) => id.length));
  const splitWidth = "split".length;
  const cellWidth = Math.max(
    "pass · pass · pass".length,
    ...columns.map((column) => column.length),
  );

  const line = (first: string, split: string, cells: readonly string[]) =>
    [first.padEnd(idWidth), split.padEnd(splitWidth), ...cells.map((c) => c.padEnd(cellWidth))]
      .join("  ")
      .trimEnd();

  const lines = [
    `fdp-eval run ${report.run.id} (profile ${report.run.profile}; cells read detection · review diagnosis · diagnosis)`,
    line("scenario", "split", columns),
    ...ids.map((id) => {
      const split = report.scenarios.find((scenario) => scenario.id === id)?.split ?? "-";
      return line(
        id,
        split,
        report.backends.map((backend) => passCell(report, id, backend.name)),
      );
    }),
    ...failureLines(report),
    gateLine(report),
    ...modeLines(report),
  ];
  const detection = detectionCheckLine(report);
  if (detection !== undefined) lines.push(detection);
  const check = checkLine(report);
  if (check !== undefined) lines.push(check);
  lines.push(...fullRecordingLines(report));
  lines.push(...tuningLines(report));
  lines.push(...designLines(report));
  if (report.exit_eval !== undefined) lines.push(exitEvalHeadline(report.exit_eval));
  lines.push(`run.json: ${files.runJson}`, `report.md: ${files.reportMd}`);
  return `${lines.join("\n")}\n`;
}
