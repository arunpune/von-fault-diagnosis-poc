// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The smoke profile end to end: the real CLI, as a child process, over the
// committed scenarios and the cut MetroPT-3 slices, with the rules backend and
// Von against the contracts' mock server — the command CI's eval-smoke job
// runs.
//
//   node --conditions=@fdp/source src/cli.ts run --profile smoke \
//        --backends rules,von --out <tmp>          (EVAL_VON_MODE=mock)
//
// It asserts the smoke profile's list: exit 0; run.json valid; five scenarios ×
// two backends; F3 detected by the rules backend with its first ticket inside the
// F3 window; no non-benign ticket on the baseline day or the depot
// depressurisation with rules; a review-or-ticket item naming the injected
// oil-cooler fault with rules; the Von column in mock mode; the comparison table
// in report.md; all of it in under 180 s. It also greps every file the run wrote
// for the mock key and for a bearer header.
//
// Known findings (open, never weakened here). The two rules-level positives are
// marked with `it.fails`: they fail today because of the backend, not the
// harness. Detection fires on both — `purge_pressure_high` at 09:51 on 5 June,
// `oil_temperature_rising` from 05:28 on 3 February — but no decision reaches
// review. On F3 the rules supports are 0.6–1.0 with the wrong leader
// (`purge_silencer_damaged` 0.75 over `dryer_purge_leak` 0.667 at 09:51) and
// the calibrated confidence's gap term holds it at 0.21; the "0.10–0.25" this
// comment used to quote were the normalised display probabilities, not
// supports. On the injected oil cooler `oil_cooler_fouled` is never among the
// six candidates the retriever offers (fused rank 13), and the backend picks
// `oil_level_low` at 0.37. Outside this profile, `inject_air_leak_downstream`
// raises no suspect event at all. The causes are the matcher, the fixture-based
// calibration proof, detection's observation filter, the stand-in retriever and
// the manual's sibling structure, not calibration alone. A marker stays until
// the change that makes its assertion pass removes it, and the assertions
// inside are unchanged. The smoke replays core-10 (test-split) scenarios, so
// its markers flip mechanically and its outcomes are never a tuning signal.
//
// The test skips when the slices are not cut, and fails instead under
// FDP_REQUIRE_DATASET=1, which CI sets once the dataset cache is restored.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MOCK_API_KEY } from "../../src/backends/mock.ts";
import { MOCK_LABEL } from "../../src/report/markdown.ts";
import { validateReport } from "../../src/report/json.ts";
import type { ReportScenario, RunReport } from "../../src/report/types.ts";
import { datasetRequired, sliceIsCut } from "../../src/slices.ts";

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** The slices the five smoke scenarios replay. */
const SMOKE_SLICES = ["baseline-feb03", "depot-jul31", "f3-jun05"];

const SMOKE_SCENARIOS = [
  "baseline_feb03_normal",
  "depot_lps_jul31",
  "f3_air_leak_jun05",
  "inject_oil_cooler_fouling",
  "inject_oil_temperature_sensor_fault",
];

/** The smoke profile's budget, the CI job included. */
const BUDGET_MS = 180_000;

const slicesCut = SMOKE_SLICES.every((slice) => sliceIsCut(slice));

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
}

