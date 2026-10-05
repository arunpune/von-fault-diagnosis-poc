// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@fdp/backend/pipeline`: the only entry point this package exports.
 *
 * The runtime and `tools/eval` are two hosts of the same pipeline, so the
 * module that composes `ingest → detect → retrieve → decide → gate →
 * episodes/tickets` holds no host of its own: it reaches the database, the
 * broker, the HTTP server and the overlay through the ports its caller
 * injects, and it never imports them. `.dependency-cruiser.cjs` enforces that
 * as the rule `pipeline-pure`, and `package.json#exports` exposes nothing else.
 *
 * ## One batch, in order
 *
 * {@link Pipeline.push} validates the batch, hands it to ingest, and walks the
 * samples ingest accepted one at a time. For each sample:
 *
 *   1. the controller alarms that changed on it are emitted;
 *   2. detection folds it in. A discontinuity — the gateway's flag, a sim-time
 *      step over a minute or a step backwards — has already reset detection's
 *      windows by then, and here it aborts every open
 *      episode and resolves their tickets;
 *   3. every suspect event detection raised goes to the episode manager, which
 *      opens an episode, asks for a re-decision or skips it. An
 *      episode that could still create a review or a ticket is decided only
 *      once its symptom's evidence has held without a break for
 *      `persistSimMin`; until then the event is only emitted;
 *   4. on a new feature frame with rules firing, the event a re-decision
 *      would send is built once the primary symptom's episode is due and may
 *      be decided, so a symptom that keeps firing is decided when its
 *      evidence has persisted and re-decided every `decisionIntervalSimMin`;
 *   5. episodes whose symptom has been silent for `episodeClearSimMin` close,
 *      and their tickets are resolved.
 *
 * A decision is retrieval, then the backend, then the gate (inside the
 * decision message, so the message, the row and the broker payload agree),
 * then the episode and ticket bookkeeping. It is awaited before the next
 * sample is looked at: the history a host records is the one a technician
 * would have seen, one step after another.
 *
 * Each decision is emitted as `suspect → decision → episode → ticket`: the
 * episode output follows the decision because it carries the episode as the
 * decision left it — counted, and merged when the decision named a fault
 * another episode's live ticket already names. A host that persists these rows
 * writes the episode before the decision that references it; the episode is in
 * the store it injected (or in {@link Pipeline.snapshot}) the moment the
 * decision is emitted. An episode whose first decision waits for persistence
 * is emitted `suspect → episode opened` at once, and its decision later on
 * its own, without a second `opened`.
 *
 * ## Failures
 *
 * A backend that does not answer throws a {@link DecisionError}; the pipeline
 * turns it into the failed form of the decision message (`status: failed`,
 * `error` set), records it on the episode — which then waits for its next
 * interval instead of asking again on every event — and changes no ticket.
 * A retriever that throws fails its decision the same way,
 * as `unknown` with a message that names retrieval: no decision could be made,
 * and the rest of the batch still is.
 *
 * Anything else — a backend throwing something other than a `DecisionError`,
 * a defect in the pipeline itself — rejects the `push` that met it, and a
 * rejected push has changed no episode and no ticket: they are put back as the
 * push found them, since the host never hears of the outputs that described
 * the changes. Detection is still shown the rest of the batch, so the next one
 * does not look like a jump, and a real jump it met is announced by the next
 * push.
 */

import { DEFAULT_UNIT_ID, SIGNALS, assertValid, simMinutesBetween, toIsoMs } from "@fdp/contracts";
import type { Decision, Sample, SeverityLevel, TelemetrySamples, Ticket } from "@fdp/contracts";

