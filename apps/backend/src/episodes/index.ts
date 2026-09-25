// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The episode state machine.
 *
 * Five transitions and nothing else:
 *
 * | transition | trigger | effect |
 * | --- | --- | --- |
 * | `open` | the first suspect event of a key | a new episode, decided once its evidence has persisted `persistSimMin` |
 * | `redecide` | the key still fires and the last decision is `decisionIntervalSimMin` sim minutes old (or none was taken) | a new decision on the same episode |
 * | `merge` | the episode's first answered decision that could open a ticket names the fault another open episode's live ticket already names | `merged_into`; the decision updates that ticket |
 * | `close` | the key has been silent for `episodeClearSimMin` sim minutes | `closed`, `close_reason: silence` |
 * | `abort` | a discontinuity | `aborted`, `close_reason: discontinuity` |
 *
 * Everything here runs on the simulated clock, so a replay at any speed
 * produces the same episodes. Nothing here reaches the database
 * or the broker: the module is a function of the store and the events it is
 * handed, which is what lets `tools/eval` drive it without a runtime. The
 * persistence half is `./repo.ts`, which the runtime imports on its own so the
 * pipeline never loads a database driver.
 *
 * Why merging exists: one fault makes several rules fire, and two rules under
 * different symptom keys open two episodes. Without the link the second
 * episode would open a second ticket for one leak and the evaluation harness
 * would count two diagnoses where a technician sees one job. The merged
 * episode stays `open` — closing it would let its key re-open on the next
 * event, which is the loop this rule exists to stop — and its decisions are
 * routed to the ticket that already exists for as long as the episode owning
 * that ticket is open. Once that episode has ended, a merged episode that is
 * still firing drives a ticket of its own again: the fault is evidently still
 * there, and a resolved ticket is not a live view of it.
 *
 * Persistence before the ticket: an episode that could still create a
 * ticket — it owns none and its decisions are not routed to a live one — is
 * decided only once its key's evidence has held without a break for
 * `persistSimMin` sim minutes ({@link EpisodeManager.mayDecide},
 * `./evidence.ts`). The episode still opens on the first suspect event and
 * the event is still emitted; only the decision waits, so a blip that ends
 * sooner costs no call and opens nothing. An episode that owns a ticket, or
 * routes to one, is decided exactly as before: its decisions update a ticket
 * that exists, and a ticket that exists keeps being the live view of it.
 */

import type { Decision, Episode as EpisodeMessage, SuspectEvent } from "@fdp/contracts";
import { simMinutesBetween } from "@fdp/contracts";

import { NONE_OF_THESE } from "../decision/types.ts";
import type { GateResult } from "../gate/index.ts";
import { createEvidenceClock, type EvidenceHit } from "./evidence.ts";
import { UnknownEpisodeError, type Episode, type EpisodeStore } from "./store.ts";

export { createEvidenceClock } from "./evidence.ts";
export type { EvidenceClock, EvidenceHit } from "./evidence.ts";
export type {
  Episode,
  EpisodeCloseReason,
  EpisodeKey,
  EpisodePatch,
  EpisodeStatus,
  EpisodeStore,
  OpenEpisode,
} from "./store.ts";
export { createEpisodeStore, EpisodeConflictError, UnknownEpisodeError } from "./store.ts";

/** What one suspect event asked of the state machine. */
export type EpisodeEventAction = "open" | "redecide" | "skip";

/** The episode an event landed on, and what the pipeline should do next. */
export interface EpisodeEventResult {
  readonly action: EpisodeEventAction;
  readonly episode: Episode;
}

/** What one decision did to the state machine, beyond being recorded. */
export type EpisodeDecisionAction = "record" | "merge";

/** Where a decision's ticket work goes, once merging has been applied. */
export interface EpisodeDecisionResult {
  /** `record` always; `merge` in front of it when this decision linked the episode. */
  readonly actions: readonly EpisodeDecisionAction[];
  /** The episode the decision was taken on. */
  readonly episode: Episode;
  /** The episode whose ticket this decision drives: `episode`, or its open merge target. */
  readonly target: Episode;
}

