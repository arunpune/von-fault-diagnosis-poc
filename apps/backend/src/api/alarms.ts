// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/alarms/native`: the controller's own alarm
 * transitions, as ingest diffed them out of the sample stream.
 *
 * The read is a window of data time, oldest first, because that is what the
 * persisted reader answers (`NativeAlarmsRepo.list`) and what both of
 * its consumers want — a chart strip draws the transitions inside the range it
 * shows, and the evaluation looks for the first raise after an onset:
 *
 * | parameter | meaning |
 * | --- | --- |
 * | `from`, `to` | the window in data time, `iso_ts`, both ends inclusive; open-ended when absent |
 * | `code` | only this controller alarm code (`W101`, `S202`, …) |
 * | `limit` | at most this many rows; the repository's default and cap apply |
 *
 * The body is `{ items: [{ code, state, sim_ts, wall_ts, seq }] }`. It is a
 * window, not a page, so there is no cursor: the next window starts after the
 * last `sim_ts` returned.
 */

import type { FastifyPluginAsync } from "fastify";

import type { NativeAlarm, NativeAlarmsRepo } from "../persistence/types.ts";
import { BadRequestError } from "./errors.ts";
import { isoParam, positiveIntParam, textParam, type Query } from "./query.ts";

/** The earliest and the latest instants `iso_ts` can write: an open window. */
const OPEN_FROM = "0001-01-01T00:00:00.000Z";
const OPEN_TO = "9999-12-31T23:59:59.999Z";

/** The `alarm_code` pattern of the contracts: W warning, X shutdown warning, S shutdown, M service. */
const ALARM_CODE = /^[WXSM][0-9]{3}$/;

/** The body of `GET /api/alarms/native`. */
export interface NativeAlarmList {
  readonly items: readonly NativeAlarm[];
}

function codeParam(query: Query): string | undefined {
  const code = textParam(query, "code");
  if (code !== undefined && !ALARM_CODE.test(code)) {
    throw new BadRequestError("code is not a controller alarm code such as W101", "code");
  }
  return code;
}

export function alarmsRoutes(nativeAlarms: NativeAlarmsRepo): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get<{ Querystring: Query }>(
      "/alarms/native",
      async (request): Promise<NativeAlarmList> => {
        const query = request.query;
        const from = isoParam(query, "from") ?? OPEN_FROM;
        const to = isoParam(query, "to") ?? OPEN_TO;
        if (from > to) throw new BadRequestError("from is after to", "from");
        const items = await nativeAlarms.list({
          from,
          to,
          code: codeParam(query),
          limit: positiveIntParam(query, "limit"),
        });
        return { items };
      },
    );
  };
}
