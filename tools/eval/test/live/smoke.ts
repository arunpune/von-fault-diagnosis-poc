// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the two live smoke tests share: the decision they ask about, the
// shape they check and the one line they print.
//
// The decision is the F3 scenario's first suspect event (`f3_air_leak_jun05`,
// the recorded air leak of 5 June): its slice is replayed through the
// pipeline host with the rules baseline, which reaches nothing, and the input
// of the first decision the pipeline takes is kept — the event and the
// candidates the retriever offered, exactly what a live backend would be
// asked in a run. The checks are the shape of the answer, never its judgment:
// one call cannot say whether a model is right.

import { NONE_OF_THESE } from "@fdp/backend/pipeline";
import type { DecisionBackend, DecisionInput, DecisionOutput } from "@fdp/backend/pipeline";
import { expect } from "vitest";

import { createRulesHandle } from "../../src/backends/rules.ts";
import type { BackendHandle } from "../../src/backends/types.ts";
import { loadCatalog } from "../../src/config.ts";
import type { EvalConfig } from "../../src/config.ts";
import { cost } from "../../src/metrics/cost.ts";
import { createFakeWallClock, runScenario } from "../../src/runner/host.ts";
import { bindScenario, loadAll } from "../../src/scenario/index.ts";

/** The scenario whose first suspect event both live tests decide. */
export const LIVE_SCENARIO = "f3_air_leak_jun05";

/** How long one live decision may take, the SDK's retries included. */
export const LIVE_TIMEOUT_MS = 120_000;

/**
 * The input of the first decision the F3 replay takes.
 *
 * @throws MissingSliceError when the slice is not cut (`make fixtures`), and Error when the
 * replay raises no suspect event at all.
 */
export async function firstSuspectInput(cfg: EvalConfig): Promise<DecisionInput> {
  const scenario = loadAll().find((entry) => entry.id === LIVE_SCENARIO);
  if (scenario === undefined) throw new Error(`no scenario ${LIVE_SCENARIO}`);
  const catalog = await loadCatalog(cfg.catalog, cfg.secrets);
  const wall = createFakeWallClock();
  const rules = createRulesHandle({ wall });

  let first: DecisionInput | undefined;
  const capturing: DecisionBackend = {
    name: rules.backend.name,
    model: rules.backend.model,
    decide: (input, options) => {
      first ??= input;
      return rules.backend.decide(input, options);
    },
  };
  const handle: BackendHandle = { ...rules, backend: capturing };
  await runScenario(bindScenario(scenario), handle, cfg, catalog, { wall });
  if (first === undefined) throw new Error(`the ${LIVE_SCENARIO} replay raised no suspect event`);
  return first;
}

/** Checks the shape of a live answer: a candidate or the abstention, and billed tokens. */
export function expectLiveShape(output: DecisionOutput, input: DecisionInput): void {
  const allowed = [...input.candidates.map((candidate) => candidate.fault_id), NONE_OF_THESE];
  expect(allowed).toContain(output.choice);
  expect(output.usage.input_tokens).toBeGreaterThan(0);
  expect(output.confidence).toBeGreaterThanOrEqual(0);
  expect(output.confidence).toBeLessThanOrEqual(1);
  for (const id of Object.keys(output.probabilities)) expect(allowed).toContain(id);
  expect(["low", "medium", "high", "critical"]).toContain(output.severity.level);
}

/** Prints what the call cost at the run's dated prices: the one line a live test writes. */
export function printCost(
  backend: "jev" | "llm",
  output: DecisionOutput,
  cfg: EvalConfig,
  input: DecisionInput,
): void {
  const billed = cost(
    [
      {
        decisionId: `${backend}-live-smoke`,
        episodeId: `${backend}-live-smoke`,
        simTs: new Date(input.event.sim_ts),
        choice: output.choice,
        confidence: output.confidence,
        gate: "log",
        abstained: output.choice === NONE_OF_THESE,
        usage: output.usage,
        backend,
        benignChoice: false,
      },
    ],
    cfg.prices,
    backend,
  );
  process.stdout.write(
    `${backend} live smoke (${output.model}): ${billed.input_tokens} input and ` +
      `${billed.output_tokens} output tokens, USD ${billed.usd.toFixed(8)} at the prices of ` +
      `${billed.prices.asOf}\n`,
  );
}