/** How an episode ended without a technician. */
export type EpisodeEndReason = "silence" | "discontinuity";

/** One episode the clock or a discontinuity ended. */
export interface EpisodeEnd {
  readonly episode: Episode;
  readonly reason: EpisodeEndReason;
}

/** The sim-minute intervals of the episode policy, from `config/env.ts`. */
export interface EpisodeConfig {
  /** `DECISION_INTERVAL_SIM_MIN`, 30: how often a firing key is re-decided. */
  readonly decisionIntervalSimMin: number;
  /** `EPISODE_CLEAR_SIM_MIN`, 120: how long silence closes an episode after. */
  readonly episodeClearSimMin: number;
  /**
   * `GATE_PERSIST_SIM_MIN`: how long a key's evidence must have held without a
   * break before an episode that could create a ticket is decided.
   * Absent or 0 decides at once.
   */
  readonly persistSimMin?: number;
}

/** What {@link createEpisodeManager} is composed of. */
export interface EpisodeManagerPorts {
  readonly store: EpisodeStore;
  readonly cfg: EpisodeConfig;
  /** A fresh `episode_id`; `ids.ts` `newId` in the runtime, a counter in tests. */
  readonly ids: () => string;
}

/** The episode state machine over one {@link EpisodeStore}. */
export interface EpisodeManager {
  /** Record a suspect event and say whether it needs a decision. */
  onEvent(event: SuspectEvent, firing: boolean): EpisodeEventResult;
  /** Record a decision, merging the episode when the merge rule applies. */
  onDecision(episodeId: string, decision: Decision, gate: GateResult): EpisodeDecisionResult;
  /**
   * Close every open episode whose key has been silent long enough.
   *
   * `firingKeys` are the symptom keys detection reports as firing at `simTs`
   * (`Detector.firing()`); one manager serves the one unit of its pipeline.
   */
  onTick(simTs: string, firingKeys: Iterable<string>): readonly EpisodeEnd[];
  /**
   * Abort every open episode; the windows behind them no longer mean anything,
   * and neither does the evidence the persistence clock was timing.
   */
  onDiscontinuity(simTs: string): readonly EpisodeEnd[];
  /**
   * Fold in the rule hits detection reports as firing after one sample, for the
   * persistence clock (`Detector.push(...).firing`).
   */
  observeEvidence(hits: readonly EvidenceHit[]): void;
  /** Sim minutes the key's evidence has held without a break at `simTs`; 0 when it is not firing. */
  persistedSimMin(symptomKey: string, simTs: string): number;
  /**
   * Whether `episode` may be decided at `simTs`.
   *
   * True when its decisions can only update a ticket that exists — it owns
   * one, or it is merged into an open episode, whose ticket its decisions
   * drive — and otherwise only once its key's evidence has persisted for
   * `persistSimMin` sim minutes. Whether a decision is *due* is a separate
   * question (`decisionIntervalSimMin`), which the caller asks as before.
   */
  mayDecide(episode: Episode, simTs: string): boolean;
  /**
   * Note that this episode now owns `ticketId`, which names `faultId`.
   *
   * Called after every ticket the ticket manager opens or updates, because an
   * update may change the fault and the merge rule compares the current one.
   */
  noteTicket(episodeId: string, ticketId: string, faultId: string): Episode;
  /** Note that a technician closed this episode's ticket. */
  noteTechnicianClosure(episodeId: string): Episode;
  /** Open episodes, for `status-backend` and `GET /api/status`. */
  openCount(): number;
  readonly store: EpisodeStore;
}

/** The symptoms of one event added to the episode's, first-seen order kept. */
function symptomsOf(episode: Episode, event: SuspectEvent): string[] {
  return [...new Set([...episode.symptom_keys, event.symptom_key, ...event.co_symptoms])];
}

