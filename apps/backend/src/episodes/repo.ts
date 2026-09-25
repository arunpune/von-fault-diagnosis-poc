// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.episodes`, written as `app_rw`.
 *
 * The state machine in `index.ts` never awaits anything, so this module is the
 * write-through half of it: one upsert per changed episode and one read at
 * startup. A restart that skipped the read would open a second episode for a
 * symptom the previous process was already watching, and the database would
 * refuse it — `episodes_one_open` is a unique index, not a hint — so
 * {@link EpisodeRepo.load} is what makes the store survive a restart.
 *
 * `load` joins `app.tickets` because {@link Episode.fault_id} is not a column
 * of `app.episodes`: the fault an episode's ticket names is the thing the
 * merge rule compares, and it lives on the ticket. The join also
 * re-derives `closed_by_technician` from the ticket's own status, so an
 * episode row that was written before its ticket was closed still hydrates as
 * finished.
 *
 * Like `ingest/repo.ts` this module holds no pool: it takes a {@link Queryable},
 * which a pool, a client checked out of one and a test double all satisfy.
 */

import { toIsoMs } from "@fdp/contracts";

import { query, type Queryable } from "../db/pool.ts";
import type { Episode, EpisodeCloseReason, EpisodeStatus } from "./store.ts";

/** The statements this repository runs. */
export interface EpisodeRepo {
  /** Insert or update one episode, keyed by `episode_id`. */
  save(episode: Episode): Promise<void>;
  /**
   * The episodes a restarting backend has to know about: everything still
   * open, plus whatever owns a ticket a technician has not finished with.
   */
  load(unitId: string): Promise<Episode[]>;
}

/** One row of the read path, as the driver hands it over. */
type EpisodeRecord = {
  episode_id: string;
  unit_id: string;
  symptom_key: string;
  symptom_keys: string[];
  status: string;
  merged_into: string | null;
  opened_sim_ts: Date;
  last_event_sim_ts: Date;
  last_decision_sim_ts: Date | null;
  closed_sim_ts: Date | null;
  close_reason: string | null;
  first_event_id: string;
  ticket_id: string | null;
  closed_by_technician: boolean;
  event_count: number;
  decision_count: number;
  fault_id: string | null;
};

const SAVE = `
INSERT INTO app.episodes
       (episode_id, unit_id, symptom_key, symptom_keys, status, merged_into,
        opened_sim_ts, last_event_sim_ts, last_decision_sim_ts, closed_sim_ts, close_reason,
        first_event_id, ticket_id, closed_by_technician, event_count, decision_count)
VALUES ($1, $2, $3, $4::text[], $5, $6,
        $7::timestamptz, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11,
        $12, $13, $14, $15, $16)
ON CONFLICT (episode_id) DO UPDATE
   SET symptom_keys = excluded.symptom_keys,
       status = excluded.status,
       merged_into = excluded.merged_into,
       last_event_sim_ts = excluded.last_event_sim_ts,
       last_decision_sim_ts = excluded.last_decision_sim_ts,
       closed_sim_ts = excluded.closed_sim_ts,
       close_reason = excluded.close_reason,
       ticket_id = excluded.ticket_id,
       closed_by_technician = excluded.closed_by_technician,
       event_count = excluded.event_count,
       decision_count = excluded.decision_count`;

const LOAD = `
SELECT e.episode_id, e.unit_id, e.symptom_key, e.symptom_keys, e.status, e.merged_into,
       e.opened_sim_ts, e.last_event_sim_ts, e.last_decision_sim_ts, e.closed_sim_ts,
       e.close_reason, e.first_event_id,
       COALESCE(e.ticket_id, t.ticket_id) AS ticket_id,
       (e.closed_by_technician OR COALESCE(t.status, '') = 'closed') AS closed_by_technician,
       e.event_count, e.decision_count, t.fault_id
  FROM app.episodes e
  LEFT JOIN app.tickets t ON t.episode_id = e.episode_id
 WHERE e.unit_id = $1
   AND (e.status = 'open' OR COALESCE(t.status, '') IN ('review', 'open'))
 ORDER BY e.opened_sim_ts, e.id`;

/** `iso_ts` or `null`, from a `timestamptz` the driver decoded into a `Date`. */
function isoOrNull(value: Date | null): string | null {
  return value === null ? null : toIsoMs(value);
}

function toEpisode(row: EpisodeRecord): Episode {
  return {
    episode_id: row.episode_id,
    unit_id: row.unit_id,
    symptom_key: row.symptom_key,
    symptom_keys: row.symptom_keys,
    status: row.status as EpisodeStatus,
    merged_into: row.merged_into,
    opened_sim_ts: toIsoMs(row.opened_sim_ts),
    last_event_sim_ts: toIsoMs(row.last_event_sim_ts),
    last_decision_sim_ts: isoOrNull(row.last_decision_sim_ts),
    closed_sim_ts: isoOrNull(row.closed_sim_ts),
    close_reason: row.close_reason as EpisodeCloseReason | null,
    first_event_id: row.first_event_id,
    ticket_id: row.ticket_id,
    closed_by_technician: row.closed_by_technician,
    event_count: row.event_count,
    decision_count: row.decision_count,
    fault_id: row.fault_id,
  };
}

/** The episode statements over one {@link Queryable}. */
export function createEpisodeRepo(db: Queryable): EpisodeRepo {
  return {
    async save(episode) {
      await query(db, SAVE, [
        episode.episode_id,
        episode.unit_id,
        episode.symptom_key,
        [...episode.symptom_keys],
        episode.status,
        episode.merged_into,
        episode.opened_sim_ts,
        episode.last_event_sim_ts,
        episode.last_decision_sim_ts,
        episode.closed_sim_ts,
        episode.close_reason,
        episode.first_event_id,
        episode.ticket_id,
        episode.closed_by_technician,
        episode.event_count,
        episode.decision_count,
      ]);
    },

    async load(unitId) {
      const rows = await query<EpisodeRecord>(db, LOAD, [unitId]);
      return rows.map(toEpisode);
    },
  };
}
