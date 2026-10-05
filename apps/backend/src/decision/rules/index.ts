// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rules-only twin of the decision backend
 * (docs/decision-backends.md#the-rules-backend).
 *
 * It answers the same three questions from the same state with no model at all,
 * which is what makes the evaluation report meaningful: precision, recall, lead
 * time, tickets per machine-day and abstention are measured against a baseline
 * that had the identical inputs.
 *
 * ## Why `confidence` is not `p1 − p2`
 *
 * The obvious margin is wrong here. Retrieval decides how many candidates
 * there are, and normalising supports into a distribution makes every
 * probability shrink as that number grows: the same
 * machine, the same evidence and one more weakly matching cause would drop the
 * decision from `review` to `log`. The gate would then be measuring retrieval's
 * list length rather than the evidence.
 *
 * So the gating quantity is built from the supports themselves, before any
 * normalisation:
 *
 * ```text
 * confidence = s1 · clamp((s1 − s2) / 0.3, 0, 1)
 * ```
 *
 * `s1` is how much of the best candidate's signature is actually on the
 * machine, and the clamped gap is how much better it is than the runner-up: a
 * cause that fits well *and* fits distinctly better than the next one reaches
 * the gate, and adding a third weaker candidate changes neither term.
 * `probabilities` keeps the normalised supports, for display only.
 *
 * Below `s1 = 0.34` no candidate explains even a third of what the machine is
 * doing, so the twin abstains with `none_of_these` and a confidence of
 * `1 − s1`: a clear non-match is a confident abstention, which is exactly what
 * the evaluation harness counts.
 */

import type { SeverityLevel } from "@fdp/contracts";

import { RULES_MODEL } from "../../config/env.ts";
import { matchContextOf, parseObservedBuckets, scoreSignalMoves } from "../../retrieval/match.ts";
import { buildState, stateDigest } from "../state.ts";
import type { SignalLabels } from "../state.ts";
import { NONE_OF_THESE } from "../types.ts";
import type {
  DecisionBackend,
  DecisionInput,
  DecisionOutput,
  DecisionSeverity,
  FaultChoice,
} from "../types.ts";

/** Below this support no candidate explains the machine and the twin abstains. */
export const ABSTAIN_BELOW_SUPPORT = 0.34;

/** The gap at which the runner-up stops holding the confidence down. */
export const DECISIVE_SUPPORT_GAP = 0.3;

/** The four severity levels, in the order the Score's indexes use. */
const SEVERITY_ORDER: readonly SeverityLevel[] = ["low", "medium", "high", "critical"];

/** What `createRulesBackend` needs from its caller. */
export interface RulesBackendOptions {
  /**
   * The `severity_hint` of every detection rule, by rule id.
   *
   * The twin has no severity question, so it reports the worst hint among the
   * rules that fired — the same number the rule registry already assigned.
   */
  readonly severityHints: Readonly<Record<string, SeverityLevel>>;
  /** The human names of the signals, for the state the twin builds. */
  readonly labels?: SignalLabels;
  /** Wall clock, injected so a test can measure a latency deterministically. */
  readonly now?: () => number;
}

/** `value` held inside `low`…`high`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The gating quantity: the calibrated rules confidence above.
 *
 * Exported because the evaluation harness reports it beside Von's peakedness
 * and has to compute it the same way.
 */
export function gatingConfidence(supports: readonly number[]): number {
  const sorted = [...supports].sort((left, right) => right - left);
  const best = sorted[0] ?? 0;
  const runnerUp = sorted[1] ?? 0;
  return best * clamp((best - runnerUp) / DECISIVE_SUPPORT_GAP, 0, 1);
}

/** The supports plus the abstention, normalised; for the decision sheet only. */
function displayProbabilities(supports: ReadonlyMap<string, number>): Record<string, number> {
  const best = Math.max(0, ...supports.values());
  const raw = new Map<string, number>(supports);
  raw.set(NONE_OF_THESE, 1 - best);
  let total = 0;
  for (const value of raw.values()) total += value;

  const probabilities: Record<string, number> = {};
  if (total <= 0) {
    // Every candidate contradicted everything and the abstention took no mass
    // either: the honest distribution is all of it on "none of these".
    for (const id of raw.keys()) probabilities[id] = 0;
    probabilities[NONE_OF_THESE] = 1;
    return probabilities;
  }
  for (const [id, value] of raw) probabilities[id] = value / total;
  return probabilities;
}

/** The worst hint among the rules that fired, one-hot. */
function severityOf(
  ruleIds: readonly string[],
  hints: Readonly<Record<string, SeverityLevel>>,
): DecisionSeverity {
  let score = 0;
  for (const ruleId of ruleIds) {
    const hint = hints[ruleId];
    if (hint === undefined) continue;
    score = Math.max(score, SEVERITY_ORDER.indexOf(hint));
  }
  const probabilities: Record<string, number> = {};
  SEVERITY_ORDER.forEach((_level, index) => {
    probabilities[String(index)] = index === score ? 1 : 0;
  });
  return {
    level: SEVERITY_ORDER[score] ?? "low",
    score,
    probabilities,
    confidence: 1,
  };
}

/**
 * The rules backend.
 *
 * It builds the very state a model backend would have been sent and scores it,
 * so the twin can never answer from data the model did not have.
 */
export function createRulesBackend(options: RulesBackendOptions): DecisionBackend {
  const { severityHints, labels = {}, now = () => Date.now() } = options;

  return {
    name: "rules",
    model: RULES_MODEL,
    // Async because two of the three implementations call a provider; this one
    // never leaves the process, which is why its latency is microseconds.
    async decide(input: DecisionInput): Promise<DecisionOutput> {
      const started = now();
      const state = buildState(input, labels);
      const observed = parseObservedBuckets(state.observations);
      // The mode the state reports, from the same event retrieval matched in.
      const context = matchContextOf(input.event);

      const supports = new Map<string, number>();
      for (const candidate of input.candidates) {
        const { score } = scoreSignalMoves(observed, candidate.signal_moves, context);
        supports.set(candidate.fault_id, score);
      }

      const ranked = [...supports.entries()].sort(([, left], [, right]) => right - left);
      const best = ranked[0];
      const bestSupport = best?.[1] ?? 0;

      let choice: FaultChoice;
      let confidence: number;
      if (best === undefined || bestSupport < ABSTAIN_BELOW_SUPPORT) {
        choice = NONE_OF_THESE;
        confidence = 1 - bestSupport;
      } else {
        choice = best[0];
        confidence = gatingConfidence([...supports.values()]);
      }

      return {
        backend: "rules",
        model: RULES_MODEL,
        choice,
        probabilities: displayProbabilities(supports),
        confidence,
        support: Object.fromEntries(supports),
        severity: severityOf(input.event.rule_ids, severityHints),
        usage: { input_tokens: 0, output_tokens: 0 },
        latency_ms: Math.max(0, now() - started),
        state,
        state_digest: stateDigest(state),
        raw: {},
      };
    },
  };
}
