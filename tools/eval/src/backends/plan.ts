// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a live run will ask and cost, known before it asks anything.
//
// Live calls are paid, so the budget is capped: `record` and every live mode
// print the planned call count and the estimated cost first, and refuse to
// contact an API without `--confirm-live`. The count cannot be read off the
// scenario files — a decision is taken wherever detection raises a suspect
// event and every `DECISION_INTERVAL_SIM_MIN` while the symptom persists — so
// the plan replays the run's scenarios once with Jev against the contracts'
// mock, which is the same pipeline, the same detection and the same request
// builders the live run will use, and counts.
//
// The estimate is exactly that. The count is the mock run's: a live answer
// can merge an episode the mock's did not, so the real run may take a few
// decisions fewer or more. The Jev tokens are the mock's usage, the
// documented estimate `ceil((bytes(state) + bytes(questions)) / 4)`. The LLM
// is asked the same three questions about the same state in one message, so
// its input is estimated the same way, and its output — one JSON object and
// a one-sentence rationale — at `LLM_OUTPUT_TOKENS_PER_CALL` per call. Every
// cost goes through the metrics' `cost()` with the run's dated prices, the same
// arithmetic the report uses afterwards.
//
// The plan selects its scenarios the way the run does — the tuning list, or
// the profile narrowed to `--scenario` — without re-checking them: it is only
// ever computed from inside `selectBackends`, which the run calls after it has
// loaded, bound and checked every scenario (runner/run.ts), and which sits
// below the run in the module graph, so it cannot import the run's own
// selection.

import { MOCK_MODEL } from "@fdp/contracts/mock";
import { loadFailureTable } from "@fdp/ground-truth";

import { loadCatalog, TUNING_PROFILE } from "../config.ts";
import type { EvalConfig } from "../config.ts";
import { cost } from "../metrics/cost.ts";
import type { DecisionRecord } from "../metrics/types.ts";
import { createFakeWallClock, runScenario } from "../runner/host.ts";
import { summarise } from "../runner/recorder.ts";
import { bindScenario, inProfile, loadAll } from "../scenario/index.ts";
import type { BoundScenario, Profile } from "../scenario/index.ts";
import { selectTuning, TUNING_BIND_PROFILE } from "../tuning.ts";
import { createMockJevHandle } from "./mock.ts";

/** The backends that reach a live API. */
export type LiveBackendName = "jev" | "llm";

/** The output an LLM decision is estimated at: a JSON answer and a one-sentence rationale. */
export const LLM_OUTPUT_TOKENS_PER_CALL = 300;

/** One live backend's share of the plan. */
export interface LivePlanRow {
  readonly backend: LiveBackendName;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
  readonly pricesAsOf: string;
}

/** What a live run will ask, per live backend, over how many scenarios. */
export interface LivePlan {
  readonly scenarios: number;
  readonly rows: readonly LivePlanRow[];
}

/** What planning reaches for; each seam defaults to the real thing. */
export interface PlanDeps {
  readonly scenariosDir?: string;
}

/** The failures the failure table marks `in_headline`, which the tuning guard keeps out. */
function headlineFailureIds(): ReadonlySet<string> {
  return new Set(
    loadFailureTable()
      .failures.filter((failure) => failure.in_headline)
      .map((failure) => failure.id),
  );
}

/** The run's scenarios, bound over the profile the run binds them with. */
function plannedScenarios(cfg: EvalConfig, deps: PlanDeps): BoundScenario[] {
  const all = loadAll(deps.scenariosDir);
  if (cfg.profile === TUNING_PROFILE) {
    return selectTuning(all, headlineFailureIds()).map((scenario) =>
      bindScenario(scenario, { profile: TUNING_BIND_PROFILE }),
    );
  }
  const profile: Profile = cfg.profile;
  const wanted = new Set(cfg.scenarios);
  return all
    .filter(
      (scenario) => inProfile(scenario, profile) && (wanted.size === 0 || wanted.has(scenario.id)),
    )
    .map((scenario) => bindScenario(scenario, { profile }));
}

/** The decisions a mock replay of the run's scenarios takes. */
async function mockDecisions(
  cfg: EvalConfig,
  deps: PlanDeps,
): Promise<{
  readonly scenarios: number;
  readonly decisions: readonly DecisionRecord[];
}> {
  const bound = plannedScenarios(cfg, deps);
  const catalog = await loadCatalog(cfg.catalog, cfg.secrets);
  const wall = createFakeWallClock();
  const handle = await createMockJevHandle({ jevModel: MOCK_MODEL }, { wall });
  try {
    const decisions: DecisionRecord[] = [];
    for (const scenario of bound) {
      const run = await runScenario(scenario, handle, cfg, catalog, { wall });
      decisions.push(...summarise(run.events, new Set()).decisions);
    }
    return { scenarios: bound.length, decisions };
  } finally {
    await handle.close();
  }
}

/** One backend's row: the mock's decisions, re-estimated for that backend, at its prices. */
export function planRow(
  backend: LiveBackendName,
  model: string,
  decisions: readonly DecisionRecord[],
  prices: EvalConfig["prices"],
): LivePlanRow {
  const estimated =
    backend === "llm"
      ? decisions.map((decision) => ({
          ...decision,
          usage: {
            input_tokens: decision.usage.input_tokens,
            output_tokens: LLM_OUTPUT_TOKENS_PER_CALL,
          },
        }))
      : decisions;
  const priced = cost(estimated, prices, backend);
  return {
    backend,
    model,
    calls: priced.calls,
    inputTokens: priced.input_tokens,
    outputTokens: priced.output_tokens,
    usd: priced.usd,
    pricesAsOf: priced.prices.asOf,
  };
}

/**
 * Plans the live calls of a run: one mock replay of its scenarios, priced for every live
 * backend named.
 *
 * @throws whatever loading the scenarios, the catalog or a slice throws, and whatever the
 * replay rejects with.
 */
export async function planLiveRun(
  cfg: EvalConfig,
  live: readonly LiveBackendName[],
  deps: PlanDeps = {},
): Promise<LivePlan> {
  const { scenarios, decisions } = await mockDecisions(cfg, deps);
  return {
    scenarios,
    rows: live.map((backend) =>
      planRow(backend, backend === "jev" ? cfg.jevModel : cfg.llmModel, decisions, cfg.prices),
    ),
  };
}