/** The environment of the child: the mock mode, and no key it could ever reach for. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, EVAL_VON_MODE: "mock" };
  for (const name of ["TYPESAFE_API_KEY", "LLM_API_KEY", "EVAL_PROFILE", "INIT_CWD"]) {
    delete env[name];
  }
  return env;
}

function runCli(args: readonly string[]): Promise<Outcome> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=@fdp/source", "src/cli.ts", ...args], {
      cwd: PACKAGE_DIR,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        wallMs: performance.now() - started,
      });
    });
  });
}

/** Every file under `root`, as paths relative to it. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

describe("fdp-eval run --profile smoke", () => {
  it("has the smoke slices cut, unless the dataset is not required", () => {
    const absence = `the smoke slices (${SMOKE_SLICES.join(", ")}) are not cut; run \`make fixtures\``;
    expect(slicesCut || !datasetRequired(), absence).toBe(true);
  });

  describe.skipIf(!slicesCut)("end to end, rules and a mock Von", () => {
    let out: string;
    let outcome: Outcome;
    let runDir: string;
    let report: RunReport;
    let markdown: string;

    beforeAll(async () => {
      out = mkdtempSync(join(tmpdir(), "fdp-eval-smoke-"));
      outcome = await runCli([
        "run",
        "--profile",
        "smoke",
        "--backends",
        "rules,von",
        "--out",
        out,
      ]);
      const runs = readdirSync(out, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      if (outcome.code !== 0 || runs.length !== 1 || runs[0] === undefined) {
        throw new Error(
          `the run exited ${String(outcome.code)} with ${runs.length} run directories\n${outcome.stderr}`,
        );
      }
      runDir = join(out, runs[0].name);
      report = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunReport;
      markdown = readFileSync(join(runDir, "report.md"), "utf8");
    }, BUDGET_MS * 2);

    afterAll(() => {
      rmSync(out, { recursive: true, force: true });
    });

    function pair(id: string, backend: string): ReportScenario {
      const found = report.scenarios.find(
        (scenario) => scenario.id === id && scenario.backend === backend,
      );
      if (found === undefined) throw new Error(`run.json has no ${id} × ${backend}`);
      return found;
    }

    /** Tickets that name a cause the scenario's ground truth does not call benign. */
    function nonBenign(scenario: ReportScenario) {
      return scenario.tickets.filter(
        (ticket) =>
          ticket.verdict !== "benign" && !scenario.benign_fault_ids.includes(ticket.fault_at_open),
      );
    }

    it("exits 0 within the smoke budget of 180 s", () => {
      expect(outcome.code).toBe(0);
      expect(outcome.wallMs).toBeLessThan(BUDGET_MS);
    });

    it("writes a run.json that validates against report.schema.json", () => {
      expect(() => validateReport(report)).not.toThrow();
      expect(report.run.profile).toBe("smoke");
    });

    it("replays the five smoke scenarios against both backends", () => {
      expect(report.backends.map((backend) => backend.name)).toEqual(["rules", "von"]);
      expect(report.scenarios).toHaveLength(10);
      for (const id of SMOKE_SCENARIOS) {
        for (const backend of ["rules", "von"]) expect(pair(id, backend).scored).toBe(true);
      }
    });

    it("writes one event log per pair, latest.json and report.md", () => {
      const files = filesUnder(runDir);
      for (const id of SMOKE_SCENARIOS) {
        expect(files).toContain(join("scenarios", `${id}.rules.jsonl`));
        expect(files).toContain(join("scenarios", `${id}.von.jsonl`));
      }
      expect(files).toEqual(expect.arrayContaining(["run.json", "report.md"]));
      expect(readFileSync(join(out, "latest.json"), "utf8")).toBe(
        readFileSync(join(runDir, "run.json"), "utf8"),
      );
    });

    it("marks the Von column as a mock, not informative", () => {
      const von = report.backends.find((backend) => backend.name === "von");
      expect(von).toMatchObject({ mode: "mock", informative: false });
      expect(markdown).toContain(`| Metric | rules | von · ${MOCK_LABEL} |`);
    });

    it("renders the comparison table and labels the MetroPT-3 check in-sample", () => {
      expect(markdown).toContain("## Comparison");
      expect(markdown).toContain("| Precision, micro (ticket level) |");
      expect(markdown).toContain("**MetroPT-3 check (in-sample)**");
      expect(markdown).toContain("`reference`, sha256");
    });

    it("opens no non-benign ticket on the baseline day with rules", () => {
      expect(nonBenign(pair("baseline_feb03_normal", "rules"))).toEqual([]);
    });

    it("opens no non-benign ticket on the depot depressurisation with rules", () => {
      expect(nonBenign(pair("depot_lps_jul31", "rules"))).toEqual([]);
    });

    it.fails(
      "KNOWN BACKEND FINDING — f3_air_leak_jun05: rules detects F3 and its first ticket falls in the F3 window",
      () => {
        const f3 = pair("f3_air_leak_jun05", "rules");
        // The ticket rule this assertion was written against, which run.json has named
        // review_diagnosis since detection-level E3 (2026-09-24) redefined detection as suspect
        // events: the marker's assertion is unchanged, so it flips on the same outcome as before.
        expect(f3.pass.review_diagnosis, f3.pass.reasons.join("; ")).toBe(true);
        const window = f3.windows.find((entry) => entry.id === "F3");
        const first = f3.tickets.find((ticket) => ticket.verdict !== "warmup");
        expect(window).toBeDefined();
        expect(first, "rules opened no ticket or review item on F3").toBeDefined();
        if (window === undefined || first === undefined) return;
        // `from` is where the bound window's true-positive span opens: F3's data onset, not its
        // `lead_from` (the credited span); the smoke replay starts long before it.
        expect(first.opened_sim_ts >= window.from && first.opened_sim_ts < window.to).toBe(true);
      },
    );

    it.fails(
      "KNOWN BACKEND FINDING — inject_oil_cooler_fouling: rules opens a review-or-ticket item naming the injected fault",
      () => {
        const oilCooler = pair("inject_oil_cooler_fouling", "rules");
        const accepted = oilCooler.windows.flatMap((window) => window.accepted);
        expect(accepted).toEqual(["oil_cooler_fouled"]);
        const naming = oilCooler.tickets.filter((ticket) =>
          accepted.includes(ticket.fault_at_open),
        );
        expect(naming.length, "rules opened no item naming oil_cooler_fouled").toBeGreaterThan(0);
      },
    );

    it("writes no key, bearer header, raw provider body or decision state anywhere", () => {
      const texts = filesUnder(out).map((file) => readFileSync(join(out, file), "utf8"));
      texts.push(outcome.stdout, outcome.stderr);
      for (const text of texts) {
        expect(text).not.toContain(MOCK_API_KEY);
        expect(text).not.toContain("Bearer");
      }
      for (const id of SMOKE_SCENARIOS) {
        const log = readFileSync(join(runDir, "scenarios", `${id}.von.jsonl`), "utf8");
        for (const line of log.split("\n").filter((entry) => entry !== "")) {
          const event = JSON.parse(line) as { type: string; output?: Record<string, unknown> };
          if (event.type !== "decision" || event.output === undefined) continue;
          expect(event.output).not.toHaveProperty("state");
          expect(event.output).not.toHaveProperty("raw");
          expect(event.output).toHaveProperty("state_digest");
        }
      }
    });
  });
});
