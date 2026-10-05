// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Record, replay, miss (tools/eval/CASSETTES.md), end to end through the real
// run: the F3 scenario of the smoke profile, the pipeline host, the Von
// backend, the reports.
//
// 1. Live and --record against a stand-in "live" API: the contracts' mock
//    TypeSafe server with a scripted answer policy, reached with a stand-in
//    key that exists only inside this test process. The live plan
//    runs first (a mock replay of the same scenario) and --confirm-live lets
//    the run through. Every answered call is written as a cassette.
// 2. Cassette mode under `auto` with no key: the same decisions, answer for
//    answer and token for token, with zero misses in run.json and report.md.
// 3. One cassette's state edited and re-filed: exactly one miss, counted and
//    reported with its digest.
//
// Every file the three runs wrote, every cassette and every captured log line
// is grepped for the stand-in key. The cassettes go to a temporary root, never
// under tools/eval/fixtures/cassettes/. The test skips when the F3 slice is
// not cut, and fails instead under FDP_REQUIRE_DATASET=1.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MOCK_MODEL, startMockTypeSafe } from "@fdp/contracts/mock";
import type { AnswerPolicy, ChoiceAnswer, MockTypeSafe } from "@fdp/contracts/mock";
import type { DecisionOutput } from "@fdp/backend/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CassetteStore, responsesOf } from "../../src/backends/cassette.ts";
import type { Cassette } from "../../src/backends/cassette.ts";
import { requestDigest } from "../../src/backends/digest.ts";
import type { DigestedRequest } from "../../src/backends/digest.ts";
import { selectBackends } from "../../src/backends/select.ts";
import { EXIT_OK } from "../../src/cli.ts";
import { loadConfig } from "../../src/config.ts";
import type { Env } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import { LATEST_JSON_NAME, RUN_JSON_NAME, validateReport } from "../../src/report/json.ts";
import { REPORT_MD_NAME } from "../../src/report/markdown.ts";
import type { RunReport } from "../../src/report/types.ts";
import { runScenario } from "../../src/runner/host.ts";
import type { ScenarioRun } from "../../src/runner/host.ts";
import { executeRun } from "../../src/runner/run.ts";
import { datasetRequired, sliceIsCut } from "../../src/slices.ts";

/** The stand-in key; nothing any run writes or logs may contain it. */
const KEY = "tsk-roundtrip-stand-in-4c9e";

const SCENARIO = ["--profile", "smoke", "--scenario", "f3_air_leak_jun05", "--backends", "von"];

const cut = sliceIsCut("f3-jun05");
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * The stand-in API's judgment: the first candidate of every Choice, and the mock's own answers
 * for everything else. Like the live model, it does not answer a repeated request the same way:
 * the confidence moves with the call's index, so a repeated request would replay only when each
 * arrival gets the answer that call got (`src/backends/handles.test.ts` repeats one directly).
 */
const CONFIDENCES = [0.8125, 0.875, 0.75] as const;

const scripted: AnswerPolicy = (request, index) => {
  const answers: Record<string, ChoiceAnswer> = {};
  const confidence = CONFIDENCES[index % CONFIDENCES.length] ?? 0.8125;
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== "choice") continue;
    const options = Object.keys(question.criteria);
    const pick = options.find((option) => option !== "none_of_these") ?? options[0];
    if (pick === undefined) continue;
    const rest = (1 - 0.875) / Math.max(1, options.length - 1);
    answers[id] = {
      type: "choice",
      choice: pick,
      confidence,
      probabilities: Object.fromEntries(
        options.map((option) => [option, option === pick ? 0.875 : rest]),
      ),
    };
  }
  return answers;
};

/** What one run produced: its exit code, the host's scenario runs, its report and its logs. */
interface Outcome {
  readonly code: number;
  readonly runs: readonly ScenarioRun[];
  readonly report: RunReport;
  readonly markdown: string;
  readonly written: string;
}

/** Runs `fdp-eval run` in process, with the cassettes under `cassettesDir`. */
async function evaluate(env: Env, argv: readonly string[], cassettesDir: string): Promise<Outcome> {
  const out = scratch("fdp-roundtrip-out-");
  const cfg = loadConfig([...argv, "--out", out], env, { cwd: "/tmp" });
  const lines: string[] = [];
  const sink = { write: (chunk: string) => lines.push(chunk) };
  const runs: ScenarioRun[] = [];
  const code = await executeRun(cfg, {
    log: createLogger({ env: {}, stream: sink }),
    stdout: sink,
    selectBackends: (config, deps) => selectBackends(config, { ...deps, cassettesDir }),
    runScenario: async (...args) => {
      const run = await runScenario(...args);
      runs.push(run);
      return run;
    },
  });
  const runId = readdirSync(out).find((name) => name !== LATEST_JSON_NAME);
  if (runId === undefined) throw new Error(`the run wrote nothing under ${out}`);
  const report = validateReport(JSON.parse(readFileSync(join(out, runId, RUN_JSON_NAME), "utf8")));
  const markdown = readFileSync(join(out, runId, REPORT_MD_NAME), "utf8");
  return { code, runs, report, markdown, written: `${lines.join("")}${everyFile(out)}` };
}

