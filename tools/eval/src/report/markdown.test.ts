// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `report.md` and the summary table: every section in its order, the labels
// the report must carry (the gate's two counts, the Jev notice, the catalog
// source, the mock column), the E3 verdict and the tuning list's shared
// slices, and no secret on the page.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { renderConsoleSummary } from "./console.ts";
import {
  SAMPLE_KEY,
  SAMPLE_PROVENANCE,
  SAMPLE_RAW_MARKER,
  SAMPLE_STATE_MARKER,
  sampleConfig,
  sampleDesignRunResult,
  sampleExitEvalRunResult,
  sampleRunResult,
} from "./fixtures.ts";
import { buildRunReport } from "./json.ts";
import {
  JEV_NOTICE,
  MOCK_LABEL,
  REPORT_MD_NAME,
  SECTION_HEADINGS,
  exitEvalHeadline,
  failureWarning,
  renderMarkdown,
  writeMarkdownReport,
} from "./markdown.ts";
import type { ReportExitEval, RunReport } from "./types.ts";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const report: RunReport = buildRunReport({
  result: sampleRunResult(tmpdir()),
  cfg: sampleConfig(),
  provenance: SAMPLE_PROVENANCE,
});
const page = renderMarkdown(report);

/** The report without its Jev backend, as a `--backends rules` run would write it. */
function rulesOnly(source: RunReport): RunReport {
  return {
    ...source,
    backends: source.backends.filter((backend) => backend.name !== "jev"),
    scenarios: source.scenarios.filter((scenario) => scenario.backend !== "jev"),
  };
}

