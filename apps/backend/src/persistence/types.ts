// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repositories of the diagnosis records, in one place.
 *
 * The REST routes (`api/deps.ts`) and the runtime's sinks import every
 * repository interface from this file, whichever task wrote the
 * implementation:
 *
 * | repository | table | implementation |
 * | --- | --- | --- |
 * | {@link EventsRepo} | `app.suspect_events` | `./events.ts` |
 * | {@link DecisionsRepo} | `app.decisions`, `app.decision_candidates` | `./decisions.ts` |
 * | {@link AlertsRepo} | `app.system_alerts` | `./alerts.ts` |
 * | {@link NativeAlarmsRepo} | `app.native_alarms` (reads) | `./native-alarms.ts` |
 * | {@link HeartbeatsRepo} | `app.heartbeats` | `./heartbeats.ts` |
 * | `TelemetryRepo` | `app.telemetry_agg_1m`, `app.native_alarms` (writes) | `ingest/repo.ts` |
 * | `EpisodeRepo` | `app.episodes` | `episodes/repo.ts` |
 * | `TicketRepo` | `app.tickets`, `app.ticket_closures` | `tickets/repo.ts` |
 * | `CostRepo` | `app.cost_ledger` | `cost/repo.ts` |
 *
 * The payloads a repository stores are the contracts' messages, and the ones
 * it hands back are those same documents: a suspect event comes back as the
 * `suspect-event` it was, a decision as its `decision` message and an alert as
 * its `alert-system` message, so a route can answer with a stored row without
 * re-assembling it.
 */

import type { AlertSystem, Decision, ManualReference, SuspectEvent } from "@fdp/contracts";

import type { HeartbeatRow } from "../heartbeat/index.ts";
import type { RetrievalScores } from "../retrieval/types.ts";
import type { Page } from "./cursor.ts";

export type { CostLedger, CostLedgerEntry, CostRepo } from "../cost/repo.ts";
export type { EpisodeRepo } from "../episodes/repo.ts";
export type { HeartbeatRow, HeartbeatSource, SystemAlertRow } from "../heartbeat/index.ts";
export type { MinuteQuery, NativeAlarmRow, TelemetryRepo } from "../ingest/repo.ts";
export type { TicketClosureRow, TicketRepo } from "../tickets/repo.ts";
export type { CursorKey, Page } from "./cursor.ts";

/** Where a newest-first list starts and how many rows a page holds. */
export interface PageQuery {
  /** The `next_cursor` of the previous page; the newest rows when absent. */
  readonly before?: string;
  /** Rows per page; `DEFAULT_PAGE_LIMIT` when absent, clamped to `1…MAX_PAGE_LIMIT`. */
  readonly limit?: number;
}

/** `GET /api/events/suspect`: the suspect events, optionally of one symptom. */
export interface EventListQuery extends PageQuery {
  readonly symptom_key?: string;
}

/** `app.suspect_events`: every suspect event detection emitted. */
export interface EventsRepo {
  /**
   * Store one `suspect-event` message, linked to the episode it opened or fed
   * when the caller knows it. Resolves `false` when that `event_id` was
   * stored already, so a replayed message is written once.
   */
  insert(event: SuspectEvent, episodeId?: string): Promise<boolean>;
  /** One page of stored messages, newest `sim_ts` first. */
  list(query?: EventListQuery): Promise<Page<SuspectEvent>>;
}

/**
 * One row of `app.decision_candidates`: a cause retrieval offered, what the
 * backend made of it and why retrieval offered it.
 *
 * The rank is the position in the list the repository is handed, from 1.
 */
export interface DecisionCandidateRow {
  readonly fault_id: string;
  readonly condition_id: string;
  readonly name: string;
  readonly probability: number;
  /**
   * The per-candidate support the backend computed — Jev's Noul, the rules
   * twin's match score — or `null` for a backend without one. The `decision`
   * message carries only the Noul, so this column is where the rules twin's
   * scores are kept.
   */
  readonly support: number | null;
  readonly benign: boolean;
  readonly manual_ref: ManualReference;
  /** The stage scores that put the cause in the list; `null` when none are known. */
  readonly retrieval: RetrievalScores | null;
}