/** Whether a decision could open a ticket: answered, a real fault, past the review gate. */
function couldOpenTicket(decision: Decision, gate: GateResult): boolean {
  return (
    decision.status === "ok" &&
    decision.choice !== NONE_OF_THESE &&
    (gate.outcome === "ticket" || gate.outcome === "review")
  );
}

/**
 * The open episode whose live ticket already names `faultId`, if there is one.
 *
 * "Live" is `ticket_id` set and no technician verdict on it: a ticket a
 * technician has closed is finished, and a decision that named the same fault
 * again belongs on a ticket of its own rather than on a job someone has been
 * to. An episode that is itself merged is never a target, so links stay one
 * deep and a chain cannot form.
 */
function mergeTarget(store: EpisodeStore, self: Episode, faultId: string): Episode | undefined {
  return store
    .listOpen()
    .find(
      (candidate) =>
        candidate.episode_id !== self.episode_id &&
        candidate.unit_id === self.unit_id &&
        candidate.merged_into === null &&
        candidate.ticket_id !== null &&
        !candidate.closed_by_technician &&
        candidate.fault_id === faultId,
    );
}

/**
 * The later of two optional `iso_ts` instants.
 *
 * Both are `iso_ts` strings, whose fixed width makes string order time order.
 */
function later(a: string, b: string | undefined): string {
  return b !== undefined && b > a ? b : a;
}

/**
 * The state machine above over an {@link EpisodeStore}.
 *
 * It is synchronous and it never awaits: persistence is the host's job
 * (`runtime/sinks.ts` writes the same rows through `episodes/repo.ts`), so a
 * replay in `tools/eval` runs the identical code with no database at all.
 *
 * Silence is measured from the last sim instant the key was seen firing,
 * which {@link EpisodeManager.onTick} records, and not only from the last
 * event: detection re-emits an event every `decisionIntervalSimMin`, so the
 * last event can be up to half an hour older than the last moment the rule
 * held. The instant lives in memory only; a hydrated episode falls back to its
 * `last_event_sim_ts`, which can only make it close later, never earlier.
 */