/** The text of one `## ` section, up to the next one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("report.md", () => {
  it("carries every section heading, in order", () => {
    const positions = SECTION_HEADINGS.map((heading) => page.indexOf(`\n## ${heading}\n`));
    for (const position of positions) expect(position).toBeGreaterThan(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("opens with its licence and names the run", () => {
    // The two literals are fenced off from `reuse lint`, which would read them as this file's.
    /* REUSE-IgnoreStart */
    expect(page.startsWith("<!-- SPDX-FileCopyrightText:")).toBe(true);
    expect(page).toContain("SPDX-License-Identifier: CC-BY-4.0");
    /* REUSE-IgnoreEnd */
    expect(page).toContain("# Evaluation report `20260922-120000-core`");
  });

  it("names the catalog source and its digest in the header", () => {
    expect(page).toContain(`| Catalog | \`reference\`, sha256 \`${"e".repeat(64)}\``);
  });

  it("prints the gate with both of its counts and says a partial run is partial", () => {
    const headline = section(page, "Headline");
    expect(headline).toContain("**Core-10 gate: ATTAINABLE**");
    expect(headline).toContain("0/10 core-10 scenarios passed, 0/6 positives");
    expect(headline).toContain("Partial run: 1 of the 10 core-10 scenarios were scored");
    expect(headline).toContain("rules at detection level 0/10; jev at diagnosis level 0/10");
    expect(headline).toContain("Enforced with `--fail-on-gate`: yes");
  });

  it("labels the MetroPT-3 check in-sample", () => {
    expect(section(page, "Headline")).toContain("**MetroPT-3 check (in-sample)**");
  });

  it("names the split of every scenario and says which are reported only", () => {
    const headline = section(page, "Headline");
    expect(headline).toMatch(/\| `inject_oil_cooler_fouling` \| injected \| test \| yes \|/);
    expect(headline).toMatch(
      /\| `august_oil_level_aug10` \| diagnostic \(reported only\) \| dev \| yes \|/,
    );
  });

  it("heads the comparison with one column per backend, the mock one marked not informative", () => {
    const comparison = section(page, "Comparison");
    expect(comparison).toContain(`| Metric | rules | jev · ${MOCK_LABEL} |`);
    for (const label of [
      "Precision, micro (ticket level)",
      "Precision, macro (ticket level)",
      "Recall, micro (ticket level)",
      "Recall, macro (ticket level)",
      "Mean lead time vs native alarm (min)",
      "Tickets per machine-day",
      "False tickets per machine-day",
      "Abstention accuracy",
      "Explicit abstention rate",
      "Cost, total (USD)",
      "Cost per ticket (USD)",
    ]) {
      expect(comparison).toContain(`| ${label} |`);
    }
  });

  it("prints the Jev notice above every table that carries Jev figures", () => {
    for (const heading of ["Comparison", "Per-fault precision and recall", "Lead times", "Cost"]) {
      expect(section(page, heading)).toContain(JEV_NOTICE);
    }
  });

  it("prints no Jev notice when Jev did not run", () => {
    const rules = renderMarkdown(rulesOnly(report));
    expect(rules).not.toContain(JEV_NOTICE);
    expect(rules).not.toContain(MOCK_LABEL);
  });

  it("lists lead times per window, with the native alarm they are measured against", () => {
    expect(section(page, "Lead times")).toMatch(
      /\| rules \| `inject_oil_cooler_fouling` \| oil_cooler_fouling \| `oil_cooler_fouled` \| 2020-02-03T03:00:00\.000Z \| W104 at 2020-02-03T07:00:00\.000Z \| 240\.0 \|/,
    );
  });

  it("shows every ticket of a scenario with its verdict", () => {
    const scenarios = section(page, "Scenarios");
    expect(scenarios).toContain("### `inject_oil_cooler_fouling` · rules");
    expect(scenarios).toContain(`### \`inject_oil_cooler_fouling\` · jev · ${MOCK_LABEL}`);
    for (const verdict of [
      "warmup",
      "misdiagnosed",
      "recovered",
      "duplicate",
      "benign",
      "ignored",
      "fp",
    ]) {
      expect(scenarios).toContain(`| ${verdict} |`);
    }
    expect(scenarios).toContain("1 ticket(s) opened inside them and were ignored");
  });

  it("states the caveats: the mock, the catalog, the labels and the in-process limits", () => {
    const caveats = section(page, "Caveats");
    expect(caveats).toContain(`jev ran in mock mode (${MOCK_LABEL})`);
    expect(caveats).toContain("the reference `catalog.json`, which is the ablation");
    expect(caveats).toContain("a proposal until a human signs it off");
    expect(caveats).toContain("no MQTT or WebSocket transport and no heartbeat");
    expect(caveats).toContain("Diagnostic scenarios are replayed and listed, never scored");
  });

  it("carries no key, bearer token, raw body or state", () => {
    for (const secret of [SAMPLE_KEY, "Bearer", SAMPLE_RAW_MARKER, SAMPLE_STATE_MARKER]) {
      expect(page).not.toContain(secret);
    }
  });

  it("is written as report.md in the run directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "fdp-eval-markdown-"));
    directories.push(directory);
    const path = writeMarkdownReport(report, directory);
    expect(path).toBe(join(directory, REPORT_MD_NAME));
    expect(readFileSync(path, "utf8")).toBe(page);
  });
});

describe("the summary table", () => {
  const text = renderConsoleSummary(report, {
    runJson: "reports/eval/x/run.json",
    reportMd: "reports/eval/x/report.md",
  });

  it("prints one line per scenario with each backend's three pass flags", () => {
    expect(text).toContain("cells read detection · review diagnosis · diagnosis");
    expect(text).toMatch(/^scenario +split +rules +jev \(mock — not informative\)$/m);
    expect(text).toMatch(
      /^inject_oil_cooler_fouling +test +FAIL · FAIL · FAIL +FAIL · FAIL · FAIL$/m,
    );
    expect(text).toMatch(/^august_oil_level_aug10 +dev +reported +reported$/m);
  });

  it("prints the detection-level MetroPT-3 check of a backend gated at detection", () => {
    expect(text).toContain(
      "MetroPT-3 check (in-sample, detection level: a suspect event in the span, in time): 0/0 detected",
    );
  });

  it("prints the gate with both counts and the in-sample MetroPT-3 check", () => {
    expect(text).toContain(
      "gate: ATTAINABLE: rules at detection level: 0/10 core-10, 0/6 positives (partial: 1 of 10 scored, 1 of 6 positives)",
    );
    expect(text).toMatch(/MetroPT-3 check \(in-sample, review level\): 0\/0 detected/);
  });

  it("ends with where the reports are", () => {
    expect(
      text.endsWith("run.json: reports/eval/x/run.json\nreport.md: reports/eval/x/report.md\n"),
    ).toBe(true);
  });
});