import { costBlock, type Prices } from "../cost/index.ts";
import { toDecisionMessage } from "../decision/message.ts";
import { createRulesBackend as createRulesTwin } from "../decision/rules/index.ts";
import type { RulesBackendOptions } from "../decision/rules/index.ts";
import { DecisionError, isDecisionError } from "../decision/types.ts";
import type { DecisionBackend, DecisionInput, DecisionOutput } from "../decision/types.ts";
import { REGISTRY, createDetector } from "../detection/index.ts";
import type { DetectionOutput, SuspectEventMessage } from "../detection/index.ts";
import { createEpisodeManager, createEpisodeStore } from "../episodes/index.ts";
import type { Episode, EpisodeEnd, EpisodeEventAction } from "../episodes/index.ts";
import type { GateResult } from "../gate/index.ts";
import { newId } from "../ids.ts";
import { createIngest } from "../ingest/index.ts";
import type { AlarmTransition, DecodedSample } from "../ingest/index.ts";
import type { Candidate } from "../retrieval/types.ts";
import { UnknownTicketError, createTicketManager, toTicketMessage } from "../tickets/index.ts";
import type { TicketChange, TicketRecord } from "../tickets/index.ts";
import type {
  Pipeline,
  PipelineConfig,
  PipelineOutput,
  PipelinePorts,
  PipelineTicket,
  TicketClosureInput,
} from "./types.ts";

/** The version of `@fdp/backend`; kept equal to `package.json` by its unit test. */
export const VERSION = "1.0.0";

/**
 * The defaults, for a host that tunes nothing.
 *
 * They are the same numbers `config/env.ts` falls back to, repeated here
 * because the pipeline never reads the environment: `tools/eval` passes its own
 * and the runtime passes the parsed `Env`.
 */
export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = Object.freeze({
  gate: Object.freeze({ ticketMin: 0.85, reviewMin: 0.6 }),
  decisionIntervalSimMin: 30,
  episodeClearSimMin: 120,
  persistSimMin: 1,
  rulesDisabled: Object.freeze(["flow_pulses_missing"]),
  unitId: DEFAULT_UNIT_ID,
});

/**
 * The prices of a run that injected none: nothing is billed.
 *
 * The date is `PRICES_AS_OF`'s default, so the block still
 * validates and says which price list the zeros stand in for.
 */
const UNPRICED: Prices = Object.freeze({
  price_input_per_mtok: 0,
  price_output_per_mtok: 0,
  prices_as_of: "2026-09-19",
});

/**
 * The `severity_hint` of every detection rule, by rule id.
 *
 * The rules twin reports the worst hint among the rules that fired, and these
 * are the registry's own, so a host builds the twin without restating them.
 */
export const RULE_SEVERITY_HINTS: Readonly<Record<string, SeverityLevel>> = Object.freeze(
  Object.fromEntries(REGISTRY.map((rule) => [rule.id, rule.severity_hint])),
);

/**
 * The rules backend (docs/decision-backends.md), with the registry's severity
 * hints unless the caller passes its own.
 */
export function createRulesBackend(options: Partial<RulesBackendOptions> = {}): DecisionBackend {
  return createRulesTwin({
    ...options,
    severityHints: options.severityHints ?? RULE_SEVERITY_HINTS,
  });
}

/**
 * Compose one unit's pipeline over the ports a host injects.
 *
 * Nothing here is persisted but ingest's folded telemetry, and that only when
 * the host passes {@link PipelinePorts.telemetry}: the episode and ticket
 * managers work in memory, and the host writes what the outputs say.
 */
