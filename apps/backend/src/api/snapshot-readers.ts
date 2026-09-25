// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ticket and episode lists, read from the pipeline's own records.
 *
 * Neither list has a persisted reader: `tickets/repo.ts` and
 * `episodes/repo.ts` save and hydrate, and nothing else. The pipeline holds
 * every ticket and episode of the running process — the ones it created and
 * the ones `runtime/hydrate.ts` loaded at startup, closed tickets of open
 * episodes included — and `Pipeline.snapshot()` hands them over as contract
 * messages, so these readers page through that snapshot instead of asking the
 * database again for what the process already knows. A ticket that was closed
 * and whose episode ended before the last restart is not hydrated, and is
 * therefore not listed; the database keeps it.
 *
 * The pages behave like the persisted ones (`persistence/cursor.ts`): newest
 * first by `opened_sim_ts`, ties broken by id, `limit` defaulted and clamped
 * the same way, and `next_cursor` an opaque token of the last row's key, so a
 * client pages a ticket list exactly as it pages the event list. A token these
 * readers did not issue throws the same `InvalidCursorError` (HTTP 400).
 */

import { ISO_MS_PATTERN, type Episode as EpisodeMessage, type Ticket } from "@fdp/contracts";

import { toEpisodeMessage } from "../episodes/index.ts";
import { clampLimit, InvalidCursorError, type Page } from "../persistence/cursor.ts";
import type { PageQuery } from "../persistence/types.ts";
import type { PipelineSnapshot } from "../pipeline/types.ts";
import type { EpisodeListQuery, EpisodesReader, TicketListQuery, TicketsReader } from "./deps.ts";

/** Where a row sits in a newest-first list: its opening instant, then its id. */
interface RowKey {
  readonly instant: string;
  readonly id: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Negative when `a` sorts below `b` in the list, that is, when it is older. */
function compareKeys(a: RowKey, b: RowKey): number {
  if (a.instant !== b.instant) return a.instant < b.instant ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function encodeKey(key: RowKey): string {
  return Buffer.from(JSON.stringify([key.instant, key.id]), "utf8").toString("base64url");
}

function decodeKey(cursor: string): RowKey {
  if (!BASE64URL.test(cursor)) throw new InvalidCursorError("not a base64url token");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("not a token this API issued");
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    throw new InvalidCursorError("not a token this API issued");
  }
  const [instant, id] = decoded as unknown[];
  if (typeof instant !== "string" || !ISO_MS_PATTERN.test(instant)) {
    throw new InvalidCursorError("the instant is malformed");
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new InvalidCursorError("the row key is malformed");
  }
  return { instant, id };
}

/** One newest-first page of `rows`, below the key `query.before` names. */
function pageOf<T>(rows: readonly T[], keyOf: (row: T) => RowKey, query: PageQuery): Page<T> {
  const limit = clampLimit(query.limit);
  const bound = query.before === undefined ? undefined : decodeKey(query.before);
  const below = rows
    .filter((row) => bound === undefined || compareKeys(keyOf(row), bound) < 0)
    .sort((a, b) => compareKeys(keyOf(b), keyOf(a)));
  const items = below.slice(0, limit);
  const last = items.at(-1);
  const more = below.length > limit && last !== undefined;
  return { items, next_cursor: more ? encodeKey(keyOf(last)) : null };
}

const ticketKey = (ticket: Ticket): RowKey => ({
  instant: ticket.opened_sim_ts,
  id: ticket.ticket_id,
});

const episodeKey = (episode: EpisodeMessage): RowKey => ({
  instant: episode.opened_sim_ts,
  id: episode.episode_id,
});

/** The part of the pipeline's snapshot these readers use. */
export type SnapshotSource = () => Pick<PipelineSnapshot, "tickets" | "episodes">;

/** The two readers, each taking a fresh snapshot per call. */
export interface SnapshotReaders {
  readonly tickets: TicketsReader;
  readonly episodes: EpisodesReader;
}

/** Ticket and episode readers over `snapshot` (the runtime passes `() => pipeline.snapshot()`). */
export function createSnapshotReaders(snapshot: SnapshotSource): SnapshotReaders {
  return {
    tickets: {
      async list(query: TicketListQuery = {}): Promise<Page<Ticket>> {
        const { status } = query;
        const tickets = snapshot().tickets.filter(
          (ticket) => status === undefined || ticket.status === status,
        );
        return pageOf(tickets, ticketKey, query);
      },

      async get(ticketId: string): Promise<Ticket | undefined> {
        return snapshot().tickets.find((ticket) => ticket.ticket_id === ticketId);
      },
    },

    episodes: {
      async list(query: EpisodeListQuery = {}): Promise<Page<EpisodeMessage>> {
        const { status } = query;
        const episodes = snapshot()
          .episodes.filter((episode) => status === undefined || episode.status === status)
          .map(toEpisodeMessage);
        return pageOf(episodes, episodeKey, query);
      },
    },
  };
}