/** The text of every file under `directory`, for the key grep. */
function everyFile(directory: string): string {
  return readdirSync(directory, { recursive: true })
    .map((name) => join(directory, String(name)))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

/** The answered decisions of a run, in order. */
function outputsOf(outcome: Outcome): DecisionOutput[] {
  return outcome.runs.flatMap((run) =>
    run.events.flatMap((event) =>
      event.type === "decision" && event.output !== null ? [event.output] : [],
    ),
  );
}

/** What a decision decided; latency and request ids are the transport's, not the decision's. */
function decided(output: DecisionOutput) {
  return {
    backend: output.backend,
    model: output.model,
    choice: output.choice,
    probabilities: output.probabilities,
    confidence: output.confidence,
    support: output.support,
    severity: output.severity,
    usage: output.usage,
    state_digest: output.state_digest,
  };
}

function digestOf(output: DecisionOutput): string {
  return requestDigest(output.raw.request as DigestedRequest);
}

describe.skipIf(!cut)("the cassette round trip over f3_air_leak_jun05", () => {
  const cassettes = scratch("fdp-roundtrip-cassettes-");
  const store = CassetteStore.forModel(MOCK_MODEL, cassettes);
  let api: MockTypeSafe;
  let recorded: Outcome;

  beforeAll(async () => {
    api = await startMockTypeSafe({ port: 0, apiKey: KEY, answer: scripted });
    try {
      recorded = await evaluate(
        { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: api.url, EVAL_VON_MODE: "live" },
        [...SCENARIO, "--record", "--confirm-live"],
        cassettes,
      );
    } finally {
      await api.close();
    }
  });

  it("records a cassette for every distinct request of the live run", () => {
    expect(recorded.code).toBe(EXIT_OK);
    expect(recorded.report.backends).toMatchObject([
      { name: "von", mode: "live", informative: true, cassette_misses: 0 },
    ]);
    const outputs = outputsOf(recorded);
    expect(outputs.length).toBeGreaterThan(0);
    const posted = api.requests.filter((request) => request.path === "/v1/systemone");
    expect(posted).toHaveLength(outputs.length);

    const digests = new Set(outputs.map(digestOf));
    expect(store.count).toBe(digests.size);
    const arrivals = new Map<string, number>();
    for (const output of outputs) {
      const digest = digestOf(output);
      const arrival = arrivals.get(digest) ?? 0;
      arrivals.set(digest, arrival + 1);
      const answer = responsesOf(store.get(digest) as Cassette)[arrival];
      expect(answer?.answers).toEqual((output.raw.response as { answers: unknown }).answers);
      expect(answer?.usage).toEqual(output.usage);
    }
    for (const [digest, count] of arrivals) {
      expect(responsesOf(store.get(digest) as Cassette)).toHaveLength(count);
    }
    expect(recorded.written).toContain("warn live plan");
  });

  it("replays the same decisions from the cassettes with no key and zero misses", async () => {
    const replayed = await evaluate({}, SCENARIO, cassettes);
    expect(replayed.code).toBe(EXIT_OK);
    const live = outputsOf(recorded);
    expect(outputsOf(replayed).map(decided)).toEqual(live.map(decided));
    expect(replayed.report.backends).toEqual([
      expect.objectContaining({
        name: "von",
        mode: "cassette",
        cassette_hits: live.length,
        cassette_misses: 0,
        cassette_miss_digests: [],
        cassette_reused: 0,
      }),
    ]);
    expect(replayed.markdown).toContain(
      `- von ran from cassettes: ${live.length} hit(s), 0 miss(es).`,
    );
    expect(replayed.written).toContain('mode="cassette"');
    expect(replayed.written).toContain("EVAL_VON_MODE=auto");
  });

  it("counts and reports one miss when one cassette's state changed", async () => {
    const live = outputsOf(recorded);
    const counts = new Map<string, number>();
    for (const output of live)
      counts.set(digestOf(output), (counts.get(digestOf(output)) ?? 0) + 1);
    const last = live
      .map(digestOf)
      .reverse()
      .find((digest) => counts.get(digest) === 1);
    if (last === undefined) throw new Error("every request of the run repeats; no single miss");

    const cassette = store.get(last) as Cassette;
    const state = JSON.parse(
      JSON.stringify(cassette.request.state).replace(/"[^"]*"/, '"edited since the recording"'),
    ) as unknown;
    const request = { ...cassette.request, state };
    rmSync(store.pathOf(last));
    store.put({ ...cassette, request, request_digest: requestDigest(request) });

    const replayed = await evaluate({ EVAL_VON_MODE: "cassette" }, SCENARIO, cassettes);
    expect(replayed.code).toBe(EXIT_OK);
    expect(replayed.report.backends[0]).toMatchObject({
      mode: "cassette",
      cassette_hits: live.length - 1,
      cassette_misses: 1,
      cassette_miss_digests: [last],
    });
    expect(replayed.markdown).toContain(`${live.length - 1} hit(s), 1 miss(es)`);
    expect(replayed.markdown).toContain(`Missed request digests: \`${last}\``);
  });

  it("never writes or logs the key", () => {
    expect(recorded.written).not.toContain(KEY);
    expect(everyFile(cassettes)).not.toContain(KEY);
    expect(JSON.stringify(api.requests)).not.toContain(KEY);
  });
});

describe("the F3 slice", () => {
  it("is cut, or its absence is allowed", () => {
    expect(cut || !datasetRequired(), "the f3-jun05 slice is not cut; run make fixtures").toBe(
      true,
    );
  });
});