export function createPipeline(ports: PipelinePorts, cfg: Partial<PipelineConfig> = {}): Pipeline {
  const config: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG, ...cfg };
  const { wall, retriever, decision } = ports;
  const signals = ports.signals ?? SIGNALS;
  const prices = ports.prices ?? UNPRICED;

  const store = ports.store ?? createEpisodeStore();
  const episodes = createEpisodeManager({
    store,
    cfg: {
      decisionIntervalSimMin: config.decisionIntervalSimMin,
      episodeClearSimMin: config.episodeClearSimMin,
      persistSimMin: config.persistSimMin,
    },
    ids: newId,
  });
  const tickets = createTicketManager({ ids: newId, wall });
  if (ports.tickets !== undefined) tickets.hydrate(ports.tickets);

  /** What ingest accepted from the batch being pushed, in order. */
  const accepted: DecodedSample[] = [];
  const ingest = createIngest({
    unitId: config.unitId,
    wall,
    signals,
    repo: ports.telemetry?.repo,
    retentionSimDays: ports.telemetry?.retentionSimDays,
    onSample: (sample) => accepted.push(sample),
  });
  const detector = createDetector({
    signals,
    rulesDisabled: config.rulesDisabled,
    unitId: config.unitId,
    wall,
    insideEpisode: () => episodes.openCount() > 0,
  });

  /** The sim time of the newest sample detection has seen. */
  let lastSimTs: string | undefined;
  const serial = createSerialQueue();

  /** Whether an open episode is due a decision at `simTs`. */
  function isDue(open: Episode, simTs: string): boolean {
    if (open.last_decision_sim_ts === null) return true;
    return simMinutesBetween(open.last_decision_sim_ts, simTs) >= config.decisionIntervalSimMin;
  }

  /**
   * What retrieval offered, or the failure of the decision it could not feed.
   *
   * Retrieval is the first stage of a decision, so a retriever that throws —
   * the catalog's database or the embedder gone — fails that one decision the
   * way an unreachable backend does: the event is
   * decided `failed`, its episode waits for its next interval, and the rest of
   * the batch goes on. The backend is not asked about an event it would get no
   * candidates for.
   */
  async function retrieve(event: SuspectEventMessage): Promise<Candidate[] | DecisionError> {
    try {
      return await retriever.retrieve(event);
    } catch (error: unknown) {
      if (isDecisionError(error)) return error;
      const reason = error instanceof Error ? error.message : String(error);
      return new DecisionError("unknown", `retrieval failed: ${reason}`);
    }
  }

  /** Ask the backend, keeping a failure as the value it is. */
  async function answer(input: DecisionInput): Promise<DecisionOutput | DecisionError> {
    try {
      return await decision.decide(input);
    } catch (error: unknown) {
      if (isDecisionError(error)) return error;
      throw error;
    }
  }

  function decisionMessage(
    result: DecisionOutput | DecisionError,
    event: SuspectEventMessage,
    episode: Episode,
    candidates: readonly Candidate[],
  ): Decision {
    return toDecisionMessage(result, {
      unit_id: config.unitId,
      decision_id: newId(),
      episode_id: episode.episode_id,
      event_id: event.event_id,
      sim_ts: event.sim_ts,
      wall_ts: toIsoMs(wall.now()),
      backend: decision.name,
      model: decision.model,
      symptom_key: episode.symptom_key,
      candidates,
      gate: config.gate,
      persistSimMin: config.persistSimMin,
      prices: (usage) => costBlock(usage, prices),
    });
  }

  /** Retrieve, decide, gate, then drive the episode and its ticket. */
  async function decide(
    event: SuspectEventMessage,
    episode: Episode,
    action: Exclude<EpisodeEventAction, "skip">,
    outputs: PipelineOutput[],
  ): Promise<void> {
    const retrieved = await retrieve(event);
    const candidates = isDecisionError(retrieved) ? [] : retrieved;
    const result = isDecisionError(retrieved)
      ? retrieved
      : await answer({ event, candidates, unit_id: config.unitId });
    const message = decisionMessage(result, event, episode, candidates);
    const answered = isDecisionError(result) ? null : result;
    const verdict = gateOf(message);
    outputs.push({
      type: "decision",
      decision: message,
      output: answered,
      gate: answered === null ? null : verdict,
      persistedSimMin: episodes.persistedSimMin(episode.symptom_key, event.sim_ts),
    });

    const recorded = episodes.onDecision(episode.episode_id, message, verdict);
    if (action === "open") {
      outputs.push({ type: "episode", episode: recorded.episode, action: "opened" });
    }
    if (recorded.actions.includes("merge")) {
      outputs.push({ type: "episode", episode: recorded.episode, action: "merged" });
    }
    if (answered === null) return;

    const chosen = candidates.find((candidate) => candidate.fault_id === message.choice);
    const outcome = await tickets.applyDecision(recorded.target, message, verdict, chosen, event);
    if (outcome.action === "none") return;
    episodes.noteTicket(
      recorded.target.episode_id,
      outcome.ticket.ticket_id,
      outcome.ticket.fault_id,
    );
    outputs.push(ticketOutput(outcome));
  }

  /**
   * One suspect event: emitted, counted on its episode, decided when the
   * manager says so.
   *
   * An episode that could still create a ticket is decided only once its
   * key's evidence has persisted: until then the event is emitted and
   * counted, and a new episode is announced as `opened` on its own, with no
   * decision behind it. The decision follows on the first frame at which the
   * evidence has lasted long enough ({@link redecideIfDue}); a blip that ends
   * sooner is never decided.
   */
  async function onSuspect(event: SuspectEventMessage, outputs: PipelineOutput[]): Promise<void> {
    outputs.push({ type: "suspect", event });
    const { action, episode } = episodes.onEvent(event, true);
    if (action === "skip") return;
    if (!episodes.mayDecide(episode, event.sim_ts)) {
      if (action === "open") outputs.push({ type: "episode", episode, action: "opened" });
      return;
    }
    await decide(event, episode, action, outputs);
  }

  /**
   * Re-emit the primary symptom once its episode is due.
   *
   * Detection raises an event only when a symptom starts firing; while it
   * keeps firing, this is what asks again. The event is the one detection's
   * `buildEvent` would send now, so a re-decision reads the current frame. A
   * key with no open episode opens one here, as it always did; an open episode
   * is asked again only when it is due and may be decided — which is also how
   * the decision an episode deferred for persistence is finally taken.
   */
  async function redecideIfDue(simTs: string, outputs: PipelineOutput[]): Promise<void> {
    const event = detector.buildEvent();
    if (event === undefined) return;
    const open = store.get({ unit_id: config.unitId, symptom_key: event.symptom_key });
    if (open !== undefined && !(isDue(open, simTs) && episodes.mayDecide(open, simTs))) return;
    await onSuspect(event, outputs);
  }

  /** Emit every ended episode and resolve the ticket it owns. */
  async function endEpisodes(
    ends: readonly EpisodeEnd[],
    outputs: PipelineOutput[],
  ): Promise<void> {
    for (const { episode, reason } of ends) {
      outputs.push({
        type: "episode",
        episode,
        action: reason === "silence" ? "closed" : "aborted",
      });
      const owned = tickets.byEpisode(episode.episode_id);
      if (owned === undefined) continue;
      const endedAt = episode.closed_sim_ts ?? owned.updated_sim_ts;
      const outcome = await tickets.resolve(owned.ticket_id, reason, endedAt);
      if (outcome.action !== "none") outputs.push(ticketOutput(outcome));
    }
  }

  /**
   * The sim instant of a discontinuity no output has announced yet.
   *
   * Set only when a push that met a jump was rejected: detection had reset its
   * windows, but the episodes that ended there were put back with the rest of
   * the push. The next push aborts them first, at this instant.
   */
  let unannouncedJump: string | undefined;

  /**
   * Where the detector's windows ended, when this sample is a discontinuity.
   *
   * The windows ended with the last sample before the jump; that instant, not
   * the first one after it, is when the episodes stopped meaning anything — and
   * a jump backwards would otherwise close an episode before it opened.
   */
  function jumpOf(sample: Sample, detected: DetectionOutput): string | undefined {
    return detected.guards.discontinuity ? (lastSimTs ?? sample.sim_ts) : undefined;
  }

  /** Everything one accepted sample sets off once detection has folded it in, in order. */
  async function step(
    sample: Sample,
    detected: DetectionOutput,
    outputs: PipelineOutput[],
  ): Promise<void> {
    const jump = jumpOf(sample, detected);
    if (jump !== undefined) await endEpisodes(episodes.onDiscontinuity(jump), outputs);
    lastSimTs = sample.sim_ts;

    for (const event of detected.events) await onSuspect(event, outputs);

    const frame = detected.frame;
    if (frame === undefined) return;
    const firingKeys = new Set(detected.firing.map((hit) => hit.symptom_key));
    if (detected.events.length === 0 && firingKeys.size > 0) {
      await redecideIfDue(frame.sim_ts, outputs);
    }
    await endEpisodes(episodes.onTick(frame.sim_ts, firingKeys), outputs);
  }

  /**
   * The episodes and tickets as a push found them, and the way back to them.
   *
   * Records are replaced on every change, never edited, so the two lists are
   * the copy. Detection and ingest are not in it: the telemetry did arrive,
   * and {@link windUp} keeps detection level with ingest instead.
   */
  function checkpoint(): () => void {
    const episodesBefore = store.list();
    const ticketsBefore = tickets.list();
    const jumpBefore = unannouncedJump;
    return () => {
      store.hydrate(episodesBefore);
      tickets.hydrate(ticketsBefore);
      unannouncedJump = jumpBefore;
    };
  }

  /**
   * Show detection the samples of a rejected push it had not reached.
   *
   * Ingest took the whole batch and the next one follows its last sample, so a
   * detector left where the push failed would read the samples it missed as a
   * gap and abort every episode over a jump the telemetry never made. Their
   * suspect events go unanswered, like the rest of the push; a symptom still
   * firing is re-decided on the next frame. The first discontinuity among them
   * is returned for the next push to announce.
   *
   * A detector that throws here has already failed the push once; it is left
   * where it stopped.
   */
  function windUp(rest: readonly Sample[]): string | undefined {
    let jump: string | undefined;
    for (const sample of rest) {
      let detected: DetectionOutput;
      try {
        detected = detector.push(sample);
      } catch {
        break;
      }
      episodes.observeEvidence(detected.firing);
      jump ??= jumpOf(sample, detected);
      lastSimTs = sample.sim_ts;
    }
    return jump;
  }

  /**
   * One batch, all or nothing for the episodes and the tickets.
   *
   * A push resolves with every output the batch produced, or rejects having
   * changed no episode and no ticket: a host that drops a rejected push's
   * outputs — the runtime counts it and moves on, `tools/eval` stops the run —
   * holds nothing the pipeline would still build on. Detection goes on to the
   * end of the batch either way ({@link windUp}).
   */
  async function run(batch: TelemetrySamples): Promise<PipelineOutput[]> {
    const valid = assertValid("telemetry-samples", batch);
    accepted.length = 0;
    const { alarms } = ingest.push(valid);
    const samples = acceptedSamples(valid, accepted);

    const outputs: PipelineOutput[] = [];
    const rollback = checkpoint();
    /** The first jump detection met in this push. */
    let jumped: string | undefined;
    /** The samples handed to detection so far, the one it may have failed on included. */
    let seen = 0;
    try {
      if (unannouncedJump !== undefined) {
        const at = unannouncedJump;
        unannouncedJump = undefined;
        await endEpisodes(episodes.onDiscontinuity(at), outputs);
      }
      let nextAlarm = 0;
      for (const sample of samples) {
        for (; nextAlarm < alarms.length; nextAlarm += 1) {
          const transition = alarms[nextAlarm] as AlarmTransition;
          if (transition.seq !== sample.seq || transition.sim_ts !== sample.sim_ts) break;
          outputs.push({ type: "alarm", transition });
        }
        seen += 1;
        const detected = detector.push(sample);
        episodes.observeEvidence(detected.firing);
        jumped ??= jumpOf(sample, detected);
        await step(sample, detected, outputs);
      }
      return outputs;
    } catch (error: unknown) {
      rollback();
      const later = windUp(samples.slice(seen));
      unannouncedJump ??= jumped ?? later;
      throw error;
    }
  }

  async function close(ticketId: string, closure: TicketClosureInput): Promise<PipelineOutput[]> {
    const known = tickets.byId(ticketId);
    if (known === undefined) throw new UnknownTicketError(ticketId);
    // Before the first sample of a restarted runtime there is no current sim
    // time; the ticket's own last instant is the closest one there is.
    const simTs = lastSimTs ?? known.resolved_sim_ts ?? known.updated_sim_ts;
    const change = await tickets.close(ticketId, closure, simTs);
    if (store.byId(change.ticket.episode_id) !== undefined) {
      episodes.noteTechnicianClosure(change.ticket.episode_id);
    }
    return [ticketOutput(change)];
  }

  return {
    ingest,
    detector,
    push: (batch) => serial(() => run(batch)),
    closeTicket: (ticketId, closure) => serial(() => close(ticketId, closure)),
    snapshot: () => ({
      episodes: store.list(),
      tickets: tickets.list().map(latestMessage),
      frame: detector.frame(),
    }),
  };
}