/** `GET /api/decisions`: the decisions, optionally of one episode. */
export interface DecisionListQuery extends PageQuery {
  readonly episode_id?: string;
}

/** A stored decision message, with the state the backend saw when it was asked for. */
export type StoredDecision = Decision & { readonly state?: unknown };

/** What {@link DecisionsRepo.get} returns beside the message. */
export interface DecisionGetOptions {
  /** Add the `state` column: what the backend saw (never published on the broker). */
  readonly withState?: boolean;
}

/** `app.decisions` and `app.decision_candidates`. */
export interface DecisionsRepo {
  /**
   * Store one `decision` message with the state its backend saw and the
   * provider bodies of the call (without headers or keys; `undefined` when the
   * backend has none). Resolves `false` when that `decision_id` was stored
   * already.
   */
  insert(
    message: Decision,
    state: unknown,
    request?: unknown,
    response?: unknown,
  ): Promise<boolean>;
  /** Store a decision's candidates in their order; resolves how many rows were new. */
  insertCandidates(
    decisionId: string,
    candidates: readonly DecisionCandidateRow[],
  ): Promise<number>;
  /** A decision's candidates, by rank. */
  candidates(decisionId: string): Promise<DecisionCandidateRow[]>;
  /** One page of stored messages, newest `sim_ts` first. */
  list(query?: DecisionListQuery): Promise<Page<Decision>>;
  /** One stored message, or `undefined` when no decision has that id. */
  get(decisionId: string, options?: DecisionGetOptions): Promise<StoredDecision | undefined>;
}

/** `GET /api/alerts/system`: the system alerts, optionally only the raised or the cleared ones. */
export interface AlertListQuery {
  /** `true`: only alerts that are raised now; `false`: only cleared ones; absent: both. */
  readonly active?: boolean;
  /** Most rows returned, newest first; `DEFAULT_ALERT_LIMIT` when absent. */
  readonly limit?: number;
}

/** `app.system_alerts`: one row per alert, raised and later cleared in place. */
export interface AlertsRepo {
  /** Record a raise, or the clear of an alert raised before, from its `alert-system` message. */
  upsert(alert: AlertSystem): Promise<void>;
  /** The alerts as their latest `alert-system` message, newest raise first. */
  list(query?: AlertListQuery): Promise<AlertSystem[]>;
}

/** One controller alarm transition as `app.native_alarms` holds it. */
export interface NativeAlarm {
  readonly code: string;
  readonly state: "raised" | "cleared";
  readonly sim_ts: string;
  /** When the backend saw the transition. */
  readonly wall_ts: string;
  /** The telemetry sample that carried it; `null` for a row that did not record one. */
  readonly seq: number | null;
}

/** A window of data time, both ends inclusive, as `iso_ts` strings. */
export interface NativeAlarmRange {
  readonly from: string;
  readonly to: string;
  /** Only transitions of this controller code. */
  readonly code?: string;
  /** Most rows returned, oldest first; `DEFAULT_NATIVE_ALARM_LIMIT` when absent. */
  readonly limit?: number;
}

/**
 * `app.native_alarms`, read side. The writes are ingest's
 * (`TelemetryRepo.insertAlarms`), which records transitions as it diffs samples.
 */
export interface NativeAlarmsRepo {
  /** The transitions inside a window, oldest `sim_ts` first. */
  list(range: NativeAlarmRange): Promise<NativeAlarm[]>;
}

/** `app.heartbeats`: one row per watched source, overwritten as the watchdog sees it. */
export interface HeartbeatsRepo {
  /** Write the watchdog's current row of one source (the heartbeat sink's `heartbeat(row)`). */
  update(row: HeartbeatRow): Promise<void>;
  /** Every source's row, by source name. */
  list(): Promise<HeartbeatRow[]>;
}

/** The repositories `./index.ts` builds over one `app_rw` pool. */
export interface Persistence {
  readonly events: EventsRepo;
  readonly decisions: DecisionsRepo;
  readonly alerts: AlertsRepo;
  readonly nativeAlarms: NativeAlarmsRepo;
  readonly heartbeats: HeartbeatsRepo;
}
