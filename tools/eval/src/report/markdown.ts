// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `report.md`: `run.json` for a person.
//
// It is rendered from the report document alone, never from the in-memory
// run, so a stored `run.json` renders to the same page months later and the
// two can never say different things. The sections come in the order the
// brief fixes — headline, comparison, per fault, lead times, abstention, cost,
// one section per scenario, caveats — and every figure keeps its level and
// its backend's mode beside it:
//
// - a mock column is headed "mock — not informative", and a notice
//   above every table carrying Jev figures says they stay in the gitignored
//   `reports/` until the vendor's publication terms allow otherwise;
// - a backend with failed decisions opens the headline with a bold warning
//   that counts them and gives their reasons; when every decision failed its
//   column is marked not informative, its count reads "not scored", the gate
//   of a run it heads is NOT SCORED and the MetroPT-3 check not measured;
// - a cassette backend's caveat gives its hits and misses, every missed
//   request digest and the hits that reused an answer because the recording
//   kept fewer than the run asked for, a live one's the live queue's
//   requests, retries and waits, and the cost table ends with the run's
//   total;
// - the gate prints both of its counts (at least 8/10 and 5/6 positives), the
//   MetroPT-3 check is labelled in-sample, and every scenario is shown with
//   its split;
// - a `--tuning` run lists, under the caveats, the tuning scenarios that share
//   a slice with the core-10;
// - an `--exit-eval e3` run prints the E3 verdict in the headline, every
//   condition with its evidence below it, and an incomplete check as
//   "not a pass" with what it did not see; the conditions are read at
//   detection level and the rules backend's ticket figures follow them
//   as a baseline that is never gated;
// - every scenario cell reads detection · review diagnosis · diagnosis,
//   and a backend gated at detection gets its detection-level MetroPT-3 check
//   beside the ticket-level one;
// - a design target is printed apart from every figure, in its
//   scenario's section and under the caveats, as reported and never gated;
// - a run that replayed the whole recording (the `full` profile) prints that
//   recording's own MetroPT-3 check, false-ticket rate and unlabelled-episode
//   detections in the headline (E6);
// - the header names the catalog source and its digest.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ReportBackend,
  ReportBaselineCounts,
  ReportComparisonRow,
  ReportCost,
  ReportDesignLevel,
  ReportDesignReading,
  ReportE3Scenario,
  ReportExitEval,
  ReportExitEvalGap,
  ReportExitEvalStatus,
  ReportFullRecording,
  ReportGate,
  ReportMetropt3Check,
  ReportScenario,
  ReportSummary,
  ReportSuspect,
  ReportTicket,
  ReportTuning,
  RunReport,
} from "./types.ts";

/** The report inside a run's directory. */
export const REPORT_MD_NAME = "report.md";

/** The section headings, in the order they appear. */
export const SECTION_HEADINGS = [
  "Headline",
  "Comparison",
  "Per-fault precision and recall",
  "Lead times",
  "Abstention",
  "Cost",
  "Scenarios",
  "Caveats",
] as const;

/** What a mock column is headed with. */
export const MOCK_LABEL = "mock — not informative";

/** What a column is marked with when every decision of its backend failed. */
export const FAILED_LABEL = "not informative, every decision failed";

/** Whether a backend was asked for decisions and every one of them failed. */
export function everyDecisionFailed(backend: Pick<ReportBackend, "calls" | "failures">): boolean {
  return backend.calls > 0 && backend.failures >= backend.calls;
}

/**
 * The one sentence a backend with failed decisions is flagged with, the same on the page and on
 * the console: how many failed, why, and what that does to its figures. `undefined` when none
 * failed.
 */
export function failureWarning(backend: ReportBackend): string | undefined {
  if (backend.failures === 0) return undefined;
  const who = backend.mode === "-" ? backend.name : `${backend.name} (${backend.mode})`;
  const reasons = (backend.failure_reasons ?? [])
    .map((entry) => `${entry.reason} ×${entry.count}`)
    .join("; ");
  const why = reasons === "" ? "" : ` — ${reasons}`;
  return everyDecisionFailed(backend)
    ? `${who}: every one of its ${backend.calls} decision(s) failed${why}. Its column is not informative and its core-10 gate is not scored.`
    : `${who}: ${backend.failures} of its ${backend.calls} decision(s) failed${why}. A failed decision has no choice, so its figures count those as missing.`;
}

/** The line printed above any table that carries Jev figures. */
export const JEV_NOTICE =
  "> Jev-derived figures stay in the gitignored `reports/` until the vendor's publication terms allow otherwise.";

/**
 * The licence the rendered page carries: evaluation figures are documentation, not code.
 *
 * Fenced off from `reuse lint`, which would otherwise read the literals as this file's own
 * declaration.
 */
/* REUSE-IgnoreStart */
const LICENCE_HEADER: readonly string[] = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
/* REUSE-IgnoreEnd */

/** The comparison rows the table shows, in order, with the metric names `compare.ts` emits. */
const COMPARISON_ROWS: readonly { readonly label: string; readonly metric: string }[] = [
  { label: "Precision, micro (ticket level)", metric: "precision (ticket, micro)" },
  { label: "Precision, macro (ticket level)", metric: "precision (ticket, macro)" },
  { label: "Recall, micro (ticket level)", metric: "recall (ticket, micro)" },
  { label: "Recall, macro (ticket level)", metric: "recall (ticket, macro)" },
  { label: "Mean lead time vs native alarm (min)", metric: "mean lead time vs native alarm (min)" },
  { label: "Tickets per machine-day", metric: "tickets per machine-day" },
  { label: "False tickets per machine-day", metric: "false tickets per machine-day" },
  { label: "Abstention accuracy", metric: "abstention accuracy" },
  { label: "Explicit abstention rate", metric: "explicit abstention rate" },
  { label: "Cost, total (USD)", metric: "cost (USD)" },
  { label: "Cost per ticket (USD)", metric: "cost per ticket (USD)" },
];