describe("cassette and live backends on the page and in the summary", () => {
  const missed = "d".repeat(64);
  const withModes: RunReport = {
    ...report,
    backends: [
      ...report.backends.map((backend) =>
        backend.name === "jev"
          ? {
              ...backend,
              mode: "cassette" as const,
              informative: true,
              cassette_hits: 2,
              cassette_misses: 2,
              cassette_miss_digests: [missed, missed],
            }
          : backend,
      ),
      {
        name: "llm",
        model: "claude-opus-5",
        mode: "live",
        informative: true,
        calls: 3,
        failures: 1,
        cassette_hits: 0,
        cassette_misses: 0,
        cassette_miss_digests: [],
        rate_limit: { calls: 5, retries: 1, waited_ms: 60_100.4 },
      },
    ],
  };
  const modesPage = renderMarkdown(withModes);

  it("names each mode with its hits and misses, the missed digests and the live queue", () => {
    const caveats = section(modesPage, "Caveats");
    expect(caveats).toContain("- jev ran from cassettes: 2 hit(s), 2 miss(es).");
    expect(caveats).toContain(`  - Missed request digests: \`${missed}\`\n`);
    expect(caveats).toContain(
      "- llm ran live: 3 call(s), 1 failed. The live queue sent 5 request(s), repeated 1 after a rate limit and waited 60100 ms.",
    );
  });

  it("prints the same counts in the summary", () => {
    const text = renderConsoleSummary(withModes, { runJson: "r.json", reportMd: "r.md" });
    expect(text).toContain("jev: cassette mode, 2 hit(s), 2 miss(es)\n");
    expect(text).toContain("llm: live mode, 3 call(s), 1 failed, 1 rate-limit retr(ies)\n");
  });

  it("warns about failed decisions on the page and in the summary, reasons or not", () => {
    const llm = withModes.backends.find((backend) => backend.name === "llm");
    if (llm === undefined) throw new Error("the page has an llm backend");
    const warning =
      "llm (live): 1 of its 3 decision(s) failed. A failed decision has no choice, so its figures count those as missing.";
    expect(failureWarning(llm)).toBe(warning);
    expect(section(modesPage, "Headline")).toContain(`**Failed decisions — ${warning}**`);
    expect(renderConsoleSummary(withModes, { runJson: "r.json", reportMd: "r.md" })).toContain(
      `WARNING: ${warning}\ngate: `,
    );
    const reasons = [{ reason: "timeout: the TypeSafe API did not answer in time", count: 1 }];
    expect(failureWarning({ ...llm, failure_reasons: reasons })).toContain(
      "failed — timeout: the TypeSafe API did not answer in time ×1.",
    );
    expect(failureWarning({ ...llm, failures: 0 })).toBeUndefined();
  });

  it("says when hits reused an answer because the recording kept fewer than the run asked", () => {
    const reusing: RunReport = {
      ...withModes,
      backends: withModes.backends.map((backend) =>
        backend.name === "jev" ? { ...backend, cassette_reused: 41 } : backend,
      ),
    };
    expect(section(renderMarkdown(reusing), "Caveats")).toContain(
      "  - 41 hit(s) asked for a request more often than its cassette recorded answers and got its last answer again.",
    );
    expect(renderConsoleSummary(reusing, { runJson: "r.json", reportMd: "r.md" })).toContain(
      "jev: cassette mode, 2 hit(s), 2 miss(es), 41 reused an earlier answer (fewer recorded than asked)\n",
    );
    expect(section(modesPage, "Caveats")).not.toContain("got its last answer again");
  });

  it("ends the cost table with the total over every backend", () => {
    const costs = (report.summary?.backends ?? []).map((backend) => backend.cost);
    const calls = costs.reduce((sum, entry) => sum + entry.calls, 0);
    const usd = costs.reduce((sum, entry) => sum + entry.usd, 0);
    const input = costs.reduce((sum, entry) => sum + entry.input_tokens, 0);
    expect(calls).toBeGreaterThan(0);
    expect(section(page, "Cost")).toContain(
      `| total | — | ${calls} | ${input} | 0 | $${usd.toFixed(6)} | $${(usd / calls).toFixed(6)} | — | 2026-09-19 |`,
    );
  });
});

