// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `app.suspect_events`, written and read as `app_rw`.
 *
 * A row is the `suspect-event` message in two forms: the columns a query
 * filters or joins on (`symptom_key`, `sim_ts`, the window, the machine mode)
 * and the whole message in `payload`. The list reads `payload` back, so
 * `GET /api/events/suspect` serves exactly the document detection published,
 * the additive fields (`rules_fired`, `baseline_ref`)
 * included.
 */

import type { SuspectEvent } from "@fdp/contracts";

import { query, withTx, type Pool } from "../db/pool.ts";
import { clampLimit, CURSOR_TS_SQL, pageParams, toPage, type KeyedRow } from "./cursor.ts";
import { jsonb } from "./sql.ts";
import type { EventListQuery, EventsRepo } from "./types.ts";

const INSERT = `
INSERT INTO app.suspect_events
       (event_id, unit_id, sim_ts, wall_ts, episode_id, symptom_key, rule_ids, machine_mode,
        evidence, observations, active_alarms, co_symptoms, ambient,
        window_from_sim_ts, window_to_sim_ts, payload)
VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5::uuid, $6, $7::text[], $8,
        $9::jsonb, $10::jsonb, $11::text[], $12::text[], $13,
        $14::timestamptz, $15::timestamptz, $16::jsonb)
ON CONFLICT (event_id) DO NOTHING`;

// `$3` and `$4` are the key of the previous page's last row, both NULL on the
// first page. The plain `sim_ts <=` bound repeats what the row comparison
// implies, so the planner can use `suspect_events_lookup (unit_id, sim_ts DESC)`.
const LIST = `
SELECT id::text AS cursor_id, ${CURSOR_TS_SQL} AS cursor_ts, payload
  FROM app.suspect_events
 WHERE unit_id = $1
   AND ($2::text IS NULL OR symptom_key = $2::text)
   AND ($3::timestamptz IS NULL
        OR (sim_ts <= $3::timestamptz AND (sim_ts, id) < ($3::timestamptz, $4::bigint)))
 ORDER BY sim_ts DESC, id DESC
 LIMIT $5::integer`;

type EventRecord = KeyedRow & { payload: SuspectEvent };

/** The suspect-event statements of one unit over one `app_rw` pool. */
export function createEventsRepo(pool: Pool, unitId: string): EventsRepo {
  return {
    async insert(event, episodeId) {
      const result = await withTx(pool, (client) =>
        client.query(INSERT, [
          event.event_id,
          event.unit_id,
          event.sim_ts,
          event.wall_ts,
          episodeId ?? null,
          event.symptom_key,
          [...event.rule_ids],
          event.machine_state.mode,
          jsonb(event.evidence),
          jsonb(event.observations),
          [...event.active_alarms],
          [...event.co_symptoms],
          event.ambient,
          event.window.from_sim_ts,
          event.window.to_sim_ts,
          jsonb(event),
        ]),
      );
      return (result.rowCount ?? 0) === 1;
    },

    async list(request: EventListQuery = {}) {
      const limit = clampLimit(request.limit);
      const rows = await query<EventRecord>(pool, LIST, [
        unitId,
        request.symptom_key ?? null,
        ...pageParams(request.before, limit),
      ]);
      return toPage(rows, limit, (row) => row.payload);
    },
  };
}