export function createEpisodeManager(ports: EpisodeManagerPorts): EpisodeManager {
  const { store, cfg, ids } = ports;
  const lastFiringSimTs = new Map<string, string>();
  const evidence = createEvidenceClock();
  const persistSimMin = cfg.persistSimMin ?? 0;

  /**
   * Whether the episode's decisions go to a ticket that already exists.
   *
   * Its own ticket, whatever its status: a live one is updated in place and a
   * closed one only records the decision, so neither creates anything.
   * Or the ticket of the open episode it is merged into, which is live by the
   * merge rule's construction.
   */
  function drivesExistingTicket(episode: Episode): boolean {
    if (episode.ticket_id !== null) return true;
    if (episode.merged_into === null) return false;
    return store.byId(episode.merged_into)?.status === "open";
  }

  function end(episode: Episode, reason: EpisodeEndReason, simTs: string): EpisodeEnd {
    lastFiringSimTs.delete(episode.episode_id);
    const ended = store.update(episode.episode_id, {
      status: reason === "silence" ? "closed" : "aborted",
      close_reason: reason,
      closed_sim_ts: simTs,
    });
    return { episode: ended, reason };
  }

  const manager: EpisodeManager = {
    store,

    onEvent(event, firing) {
      const open = store.get({ unit_id: event.unit_id, symptom_key: event.symptom_key });
      if (open === undefined) {
        const episode = store.open({
          episode_id: ids(),
          unit_id: event.unit_id,
          symptom_key: event.symptom_key,
          opened_sim_ts: event.sim_ts,
          first_event_id: event.event_id,
          co_symptoms: event.co_symptoms,
        });
        return { action: "open", episode };
      }

      const episode = store.update(open.episode_id, {
        last_event_sim_ts: later(open.last_event_sim_ts, event.sim_ts),
        event_count: open.event_count + 1,
        symptom_keys: symptomsOf(open, event),
      });
      // A key that has never been decided is due at once: its opening decision
      // never ran, and waiting half a sim hour would hide the fault.
      const due =
        open.last_decision_sim_ts === null ||
        simMinutesBetween(open.last_decision_sim_ts, event.sim_ts) >= cfg.decisionIntervalSimMin;
      return { action: firing && due ? "redecide" : "skip", episode };
    },

    onDecision(episodeId, decision, gate) {
      const current = store.byId(episodeId);
      if (current === undefined) throw new UnknownEpisodeError(episodeId);

      // "No ticket of its own and not linked yet" is, by construction, the
      // first answered decision that could have opened a ticket. A first
      // decision the gate only logged does not use the chance up: the next one
      // that clears the review threshold is still the first that would open a
      // second ticket for the same fault.
      const merging =
        current.ticket_id === null &&
        current.merged_into === null &&
        couldOpenTicket(decision, gate)
          ? mergeTarget(store, current, decision.choice)
          : undefined;

      const episode = store.update(episodeId, {
        last_decision_sim_ts: decision.sim_ts,
        decision_count: current.decision_count + 1,
        ...(merging === undefined ? {} : { merged_into: merging.episode_id }),
      });

      const linked = episode.merged_into === null ? undefined : store.byId(episode.merged_into);
      return {
        actions: merging === undefined ? ["record"] : ["merge", "record"],
        episode,
        target: linked !== undefined && linked.status === "open" ? linked : episode,
      };
    },

    onTick(simTs, firingKeys) {
      const firing = new Set(firingKeys);
      const ended: EpisodeEnd[] = [];
      for (const candidate of store.listOpen()) {
        if (firing.has(candidate.symptom_key)) {
          lastFiringSimTs.set(candidate.episode_id, simTs);
          continue;
        }
        const quietSince = later(
          candidate.last_event_sim_ts,
          lastFiringSimTs.get(candidate.episode_id),
        );
        if (simMinutesBetween(quietSince, simTs) >= cfg.episodeClearSimMin) {
          ended.push(end(candidate, "silence", simTs));
        }
      }
      return ended;
    },

    onDiscontinuity(simTs) {
      evidence.reset();
      return store.listOpen().map((candidate) => end(candidate, "discontinuity", simTs));
    },

    observeEvidence(hits) {
      evidence.observe(hits);
    },

    persistedSimMin(symptomKey, simTs) {
      return evidence.persistedSimMin(symptomKey, simTs);
    },

    mayDecide(episode, simTs) {
      if (persistSimMin <= 0 || drivesExistingTicket(episode)) return true;
      return evidence.persistedSimMin(episode.symptom_key, simTs) >= persistSimMin;
    },

    noteTicket(episodeId, ticketId, faultId) {
      return store.update(episodeId, { ticket_id: ticketId, fault_id: faultId });
    },

    noteTechnicianClosure(episodeId) {
      return store.update(episodeId, { closed_by_technician: true });
    },

    openCount() {
      return store.listOpen().length;
    },
  };

  return manager;
}

/**
 * One episode as `api-episodes` and the WebSocket `snapshot` frame carry it.
 *
 * The contract is the public view: the merge link, the fault the ticket names,
 * the first event and the technician flag are the backend's bookkeeping and
 * stay out of it (the definition is closed, `additionalProperties: false`).
 */
export function toEpisodeMessage(episode: Episode): EpisodeMessage {
  return {
    episode_id: episode.episode_id,
    unit_id: episode.unit_id,
    symptom_key: episode.symptom_key,
    symptom_keys: [...episode.symptom_keys],
    status: episode.status,
    opened_sim_ts: episode.opened_sim_ts,
    last_event_sim_ts: episode.last_event_sim_ts,
    last_decision_sim_ts: episode.last_decision_sim_ts,
    closed_sim_ts: episode.closed_sim_ts,
    close_reason: episode.close_reason,
    ticket_id: episode.ticket_id,
    event_count: episode.event_count,
    decision_count: episode.decision_count,
  };
}