/** The gate block of a decision message, read back as the gate's own result. */
function gateOf(message: Decision): GateResult {
  return {
    outcome: message.gate.outcome,
    abstained: message.gate.abstained,
    reason: message.gate.reason,
  };
}

function ticketOutput(change: TicketChange): PipelineTicket {
  return { type: "ticket", ticket: change.message, record: change.ticket, closure: change.closure };
}

/**
 * The batch's samples ingest accepted, as they were published.
 *
 * Ingest reports what it took through its `onSample` hook, decoded; detection
 * reads the sample as the gateway sent it, so the two lists are walked
 * together and each accepted sample is found in the batch by its `seq`, its
 * instant and its discontinuity flag. Both lists are in the batch's order.
 */
function acceptedSamples(batch: TelemetrySamples, accepted: readonly DecodedSample[]): Sample[] {
  const samples: Sample[] = [];
  let next = 0;
  for (const sample of batch.samples) {
    const taken = accepted[next];
    if (taken === undefined) break;
    if (
      taken.seq === sample.seq &&
      taken.simTs === sample.sim_ts &&
      taken.discontinuity === sample.flags.discontinuity
    ) {
      samples.push(sample);
      next += 1;
    }
  }
  return samples;
}

/** The action a ticket's latest message announced, read off its record. */
function latestAction(ticket: TicketRecord): Ticket["action"] {
  if (ticket.status === "closed") return "closed";
  if (ticket.status === "resolved") return "resolved";
  return ticket.update_count > 0 ? "updated" : "opened";
}

