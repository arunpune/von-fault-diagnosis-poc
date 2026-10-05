// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A stored run, back in the metrics' vocabulary, and one scenario of it
// re-gated at one pair: what `fdp-eval sweep` and its pre-registered form
// (`preregistered.ts`) share.
//
// A scenario of `run.json` becomes the binding the run scored it with and the
// `SweepRun` `sweep()` re-gates: its decisions by episode, a merged episode's
// under its target's (`mergeTargets`), each backend around the pair its gate
// applied (`backendThresholds`), with the run's `GATE_PERSIST_SIM_MIN` so that
// a decision a ticketless episode could not have taken never opens a ticket.
// `rescoreScenario` then scores the re-gated tickets with the run's own
// scorer, so the row at the run's own pair gives the run back.

import { NONE_OF_THESE, gate, scoreScenario } from "../metrics/index.ts";
import type {
  DecisionRecord,
  ScenarioBinding,
  ScenarioMetrics,
  SuspectRecord,
  SweepRun,
  ThresholdPair,
} from "../metrics/index.ts";
import type { ReportDecision, ReportScenario, RunReport } from "../report/types.ts";

/** A problem the caller fixes by changing a flag or the run it points at. */
export class SweepUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepUsageError";
  }
}

/** A stored decision in the metrics' vocabulary, with how long its evidence had held. */
export function decisionRecord(decision: ReportDecision): DecisionRecord {
  return {
    decisionId: decision.decision_id,
    episodeId: decision.episode_id,
    simTs: new Date(decision.sim_ts),
    choice: decision.choice,
    confidence: decision.confidence,
    gate: decision.gate,
    abstained: decision.abstained,
    usage: { ...decision.usage },
    backend: decision.backend,
    benignChoice: decision.benign_choice,
    ...(decision.persisted_sim_min === undefined
      ? {}
      : { persistedSimMin: decision.persisted_sim_min }),
  };
}

/** The suspect events a stored run kept for a scenario; none for an older run. */
export function suspectsOf(scenario: ReportScenario): SuspectRecord[] {
  return (scenario.suspect_events ?? []).map((suspect) => ({
    eventId: suspect.event_id,
    simTs: new Date(suspect.sim_ts),
    symptomKey: suspect.symptom_key,
  }));
}

/**
 * The pair the run's gate applied to one backend: its own when the run recorded it (Von's),
 * else the run's global pair, which every backend used before backends had their own.
 */
export function backendThresholds(
  report: RunReport,
  backend: string,
): { readonly ticketMin: number; readonly reviewMin: number } {
  const own = report.backends.find((entry) => entry.name === backend)?.thresholds;
  const pair = own ?? report.run.thresholds;
  return { ticketMin: pair.ticket_min, reviewMin: pair.review_min };
}

/** A scenario entry of `run.json` as the binding the run scored it with. */
export function bindingOf(scenario: ReportScenario): ScenarioBinding {
  return {
    id: scenario.id,
    group: scenario.group,
    split: scenario.split,
    positive: scenario.positive,
    replay: { from: new Date(scenario.replay.from), to: new Date(scenario.replay.to) },
    warmupMin: scenario.warmup_min,
    windows: scenario.windows.map((window) => ({
      id: window.id,
      from: new Date(window.from),
      to: new Date(window.to),
      leadFrom: new Date(window.lead_from),
      accepted: [...window.accepted],
      benign: window.benign,
      ...(window.onset === null ? {} : { onset: new Date(window.onset) }),
      onsetKnown: window.onset_known,
      ...(window.native_lps_first === null
        ? {}
        : { nativeLpsFirst: new Date(window.native_lps_first) }),
      headline: window.headline,
    })),
    excluded: scenario.excluded.map((window) => ({
      id: window.id,
      from: new Date(window.from),
      to: new Date(window.to),
      reason: window.reason,
    })),
    benignFaultIds: new Set(scenario.benign_fault_ids),
    expect: {
      tickets: scenario.expect.tickets,
      fault: scenario.expect.fault,
      ...(scenario.expect.within_min === null ? {} : { withinMin: scenario.expect.within_min }),
      maxFalseTickets: scenario.expect.max_false_tickets,
      passLevel: scenario.expect.pass_level,
    },
  };
}

