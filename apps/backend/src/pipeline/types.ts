// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vocabulary of the pipeline entry.
 *
 * Two hosts drive the same pipeline — the runtime of `src/runtime/` and the
 * evaluation harness in `tools/eval` — and both speak to it in these types
 * only: the ports they inject, the configuration they tune and the outputs
 * they persist, publish or score. A change here is a change to both hosts,
 * which is why the file holds types and nothing else.
 *
 * Every output is a plain value the host can serialise as it stands. The
 * contract messages (`suspect-event`, `decision`, `ticket`) travel exactly as
 * they are published; beside them sit the backend-side records a host needs to
 * persist what the contract leaves out — the backend's raw answer and the
 * state it saw, the ticket's wall stamps, the closure row.
 */

import type { Decision, Signal, TelemetrySamples, Ticket } from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import type { Prices } from "../cost/index.ts";
import type { DecisionBackend, DecisionOutput } from "../decision/types.ts";
import type { Detector, FeatureFrame, SuspectEventMessage } from "../detection/index.ts";
import type { Episode, EpisodeStore } from "../episodes/index.ts";
import type { GateConfig, GateResult } from "../gate/index.ts";
import type { AlarmTransition, Ingest, TelemetryRepo } from "../ingest/index.ts";
import type { Retriever } from "../retrieval/index.ts";
import type { TicketClosureRow, TicketRecord, TicketVerdict } from "../tickets/index.ts";

/**
 * What a host hands the pipeline.
 *
 * Only the wall clock, the retriever and the decision backend are required:
 * they are the three things the pipeline cannot choose for its host. Everything
 * else has an in-process default, so `tools/eval` composes a run from three
 * values and the runtime adds what it hydrated from the database.
 */
export interface PipelinePorts {
  /** Wall time for `wall_ts`, latencies and the ticket stamps; never for windows. */
  readonly wall: WallClock;
  readonly retriever: Retriever;
  readonly decision: DecisionBackend;
  /** The register map; the contracts' `SIGNALS` by default. */
  readonly signals?: readonly Signal[];
  /** The episodes to continue from; an empty in-memory store by default. */
  readonly store?: EpisodeStore;
  /**
   * The tickets of the episodes in {@link PipelinePorts.store}, as read back
   * from `app.tickets` (`tickets/repo.ts#load`); none by default.
   *
   * A hydrated episode that owns a ticket must find it here, or its next
   * decision would open a second ticket for it and the database would refuse
   * the row (`tickets.episode_id` is unique).
   */
  readonly tickets?: readonly TicketRecord[];
  /** What the decision backend is billed at, for the message's `cost` block; zero by default. */
  readonly prices?: Prices;
  /**
   * Where ingest writes what it folds — the one-minute aggregates and the
   * controller alarm rows — and how far back the
   * aggregates are kept. The runtime passes the `app_rw` repository; without
   * one (`tools/eval`) the folded rows are dropped and `Ingest.flush` and
   * `Ingest.prune` do nothing.
   */
  readonly telemetry?: PipelineTelemetry;
}

/** The persistence of ingest's folded rows, for a host that keeps them. */
export interface PipelineTelemetry {
  readonly repo: TelemetryRepo;
  /** `TELEMETRY_RETENTION_SIM_DAYS`: data days of aggregates `Ingest.prune` keeps. */
  readonly retentionSimDays: number;
}

/** The tunables of one run. */
export interface PipelineConfig {
  /** `GATE_TICKET_MIN_CONFIDENCE` and `GATE_REVIEW_MIN_CONFIDENCE`. */
  readonly gate: GateConfig;
  /** `DECISION_INTERVAL_SIM_MIN`: how often a firing symptom is re-decided. */
  readonly decisionIntervalSimMin: number;
  /** `EPISODE_CLEAR_SIM_MIN`: how long a symptom must be silent before its episode closes. */
  readonly episodeClearSimMin: number;
  /**
   * `GATE_PERSIST_SIM_MIN`: how long a symptom's evidence must have held without
   * a break before an episode that could open a review or a ticket is decided
   * (persistence before the first decision); 0 decides at once.
   */
  readonly persistSimMin: number;
  /** `RULES_DISABLED`: detection rule ids left out of the registry. */
  readonly rulesDisabled: readonly string[];
  /** `UNIT_ID`: the unit every event, decision and ticket names. */
  readonly unitId: string;
}

/** A detection rule started firing, or a firing one is due for its next decision. */
export interface PipelineSuspect {
  readonly type: "suspect";
  /** The validated `suspect-event` message, with detection's two additive fields. */
  readonly event: SuspectEventMessage;
}

