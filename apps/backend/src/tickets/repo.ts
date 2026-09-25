// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.tickets` and `app.ticket_closures`, written as `app_rw`.
 *
 * The ticket manager in `index.ts` keeps the tickets of one process in memory
 * and, when it is given this repository, writes every change through before it
 * returns. Two tables and one rule between them: a ticket row is upserted on
 * every transition, and a technician's verdict is one more row in
 * `app.ticket_closures`, never an edit of an earlier one.
 *
 * {@link TicketRepo.load} is the read a restarting backend needs, and it reads
 * more than the live tickets: a ticket a technician has closed while its
 * episode is still open has to come back too, because `app.tickets.episode_id`
 * is unique and a manager that forgot it would try to open a second ticket for
 * that episode on the next decision.
 *
 * Like `ingest/repo.ts` this module holds no pool: it takes a {@link Queryable},
 * which a pool, a client checked out of one and a test double all satisfy.
 */

import { toIsoMs } from "@fdp/contracts";
import type { DecisionBackend, EvidenceItem, ManualReference, SeverityLevel } from "@fdp/contracts";

import { query, type Queryable } from "../db/pool.ts";
import type { TicketClosure, TicketCloseReason, TicketRecord, TicketStatus } from "./types.ts";

/** One row of `app.ticket_closures`: the technician's verdict. */
export interface TicketClosureRow {
  readonly ticket_id: string;
  readonly verdict: "correct" | "wrong";
  readonly note: string | null;
  readonly closed_by: string | null;
  /** The simulated instant the technician closed the ticket at. */
  readonly sim_ts: string;
  readonly wall_ts: string;
}

/** The statements this repository runs. */
export interface TicketRepo {
  /** Insert or update one ticket, keyed by `ticket_id`. */
  save(ticket: TicketRecord): Promise<void>;
  /** Append one technician verdict. */
  saveClosure(closure: TicketClosureRow): Promise<void>;
  /**
   * The tickets a restarting backend has to know about: every live one
   * (`review`, `open`) and every ticket of an episode that is still open.
   */
  load(unitId: string): Promise<TicketRecord[]>;
}

/** One row of the read path, as the driver hands it over. */
type TicketRow = {
  ticket_id: string;
  episode_id: string;
  unit_id: string;
  status: string;
  fault_id: string;
  condition_id: string;
  title: string;
  cause: string;
  remedy: string;
  checks: string[];
  manual_ref: ManualReference;
  evidence: EvidenceItem[];
  confidence: number;
  probabilities: Record<string, number>;
  severity_level: string;
  backend: string;
  model: string;
  rationale: string | null;
  latest_decision_id: string;
  opened_sim_ts: Date;
  updated_sim_ts: Date;
  resolved_sim_ts: Date | null;
  close_reason: string | null;
  opened_wall_ts: Date;
  updated_wall_ts: Date;
  resolved_wall_ts: Date | null;
  update_count: number;
  verdict: string | null;
  note: string | null;
  closed_by: string | null;
  closure_wall_ts: Date | null;
};

const SAVE = `
INSERT INTO app.tickets
       (ticket_id, episode_id, unit_id, status, fault_id, condition_id, title, cause, remedy,
        checks, manual_ref, evidence, confidence, probabilities, severity_level, backend, model,
        rationale, latest_decision_id, opened_sim_ts, updated_sim_ts, resolved_sim_ts,
        close_reason, opened_wall_ts, updated_wall_ts, resolved_wall_ts, update_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12::jsonb, $13, $14::jsonb, $15, $16, $17,
        $18, $19, $20::timestamptz, $21::timestamptz, $22::timestamptz,
        $23, $24::timestamptz, $25::timestamptz, $26::timestamptz, $27)
ON CONFLICT (ticket_id) DO UPDATE
   SET status = excluded.status,
       fault_id = excluded.fault_id,
       condition_id = excluded.condition_id,
       title = excluded.title,
       cause = excluded.cause,
       remedy = excluded.remedy,
       checks = excluded.checks,
       manual_ref = excluded.manual_ref,
       evidence = excluded.evidence,
       confidence = excluded.confidence,
       probabilities = excluded.probabilities,
       severity_level = excluded.severity_level,
       backend = excluded.backend,
       model = excluded.model,
       rationale = excluded.rationale,
       latest_decision_id = excluded.latest_decision_id,
       updated_sim_ts = excluded.updated_sim_ts,
       resolved_sim_ts = excluded.resolved_sim_ts,
       close_reason = excluded.close_reason,
       updated_wall_ts = excluded.updated_wall_ts,
       resolved_wall_ts = excluded.resolved_wall_ts,
       update_count = excluded.update_count`;

const SAVE_CLOSURE = `
INSERT INTO app.ticket_closures (ticket_id, verdict, note, closed_by, sim_ts, wall_ts)
VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`;

