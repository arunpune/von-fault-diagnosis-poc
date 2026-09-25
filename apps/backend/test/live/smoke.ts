// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the two live smoke tests share.
 *
 * One real decision per backend, from the same hand-built F3-like event and
 * the same fixture candidates the decision tests use (signature A: the dryer
 * purge valve does not seat), so the Jev answer and the language-model answer
 * describe one situation and can be read side by side.
 *
 * The assertions are about shape only. A live model is not a fixture: which
 * cause it picks is a question for the evaluation, not a test failure. What
 * must hold is that the answer is a decision the rest of the pipeline can
 * carry: a `decision` message that validates, billed tokens, a choice inside
 * the options offered.
 *
 * Keys stay inside `Secret` wrappers. The only place a value is revealed is
 * the check that the written report does not contain it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { assertValid } from "@fdp/contracts";
import type { Decision } from "@fdp/contracts";
import { expect } from "vitest";

import { gateThresholds, type Env } from "../../src/config/env.ts";
import type { Secret } from "../../src/config/secret.ts";
import { costBlock, pricesFor } from "../../src/cost/index.ts";
import { toDecisionMessage } from "../../src/decision/message.ts";
import { NONE_OF_THESE } from "../../src/decision/types.ts";
import type {
  DecisionBackendName,
  DecisionInput,
  DecisionOutput,
} from "../../src/decision/types.ts";
import { candidatesFor } from "../fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../fixtures/catalog/events.ts";
import { REPO_ROOT } from "../helpers/fixtures.ts";

/** The F3-like event and the candidates retrieval would offer for it. */
export const LIVE_INPUT: DecisionInput = {
  event: SIGNATURE_A_EVENT,
  candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
  unit_id: FIXTURE_UNIT_ID,
};

/** Where the redacted outputs go; `reports/*` is ignored by Git. */
export const REPORTS_DIR = join(REPO_ROOT, "reports");

/** Ids for the message envelope; nothing is written anywhere but `reports/`. */
const DECISION_ID = "66666666-6666-4666-8666-666666666601";
const EPISODE_ID = "66666666-6666-4666-8666-666666666602";

/**
 * Whether a key is set in the environment of this process.
 *
 * Only presence is read here, so the skip decision never touches a value; an
 * empty string is unset, as `config/env.ts` treats it.
 */
export function hasKey(name: "TYPESAFE_API_KEY" | "LLM_API_KEY"): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "";
}

/**
 * Assert the shape of one live answer and return it as the `decision` message
 * the pipeline would publish, priced as the ledger would bill it.
 */
export function assertLiveShape(
  output: DecisionOutput,
  env: Env,
  expected: { readonly backend: DecisionBackendName; readonly model: string },
): Decision {
  const allowed = [...SIGNATURE_A_CANDIDATE_IDS, NONE_OF_THESE];

  expect(output.backend).toBe(expected.backend);
  expect(output.model).toBe(expected.model);
  expect(output.usage.input_tokens).toBeGreaterThan(0);
  expect(allowed).toContain(output.choice);
  expect(output.confidence).toBeGreaterThanOrEqual(0);
  expect(output.confidence).toBeLessThanOrEqual(1);
  for (const id of Object.keys(output.probabilities)) expect(allowed).toContain(id);
  const mass = Object.values(output.probabilities).reduce((sum, value) => sum + value, 0);
  expect(mass).toBeCloseTo(1, 6);
  expect(output.state_digest).toMatch(/^[0-9a-f]{64}$/);

  const prices = pricesFor(env, expected.backend);
  return assertValid(
    "decision",
    toDecisionMessage(output, {
      unit_id: FIXTURE_UNIT_ID,
      decision_id: DECISION_ID,
      episode_id: EPISODE_ID,
      event_id: SIGNATURE_A_EVENT.event_id,
      sim_ts: SIGNATURE_A_EVENT.sim_ts,
      wall_ts: new Date().toISOString(),
      backend: expected.backend,
      model: expected.model,
      symptom_key: SIGNATURE_A_EVENT.symptom_key,
      candidates: LIVE_INPUT.candidates,
      gate: {
        ticketMin: gateThresholds(env.gate, expected.backend).ticketMinConfidence,
        reviewMin: gateThresholds(env.gate, expected.backend).reviewMinConfidence,
      },
      prices: (usage) => costBlock(usage, prices),
    }),
  );
}

/**
 * Write the redacted output to `reports/live-smoke-<backend>-<date>.json`.
 *
 * Redacted means: the contract message only — the answer, the tokens, the
 * cost, the latency and the request id — and never the state, the provider
 * bodies or a header. The text is checked before it is written: it must not
 * contain any of `secrets`, which is the one check a key is revealed for.
 */
export function writeLiveReport(
  backend: DecisionBackendName,
  message: Decision,
  secrets: readonly Secret[],
): string {
  const day = new Date().toISOString().slice(0, 10);
  const path = join(REPORTS_DIR, `live-smoke-${backend}-${day}.json`);
  const text = `${JSON.stringify({ kind: "live-smoke", backend, decision: message }, null, 2)}\n`;
  for (const secret of secrets) expect(text.includes(secret.reveal())).toBe(false);

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}
