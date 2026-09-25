// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Reading the open work back at start-up. The
// statements themselves run against PostgreSQL in
// test/integration/episodes-tickets.test.ts; this proves the runtime asks for
// the right unit and continues from what came back.

import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import type { Episode } from "../episodes/index.ts";
import { createCatalogRetriever, createPipeline } from "../pipeline/index.ts";
import type { PipelineTicket } from "../pipeline/types.ts";
import type { TicketRecord } from "../tickets/index.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import { longLoadedRuns, scenarioBatches } from "../../test/fixtures/synthetic/index.ts";
import { confidentBackend } from "./fakes.test-helper.ts";
import { hydrate } from "./hydrate.ts";

/** An open episode that owns an open ticket, as a first process left them. */
async function openWork(): Promise<{ episodes: Episode[]; tickets: TicketRecord[] }> {
  const pipeline = createPipeline({
    wall: fixedClock("2026-09-22T08:00:00.000Z"),
    retriever: createCatalogRetriever(FIXTURE_CATALOG),
    decision: confidentBackend(),
  });
  for (const batch of scenarioBatches(longLoadedRuns(20))) {
    const ticket = (await pipeline.push(batch)).find(
      (output): output is PipelineTicket => output.type === "ticket",
    );
    if (ticket !== undefined) {
      return { episodes: [...pipeline.snapshot().episodes], tickets: [ticket.record] };
    }
  }
  throw new Error("the scenario opened no ticket");
}

describe("hydrate", () => {
  it("reads the unit's open episodes and tickets into a fresh store", async () => {
    const work = await openWork();
    const asked: string[] = [];

    const hydrated = await hydrate({
      unitId: "cau-7",
      episodes: {
        load: (unitId) => {
          asked.push(`episodes ${unitId}`);
          return Promise.resolve(work.episodes);
        },
      },
      tickets: {
        load: (unitId) => {
          asked.push(`tickets ${unitId}`);
          return Promise.resolve(work.tickets);
        },
      },
    });

    expect(asked.sort()).toEqual(["episodes cau-7", "tickets cau-7"]);
    expect(hydrated.store.list()).toEqual(work.episodes);
    expect(hydrated.tickets).toEqual(work.tickets);
  });

  it("lets a second pipeline continue the ticket instead of opening another", async () => {
    const work = await openWork();
    const hydrated = await hydrate({
      unitId: "cau-7",
      episodes: { load: () => Promise.resolve(work.episodes) },
      tickets: { load: () => Promise.resolve(work.tickets) },
    });
    const restarted = createPipeline({
      wall: fixedClock("2026-09-22T09:00:00.000Z"),
      retriever: createCatalogRetriever(FIXTURE_CATALOG),
      decision: confidentBackend(),
      store: hydrated.store,
      tickets: hydrated.tickets,
    });

    const [owned] = work.tickets;
    expect(restarted.snapshot().tickets.map((ticket) => ticket.ticket_id)).toEqual([
      owned?.ticket_id,
    ]);
    const closed = await restarted.closeTicket(owned?.ticket_id ?? "", { verdict: "wrong" });
    expect(closed).toEqual([
      expect.objectContaining({
        type: "ticket",
        ticket: expect.objectContaining({ status: "closed" }) as unknown,
      }),
    ]);
  });
});