// The newest closure of each ticket rides along, so a closed ticket hydrates
// with the verdict its message carried.
const LOAD = `
SELECT t.ticket_id, t.episode_id, t.unit_id, t.status, t.fault_id, t.condition_id, t.title,
       t.cause, t.remedy, t.checks, t.manual_ref, t.evidence, t.confidence, t.probabilities,
       t.severity_level, t.backend, t.model, t.rationale, t.latest_decision_id,
       t.opened_sim_ts, t.updated_sim_ts, t.resolved_sim_ts, t.close_reason,
       t.opened_wall_ts, t.updated_wall_ts, t.resolved_wall_ts, t.update_count,
       c.verdict, c.note, c.closed_by, c.wall_ts AS closure_wall_ts
  FROM app.tickets t
  JOIN app.episodes e ON e.episode_id = t.episode_id
  LEFT JOIN LATERAL (
         SELECT verdict, note, closed_by, wall_ts
           FROM app.ticket_closures
          WHERE ticket_id = t.ticket_id
          ORDER BY id DESC
          LIMIT 1) c ON true
 WHERE t.unit_id = $1
   AND (t.status IN ('review', 'open') OR e.status = 'open')
 ORDER BY t.opened_sim_ts, t.id`;

/** `iso_ts` or `null`, from a `timestamptz` the driver decoded into a `Date`. */
function isoOrNull(value: Date | null): string | null {
  return value === null ? null : toIsoMs(value);
}

/** The closure block of a row, or `null` when the ticket carries no verdict. */
function closureOf(row: TicketRow): TicketClosure | null {
  if (row.verdict === null || row.closure_wall_ts === null) return null;
  return {
    verdict: row.verdict as TicketClosure["verdict"],
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.closed_by === null ? {} : { closed_by: row.closed_by }),
    wall_ts: toIsoMs(row.closure_wall_ts),
  };
}

/**
 * One row as the manager holds it.
 *
 * The enum columns are narrowed with a cast: the database's `CHECK`
 * constraints are what admit the values, and a row this backend did not write
 * would still have passed them.
 */
function toRecord(row: TicketRow): TicketRecord {
  return {
    ticket_id: row.ticket_id,
    episode_id: row.episode_id,
    unit_id: row.unit_id,
    status: row.status as TicketStatus,
    fault_id: row.fault_id,
    condition_id: row.condition_id,
    title: row.title,
    cause: row.cause,
    remedy: row.remedy,
    checks: row.checks,
    manual_ref: row.manual_ref,
    evidence: row.evidence,
    confidence: row.confidence,
    probabilities: row.probabilities,
    severity: row.severity_level as SeverityLevel,
    backend: row.backend as DecisionBackend,
    model: row.model,
    rationale: row.rationale,
    latest_decision_id: row.latest_decision_id,
    opened_sim_ts: toIsoMs(row.opened_sim_ts),
    updated_sim_ts: toIsoMs(row.updated_sim_ts),
    resolved_sim_ts: isoOrNull(row.resolved_sim_ts),
    close_reason: row.close_reason as TicketCloseReason | null,
    opened_wall_ts: toIsoMs(row.opened_wall_ts),
    updated_wall_ts: toIsoMs(row.updated_wall_ts),
    resolved_wall_ts: isoOrNull(row.resolved_wall_ts),
    update_count: row.update_count,
    closure: closureOf(row),
  };
}

/** The ticket statements over one {@link Queryable} holding the `app_rw` credential. */
export function createTicketRepo(db: Queryable): TicketRepo {
  return {
    async save(ticket) {
      await query(db, SAVE, [
        ticket.ticket_id,
        ticket.episode_id,
        ticket.unit_id,
        ticket.status,
        ticket.fault_id,
        ticket.condition_id,
        ticket.title,
        ticket.cause,
        ticket.remedy,
        JSON.stringify(ticket.checks),
        JSON.stringify(ticket.manual_ref),
        JSON.stringify(ticket.evidence),
        ticket.confidence,
        JSON.stringify(ticket.probabilities),
        ticket.severity,
        ticket.backend,
        ticket.model,
        ticket.rationale,
        ticket.latest_decision_id,
        ticket.opened_sim_ts,
        ticket.updated_sim_ts,
        ticket.resolved_sim_ts,
        ticket.close_reason,
        ticket.opened_wall_ts,
        ticket.updated_wall_ts,
        ticket.resolved_wall_ts,
        ticket.update_count,
      ]);
    },

    async saveClosure(closure) {
      await query(db, SAVE_CLOSURE, [
        closure.ticket_id,
        closure.verdict,
        closure.note,
        closure.closed_by,
        closure.sim_ts,
        closure.wall_ts,
      ]);
    },

    async load(unitId) {
      const rows = await query<TicketRow>(db, LOAD, [unitId]);
      return rows.map(toRecord);
    },
  };
}
