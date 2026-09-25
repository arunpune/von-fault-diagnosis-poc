// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What stack mode reads from a running Compose stack's database.
//
// Every statement here is a SELECT, and the reader runs them inside one
// `BEGIN TRANSACTION READ ONLY` (`withReadOnlyTransaction`), as role `eval`
// whose grants on `gt` are SELECT only. Two guards, then:
// PostgreSQL refuses any write inside the transaction whatever the role may
// do, and the role may not write ground truth whatever the transaction says.
// `db.test.ts` pins the first mechanically by reading every statement of this
// module.
//
// The reads are the diagnosis side's records — the suspect events detection
// raised (detection level), tickets with their episode's symptom keys and first
// technician closure, every decision with the gate thresholds its message was
// gated at, the chosen candidate's benign flag, the episodes, the controller's
// raised alarms and the cost ledger — and the ground truth the overlay stored:
// the injection windows and the replay markers. Covered time comes from the
// one-minute telemetry aggregates, read as islands of consecutive minutes (a
// missing minute is a gap of more than 60 s), which is what the stack actually
// replayed.
//
// Instants are `timestamptz` and arrive as `Date`; integer sums and prices are
// cast to `float8` so they arrive as numbers, and the ledger's date as text.

import { DEFAULT_UNIT_ID } from "@fdp/contracts";

import type { Queryable } from "../catalog/ingested.ts";

export type { Queryable } from "../catalog/ingested.ts";

/** An optional window of sim time the reads are limited to, `[from, to)`. */
export interface StackRange {
  readonly from?: Date;
  readonly to?: Date;
}

/** What `readStack` is asked for. */
export interface ReadStackOptions extends StackRange {
  /** The unit whose rows are read; the contracts' default unit by default. */
  readonly unitId?: string;
}

/** One `app.tickets` row with its episode's symptom keys and its first closure. */
export interface TicketRow {
  readonly ticket_id: string;
  readonly episode_id: string;
  readonly status: "review" | "open" | "resolved" | "closed";
  readonly fault_id: string;
  readonly backend: string;
  readonly model: string;
  readonly opened_sim_ts: Date;
  readonly updated_sim_ts: Date;
  readonly resolved_sim_ts: Date | null;
  readonly latest_decision_id: string;
  readonly symptom_key: string;
  readonly symptom_keys: readonly string[];
  /** The sim time of the first technician verdict, or `null`. */
  readonly closed_sim_ts: Date | null;
}

/** One `app.decisions` row, with the thresholds its gate block recorded. */
export interface DecisionRow {
  readonly decision_id: string;
  readonly episode_id: string;
  readonly event_id: string;
  readonly sim_ts: Date;
  readonly backend: string;
  readonly model: string;
  readonly status: "ok" | "failed";
  readonly choice: string;
  readonly confidence: number;
  readonly gate_outcome: "ticket" | "review" | "log";
  readonly abstained: boolean;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly state_digest: string;
  /** `GATE_TICKET_MIN_CONFIDENCE` as the decision message states it, or `null`. */
  readonly ticket_min: number | null;
  /** `GATE_REVIEW_MIN_CONFIDENCE` as the decision message states it, or `null`. */
  readonly review_min: number | null;
  /**
   * `GATE_PERSIST_SIM_MIN` as the decision message states it, or `null`
   * for a message written before the gate block carried it.
   */
  readonly persist_min?: number | null;
}

/** The candidate a decision chose, with the catalog's benign flag for it. */
export interface ChosenCandidateRow {
  readonly decision_id: string;
  readonly fault_id: string;
  readonly benign: boolean;
}

/** One `app.episodes` row, reduced to what the scorer counts. */
export interface EpisodeRow {
  readonly episode_id: string;
  readonly status: "open" | "closed" | "aborted";
  readonly merged_into: string | null;
}

/** One raise of a controller alarm (`app.native_alarms`, state `raised`). */
export interface AlarmRow {
  readonly code: string;
  readonly sim_ts: Date;
}

/** The cost ledger of one backend and model, with the prices of its latest row. */
export interface LedgerRow {
  readonly backend: string;
  readonly model: string;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number;
  readonly price_input_per_mtok: number;
  readonly price_output_per_mtok: number;
  readonly prices_as_of: string;
}

/** One `gt.v_injection_windows` row. */
export interface InjectionWindowRow {
  readonly instance_id: string;
  readonly injection_id: string;
  readonly fault_id: string;
  readonly start_sim_ts: Date;
  /** The stop event's sim time, else the planned end; `null` while nothing bounds it. */
  readonly end_sim_ts: Date | null;
  readonly reason: string | null;
}

