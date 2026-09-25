// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The shape of `.github/workflows/ci.yml`.
//
// A workflow is the one part of this repository that no local run exercises:
// the proof that it works is a green run on GitHub, which nobody can see from
// a local checkout. So the properties that a green run would not reveal either
// are asserted here instead — that every job exists with its intended
// prerequisites, runner and timeout, that no third-party action floats on a
// tag, that no secret is referenced, that no job is skipped except the two
// advisory ones, and that the four rules the workflow is the only home of (the
// dataset slices, the timing slack, the embedding model and Go's integration
// tests in one job) are actually in it.
//
// Syntax is left to actionlint, run here in the image `make lint` uses and
// `ci.yml` pins by digest; a machine without Docker warns and skips that one
// test, and FDP_REQUIRE_DOCKER (which CI sets) turns the absence into a
// failure.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW = join(REPO_ROOT, ".github/workflows/ci.yml");
const TOOLCHAIN_ACTION = join(REPO_ROOT, ".github/actions/setup-toolchain/action.yml");
const DATASET_ACTION = join(REPO_ROOT, ".github/actions/setup-dataset/action.yml");
const DEPENDABOT = join(REPO_ROOT, ".github/dependabot.yml");

/** The image `ci.yml` and `make lint` both run actionlint from. */
const ACTIONLINT_IMAGE =
  "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667";

/**
 * The core jobs, with their budget in minutes.
 * `timeout-minutes` is twice the budget, so the table is the assertion.
 */
const CORE_JOBS: Record<string, number> = {
  lint: 6,
  test: 8,
  "test-integration": 15,
  reuse: 2,
  licenses: 5,
  "contract-drift": 4,
  "manual-spec": 4,
  "check-manual": 10,
  go: 12,
  frontend: 8,
  "foundation-smoke": 6,
  "eval-smoke": 10,
};

/** The stack jobs, with their budget. */
const STACK_JOBS: Record<string, number> = {
  stack: 20,
  quickstart: 20,
  "mosquitto-next": 15,
  "quickstart-download": 40,
};

/**
 * The prerequisites: the heavy stack jobs wait for the fast ones, so a
 * broken commit fails in minutes. A job absent from this map has none.
 */
const NEEDS: Record<string, string[]> = {
  "eval-smoke": ["test"],
  stack: ["lint", "test"],
  quickstart: ["lint", "test"],
  "mosquitto-next": ["lint"],
};

/**
 * The only jobs that may be skipped, with the exact condition that runs them:
 * the manual Mosquitto 2.1 job and the weekly download job.
 * Neither is a required check.
 */
const ADVISORY_JOBS: Record<string, string> = {
  "mosquitto-next": "github.event.inputs.mosquitto_next == 'true'",
  "quickstart-download":
    "github.event_name == 'schedule' || github.event.inputs.full_dataset == 'true'",
};

/**
 * The jobs that read MetroPT-3 and therefore run `setup-dataset`.
 * `mosquitto-next` is one because smoke.sh refuses to start without the slice.
 */
const DATASET_CONSUMERS = [
  "test",
  "test-integration",
  "go",
  "eval-smoke",
  "stack",
  "quickstart",
  "mosquitto-next",
];

/**
 * `owner/repo@<40 hex> # vX.Y.Z` — the only accepted form: every dependency is verified
 * before it is pinned, and a moved tag cannot change what runs.
 */
const PINNED_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} {1,2}# v\d/;

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  id?: string;
  name?: string;
  "working-directory"?: string;
}

interface Job {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  strategy?: { matrix?: { include?: Record<string, string>[] } };
  steps?: Step[];
}

