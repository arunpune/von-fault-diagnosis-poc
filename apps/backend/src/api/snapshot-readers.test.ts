// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The in-memory ticket and episode readers: newest first, filtered by status,
// paged with an opaque cursor that neither repeats nor skips a row, and strict
// about tokens they did not issue.

import { isValid, type Ticket } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import type { Episode } from "../episodes/index.ts";
import { InvalidCursorError, type Page } from "../persistence/cursor.ts";
import { contract, episodeRecord } from "./fake-deps.test-helper.ts";
import { createSnapshotReaders } from "./snapshot-readers.ts";

/** A ticket of the given status, id and opening instant. */
function ticket(id: string, status: Ticket["status"], openedSimTs: string): Ticket {
  return {
    ...contract<Ticket>("ticket", "valid-opened.json"),
    ticket_id: id,
    status,
    opened_sim_ts: openedSimTs,
  };
}

/** A uuid whose last group is `n`, so ids sort by `n`. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Every item of every page, following `next_cursor` to the end. */
async function drain<T>(read: (before?: string) => Promise<Page<T>>): Promise<T[][]> {
  const pages: T[][] = [];
  let before: string | undefined;
  do {
    const page = await read(before);
    pages.push(page.items);
    before = page.next_cursor ?? undefined;
  } while (before !== undefined);
  return pages;
}

describe("tickets reader", () => {
  // Five tickets; two share an opening instant, so the id breaks the tie.
  const tickets = [
    ticket(uuid(1), "open", "2020-06-05T09:00:00.000Z"),
    ticket(uuid(2), "review", "2020-06-05T10:00:00.000Z"),
    ticket(uuid(3), "open", "2020-06-05T10:00:00.000Z"),
    ticket(uuid(4), "closed", "2020-06-05T11:00:00.000Z"),
    ticket(uuid(5), "resolved", "2020-06-05T08:00:00.000Z"),
  ];
  const readers = createSnapshotReaders(() => ({ tickets, episodes: [] }));

  it("lists newest first, the id breaking a tie between two instants", async () => {
    const page = await readers.tickets.list();
    expect(page.items.map((item) => item.ticket_id)).toEqual([
      uuid(4),
      uuid(3),
      uuid(2),
      uuid(1),
      uuid(5),
    ]);
    expect(page.next_cursor).toBeNull();
    expect(isValid("api-tickets", page)).toBe(true);
  });

  it("pages through every ticket without repeating or skipping one", async () => {
    const pages = await drain((before) => readers.tickets.list({ limit: 2, before }));
    expect(pages.map((items) => items.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((item) => item.ticket_id)).toEqual([
      uuid(4),
      uuid(3),
      uuid(2),
      uuid(1),
      uuid(5),
    ]);
  });

  it("filters by status", async () => {
    const page = await readers.tickets.list({ status: "open" });
    expect(page.items.map((item) => item.ticket_id)).toEqual([uuid(3), uuid(1)]);
  });

  it("finds one ticket by id", async () => {
    expect((await readers.tickets.get(uuid(2)))?.status).toBe("review");
    expect(await readers.tickets.get(uuid(9))).toBeUndefined();
  });

  it("clamps the limit the way the persisted pages do", async () => {
    const page = await readers.tickets.list({ limit: 0 });
    expect(page.items).toHaveLength(1);
  });

  it.each([
    "***",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify(["2020-06-05T09:00:00.000Z"])).toString("base64url"),
    Buffer.from(JSON.stringify(["yesterday", uuid(1)])).toString("base64url"),
    Buffer.from(JSON.stringify(["2020-06-05T09:00:00.000Z", "ticket-1"])).toString("base64url"),
  ])("refuses a cursor it did not issue: %s", async (before) => {
    await expect(readers.tickets.list({ before })).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("episodes reader", () => {
  const episodes: Episode[] = [
    episodeRecord(uuid(1), "open", "2020-06-05T09:00:00.000Z"),
    episodeRecord(uuid(2), "closed", "2020-06-05T07:00:00.000Z"),
    episodeRecord(uuid(3), "aborted", "2020-06-05T10:00:00.000Z"),
  ];
  const readers = createSnapshotReaders(() => ({ tickets: [], episodes }));

  it("answers api-episodes items, newest first, without the backend-only fields", async () => {
    const page = await readers.episodes.list();
    expect(isValid("api-episodes", page)).toBe(true);
    expect(page.items.map((item) => item.episode_id)).toEqual([uuid(3), uuid(1), uuid(2)]);
    expect(page.items[0]).not.toHaveProperty("merged_into");
  });

  it("filters by status", async () => {
    const page = await readers.episodes.list({ status: "closed" });
    expect(page.items.map((item) => item.episode_id)).toEqual([uuid(2)]);
  });

  it("reads a fresh snapshot on every call", async () => {
    const live: Episode[] = [];
    const reader = createSnapshotReaders(() => ({ tickets: [], episodes: live })).episodes;
    expect((await reader.list()).items).toHaveLength(0);
    live.push(episodeRecord(uuid(4), "open", "2020-06-05T11:00:00.000Z"));
    expect((await reader.list()).items).toHaveLength(1);
  });
});