/** The in-process limitations every report states. */
const IN_PROCESS_LIMITATIONS =
  "In-process run: retrieval is the catalog retriever (signal moves and keywords), not the Postgres vector and full-text search of the stack; there is no MQTT or WebSocket transport and no heartbeat. `fdp-eval score-stack` measures the stack itself.";

/** What a stack run's report states instead. */
const STACK_LIMITATIONS =
  "Stack run: scored from the database of a running Compose stack as role `eval`, read-only. Retrieval used the backend's Postgres path (vector and full-text search) and every backend answered as the stack was configured, so a Jev column from a stack pointed at the mock TypeSafe server is not informative. Covered time is the telemetry minutes the stack aggregated, minus the jumps, the gaps and the excluded windows.";

// --- Formatting ----------------------------------------------------------------

const DASH = "—";

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(" | ")} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)];
}

function ratio(value: number | null, digits = 3): string {
  return value === null ? DASH : value.toFixed(digits);
}

function minutes(value: number | null): string {
  return value === null ? DASH : value.toFixed(1);
}

function usd(value: number | null): string {
  return value === null ? DASH : `$${value.toFixed(6)}`;
}

function code(text: string): string {
  return `\`${text}\``;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function passFail(value: boolean): string {
  return value ? "pass" : "FAIL";
}

/**
 * A backend's column heading: its name, its mode when it reaches a model, and "not informative"
 * for a mock column and for a backend whose every decision failed.
 */
function columnHeading(backend: ReportBackend): string {
  const failed = everyDecisionFailed(backend);
  if (backend.mode === "-") return failed ? `${backend.name} · ${FAILED_LABEL}` : backend.name;
  if (backend.mode === "mock") return `${backend.name} · ${MOCK_LABEL}`;
  return `${backend.name} · ${backend.mode}${failed ? ` — ${FAILED_LABEL}` : ""}`;
}

function hasJev(report: RunReport): boolean {
  return report.backends.some((backend) => backend.name === "jev");
}

/** The Jev notice and a blank line, when the table below it carries Jev figures. */
function jevNotice(report: RunReport): string[] {
  return hasJev(report) ? [JEV_NOTICE, ""] : [];
}

function backendOf(report: RunReport, name: string): ReportBackend | undefined {
  return report.backends.find((backend) => backend.name === name);
}

/**
 * The backends the gate ran with a pair other than the global one (Jev's own pair), as
 * `" (jev: ticket ≥ …, review ≥ …)"`; empty when every backend ran with the global pair.
 */
function ownPairs(report: RunReport): string {
  const { ticket_min: ticketMin, review_min: reviewMin } = report.run.thresholds;
  const own = report.backends.flatMap((backend) =>
    backend.thresholds === undefined ||
    (backend.thresholds.ticket_min === ticketMin && backend.thresholds.review_min === reviewMin)
      ? []
      : [
          `${backend.name}: ticket ≥ ${backend.thresholds.ticket_min}, review ≥ ${backend.thresholds.review_min}`,
        ],
  );
  return own.length === 0 ? "" : ` (${own.join("; ")})`;
}

// --- Sections ------------------------------------------------------------------

function header(report: RunReport): string[] {
  const { run } = report;
  const backends = report.backends
    .map((backend) => `${columnHeading(backend)} (${code(backend.model)})`)
    .join(", ");
  const pairs = report.scenarios.length;
  const registry =
    run.alarm_registry.sha256 === null
      ? run.alarm_registry.source
      : `${run.alarm_registry.source}, sha256 ${code(run.alarm_registry.sha256)}`;
  const truth = run.ground_truth;
  return [
    ...LICENCE_HEADER,
    "",
    `# Evaluation report ${code(run.id)}`,
    "",
    ...table(
      ["Field", "Value"],
      [
        ["Profile", `${run.profile} (${pairs} scenario × backend pairs)`],
        [
          "Scenario filter",
          run.scenario_filter.length === 0 ? DASH : run.scenario_filter.join(", "),
        ],
        ["Backends", backends],
        [
          "Catalog",
          `${code(run.catalog.name)}, sha256 ${code(run.catalog.sha256)} (${run.catalog.entries} entries, ${run.catalog.faults} faults)`,
        ],
        ["Alarm registry", registry],
        [
          "Ground truth",
          `@fdp/ground-truth ${truth.package_version}; failure table sha256 ${code(truth.failures_sha256)}; injections sha256 ${truth.injections_sha256 === null ? DASH : code(truth.injections_sha256)}`,
        ],
        [
          "Gate thresholds",
          `ticket ≥ ${run.thresholds.ticket_min}, review ≥ ${run.thresholds.review_min}` +
            ownPairs(report) +
            `; decision every ${run.thresholds.decision_interval_sim_min} sim-min; episode clears after ${run.thresholds.episode_clear_sim_min} sim-min` +
            (run.thresholds.persist_sim_min === undefined
              ? ""
              : `; review or ticket only after ${run.thresholds.persist_sim_min} sim-min of unbroken evidence`),
        ],
        ["Rules left out", run.rules_disabled.length === 0 ? DASH : run.rules_disabled.join(", ")],
        [
          "Prices",
          `Jev $${run.prices.jev_input_per_mtok}/Mtok input; LLM $${run.prices.llm_input_per_mtok}/$${run.prices.llm_output_per_mtok} per Mtok in/out; as of ${run.prices.as_of}`,
        ],
        ["Commit", run.git_sha === null ? DASH : code(run.git_sha)],
        ["Runtime", `Node ${run.node}; @fdp/backend ${run.backend_version}`],
        ["Wall clock", `${run.started_wall_ts} → ${run.finished_wall_ts}`],
      ],
    ),
    "",
  ];
}

/** A gate verdict as the headline and the console print it: `NOT SCORED`, `FAIL`, … */
export function verdictText(verdict: ReportGate["verdict"]): string {
  return verdict === "not_scored" ? "NOT SCORED" : verdict.toUpperCase();
}

/** One backend's core-10 count, or why it has none. */
function core10Text(report: RunReport, name: string, count: string | null): string {
  if (count !== null) return count;
  const backend = backendOf(report, name);
  if (backend !== undefined && everyDecisionFailed(backend)) {
    return "not scored (every decision failed)";
  }
  return DASH;
}

function gateLines(gate: ReportGate, report: RunReport): string[] {
  const perBackend = [
    `- Per backend: rules at detection level ${core10Text(report, "rules", gate.core10.rules_detection)}; ` +
      `jev at diagnosis level ${core10Text(report, "jev", gate.core10.jev_diagnosis)}`,
    `- Enforced with \`--fail-on-gate\`: ${yesNo(gate.enforced)}`,
    "",
  ];
  if (gate.verdict === "not_scored") {
    return [
      `**Core-10 gate: NOT SCORED** — every decision of ${gate.backend} failed, so no core-10 scenario was scored at ${gate.level} level ` +
        "and there is nothing to judge (the gate needs at least 8/10 and 5/6). It is not a pass, and `--fail-on-gate` exits 2 on it.",
      "",
      `- Not scored: all ${gate.total} core-10 scenarios`,
      ...perBackend,
    ];
  }
  const lines = [
    `**Core-10 gate: ${verdictText(gate.verdict)}** — ${gate.backend} at ${gate.level} level: ` +
      `${gate.passed}/${gate.total} core-10 scenarios passed, ${gate.positives_passed}/${gate.positives_total} positives ` +
      `(the gate needs at least 8/10 and 5/6).`,
    "",
  ];
  if (!gate.complete) {
    lines.push(
      `Partial run: ${gate.scored} of the ${gate.total} core-10 scenarios were scored (${gate.positives_scored} of the ${gate.positives_total} positives); ` +
        `the ${gate.missing.length} missing ones count as failed above. On what was scored the gate is ` +
        `${gate.verdict === "attainable" ? "still attainable" : "out of reach"}.`,
      "",
    );
  }
  lines.push(
    `- Scored and failed: ${gate.failed.length === 0 ? "none" : gate.failed.map(code).join(", ")}`,
    `- Not scored: ${gate.missing.length === 0 ? "none" : gate.missing.map(code).join(", ")}`,
    ...perBackend,
  );
  return lines;
}

/** One bold warning per backend whose decisions failed, above everything else in the headline. */
function failureLines(report: RunReport): string[] {
  return report.backends.flatMap((backend) => {
    const warning = failureWarning(backend);
    return warning === undefined ? [] : [`**Failed decisions — ${warning}**`, ""];
  });
}

/** Whether every decision of the backend the summary's headline figures belong to failed. */
export function headlineAnsweredNothing(report: RunReport): boolean {
  const name = report.summary?.headline_backend;
  const backend = name === undefined ? undefined : backendOf(report, name);
  return backend !== undefined && everyDecisionFailed(backend);
}

/**
 * The headline backend's detection-level MetroPT-3 check when its gate is read at detection
 * level, else `undefined`: a report written before E3 was read at detection level carries none.
 */
function detectionCheckOf(summary: ReportSummary): ReportMetropt3Check | undefined {
  const headline = summary.backends.find((entry) => entry.backend === summary.headline_backend);
  if (headline?.gate.level !== "detection") return undefined;
  return headline.metropt3_detection;
}

function metropt3Lines(report: RunReport, summary: ReportSummary): string[] {
  if (headlineAnsweredNothing(report)) {
    return [
      `**MetroPT-3 check (in-sample)**: not measured — every decision of ${summary.headline_backend} failed, so there is no answer of its to check.`,
      "",
    ];
  }
  const check = summary.metropt3_check;
  const wanted = check.detected.length + check.missed.length;
  const detection = detectionCheckOf(summary);
  const lines: string[] = [];
  if (detection !== undefined) {
    const found = detection.detected.length + detection.missed.length;
    lines.push(
      `**MetroPT-3 check at detection level (in-sample)**: ${detection.detected.length}/${found} headline failures had a suspect event in their credited span within the budget ` +
        `for ${summary.headline_backend} — ${passFail(detection.pass)}. Detected: ${listed(detection.detected)}; missed: ${listed(detection.missed)}. ` +
        "This is the level E3 gates; the ticket check below is the rules backend's diagnosis baseline, never gated.",
      "",
    );
  }
  lines.push(
    `**MetroPT-3 check (in-sample)**: ${check.detected.length}/${wanted} headline failures detected at ${check.level} level ` +
      `by ${summary.headline_backend} — ${passFail(check.pass)}. Detected: ${listed(check.detected)}; missed: ${listed(check.missed)}. ` +
      "The detection rules were designed after inspecting F1–F4, so this measures fit, not generalisation.",
    "",
  );
  return lines;
}

/** `n/m` detected of the headline failures a check was over. */
function checkCount(check: ReportFullRecording["metropt3_check"]["ticket"]): string {
  return `${check.detected.length}/${check.detected.length + check.missed.length}`;
}

/**
 * The whole recording read on its own, per backend (E6): the MetroPT-3 check at both levels, the
 * false-ticket rate over its negative time, and the unlabelled-episode detections listed apart.
 */
function fullRecordingLines(entries: readonly ReportFullRecording[]): string[] {
  const lines = [
    "**Whole recording (E6, in-sample)** — the full profile's replay of the whole MetroPT-3 recording, read on its own:",
    "",
  ];
  for (const entry of entries) {
    const { ticket, review } = entry.metropt3_check;
    const rate = entry.false_tickets_per_machine_day;
    lines.push(
      `- ${entry.backend} on ${code(entry.scenario)} (${entry.replay.from} → ${entry.replay.to}): ` +
        `MetroPT-3 check ${checkCount(ticket)} at ticket level (${passFail(ticket.pass)}), ` +
        `${checkCount(review)} at review level (${passFail(review.pass)}); missed at ticket level: ${listed(ticket.missed)}. ` +
        `False tickets per machine-day over ${entry.negative_machine_days.toFixed(1)} negative machine-days: ` +
        `${ratio(rate.ticket)} at ticket level (${entry.false_tickets.ticket}), ${ratio(rate.review)} at review level (${entry.false_tickets.review}). ` +
        `${entry.unlabelled_detections.length} detection(s) inside unlabelled episodes, never counted as false positives` +
        (entry.unlabelled_detections.length === 0 ? "." : ":"),
      ...entry.unlabelled_detections.map(
        (detection) =>
          `  - ${code(detection.fault_at_open)} at ${detection.opened_sim_ts} (${detection.max_level}), in the episode ${detection.episode_from} → ${detection.episode_to}`,
      ),
    );
  }
  lines.push("");
  return lines;
}

function statusText(status: ReportExitEvalStatus): string {
  if (status === "not_covered") return "not covered";
  return status === "pass" ? "pass" : "FAIL";
}

function listed(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.join(", ");
}

/** Each uncovered condition with what it would have needed: `condition (a, b); other (c)`. */
function gapsText(gaps: readonly ReportExitEvalGap[]): string {
  return gaps
    .map((gap) =>
      gap.missing.length === 0 ? gap.condition : `${gap.condition} (${gap.missing.join(", ")})`,
    )
    .join("; ");
}

/**
 * The one line an exit eval is summed up in, the same on the console and in report.md:
 * an incomplete check says it is not a pass and names what it did not see.
 */
export function exitEvalHeadline(exitEval: ReportExitEval): string {
  const name = exitEval.name.toUpperCase();
  const uncovered = gapsText(exitEval.not_covered);
  if (exitEval.verdict === "incomplete") {
    return `${name} INCOMPLETE — not a pass; not covered: ${uncovered}`;
  }
  if (exitEval.verdict === "pass") {
    return `${name} PASS — every condition covered and held (${exitEval.backend} backend)`;
  }
  const broken = `${name} FAIL — broken: ${exitEval.failed.join(", ")}`;
  return exitEval.not_covered.length === 0 ? broken : `${broken}; not covered: ${uncovered}`;
}

/** How much of its range a scenario an exit eval reads was replayed, in words. */
const REPLAY_TEXT: Readonly<Record<ReportE3Scenario["replay"], string>> = {
  whole: "replayed whole",
  partial: "replayed in part only",
  none: "not replayed",
};

function ticketText(ticket: ReportTicket): string {
  return `${code(ticket.fault_at_open)} at ${ticket.opened_sim_ts} (${ticket.max_level}, ${ticket.verdict})`;
}

function suspectText(suspect: ReportSuspect): string {
  return `${code(suspect.symptom_key)} at ${suspect.sim_ts}`;
}

/** How many of a list to print before saying how many more there were. */
const SUSPECTS_SHOWN = 5;

function e3ScenarioLine(check: ReportE3Scenario, what: string): string {
  const tickets =
    check.tickets.length === 0
      ? ""
      : `; ${check.tickets.length} ${what}: ${check.tickets.map(ticketText).join("; ")}`;
  const shown = check.suspects.slice(0, SUSPECTS_SHOWN).map(suspectText).join("; ");
  const more =
    check.suspects.length > SUSPECTS_SHOWN
      ? `; and ${check.suspects.length - SUSPECTS_SHOWN} more`
      : "";
  const suspects =
    check.suspects.length === 0
      ? ""
      : `; ${check.suspects.length} suspect event(s): ${shown}${more}`;
  return `${code(check.scenario)}: ${statusText(check.status)} (${REPLAY_TEXT[check.replay]})${tickets}${suspects}`;
}

function baselineCountText(counts: ReportBaselineCounts): string {
  return (
    `${counts.passed}/${counts.total} core-10, ${counts.positives_passed}/${counts.positives_total} positives; ` +
    `failed: ${listed(counts.failed)}; not replayed whole: ${listed(counts.not_replayed)}`
  );
}

function exitEvalLines(exitEval: ReportExitEval): string[] {
  const { core10_counts: counts, metropt3_check: check } = exitEval.conditions;
  const negatives = exitEval.conditions.negatives_no_suspect;
  const abstain = exitEval.conditions.abstain_non_benign;
  const depot = exitEval.conditions.depot_no_ticket;
  const { baseline } = exitEval;
  return [
    `**${exitEvalHeadline(exitEval)}**`,
    "",
    `Every condition of ${exitEval.name.toUpperCase()}, read from the ${exitEval.backend} backend over the scenarios this run replayed whole; a condition it did not show is not covered, never passed. ` +
      "E3 gates detection — suspect events, not tickets — and the abstain cases' ticket rules.",
    "",
    `- Core-10 counts at ${counts.level} level: ${statusText(counts.status)} — ${counts.passed}/${counts.total} core-10, ` +
      `${counts.positives_passed}/${counts.positives_total} positives (gate ${counts.gate_verdict}); ` +
      `failed: ${listed(counts.failed)}; not replayed whole: ${listed(counts.not_replayed)}`,
    `- MetroPT-3 check 4/4 at detection level, a suspect event in each credited span within its budget (in-sample): ${statusText(check.status)} — ` +
      `detected: ${listed(check.detected)}; missed: ${listed(check.missed)}; not replayed whole: ${listed(check.not_replayed)}`,
    `- No suspect event on the normal-operation negatives: ${statusText(negatives.status)}`,
    ...negatives.scenarios.map((scenario) => `  - ${e3ScenarioLine(scenario, "ticket(s)")}`),
    `- Zero non-benign tickets on the abstain cases: ${statusText(abstain.status)}`,
    ...abstain.scenarios.map(
      (scenario) => `  - ${e3ScenarioLine(scenario, "non-benign ticket(s)")}`,
    ),
    `- No ticket at all, benign ones included, on the depot day: ${statusText(depot.status)}`,
    `  - ${e3ScenarioLine(depot, "ticket(s)")}`,
    "",
    "The rules backend's diagnosis baseline — tickets naming an accepted fault — recorded beside E3 and never gated:",
    "",
    `- Review diagnosis (E3's earlier ticket-level reading): ${baselineCountText(baseline.review_diagnosis)}`,
    `- Diagnosis (E4's rule): ${baselineCountText(baseline.diagnosis)}`,
    `- MetroPT-3 check at review-or-ticket level on tickets (in-sample): detected: ${listed(baseline.metropt3_check.detected)}; ` +
      `missed: ${listed(baseline.metropt3_check.missed)}; not replayed whole: ${listed(baseline.metropt3_check.not_replayed)}`,
    "",
  ];
}

/**
 * One scenario's three pass flags for one backend: `detection · review diagnosis · diagnosis`,
 * `reported` for a scenario that is never judged, a dash when the pair did not run. A report
 * written before E3 moved to detection level has no review-diagnosis flag, which reads as a dash.
 */
export function passCell(report: RunReport, id: string, backend: string): string {
  const entry = report.scenarios.find(
    (scenario) => scenario.id === id && scenario.backend === backend,
  );
  if (entry === undefined) return DASH;
  if (!entry.scored) return "reported";
  const review =
    entry.pass.review_diagnosis === undefined ? DASH : passFail(entry.pass.review_diagnosis);
  return `${passFail(entry.pass.detection)} · ${review} · ${passFail(entry.pass.diagnosis)}`;
}

function headline(report: RunReport): string[] {
  const lines = ["## Headline", "", ...failureLines(report)];
  if (report.summary === null || report.gate === null) {
    lines.push(
      "No scenario of this run was scored, so there is no gate and no MetroPT-3 check.",
      "",
    );
  } else {
    lines.push(...gateLines(report.gate, report), ...metropt3Lines(report, report.summary));
  }
  if (report.full_recording !== undefined) lines.push(...fullRecordingLines(report.full_recording));
  if (report.exit_eval !== undefined) lines.push(...exitEvalLines(report.exit_eval));

  const ids = [...new Set(report.scenarios.map((scenario) => scenario.id))];
  lines.push(
    "Every scenario, with its split; each cell reads detection · review diagnosis · diagnosis. Detection is read on suspect events (a positive's credited span within its budget; none on a normal-operation negative) and the ticket rule on an abstain case; both diagnosis flags read tickets naming an accepted fault.",
    "",
    ...table(
      ["Scenario", "Group", "Split", "Positive", ...report.backends.map(columnHeading)],
      ids.map((id) => {
        const first = report.scenarios.find((scenario) => scenario.id === id);
        const scored = first?.scored === true;
        return [
          code(id),
          first === undefined ? DASH : `${first.group}${scored ? "" : " (reported only)"}`,
          first?.split ?? DASH,
          first === undefined ? DASH : yesNo(first.positive),
          ...report.backends.map((backend) => passCell(report, id, backend.name)),
        ];
      }),
    ),
    "",
  );
  return lines;
}

function comparisonValue(rowValue: ReportComparisonRow, backend: string): number | null {
  if (backend === "rules") return rowValue.rules;
  if (backend === "jev") return rowValue.jev;
  return rowValue.llm;
}

function comparison(report: RunReport): string[] {
  const lines = ["## Comparison", ""];
  if (report.summary === null) {
    lines.push("Nothing was scored.", "");
    return lines;
  }
  const byMetric = new Map(report.summary.comparison.map((entry) => [entry.metric, entry]));
  lines.push(
    ...jevNotice(report),
    ...table(
      ["Metric", ...report.backends.map(columnHeading)],
      COMPARISON_ROWS.map(({ label, metric }) => {
        const entry = byMetric.get(metric);
        const digits = metric.startsWith("cost") ? 6 : 3;
        return [
          label,
          ...report.backends.map((backend) => {
            const value = entry === undefined ? null : comparisonValue(entry, backend.name);
            return digits === 6 ? usd(value) : ratio(value, digits);
          }),
        ];
      }),
    ),
    "",
    "The rules confidence is a calibrated gating quantity and Jev's a probability; neither is compared here.",
    "",
  );
  return lines;
}

function perFault(report: RunReport): string[] {
  const lines = ["## Per-fault precision and recall", ""];
  const rows: string[][] = [];
  for (const backend of report.summary?.backends ?? []) {
    const ticket = backend.precision_recall.ticket.per_fault;
    const review = backend.precision_recall.review.per_fault;
    const faults = [...new Set([...Object.keys(ticket), ...Object.keys(review)])].sort();
    for (const fault of faults) {
      const atTicket = ticket[fault];
      const atReview = review[fault];
      rows.push([
        backend.backend,
        code(fault),
        ratio(atTicket?.precision ?? null),
        ratio(atTicket?.recall ?? null),
        ratio(atReview?.precision ?? null),
        ratio(atReview?.recall ?? null),
        atTicket === undefined ? DASH : `${atTicket.tp} / ${atTicket.fp} / ${atTicket.fn}`,
      ]);
    }
  }
  if (rows.length === 0) {
    lines.push("No fault was named by a ticket or expected by a window.", "");
    return lines;
  }
  lines.push(
    ...jevNotice(report),
    ...table(
      [
        "Backend",
        "Fault",
        "Precision (ticket)",
        "Recall (ticket)",
        "Precision (review)",
        "Recall (review)",
        "TP / FP / FN (ticket)",
      ],
      rows,
    ),
    "",
  );
  return lines;
}

function leadTimes(report: RunReport): string[] {
  const lines = ["## Lead times", ""];
  const rows = report.scenarios
    .filter((scenario) => scenario.scored)
    .flatMap((scenario) =>
      scenario.metrics.lead_times.map((lead) => [
        scenario.backend,
        code(scenario.id),
        lead.window_id,
        code(lead.fault),
        lead.first_correct_ticket,
        lead.native_code === null ? DASH : `${lead.native_code} at ${lead.native_first ?? DASH}`,
        minutes(lead.lead_minutes),
        minutes(lead.lps_lead_minutes),
        `${lead.qualifier === ">=" ? "≥ " : ""}${minutes(lead.latency_minutes)}`,
      ]),
    );
  if (rows.length === 0) {
    lines.push("No window was detected, so there is no lead time to report.", "");
    return lines;
  }
  lines.push(
    ...jevNotice(report),
    "Lead time is the native alarm minus the first correct ticket (positive: earlier than the controller); latency is the ticket minus the data onset, `≥` when the onset is a lower bound.",
    "",
    ...table(
      [
        "Backend",
        "Scenario",
        "Window",
        "Fault",
        "First correct ticket",
        "Native alarm",
        "Lead vs native (min)",
        "Lead vs LPS (min)",
        "Latency (min)",
      ],
      rows,
    ),
    "",
  );
  return lines;
}

function abstention(report: RunReport): string[] {
  const lines = ["## Abstention", ""];
  const backends = report.summary?.backends ?? [];
  const cases = backends.flatMap((backend) =>
    backend.abstention.cases.map((entry) => [
      backend.backend,
      code(entry.id),
      yesNo(entry.correct),
      entry.reasons.length === 0 ? DASH : entry.reasons.join("; "),
    ]),
  );
  if (cases.length === 0) {
    lines.push("This run replayed no abstain case.", "");
    return lines;
  }
  lines.push(
    ...jevNotice(report),
    ...table(
      ["Backend", "Accuracy", "Correct / cases", "Explicit abstention rate"],
      backends.map((backend) => [
        backend.backend,
        ratio(backend.abstention.accuracy),
        `${backend.abstention.correct} / ${backend.abstention.total}`,
        ratio(backend.abstention.explicit_rate),
      ]),
    ),
    "",
    ...table(["Backend", "Case", "Correct", "Reasons"], cases),
    "",
  );
  return lines;
}

function cost(report: RunReport): string[] {
  const lines = ["## Cost", ""];
  const backends = report.summary?.backends ?? [];
  if (backends.length === 0) {
    lines.push("Nothing was scored.", "");
    return lines;
  }
  lines.push(
    ...jevNotice(report),
    ...table(
      [
        "Backend",
        "Mode",
        "Decisions",
        "Input tokens",
        "Output tokens",
        "Cost (USD)",
        "Per decision",
        "Per ticket",
        "Prices as of",
      ],
      [
        ...backends.map((backend) => {
          const mode = backendOf(report, backend.backend)?.mode ?? DASH;
          return [
            backend.backend,
            mode === "mock" ? MOCK_LABEL : mode,
            String(backend.cost.calls),
            String(backend.cost.input_tokens),
            String(backend.cost.output_tokens),
            usd(backend.cost.usd),
            usd(backend.cost.per_decision),
            usd(backend.cost.per_ticket),
            backend.cost.prices.as_of,
          ];
        }),
        totalCostRow(backends.map((backend) => backend.cost)),
      ],
    ),
    "",
  );
  return lines;
}

/**
 * The cost table's last row: every backend's decisions, tokens and dollars added up. A cost per
 * ticket is left out, because the backends' tickets are not the same tickets.
 */
function totalCostRow(costs: readonly ReportCost[]): string[] {
  const calls = costs.reduce((sum, entry) => sum + entry.calls, 0);
  const total = costs.reduce((sum, entry) => sum + entry.usd, 0);
  const days = [...new Set(costs.map((entry) => entry.prices.as_of))];
  return [
    "total",
    DASH,
    String(calls),
    String(costs.reduce((sum, entry) => sum + entry.input_tokens, 0)),
    String(costs.reduce((sum, entry) => sum + entry.output_tokens, 0)),
    usd(total),
    usd(calls === 0 ? null : total / calls),
    DASH,
    days.join(", "),
  ];
}

/**
 * A scenario's suspect events at detection level; nothing for a report written before E3 moved to
 * detection level.
 */
function detectionLines(scenario: ReportScenario): string[] {
  const detection = scenario.metrics.detection;
  if (detection === undefined) return [];
  const windows = detection.windows.map((window) => {
    if (window.first_suspect === null) return `${window.window_id}: no suspect event in its span`;
    const when = window.detected ? "in time" : "after the budget";
    return `${window.window_id}: first suspect event ${suspectText(window.first_suspect)} (${when})`;
  });
  return [
    `- Detection: ${detection.suspects} suspect event(s) scored, ${detection.warmup_suspects} in the warmup, ` +
      `${detection.outside_windows} outside every positive span and excluded window` +
      (windows.length === 0 ? "" : `; ${windows.join("; ")}`),
  ];
}

function designLevelText(level: ReportDesignLevel): string {
  const first =
    level.first === null
      ? "no ticket inside the episode"
      : `first ${code(level.first.fault_at_open)} at ${level.first.opened_sim_ts} (${level.met ? "on target" : "off target"})`;
  return `${first}; ${level.on_target} on target, ${level.off_target} off target, ${level.benign} benign inside, ${level.outside} outside`;
}

/** The notice every printed design target carries. */
const DESIGN_NOTICE =
  "a design aid, reported only: no gate, exit eval, pass rule or threshold selection reads it";

/** One design reading in words, for the scenario section and the caveats. */
function designText(reading: ReportDesignReading): string {
  return (
    `design target ${reading.accepted.map(code).join(" or ")} (${reading.provenance}) — ` +
    `review level: ${designLevelText(reading.review)}; ticket level: ${designLevelText(reading.ticket)}; ` +
    `decisions inside: ${reading.decisions.on_target} of ${reading.decisions.total} on target`
  );
}

/** The design reading of this scenario and backend, when it carries a design target. */
function scenarioDesignLines(report: RunReport, scenario: ReportScenario): string[] {
  const reading = (report.design_targets ?? []).find(
    (entry) => entry.scenario === scenario.id && entry.backend === scenario.backend,
  );
  if (reading === undefined) return [];
  return [`- Design target, ${DESIGN_NOTICE}: ${designText(reading)}`];
}

/** Every design reading of the run, apart from its figures. */
function designCaveats(readings: readonly ReportDesignReading[]): string[] {
  return [
    `- ${readings.length} design-target reading(s), ${DESIGN_NOTICE}. A design target is inferred, not verified, and its scenario's episode stays an excluded window:`,
    ...readings.map(
      (reading) => `  - ${code(reading.scenario)} · ${reading.backend}: ${designText(reading)}`,
    ),
  ];
}

function scenarioSection(report: RunReport, scenario: ReportScenario): string[] {
  const backend = backendOf(report, scenario.backend);
  const heading = backend === undefined ? scenario.backend : columnHeading(backend);
  const lines = [
    `### ${code(scenario.id)} · ${heading}`,
    "",
    `${scenario.title}. Group ${scenario.group}, split ${scenario.split}, ${scenario.positive ? "positive" : "not a positive"}` +
      `${scenario.scored ? "" : "; reported only, never scored"}.`,
    "",
    ...(scenario.scored
      ? [
          `- Pass: detection ${passFail(scenario.pass.detection)}, review diagnosis ${scenario.pass.review_diagnosis === undefined ? DASH : passFail(scenario.pass.review_diagnosis)}, diagnosis ${passFail(scenario.pass.diagnosis)} (the scenario asks for ${scenario.expect.pass_level})`,
          ...scenario.pass.reasons.map((reason) => `  - ${reason}`),
        ]
      : ["- Pass: not judged; a diagnostic scenario is reported only"]),
    ...detectionLines(scenario),
    ...scenarioDesignLines(report, scenario),
    `- Replay: ${scenario.replay.from} → ${scenario.replay.to}; ${scenario.replay.samples} samples, ${scenario.replay.discontinuities} discontinuities; ${scenario.replay.covered_machine_days.toFixed(3)} covered machine-days`,
    `- Decisions: ${scenario.decisions_summary.count} answered (ticket ${scenario.decisions_summary.by_gate.ticket}, review ${scenario.decisions_summary.by_gate.review}, log ${scenario.decisions_summary.by_gate.log}), ${scenario.decisions_summary.abstained} abstained, ${scenario.decisions_summary.failed} failed`,
    `- Event log: ${code(scenario.events_file)}`,
    "",
  ];

  if (scenario.windows.length === 0) {
    lines.push("Windows: none (a negative, abstain or diagnostic case).", "");
  } else {
    lines.push(
      ...table(
        ["Window", "From", "To", "Lead from", "Accepted", "Benign"],
        scenario.windows.map((window) => [
          window.id,
          window.from,
          window.to,
          window.lead_from,
          window.accepted.join(", "),
          yesNo(window.benign),
        ]),
      ),
      "",
    );
  }

  if (scenario.tickets.length === 0) {
    lines.push("Tickets: none.", "");
  } else {
    lines.push(
      ...table(
        ["Opened (sim)", "Fault at open", "Latest", "Level", "Verdict", "Window", "Open at end"],
        scenario.tickets.map((ticket) => [
          ticket.opened_sim_ts,
          code(ticket.fault_at_open),
          code(ticket.fault_latest),
          ticket.max_level,
          ticket.verdict,
          ticket.window_id ?? DASH,
          yesNo(ticket.open_at_end),
        ]),
      ),
      "",
    );
  }

  const ignored = scenario.tickets.filter((ticket) => ticket.verdict === "ignored").length;
  const open = scenario.tickets.filter((ticket) => ticket.open_at_end).length;
  lines.push(
    `- Excluded windows: ${
      scenario.excluded.length === 0
        ? "none"
        : scenario.excluded
            .map((window) => `${window.reason} ${window.from} → ${window.to}`)
            .join("; ")
    }; ${ignored} ticket(s) opened inside them and were ignored`,
    `- Open at end: ${open} ticket(s)`,
    "",
  );
  return lines;
}

function scenarios(report: RunReport): string[] {
  return [
    "## Scenarios",
    "",
    ...report.scenarios.flatMap((scenario) => scenarioSection(report, scenario)),
  ];
}

/** What a tuning run replayed, and the slices it shares with the core-10. */
function tuningCaveats(tuning: ReportTuning): string[] {
  const lines = [
    `- Tuning run: the ${tuning.scenarios.length} scenarios of the explicit tuning list, which with synthetic frames is all design tuning may read — never the \`dev\` profile as a whole, a core-10 result or the smoke E2E's outcomes.`,
  ];
  if (tuning.shared_slices.length === 0) {
    lines.push("- No tuning scenario replays a slice a core-10 scenario also replays.");
    return lines;
  }
  lines.push(
    `- ${tuning.shared_slices.length} tuning scenario(s) replay a slice a core-10 scenario also replays; the dev/test split allows them, so they are reported, not refused:`,
    ...tuning.shared_slices.map(
      (entry) =>
        `  - ${code(entry.scenario)} on ${code(entry.slice)}, shared with ${entry.core10.map(code).join(", ")}`,
    ),
  );
  return lines;
}

/** How a backend that reaches a model was reached, for the caveats. */
function modeCaveats(backend: ReportBackend): string[] {
  switch (backend.mode) {
    case "mock":
      return [
        `- ${backend.name} ran in mock mode (${MOCK_LABEL}): the answers come from the contracts mock server, not from the model.`,
      ];
    case "cassette": {
      const lines = [
        `- ${backend.name} ran from cassettes: ${backend.cassette_hits} hit(s), ${backend.cassette_misses} miss(es). A miss is answered by the contracts mock, not by the model; misses mean the backend's state or questions changed since the recording, and the cassettes are re-recorded (\`tools/eval/CASSETTES.md\`).`,
      ];
      if (backend.cassette_miss_digests.length > 0) {
        lines.push(
          `  - Missed request digests: ${[...new Set(backend.cassette_miss_digests)].map(code).join(", ")}`,
        );
      }
      const reused = backend.cassette_reused ?? 0;
      if (reused > 0) {
        lines.push(
          `  - ${reused} hit(s) asked for a request more often than its cassette recorded answers and got its last answer again. The model answers a repeated request differently, so those decisions need not be the recorded run's; a recording made since \`repeat_responses\` existed keeps every answer.`,
        );
      }
      return lines;
    }
    case "live": {
      const queue = backend.rate_limit;
      const paced =
        queue === null
          ? ""
          : ` The live queue sent ${queue.calls} request(s), repeated ${queue.retries} after a rate limit and waited ${Math.round(queue.waited_ms)} ms.`;
      return [
        `- ${backend.name} ran live: ${backend.calls} call(s), ${backend.failures} failed.${paced}`,
      ];
    }
    case "-":
      return [];
  }
}

function caveats(report: RunReport): string[] {
  const lines = ["## Caveats", ""];
  for (const backend of report.backends) lines.push(...modeCaveats(backend));
  const { catalog, alarm_registry: registry } = report.run;
  lines.push(
    catalog.source === "reference"
      ? "- Catalog: the reference `catalog.json`, which is the ablation; the headline scores the catalog extracted from the realistic PDF (`--catalog file:<path>`)."
      : `- Catalog: ${code(catalog.name)}.`,
  );
  if (registry.source === "provisional") {
    lines.push(
      "- Alarm registry: provisional (`tools/eval/fixtures/alarms-provisional`), not the manual's; lead times against it are indicative only.",
    );
  } else if (registry.source === "off") {
    lines.push(
      "- Alarm registry: off; no controller alarm was evaluated, so no lead time against a native alarm exists.",
    );
  }
  const openAtEnd = report.scenarios.reduce(
    (total, scenario) => total + scenario.tickets.filter((ticket) => ticket.open_at_end).length,
    0,
  );
  lines.push(
    `- ${openAtEnd} ticket(s) were still open when their replay ended; they are scored as they stood.`,
    "- The MetroPT-3 failure table is a proposal until a human signs it off; every figure derived from it is provisional.",
    `- ${report.run.mode === "stack" ? STACK_LIMITATIONS : IN_PROCESS_LIMITATIONS}`,
  );
  if (report.scenarios.some((scenario) => !scenario.scored)) {
    lines.push("- Diagnostic scenarios are replayed and listed, never scored.");
  }
  if (report.gate !== null && !report.gate.complete) {
    lines.push(
      `- This run scored ${report.gate.scored} of the ${report.gate.total} core-10 scenarios; only a core profile run decides the gate.`,
    );
  }
  if (report.tuning !== undefined) lines.push(...tuningCaveats(report.tuning));
  if (report.design_targets !== undefined) lines.push(...designCaveats(report.design_targets));
  if (report.exit_eval?.verdict === "incomplete") {
    lines.push(
      `- ${report.exit_eval.name.toUpperCase()} is incomplete, which is not a pass: E3's recipe is a core run and a dev run of \`frozen_logger_jun22\`, each read for the conditions it covers.`,
    );
  }
  lines.push("");
  return lines;
}

/** Renders `report.md` from a report document. */
export function renderMarkdown(report: RunReport): string {
  return [
    ...header(report),
    ...headline(report),
    ...comparison(report),
    ...perFault(report),
    ...leadTimes(report),
    ...abstention(report),
    ...cost(report),
    ...scenarios(report),
    ...caveats(report),
  ].join("\n");
}

/** Writes `<runDir>/report.md` and returns its path. */
export function writeMarkdownReport(report: RunReport, runDir: string): string {
  const path = join(runDir, REPORT_MD_NAME);
  writeFileSync(path, renderMarkdown(report), "utf8");
  return path;
}
