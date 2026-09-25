// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/catalog/faults` and `GET /api/catalog/faults/:fault_id`
 * (contracts `catalog-entry`).
 *
 * The causes of the active manual document, in the `catalog-entry` shape the
 * decision sheet expands a candidate with: the list is
 * `{ items: catalog-entry[] }` in `fault_id` order (empty before init has
 * run), and the single cause is the entry itself, or 404 when the active
 * document has no cause with that id. The entries were validated when the
 * catalog was loaded (`retrieval/catalog.ts`), so a row the extraction mangled
 * is never served.
 */

import type { CatalogEntry } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import type { CatalogReader } from "./deps.ts";
import { NotFoundError } from "./errors.ts";

/** The body of `GET /api/catalog/faults`. */
export interface CatalogFaultList {
  readonly items: readonly CatalogEntry[];
}

export function catalogRoutes(
  catalog: Pick<CatalogReader, "faults" | "fault">,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/catalog/faults", async (): Promise<CatalogFaultList> => ({
      items: await catalog.faults(),
    }));

    fastify.get<{ Params: { fault_id: string } }>(
      "/catalog/faults/:fault_id",
      async (request): Promise<CatalogEntry> => {
        const entry = await catalog.fault(request.params.fault_id);
        if (entry === undefined) {
          throw new NotFoundError(`no cause with fault_id ${request.params.fault_id}`);
        }
        return entry;
      },
    );
  };
}
