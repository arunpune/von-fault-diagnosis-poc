// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ticket routes (contracts `api-tickets`, `ticket` and `api-ticket-close`).
 *
 * - `GET /api/tickets` — one page of ticket messages, newest first. `status`
 *   is `review`, `open`, `resolved`, `closed` or `all` (the default); the
 *   Review tab is `?status=review`, because the review queue is the set of
 *   review-status tickets and has no route of its own. `before` and
 *   `limit` page as everywhere else.
 * - `GET /api/tickets/:id` — the ticket message plus `decisions`: the decision
 *   messages of the ticket's episode, newest first, which the ticket sheet
 *   shows as its history (at most one page of 200, about four days of
 *   half-hourly re-decisions).
 * - `POST /api/tickets/:id/close` — a technician's verdict. The body is
 *   `api-ticket-close` (`verdict`, never `outcome`); the answer is
 *   the `ticket` message the close produced. An unknown id is 404 and a ticket
 *   that already has a verdict is 409; a review, open or resolved ticket takes
 *   one.
 */

import { assertValid, validate, type ApiTickets, type Decision, type Ticket } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { MAX_PAGE_LIMIT } from "../persistence/cursor.ts";
import type { TicketStatus } from "../tickets/index.ts";
import type { ApiDeps } from "./deps.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import { enumParam, positiveIntParam, textParam, type Query } from "./query.ts";

/** The values `?status=` accepts: the four ticket statuses, or every ticket. */
export const TICKET_STATUS_FILTERS: readonly (TicketStatus | "all")[] = [
  "review",
  "open",
  "resolved",
  "closed",
  "all",
];

/** The body of `GET /api/tickets/:id`: the ticket with its decision history. */
export type TicketDetail = Ticket & { readonly decisions: readonly Decision[] };

type TicketDeps = Pick<ApiDeps, "actions"> & {
  readonly repos: Pick<ApiDeps["repos"], "tickets" | "decisions">;
};

export function ticketsRoutes(deps: TicketDeps): FastifyPluginAsync {
  const { tickets, decisions } = deps.repos;

  return async (fastify) => {
    fastify.get<{ Querystring: Query }>("/tickets", async (request): Promise<ApiTickets> => {
      const query = request.query;
      const status = enumParam(query, "status", TICKET_STATUS_FILTERS) ?? "all";
      const page = await tickets.list({
        status: status === "all" ? undefined : status,
        before: textParam(query, "before"),
        limit: positiveIntParam(query, "limit"),
      });
      return assertValid("api-tickets", page);
    });

    fastify.get<{ Params: { id: string } }>(
      "/tickets/:id",
      async (request): Promise<TicketDetail> => {
        const ticket = await tickets.get(request.params.id);
        if (ticket === undefined) throw new NotFoundError(`no ticket with id ${request.params.id}`);
        const history = await decisions.list({
          episode_id: ticket.episode_id,
          limit: MAX_PAGE_LIMIT,
        });
        const detail: TicketDetail = { ...ticket, decisions: history.items };
        assertValid("ticket", detail);
        return detail;
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/tickets/:id/close",
      async (request): Promise<Ticket> => {
        const body = validate("api-ticket-close", request.body);
        if (!body.ok) {
          throw new BadRequestError("the body is not an api-ticket-close", undefined, {
            issues: body.errors.map((issue) => issue.text),
          });
        }
        const ticket = await deps.actions.closeTicket(request.params.id, body.value);
        return assertValid("ticket", ticket);
      },
    );
  };
}
