// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a restarting backend reads back before the first sample.
 *
 * The episode store and the ticket manager live in memory, and the database
 * enforces what they assume: one open episode per symptom
 * (`episodes_one_open`) and one ticket per episode (`tickets.episode_id`). A
 * restart that forgot either would open a second episode or a second ticket on
 * the next suspect event, and the insert would be refused. So the runtime
 * loads, per unit:
 *
 *   * every episode that is still open, or that owns a ticket in the `review`
 *     or `open` state (`episodes/repo.ts#load`), and
 *   * every live ticket, plus every ticket of a still-open episode — closed
 *     ones included, because the uniqueness holds for them too
 *     (`tickets/repo.ts#load`).
 *
 * The review queue is the set of review-status tickets, so it comes
 * back with them.
 */

import { createEpisodeStore, type EpisodeStore } from "../episodes/index.ts";
import type { EpisodeRepo } from "../episodes/repo.ts";
import type { TicketRecord } from "../tickets/index.ts";
import type { TicketRepo } from "../tickets/repo.ts";

export interface HydrationSources {
  readonly episodes: Pick<EpisodeRepo, "load">;
  readonly tickets: Pick<TicketRepo, "load">;
  readonly unitId: string;
}

/** The two ports `createPipeline` continues from (`PipelinePorts.store`, `.tickets`). */
export interface Hydrated {
  readonly store: EpisodeStore;
  readonly tickets: readonly TicketRecord[];
}

/** Read the open work of one unit back into a fresh store. */
export async function hydrate(sources: HydrationSources): Promise<Hydrated> {
  const [episodes, tickets] = await Promise.all([
    sources.episodes.load(sources.unitId),
    sources.tickets.load(sources.unitId),
  ]);
  return { store: createEpisodeStore(episodes), tickets };
}