describe("--tuning and --exit-eval e3 on the page and in the summary", () => {
  const e3Report: RunReport = buildRunReport({
    result: sampleExitEvalRunResult(tmpdir()),
    cfg: sampleConfig(),
    provenance: SAMPLE_PROVENANCE,
  });
  const e3Page = renderMarkdown(e3Report);
  const exitEval = e3Report.exit_eval;
  if (exitEval === undefined) throw new Error("the E3 sample carries an exit_eval block");
  const verdictLine =
    "E3 FAIL — broken: negatives_no_suspect, depot_no_ticket; not covered: " +
    "core10_counts (f1_air_leak_apr18, f2_air_leak_may30, f3_air_leak_jun05, f4_air_leak_jul15, " +
    "inject_oil_cooler_fouling, inject_air_leak_downstream, inject_high_ambient_benign, " +
    "inject_oil_temperature_sensor_fault); metropt3_check (F1, F2, F3, F4); " +
    "abstain_non_benign (inject_high_ambient_benign, inject_oil_temperature_sensor_fault)";

  /** The sample's check with another verdict, as a stored run would carry it. */
  function withVerdict(verdict: ReportExitEval["verdict"]): ReportExitEval {
    return {
      ...exitEval,
      verdict,
      failed: [],
      not_covered:
        verdict === "pass"
          ? []
          : [{ condition: "negatives_no_suspect", missing: ["frozen_logger_jun22"] }],
    } as ReportExitEval;
  }

  it("prints the E3 verdict, then every condition with its evidence, in the headline", () => {
    const headline = section(e3Page, "Headline");
    expect(headline).toContain(`**${verdictLine}**`);
    expect(headline).toContain(
      "- Core-10 counts at detection level: not covered — 2/10 core-10, 0/6 positives (gate attainable); failed: none; not replayed whole: f1_air_leak_apr18,",
    );
    expect(headline).toContain(
      "- MetroPT-3 check 4/4 at detection level, a suspect event in each credited span within its budget (in-sample): not covered — detected: none; missed: none; not replayed whole: F1, F2, F3, F4",
    );
    expect(headline).toContain("- No suspect event on the normal-operation negatives: FAIL");
    expect(headline).toContain(
      "  - `baseline_feb03_normal`: FAIL (replayed whole); 1 suspect event(s): `frequent_cycling` at 2020-02-03T00:20:00.000Z",
    );
    expect(headline).toContain("  - `frozen_logger_jun22`: pass (replayed whole)");
    expect(headline).toContain("- Zero non-benign tickets on the abstain cases: not covered");
    expect(headline).toContain("  - `inject_high_ambient_benign`: not covered (not replayed)");
    expect(headline).toContain("- No ticket at all, benign ones included, on the depot day: FAIL");
    expect(headline).toContain(
      "  - `depot_lps_jul31`: FAIL (replayed whole); 1 ticket(s): `high_air_demand`",
    );
  });

  it("follows the conditions with the rules backend's diagnosis baseline, never gated", () => {
    const headline = section(e3Page, "Headline");
    expect(headline).toContain(
      "The rules backend's diagnosis baseline — tickets naming an accepted fault — recorded beside E3 and never gated:",
    );
    expect(headline).toContain(
      "- Review diagnosis (E3's earlier ticket-level reading): 2/10 core-10, 0/6 positives; failed: none; not replayed whole: f1_air_leak_apr18,",
    );
    expect(headline).toContain(
      "- MetroPT-3 check at review-or-ticket level on tickets (in-sample): detected: none; missed: none; not replayed whole: F1, F2, F3, F4",
    );
  });

  it("says an incomplete check is not a pass, in the headline and in the caveats", () => {
    const incomplete = renderMarkdown({ ...e3Report, exit_eval: withVerdict("incomplete") });
    expect(section(incomplete, "Headline")).toContain(
      "**E3 INCOMPLETE — not a pass; not covered: negatives_no_suspect (frozen_logger_jun22)**",
    );
    expect(section(incomplete, "Caveats")).toContain("E3 is incomplete, which is not a pass");
    expect(section(e3Page, "Caveats")).not.toContain("E3 is incomplete");
  });

  it("calls a pass a pass only when nothing broke and nothing was left uncovered", () => {
    expect(exitEvalHeadline(withVerdict("pass"))).toBe(
      "E3 PASS — every condition covered and held (rules backend)",
    );
    expect(exitEvalHeadline(exitEval)).toBe(verdictLine);
  });

  it("lists the tuning scenarios that share a slice with the core-10 under the caveats", () => {
    const caveats = section(e3Page, "Caveats");
    expect(caveats).toContain("- Tuning run: the 10 scenarios of the explicit tuning list");
    expect(caveats).toContain(
      "  - `inject_dryer_tower_switching_failure` on `baseline-feb03`, shared with `baseline_feb03_normal`, `inject_air_leak_downstream`,",
    );
  });

  it("prints neither block for a run started without the flags", () => {
    expect(page).not.toContain("**E3");
    expect(page).not.toContain("Tuning run:");
  });

  it("prints the tuning list and the E3 line in the summary table", () => {
    const text = renderConsoleSummary(e3Report, {
      runJson: "reports/eval/x/run.json",
      reportMd: "reports/eval/x/report.md",
    });
    expect(text).toContain(
      "tuning list: 10 scenarios; 4 share a slice with the core-10 (allowed by the dev/test split, reported only)\n" +
        "  inject_dryer_tower_switching_failure shares baseline-feb03 with baseline_feb03_normal,",
    );
    expect(text).toContain(`${verdictLine}\nrun.json: reports/eval/x/run.json`);
  });
});