/** One `gt.markers` row: a jump, a reset or a loop of the simulator. */
export interface MarkerRow {
  readonly kind: "jump" | "reset" | "loop";
  readonly preset_id: string | null;
  readonly sim_ts_from: Date;
  readonly sim_ts_to: Date;
  readonly wall_ts: Date;
}

/** A run of consecutive telemetry minutes, and the samples they aggregated. */
export interface MinuteIsland {
  /** The first minute of the island. */
  readonly first_minute: Date;
  /** The last minute of the island; the island covers up to one minute after it. */
  readonly last_minute: Date;
  readonly minutes: number;
  /** Samples ingested in the island: per minute, the largest count any signal saw. */
  readonly samples: number;
}

/** One `app.suspect_events` row: what detection level is scored on. */
export interface SuspectRow {
  readonly event_id: string;
  readonly sim_ts: Date;
  readonly symptom_key: string;
}

/** Everything stack mode reads, as the rows came. */
export interface StackRows {
  readonly unitId: string;
  /**
   * The suspect events detection raised. Absent from rows a caller
   * built before it existed, which score as a replay that raised none.
   */
  readonly suspects?: readonly SuspectRow[];
  readonly tickets: readonly TicketRow[];
  readonly decisions: readonly DecisionRow[];
  readonly chosen: readonly ChosenCandidateRow[];
  readonly episodes: readonly EpisodeRow[];
  readonly alarms: readonly AlarmRow[];
  readonly ledger: readonly LedgerRow[];
  readonly injections: readonly InjectionWindowRow[];
  readonly markers: readonly MarkerRow[];
  readonly islands: readonly MinuteIsland[];
}

/** `$2`/`$3` bound a `timestamptz` column to the optional `[from, to)` of the read. */
function inRange(column: string): string {
  return `($2::timestamptz IS NULL OR ${column} >= $2) AND ($3::timestamptz IS NULL OR ${column} < $3)`;
}

export const SUSPECTS_SQL = `
  SELECT s.event_id, s.sim_ts, s.symptom_key
    FROM app.suspect_events AS s
   WHERE s.unit_id = $1 AND ${inRange("s.sim_ts")}
   ORDER BY s.sim_ts, s.event_id`;

export const TICKETS_SQL = `
  SELECT t.ticket_id, t.episode_id, t.status, t.fault_id, t.backend, t.model,
         t.opened_sim_ts, t.updated_sim_ts, t.resolved_sim_ts, t.latest_decision_id,
         e.symptom_key, e.symptom_keys,
         (SELECT min(c.sim_ts) FROM app.ticket_closures AS c WHERE c.ticket_id = t.ticket_id)
           AS closed_sim_ts
    FROM app.tickets AS t
    JOIN app.episodes AS e ON e.episode_id = t.episode_id
   WHERE t.unit_id = $1 AND ${inRange("t.opened_sim_ts")}
   ORDER BY t.opened_sim_ts, t.ticket_id`;

export const DECISIONS_SQL = `
  SELECT d.decision_id, d.episode_id, d.event_id, d.sim_ts, d.backend, d.model, d.status,
         d.choice, d.confidence, d.gate_outcome, d.abstained, d.input_tokens, d.output_tokens,
         d.state_digest,
         (d.message #>> '{gate,ticket_min_confidence}')::float8 AS ticket_min,
         (d.message #>> '{gate,review_min_confidence}')::float8 AS review_min,
         (d.message #>> '{gate,persist_sim_min}')::float8 AS persist_min
    FROM app.decisions AS d
   WHERE d.unit_id = $1 AND ${inRange("d.sim_ts")}
   ORDER BY d.sim_ts, d.decision_id`;

export const CHOSEN_CANDIDATES_SQL = `
  SELECT c.decision_id, c.fault_id, c.benign
    FROM app.decision_candidates AS c
    JOIN app.decisions AS d ON d.decision_id = c.decision_id AND c.fault_id = d.choice
   WHERE d.unit_id = $1 AND ${inRange("d.sim_ts")}
   ORDER BY c.decision_id`;

export const EPISODES_SQL = `
  SELECT e.episode_id, e.status, e.merged_into
    FROM app.episodes AS e
   WHERE e.unit_id = $1
     AND e.episode_id IN (SELECT d.episode_id FROM app.decisions AS d
                           WHERE d.unit_id = $1 AND ${inRange("d.sim_ts")})
   ORDER BY e.opened_sim_ts, e.episode_id`;