/** The wall instant of that latest message. */
function latestWallTs(ticket: TicketRecord): string {
  if (ticket.status === "closed") return ticket.closure?.wall_ts ?? ticket.updated_wall_ts;
  if (ticket.status === "resolved") return ticket.resolved_wall_ts ?? ticket.updated_wall_ts;
  return ticket.updated_wall_ts;
}

/** A ticket as the message of its latest state, for a snapshot. */
function latestMessage(ticket: TicketRecord): Ticket {
  return toTicketMessage(ticket, latestAction(ticket), latestWallTs(ticket));
}

/**
 * Run tasks one after another, in the order they were queued.
 *
 * A task that fails rejects its own caller and leaves the queue running, so a
 * malformed batch does not stall the batches behind it.
 */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

// What the hosts compose with. Every factory is the
// module's own, except `createRulesBackend` above, which only fills in the
// registry's severity hints.
export { Secret } from "../config/secret.ts";
export { createCatalogRetriever } from "../retrieval/index.ts";
export { createVonBackend } from "../decision/von/index.ts";
export { createAnthropicProvider, createLlmBackend } from "../decision/llm/index.ts";
export { selectBackend } from "../decision/select.ts";
export { buildState } from "../decision/state.ts";
export { DecisionError, NONE_OF_THESE, isDecisionError } from "../decision/types.ts";
export { gate } from "../gate/index.ts";