interface Workflow {
  name?: string;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const workflowText = readFileSync(WORKFLOW, "utf8");
const workflow = parse(workflowText) as Workflow;
const jobs = workflow.jobs ?? {};
const jobIds = Object.keys(jobs);

/** Every `uses:` value in a file, workflow or composite action alike. */
function usesValues(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:-\s+)?uses:\s*(\S.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
}

/** The steps of a job, with the composite actions it calls left as `uses`. */
function stepsOf(id: string): Step[] {
  return jobs[id]?.steps ?? [];
}

/** Every shell command a job runs, for the "where does X run" checks. */
function runLines(id: string): string[] {
  return stepsOf(id)
    .map((step) => step.run)
    .filter((run): run is string => run !== undefined);
}

/** The same commands as one string, for a substring search. */
function runScript(id: string): string {
  return runLines(id).join("\n");
}

/** The position of the first step of a job whose command contains `text`, or -1. */
function stepRunning(id: string, text: string): number {
  return stepsOf(id).findIndex((step) => step.run?.includes(text) ?? false);
}

/** The position of the first step of a job that uses an action matching `text`, or -1. */
function stepUsing(id: string, text: string): number {
  return stepsOf(id).findIndex((step) => step.uses?.includes(text) ?? false);
}

/** The upload steps of a job, by the artefact paths they upload. */
function uploadsOf(id: string): Step[] {
  return stepsOf(id).filter((step) => step.uses?.includes("upload-artifact"));
}

/** The check runs a job shows on GitHub: its name, once per matrix entry. */
function checkNames(id: string): string[] {
  const job = jobs[id];
  const name = job?.name ?? id;
  const include = job?.strategy?.matrix?.include;
  if (include === undefined) return [name];
  return include.map((entry) =>
    name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_match, key: string) => entry[key] ?? ""),
  );
}

/** Anything that would execute the Go tests behind the `integration` tag. */
const GO_INTEGRATION = /test-integration-go|-tags integration|-C services\/modbus test-integration/;

function hasDocker(): boolean {
  return (
    spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" })
      .status === 0
  );
}