/**
 * One decision, answered or failed.
 *
 * `decision` is the contract message and carries the gate outcome every
 * consumer reads. `output` is what the backend returned — the state it saw and
 * its raw bodies, which `app.decisions` stores and the broker never carries —
 * and is `null` when the call failed. `gate` is `null` for the same reason:
 * a failed call never reaches the gate.
 */
export interface PipelineDecision {
  readonly type: "decision";
  readonly decision: Decision;
  readonly output: DecisionOutput | null;
  readonly gate: GateResult | null;
  /**
   * How long the episode's own symptom key had fired without a break when the
   * decision was taken, in sim minutes (the persistence measure of
   * `episodes/evidence.ts`).
   * An episode that owns no ticket is decided only once this reaches
   * `persistSimMin`; one that owns or drives a ticket is decided whatever it
   * reads. The offline threshold sweep reads it so that a re-gated pair never
   * opens a ticket on a decision a ticketless episode could not have taken.
   * It is not part of the decision message. Optional for a host that builds
   * outputs by hand.
   */
  readonly persistedSimMin?: number;
}

/** What happened to an episode. */
export type EpisodeAction = "opened" | "merged" | "closed" | "aborted";

/**
 * An episode opened, merged into another, fell silent or was cut by a jump.
 *
 * `episode` is the backend's record, merge link included, as it stands after
 * the step that produced this output.
 */
export interface PipelineEpisode {
  readonly type: "episode";
  readonly episode: Episode;
  readonly action: EpisodeAction;
}

/**
 * A ticket was opened, updated, promoted, resolved or closed.
 *
 * `ticket` is the validated contract message; its `action` is one of
 * `opened | updated | resolved | closed` and a promotion is an `updated`
 * message whose `status` became `open`. `record` is the `app.tickets` row the
 * message was rendered from, and `closure` the `app.ticket_closures` row of a
 * technician's verdict.
 */
export interface PipelineTicket {
  readonly type: "ticket";
  readonly ticket: Ticket;
  readonly record: TicketRecord;
  readonly closure: TicketClosureRow | null;
}

/** A controller alarm raised or cleared on the sample that carried it. */
export interface PipelineAlarm {
  readonly type: "alarm";
  readonly transition: AlarmTransition;
}

/** Everything the pipeline emits, in the order it happened. */
export type PipelineOutput =
  PipelineSuspect | PipelineDecision | PipelineEpisode | PipelineTicket | PipelineAlarm;

/** What a technician says when closing a ticket (`api-ticket-close`). */
export type TicketClosureInput = TicketVerdict;

/** The pipeline's current picture, for a WebSocket `snapshot` and a run's end. */
export interface PipelineSnapshot {
  /** Every episode the store holds, oldest first. */
  readonly episodes: readonly Episode[];
  /** Every ticket, oldest first, as the contract message of its latest state. */
  readonly tickets: readonly Ticket[];
  /** The newest feature frame; undefined before the first sample. */
  readonly frame: FeatureFrame | undefined;
}

/**
 * One unit's diagnosis, from telemetry to tickets.
 *
 * Calls are serialised: a `push` or `closeTicket` made while another is still
 * running waits for it, so outputs never interleave and every host sees one
 * ordered history.
 */
export interface Pipeline {
  /**
   * Validate one batch and run it through ingest, detection, retrieval, the
   * decision backend, the gate, the episodes and the tickets.
   *
   * Resolves once every decision the batch triggered has been answered, with
   * the outputs in the order they happened. A decision whose backend did not
   * answer, or whose retrieval failed, is one of them, in its failed form.
   *
   * A push that rejects has changed no episode and no ticket, so a host may
   * drop it whole. Ingest and detection keep the samples they took.
   *
   * @throws SchemaValidationError when the batch is not a `telemetry-samples` message.
   * @throws Error — anything else a backend or the pipeline itself threw (a defect).
   */
  push(batch: TelemetrySamples): Promise<PipelineOutput[]>;
  /**
   * Close a ticket on a technician's verdict, at the current sim time.
   *
   * @throws UnknownTicketError when no ticket carries that id.
   * @throws TicketClosedError when a verdict was already given.
   */
  closeTicket(ticketId: string, closure: TicketClosureInput): Promise<PipelineOutput[]>;
  snapshot(): PipelineSnapshot;
  /** The ingest stage, for the ring, the series and the aggregates a runtime writes. */
  readonly ingest: Ingest;
  readonly detector: Detector;
}