describe("detection level and the design target on the page and in the summary", () => {
  const designReport: RunReport = buildRunReport({
    result: sampleDesignRunResult(tmpdir()),
    cfg: sampleConfig(),
    provenance: SAMPLE_PROVENANCE,
  });
  const designPage = renderMarkdown(designReport);

  it("prints each scenario's detection reading in its section", () => {
    const scenarios = section(page, "Scenarios");
    expect(scenarios).toContain(
      "- Pass: detection FAIL, review diagnosis FAIL, diagnosis FAIL (the scenario asks for diagnosis)",
    );
    expect(scenarios).toContain(
      "- Detection: 0 suspect event(s) scored, 0 in the warmup, 0 outside every positive span and excluded window; oil_cooler_fouling: no suspect event in its span",
    );
    expect(section(page, "Headline")).toContain(
      "each cell reads detection · review diagnosis · diagnosis",
    );
    expect(section(page, "Headline")).toContain(
      "**MetroPT-3 check at detection level (in-sample)**",
    );
  });

  it("prints the design reading in the design case's section, marked never gated", () => {
    const scenarios = section(designPage, "Scenarios");
    expect(scenarios).toContain(
      "- Design target, a design aid, reported only: no gate, exit eval, pass rule or threshold selection reads it: design target `dryer_purge_leak` or `downstream_air_leak`",
    );
    expect(scenarios).toContain(
      "review level: first `purge_silencer_damaged` at 2020-05-19T23:00:00.000Z (off target); 1 on target, 1 off target, 0 benign inside, 1 outside",
    );
    expect(scenarios).toContain(
      "ticket level: first `dryer_purge_leak` at 2020-05-20T02:00:00.000Z (on target)",
    );
  });

  it("lists every design reading under the caveats, apart from the figures", () => {
    const caveats = section(designPage, "Caveats");
    expect(caveats).toContain("- 1 design-target reading(s), a design aid, reported only");
    expect(caveats).toContain("  - `unlabelled_leak_may19` · rules: design target");
    expect(section(designPage, "Headline")).not.toContain("design target");
    expect(section(page, "Caveats")).not.toContain("design-target reading");
  });

  it("prints one line per design reading in the summary", () => {
    const text = renderConsoleSummary(designReport, { runJson: "r.json", reportMd: "r.md" });
    expect(text).toContain(
      "design target (reported only, never gated) unlabelled_leak_may19 rules: dryer_purge_leak or downstream_air_leak; " +
        "first review item purge_silencer_damaged (not on target), first ticket-level dryer_purge_leak (on target); decisions inside 1/3 on target",
    );
  });
});