describe("ci.yml header", () => {
  it("is the workflow named ci, triggered by its four events", () => {
    expect(workflow.name).toBe("ci");
    // YAML 1.2 keeps `on` a string key; older loaders fold it to `true`.
    const triggers = (workflow as Record<string, unknown>)["on"] as
      Record<string, unknown> | undefined;
    expect(Object.keys(triggers ?? {}).sort()).toEqual([
      "pull_request",
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
    const dispatch = triggers?.["workflow_dispatch"] as { inputs?: Record<string, unknown> };
    expect(Object.keys(dispatch.inputs ?? {}).sort()).toEqual(["full_dataset", "mosquitto_next"]);
  });

  it("grants read access to the contents and nothing else", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("cancels superseded runs of the same ref", () => {
    expect(workflow.concurrency?.group).toBe("${{ github.workflow }}-${{ github.ref }}");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("carries the shared environment and the CI timing slack", () => {
    const env = workflow.env ?? {};
    expect(env["CI"]).toBe("true");
    expect(env["FDP_REQUIRE_SCHEMAS"]).toBe("1");
    expect(env["FDP_REQUIRE_CONTRACTS"]).toBe("1");
    expect(env["FDP_TIMING_SLACK"]).toBe("3");
    expect(env["MODEL_CACHE_DIR"]).toBe("${{ github.workspace }}/.cache/models");
  });

  it("pins uv to the version the toolchain action installs", () => {
    const action = parse(readFileSync(TOOLCHAIN_ACTION, "utf8")) as {
      inputs?: Record<string, { default?: string }>;
    };
    expect(workflow.env?.["UV_VERSION"]).toBe(action.inputs?.["uv-version"]?.default);
  });
});

describe("ci.yml jobs", () => {
  it("contains every expected job", () => {
    for (const id of [...Object.keys(CORE_JOBS), ...Object.keys(STACK_JOBS)]) {
      expect(jobIds).toContain(id);
    }
  });

  it("contains no unexpected job", () => {
    const planned = [...Object.keys(CORE_JOBS), ...Object.keys(STACK_JOBS)];
    for (const id of jobIds) expect(planned).toContain(id);
  });

  it("declares the expected prerequisites and no others", () => {
    for (const id of jobIds) {
      const needs = jobs[id]?.needs;
      const declared = typeof needs === "string" ? [needs] : (needs ?? []);
      expect([id, [...declared].sort()]).toEqual([id, NEEDS[id] ?? []]);
    }
  });

  it("runs every job on ubuntu-24.04 with a timeout of twice its budget", () => {
    const budgets = { ...CORE_JOBS, ...STACK_JOBS };
    for (const id of jobIds) {
      expect([id, jobs[id]?.["runs-on"]]).toEqual([id, "ubuntu-24.04"]);
      expect([id, jobs[id]?.["timeout-minutes"]]).toEqual([id, 2 * (budgets[id] as number)]);
    }
  });

  it("uploads what a failed job produced, with a 14-day retention", () => {
    // These write no report: their whole output is the exit code and the log.
    const silent = new Set(["reuse", "contract-drift", "foundation-smoke"]);
    for (const id of jobIds) {
      if (silent.has(id)) continue;
      const uploads = stepsOf(id).filter((step) => step.uses?.includes("upload-artifact"));
      expect([id, uploads.length > 0]).toEqual([id, true]);
      for (const upload of uploads) {
        expect([id, upload.with?.["retention-days"]]).toEqual([id, 14]);
      }
    }
  });
});

describe("ci.yml required checks", () => {
  it("lists in its header exactly the checks of every job that is not advisory", () => {
    const header = workflowText.slice(0, workflowText.indexOf("\nname: ci"));
    const listed = header
      .split("\n")
      .flatMap((line) => /^# {3}- (\S.*)$/.exec(line)?.slice(1) ?? []);
    const expected = jobIds.filter((id) => !(id in ADVISORY_JOBS)).flatMap((id) => checkNames(id));
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(listed).toContain("test-integration (node)");
    expect(listed).toContain("test-integration (python)");
  });
});

describe("ci.yml pins and secrets", () => {
  it("pins every third-party action to a commit with its version in a comment", () => {
    const external = usesValues(workflowText).filter((value) => !value.startsWith("./"));
    expect(external.length).toBeGreaterThan(0);
    for (const value of external) expect([value, PINNED_USES.test(value)]).toEqual([value, true]);
  });

  it("pins the actions of both composite actions the same way", () => {
    for (const file of [TOOLCHAIN_ACTION, DATASET_ACTION]) {
      const external = usesValues(readFileSync(file, "utf8")).filter(
        (value) => !value.startsWith("./"),
      );
      expect(external.length).toBeGreaterThan(0);
      for (const value of external) expect([value, PINNED_USES.test(value)]).toEqual([value, true]);
    }
  });

  it("references no repository secret anywhere in the CI configuration", () => {
    for (const file of [WORKFLOW, TOOLCHAIN_ACTION, DATASET_ACTION, DEPENDABOT]) {
      // Whole-line comments are prose about the rule, not a use of it.
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect([file, code.includes("secrets.")]).toEqual([file, false]);
    }
  });
});

describe("ci.yml job conditions", () => {
  it("gates only the two advisory jobs, each on its own trigger", () => {
    const gated = Object.fromEntries(
      jobIds.flatMap((id) => {
        const condition = jobs[id]?.if;
        return condition === undefined ? [] : [[id, condition]];
      }),
    );
    expect(gated).toEqual(ADVISORY_JOBS);
  });

  it("keeps no temporary guard: no detect job, no marker probe, no TODO marker", () => {
    expect(jobIds).not.toContain("detect");
    expect(workflowText).not.toContain("needs.detect");
    expect(workflowText).not.toMatch(/TODO\(/);
  });

  it("skips no job or step on hashFiles, which is only a cache key", () => {
    for (const id of jobIds) {
      const conditions = [jobs[id]?.if, ...stepsOf(id).map((step) => step.if)];
      for (const condition of conditions) {
        expect([id, condition?.includes("hashFiles") ?? false]).toEqual([id, false]);
      }
    }
  });

  it("never lets a job continue on error", () => {
    expect(workflowText).not.toContain("continue-on-error");
  });
});

describe("ci.yml stack job", () => {
  it("runs the smoke test with --keep, then the browser tour, then the stack score", () => {
    const smoke = stepRunning("stack", "scripts/smoke.sh --mode ci --keep --report reports/smoke");
    const tour = stepRunning("stack", "make e2e");
    const score = stepRunning("stack", "make eval-stack");
    expect(smoke).toBeGreaterThanOrEqual(0);
    expect(tour).toBeGreaterThan(smoke);
    expect(score).toBeGreaterThan(tour);
  });

  it("collects the logs and tears the stack down in an always() step", () => {
    const index = stepRunning("stack", "down -v --remove-orphans");
    const teardown = stepsOf("stack")[index];
    expect(index).toBeGreaterThan(stepRunning("stack", "make eval-stack"));
    expect(teardown?.if).toBe("always()");
    expect(teardown?.run).toContain("project=$(cat reports/smoke/project)");
    expect(teardown?.run).toContain(
      'docker compose -p "$project" logs --no-color > reports/smoke/logs.txt',
    );
    expect(teardown?.run).toContain('docker compose -p "$project" down -v --remove-orphans');
  });

  it("restores the embedding models and Chromium before the smoke test", () => {
    const smoke = stepRunning("stack", "scripts/smoke.sh");
    const models = stepsOf("stack").findIndex((step) => step.with?.["path"] === ".cache/models");
    const browsers = stepsOf("stack").findIndex(
      (step) => step.with?.["path"] === "~/.cache/ms-playwright",
    );
    expect(models).toBeGreaterThanOrEqual(0);
    expect(browsers).toBeGreaterThanOrEqual(0);
    expect(Math.max(models, browsers)).toBeLessThan(smoke);
    expect(stepsOf("stack")[models]?.with?.["key"]).toBe(
      "models-${{ hashFiles('packages/contracts/embedding.json') }}",
    );
  });

  it("uploads the smoke report and the score always, the Playwright report on failure", () => {
    const byPath = new Map(uploadsOf("stack").map((step) => [step.with?.["path"], step.if]));
    expect(byPath.get("reports/smoke/**")).toBe("always()");
    expect(byPath.get("reports/eval/**")).toBe("always()");
    expect(byPath.get("apps/frontend/playwright-report")).toBe("failure()");
  });
});

describe("ci.yml quickstart job", () => {
  const clone = "${{ runner.temp }}/clone";

  it("cuts the slice in the workspace, clones, then copies the slice into the clone", () => {
    const dataset = stepUsing("quickstart", "./.github/actions/setup-dataset");
    const cloned = stepRunning(
      "quickstart",
      'git clone --depth 1 "file://$GITHUB_WORKSPACE" "$RUNNER_TEMP/clone"',
    );
    const copied = stepRunning(
      "quickstart",
      'cp data/fixtures/metropt3/ci-slice.csv "$RUNNER_TEMP/clone/data/fixtures/metropt3/"',
    );
    expect(dataset).toBeGreaterThanOrEqual(0);
    expect(cloned).toBeGreaterThan(dataset);
    expect(copied).toBeGreaterThan(cloned);
    expect(stepsOf("quickstart")[copied]?.run).toContain(
      'mkdir -p "$RUNNER_TEMP/clone/data/fixtures/metropt3"',
    );
    expect(stepRunning("quickstart", "make up")).toBeGreaterThan(copied);
  });

  it("keeps exactly one documented .env deviation, the fixture line", () => {
    const script = runScript("quickstart");
    expect(script).toContain("cp .env.example .env");
    expect(script.match(/>> \.env/g)).toHaveLength(1);
    expect(script).toContain(
      "printf 'METROPT_CSV=/data/fixtures/metropt3/ci-slice.csv\\n' >> .env",
    );
  });

  it("runs the README commands inside the clone, in the README's order", () => {
    const steps = stepsOf("quickstart");
    const order = [
      "cp .env.example .env",
      "make up",
      "curl -fsS http://localhost:8080/healthz",
      "scripts/smoke.sh --mode quickstart",
      "make down",
      "make reset",
    ].map((command) => stepRunning("quickstart", command));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
    for (const index of order) {
      const step = steps[index];
      if (step?.run?.startsWith("curl")) continue;
      expect([step?.run, step?.["working-directory"]]).toEqual([step?.run, clone]);
    }
    for (const command of ["make down", "make reset"]) {
      expect(steps[stepRunning("quickstart", command)]?.if).toBe(
        "always() && steps.clone.outcome == 'success'",
      );
    }
  });

  it("sets up no toolchain, because the README asks for Docker and git only", () => {
    expect(stepUsing("quickstart", "setup-toolchain")).toBe(-1);
  });

  it("always uploads the quick-start smoke report", () => {
    const [upload] = uploadsOf("quickstart");
    expect(upload?.with?.["path"]).toBe("reports/smoke-quickstart/**");
    expect(upload?.if).toBe("always()");
  });
});

describe("ci.yml quickstart-download job", () => {
  it("runs weekly from the schedule trigger", () => {
    const triggers = (workflow as Record<string, unknown>)["on"] as {
      schedule?: { cron?: string }[];
    };
    const crons = (triggers.schedule ?? []).map((entry) => entry.cron ?? "");
    expect(crons).toHaveLength(1);
    // Five fields, a fixed minute and hour, any day of the month, one weekday.
    expect(crons[0]).toMatch(/^\d{1,2} \d{1,2} \* \* [0-6]$/);
  });

  it("downloads through init: no setup-dataset, no slice copy, no METROPT_CSV line", () => {
    const script = runScript("quickstart-download");
    expect(stepUsing("quickstart-download", "setup-dataset")).toBe(-1);
    expect(script).not.toContain("ci-slice.csv");
    expect(script).not.toContain("METROPT_CSV");
    expect(script).toContain("cp .env.example .env");
    const up = stepsOf("quickstart-download")[stepRunning("quickstart-download", "make up")];
    expect(up?.env?.["METROPT_URL"]).toBe("${{ vars.METROPT_URL }}");
  });

  it("cuts the smoke test's slice from the download before the smoke test runs", () => {
    const up = stepRunning("quickstart-download", "make up");
    const cut = stepRunning("quickstart-download", "make fixtures");
    const smoke = stepRunning("quickstart-download", "scripts/smoke.sh --mode ci");
    expect(cut).toBeGreaterThan(up);
    expect(smoke).toBeGreaterThan(cut);
    expect(stepsOf("quickstart-download")[cut]?.env?.["FDP_REQUIRE_DATASET"]).toBe("1");
  });

  it("uploads the smoke report and init's report always", () => {
    const paths = uploadsOf("quickstart-download").map((step) => [step.with?.["path"], step.if]);
    expect(paths).toEqual([
      ["reports/quickstart-download/**", "always()"],
      ["${{ runner.temp }}/clone/reports/**", "always()"],
    ]);
  });
});

describe("ci.yml mosquitto-next job", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "infra/mosquitto/Dockerfile"), "utf8");

  it("builds the broker on 2.1.2-alpine through the Dockerfile's build argument", () => {
    expect(jobs["mosquitto-next"]?.env?.["MQTT_IMAGE"]).toBe("eclipse-mosquitto:2.1.2-alpine");
    expect(runScript("mosquitto-next")).toContain(
      'build --build-arg "MQTT_IMAGE=$MQTT_IMAGE" mqtt',
    );
    expect(dockerfile).toMatch(/^ARG MQTT_IMAGE=eclipse-mosquitto:2\.0\.22$/m);
    expect(dockerfile).toMatch(/^FROM \$\{MQTT_IMAGE\}$/m);
  });

  it("checks the version, then smokes the prebuilt broker without rebuilding it", () => {
    const build = stepRunning("mosquitto-next", "--build-arg");
    const version = stepRunning("mosquitto-next", '"mosquitto version 2.1."*');
    const smoke = stepRunning(
      "mosquitto-next",
      'scripts/smoke.sh --mode ci --project "$SMOKE_PROJECT" --no-build',
    );
    expect(version).toBeGreaterThan(build);
    expect(smoke).toBeGreaterThan(version);
  });

  it("teaches no compose file or .env row the variable", () => {
    for (const file of ["compose.yaml", "compose.ci.yaml", "compose.dev.yaml", ".env.example"]) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      expect([file, text.includes("MQTT_IMAGE")]).toEqual([file, false]);
    }
  });
});

describe("ci.yml eval-smoke job", () => {
  it("runs the smoke profile against the core-10 gate with a mock Jev", () => {
    const env = jobs["eval-smoke"]?.env ?? {};
    expect(env["EVAL_PROFILE"]).toBe("smoke");
    expect(env["EVAL_JEV_MODE"]).toBe("mock");
    expect(runLines("eval-smoke")).toContain("pnpm --filter @fdp/eval run eval -- --fail-on-gate");
  });

  it("always uploads the evaluation report", () => {
    const [upload] = uploadsOf("eval-smoke");
    expect(upload?.with?.["path"]).toBe("reports/eval/**");
    expect(upload?.if).toBe("always()");
  });
});

describe("ci.yml frontend long-task ceiling", () => {
  const index = stepRunning("frontend", "measured?.longest_long_task_ms");
  const step = stepsOf("frontend")[index];
  const jobEnv = jobs["frontend"]?.env ?? {};

  /** Runs the step as the runner would, against a report with the given body. */
  function runCeiling(report: string | undefined): number | null {
    const dir = mkdtempSync(join(tmpdir(), "fdp-perf-ceiling-"));
    try {
      const file = join(dir, "frontend-perf.json");
      if (report !== undefined) writeFileSync(file, report);
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step?.run ?? ""],
        {
          cwd: dir,
          env: { ...process.env, ...jobEnv, ...step?.env, PERF_REPORT: file },
          encoding: "utf8",
        },
      );
      return result.status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const measured = (longest: number): string =>
    JSON.stringify({
      report_only: true,
      measured: { long_tasks: 3, longest_long_task_ms: longest },
    });

  it("keeps the strict budget report-only and sets the loose ceiling at 250 ms", () => {
    expect(jobEnv["PERF_REPORT_ONLY"]).toBe("1");
    expect(jobEnv["PERF_CI_LONG_TASK_CEILING_MS"]).toBe("250");
    expect(step?.env?.["PERF_REPORT"]).toBe("reports/frontend-perf.json");
  });

  it("reads the report after the browser tests and uploads it either way", () => {
    expect(index).toBeGreaterThan(stepRunning("frontend", "e2e:mock"));
    const upload = uploadsOf("frontend").find(
      (candidate) => candidate.with?.["path"] === "reports/frontend-perf.json",
    );
    expect(upload?.if).toBe("always()");
  });

  it("passes a longest long task at or under the ceiling", () => {
    expect(runCeiling(measured(63))).toBe(0);
    expect(runCeiling(measured(250))).toBe(0);
  });

  it("fails a longest long task above the ceiling", () => {
    expect(runCeiling(measured(251))).toBe(1);
  });

  it("fails when the report is missing or has no measurement", () => {
    expect(runCeiling(undefined)).toBe(1);
    expect(runCeiling(JSON.stringify({ measured: {} }))).toBe(1);
  });
});

describe("ci.yml dataset, embeddings and Go", () => {
  it("runs setup-dataset in every job that reads MetroPT-3, and nowhere else", () => {
    for (const id of jobIds) {
      const uses = stepsOf(id).map((step) => step.uses);
      const wanted = DATASET_CONSUMERS.includes(id);
      expect([id, uses.includes("./.github/actions/setup-dataset")]).toEqual([id, wanted]);
    }
  });

  it("makes a skipped embedding parity test a failure in test-integration", () => {
    const env = jobs["test-integration"]?.env ?? {};
    expect(env["EMBEDDER_ALLOW_DOWNLOAD"]).toBe("true");
    expect(env["FDP_REQUIRE_MODEL"]).toBe("1");
  });

  it("runs the Python network parity test next to the Python integration layer", () => {
    expect(runScript("test-integration")).toContain("pytest -m network");
  });

  it("leaves Go out of the test-integration matrix", () => {
    const include = jobs["test-integration"]?.strategy?.matrix?.include ?? [];
    expect(include.map((entry) => entry["lang"])).toEqual(["node", "python"]);
  });

  it("runs the Go integration tests only in the go job", () => {
    for (const id of jobIds) {
      expect([id, GO_INTEGRATION.test(runScript(id))]).toEqual([id, id === "go"]);
    }
  });

  it("gives the go job one step without the race detector, for the timing file", () => {
    const lines = runLines("go");
    expect(lines).toContain("make -C services/modbus test-race");
    expect(lines).toContain("make -C services/modbus test");
  });
});

describe("the composite actions", () => {
  const dataset = readFileSync(DATASET_ACTION, "utf8");

  it("restores the dataset from a cache keyed on the committed checksums", () => {
    const action = parse(dataset) as { runs?: { steps?: Step[] } };
    const restore = action.runs?.steps?.[0];
    expect(restore?.uses).toContain("actions/cache@");
    expect(restore?.with?.["path"]).toBe("data/metropt3");
    expect(restore?.with?.["key"]).toBe("metropt3-${{ hashFiles('data/SHA256SUMS') }}");
  });

  it("downloads only on a cache miss, then cuts the slices and requires them", () => {
    const action = parse(dataset) as { runs?: { steps?: Step[] } };
    const steps = action.runs?.steps ?? [];
    const download = steps.find((step) => step.run?.includes("scripts/data/fetch-metropt3.sh"));
    expect(download?.if).toBe("steps.restore.outputs.cache-hit != 'true'");
    const scripts = steps.map((step) => step.run?.trim());
    // The export must precede the cut, or a missing source is a silent skip.
    const required = scripts.indexOf('echo "FDP_REQUIRE_DATASET=1" >> "$GITHUB_ENV"');
    const cut = scripts.indexOf("make fixtures");
    expect(required).toBeGreaterThanOrEqual(0);
    expect(cut).toBeGreaterThan(required);
  });

  it("installs Node, uv and Go from the files in the repository", () => {
    const toolchain = readFileSync(TOOLCHAIN_ACTION, "utf8");
    expect(toolchain).toContain("node-version-file: .nvmrc");
    expect(toolchain).toContain("cache: pnpm");
    expect(toolchain).toContain("go-version-file: services/modbus/go.mod");
    expect(toolchain).toContain("cache-dependency-glob: uv.lock");
    expect(toolchain).toContain("run: make install");
  });
});

describe("the repository's CI configuration", () => {
  it("keeps the foundation checks in ci.yml, with no separate foundation.yml", () => {
    expect(existsSync(join(REPO_ROOT, ".github/workflows/foundation.yml"))).toBe(false);
    for (const id of ["lint", "test", "reuse", "licenses", "foundation-smoke"]) {
      expect(jobIds).toContain(id);
    }
  });

  it("keeps ci.yml the only workflow in the repository", () => {
    const names = readdirSync(join(REPO_ROOT, ".github/workflows"))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(names).toEqual(["ci.yml"]);
  });

  it("asks Dependabot for weekly updates of every ecosystem", () => {
    const config = parse(readFileSync(DEPENDABOT, "utf8")) as {
      version?: number;
      updates?: { "package-ecosystem"?: string; schedule?: { interval?: string } }[];
    };
    expect(config.version).toBe(2);
    const ecosystems = (config.updates ?? []).map((entry) => entry["package-ecosystem"]);
    expect(ecosystems.sort()).toEqual(["docker", "github-actions", "gomod", "npm", "uv"]);
    for (const entry of config.updates ?? []) {
      expect(entry.schedule?.interval).toBe("weekly");
    }
  });
});

describe("actionlint", () => {
  it("accepts the workflow", () => {
    if (!hasDocker()) {
      const message = `ci-workflow: Docker is absent; actionlint did not run over ${WORKFLOW}.`;
      if (process.env["FDP_REQUIRE_DOCKER"] !== undefined) throw new Error(message);
      console.warn(message);
      return;
    }
    const result = spawnSync(
      "docker",
      ["run", "--rm", "-v", `${REPO_ROOT}:/repo`, "-w", "/repo", ACTIONLINT_IMAGE, "-color"],
      { encoding: "utf8" },
    );
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()).toBe("");
    expect(result.status).toBe(0);
  });
});