/**
 * The episodes the run merged, each mapped to the episode whose ticket its decisions updated.
 *
 * At the run's own thresholds an episode whose decision the gate passed (review or ticket, a
 * named fault) opens a ticket unless the episode manager merged it into an open episode whose
 * ticket names the same fault. An episode with such a decision and no ticket of its own was
 * therefore merged, and its target is the ticket that was live at that decision and named the
 * same fault, the latest opened when several were. `run.json` records the merge count, not the
 * pairs, so this is where they are recovered; `sweep()` then re-gates each merged episode's
 * decisions with its target's, as the run did, rather than opening a ticket for it. Merges stay
 * as the run made them at every grid point, which is why each row is approximate.
 */
export function mergeTargets(scenario: ReportScenario): Map<string, string> {
  const owners = new Set(scenario.tickets.map((ticket) => ticket.episode_id));
  const byEpisode = new Map<string, ReportDecision[]>();
  for (const decision of scenario.decisions) {
    const list = byEpisode.get(decision.episode_id) ?? [];
    list.push(decision);
    byEpisode.set(decision.episode_id, list);
  }
  const targets = new Map<string, string>();
  for (const [episodeId, decisions] of byEpisode) {
    if (owners.has(episodeId)) continue;
    const first = [...decisions]
      .sort((left, right) => left.sim_ts.localeCompare(right.sim_ts))
      .find((decision) => decision.gate !== "log" && decision.choice !== NONE_OF_THESE);
    if (first === undefined) continue;
    const target = scenario.tickets
      .filter(
        (ticket) =>
          (ticket.fault_at_open === first.choice || ticket.fault_latest === first.choice) &&
          ticket.opened_sim_ts <= first.sim_ts &&
          (ticket.closed_sim_ts === null || ticket.closed_sim_ts > first.sim_ts),
      )
      .sort((left, right) => right.opened_sim_ts.localeCompare(left.opened_sim_ts))[0];
    if (target !== undefined) targets.set(episodeId, target.episode_id);
  }
  return targets;
}

/**
 * A scenario entry of `run.json` as the stored run `sweep()` re-gates: its decisions by episode,
 * a merged episode's under its target's (`mergeTargets`).
 */
export function sweepRunOf(scenario: ReportScenario, report: RunReport): SweepRun {
  const binding = bindingOf(scenario);
  const targets = mergeTargets(scenario);
  const byEpisode = new Map<string, DecisionRecord[]>();
  for (const decision of scenario.decisions) {
    const episodeId = targets.get(decision.episode_id) ?? decision.episode_id;
    const list = byEpisode.get(episodeId) ?? [];
    list.push(decisionRecord(decision));
    byEpisode.set(episodeId, list);
  }
  const persistSimMin = report.run.thresholds.persist_sim_min;
  return {
    split: scenario.split,
    thresholds: backendThresholds(report, scenario.backend),
    windows: binding.windows,
    excluded: binding.excluded,
    benignFaultIds: binding.benignFaultIds,
    episodes: [...byEpisode].map(([episodeId, decisions]) => ({ episodeId, decisions })),
    coveredMachineDays: scenario.replay.covered_machine_days,
    negativeMachineDays: scenario.replay.negative_machine_days,
    ...(persistSimMin === undefined ? {} : { persistSimMin }),
  };
}

/** A stored scenario's decisions re-gated at one pair; the choices never move. */
export function regatedDecisions(scenario: ReportScenario, pair: ThresholdPair): DecisionRecord[] {
  const [ticketMin, reviewMin] = pair;
  return scenario.decisions.map((stored) => {
    const verdict = gate(stored.choice, stored.confidence, ticketMin, reviewMin);
    return { ...decisionRecord(stored), gate: verdict.outcome, abstained: verdict.abstained };
  });
}

/**
 * One scenario re-scored at one pair: `sweep()`'s tickets, the decisions re-gated at the pair,
 * the run's own scorer (warmup, excluded windows and abstention included) with the suspect events
 * the run kept, so the detection level reads as the run read it.
 */
export function rescoreScenario(
  scenario: ReportScenario,
  row: { readonly tickets: ScenarioMetrics["tickets"] },
  pair: ThresholdPair,
  report: RunReport,
): ScenarioMetrics {
  const { prices } = report.run;
  return scoreScenario(
    bindingOf(scenario),
    row.tickets,
    regatedDecisions(scenario, pair),
    [],
    {
      vonInputPerMtok: prices.von_input_per_mtok,
      llmInputPerMtok: prices.llm_input_per_mtok,
      llmOutputPerMtok: prices.llm_output_per_mtok,
      asOf: prices.as_of,
    },
    { backend: scenario.backend, reviewMin: pair[1], suspects: suspectsOf(scenario) },
  );
}