export const ALARMS_SQL = `
  SELECT a.code, a.sim_ts
    FROM app.native_alarms AS a
   WHERE a.unit_id = $1 AND a.state = 'raised' AND ${inRange("a.sim_ts")}
   ORDER BY a.sim_ts, a.id`;

export const LEDGER_SQL = `
  SELECT l.backend, l.model, count(*)::int AS calls,
         sum(l.input_tokens)::float8 AS input_tokens, sum(l.output_tokens)::float8 AS output_tokens,
         sum(l.cost_usd)::float8 AS cost_usd,
         (array_agg(l.price_input_per_mtok ORDER BY l.wall_ts DESC, l.id DESC))[1]::float8
           AS price_input_per_mtok,
         (array_agg(l.price_output_per_mtok ORDER BY l.wall_ts DESC, l.id DESC))[1]::float8
           AS price_output_per_mtok,
         (array_agg(l.prices_as_of ORDER BY l.wall_ts DESC, l.id DESC))[1]::text AS prices_as_of
    FROM app.cost_ledger AS l
    JOIN app.decisions AS d ON d.decision_id = l.decision_id
   WHERE d.unit_id = $1 AND ${inRange("d.sim_ts")}
   GROUP BY l.backend, l.model
   ORDER BY l.backend, l.model`;

export const INJECTIONS_SQL = `
  SELECT w.instance_id, w.injection_id, w.fault_id, w.start_sim_ts, w.end_sim_ts, w.reason
    FROM gt.v_injection_windows AS w
   WHERE w.unit_id = $1
     AND ($3::timestamptz IS NULL OR w.start_sim_ts < $3)
     AND ($2::timestamptz IS NULL OR w.end_sim_ts IS NULL OR w.end_sim_ts > $2)
   ORDER BY w.start_sim_ts, w.instance_id`;

export const MARKERS_SQL = `
  SELECT m.kind, m.preset_id, m.sim_ts_from, m.sim_ts_to, m.wall_ts
    FROM gt.markers AS m
   WHERE m.unit_id = $1
   ORDER BY m.wall_ts, m.id`;

export const MINUTE_ISLANDS_SQL = `
  SELECT min(m.minute_sim_ts) AS first_minute, max(m.minute_sim_ts) AS last_minute,
         count(*)::int AS minutes, sum(m.samples)::float8 AS samples
    FROM (SELECT a.minute_sim_ts, max(a.n) AS samples,
                 a.minute_sim_ts
                   - make_interval(mins => (row_number() OVER (ORDER BY a.minute_sim_ts))::int)
                   AS island
            FROM app.telemetry_agg_1m AS a
           WHERE a.unit_id = $1 AND ${inRange("a.minute_sim_ts")}
           GROUP BY a.minute_sim_ts) AS m
   GROUP BY m.island
   ORDER BY first_minute`;

/** Every statement of the module, for the read-only test. */
export const STACK_STATEMENTS: readonly string[] = [
  SUSPECTS_SQL,
  TICKETS_SQL,
  DECISIONS_SQL,
  CHOSEN_CANDIDATES_SQL,
  EPISODES_SQL,
  ALARMS_SQL,
  LEDGER_SQL,
  INJECTIONS_SQL,
  MARKERS_SQL,
  MINUTE_ISLANDS_SQL,
];

/**
 * Reads everything stack mode scores, through a connection the caller holds.
 *
 * The statements run one after the other on the one connection, so inside the caller's
 * read-only transaction they read one snapshot.
 */
export async function readStack(db: Queryable, options: ReadStackOptions = {}): Promise<StackRows> {
  const unitId = options.unitId ?? DEFAULT_UNIT_ID;
  const params = [unitId, options.from ?? null, options.to ?? null];
  const rows = async <R extends object>(sql: string): Promise<R[]> =>
    (await db.query<R & Record<string, unknown>>(sql, params)).rows;

  return {
    unitId,
    suspects: await rows<SuspectRow>(SUSPECTS_SQL),
    tickets: await rows<TicketRow>(TICKETS_SQL),
    decisions: await rows<DecisionRow>(DECISIONS_SQL),
    chosen: await rows<ChosenCandidateRow>(CHOSEN_CANDIDATES_SQL),
    episodes: await rows<EpisodeRow>(EPISODES_SQL),
    alarms: await rows<AlarmRow>(ALARMS_SQL),
    ledger: await rows<LedgerRow>(LEDGER_SQL),
    injections: await rows<InjectionWindowRow>(INJECTIONS_SQL),
    markers: (await db.query<MarkerRow & Record<string, unknown>>(MARKERS_SQL, [unitId])).rows,
    islands: await rows<MinuteIsland>(MINUTE_ISLANDS_SQL),
  };
}