export type * from "./types.ts";
export type { Decision, SuspectEvent, TelemetrySamples, Ticket } from "@fdp/contracts";
export type { WallClock } from "../clock.ts";
export type { Env } from "../config/env.ts";
export type { Prices } from "../cost/index.ts";
export type { VonBackendOptions } from "../decision/von/index.ts";
export type { AnthropicProviderOptions, LlmBackendOptions } from "../decision/llm/index.ts";
export type { LlmProvider } from "../decision/llm/provider.ts";
export type { RulesBackendOptions } from "../decision/rules/index.ts";
export type { DecisionBackendFactories, DecisionBackendFactory } from "../decision/select.ts";
export type {
  DecisionBackend,
  DecisionInput,
  DecisionOutput,
  FaultChoice,
} from "../decision/types.ts";
export type { Detector, FeatureFrame, SuspectEventMessage } from "../detection/index.ts";
export type { Episode, EpisodeStore } from "../episodes/index.ts";
export type { GateConfig, GateResult } from "../gate/index.ts";
export type { AlarmTransition, Ingest } from "../ingest/index.ts";
export type { Retriever } from "../retrieval/index.ts";
export type { Candidate } from "../retrieval/types.ts";
export type { TicketClosureRow, TicketRecord } from "../tickets/index.ts";
