// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ticket lifecycle (docs/decision-backends.md#tickets).
 *
 * A ticket is the live view of one episode, and there is at most one per
 * episode — `app.tickets.episode_id` is unique, so the rule is a property of
 * the schema and not only of this file. Four states and the transitions
 * between them:
 *
 * | from | trigger | to | message |
 * | --- | --- | --- | --- |
 * | — | gate `ticket` | `open` | `action: opened` |
 * | — | gate `review` | `review` | `action: opened` |
 * | — | gate `log` | — | none |
 * | `review` | a later decision at or above the ticket threshold | `open` | `action: updated` (a promotion) |
 * | `review` | any other later decision naming a fault | `review` | `action: updated` |
 * | `open` | any later decision naming a fault, whatever the gate said | `open` | `action: updated` |
 * | `review`/`open` | the episode fell silent or a discontinuity ended it | `resolved` | `action: resolved` |
 * | `review`/`open`/`resolved` | a technician's verdict | `closed` | `action: closed`, with `closure` |
 *
 * There is no review queue: `review` is a ticket status, the Review tab is
 * `GET /api/tickets?status=review`, and a technician may close a review ticket
 * with a verdict like any other. A `resolved` or `closed` ticket is
 * never written by a decision again — the machine has stopped talking about
 * it, or a person has been to it — which is why a new episode on the same
 * symptom later starts a ticket of its own instead of re-opening a diagnosis
 * someone has judged. A resolved ticket still takes a verdict: the technician
 * who goes to a machine that has gone quiet can say whether the diagnosis was
 * right, and the evaluation harness needs that answer.
 *
 * A decision that names no fault (`none_of_these`) changes no ticket: there is
 * no cause to render, and replacing the diagnosis a technician is reading with
 * an abstention would leave them a ticket that says nothing.
 *
 * Every transition produces a `ticket` message, and every message is
 * validated before it leaves this module: a lifecycle that emitted an
 * off-contract payload would break the UI at the one moment a technician is
 * watching.
 */

import { assertValid, toIsoMs } from "@fdp/contracts";
import type { CatalogEntry, Decision, SuspectEvent, Ticket } from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import { NONE_OF_THESE } from "../decision/types.ts";
import type { Episode } from "../episodes/store.ts";
import type { GateResult } from "../gate/index.ts";
import { renderTicket } from "./render.ts";
import type { TicketClosureRow, TicketRepo } from "./repo.ts";
import type { TicketClosure, TicketRecord, TicketResolveReason, TicketVerdict } from "./types.ts";

export { renderTicket } from "./render.ts";
export type { RenderedTicket } from "./render.ts";
export type { TicketClosureRow, TicketRepo } from "./repo.ts";
export type {
  TicketClosure,
  TicketCloseReason,
  TicketRecord,
  TicketResolveReason,
  TicketStatus,
  TicketVerdict,
} from "./types.ts";

/** The schema id every ticket message repeats. */
export const TICKET_SCHEMA = "urn:fdp:schema:ticket:v1";

/** What happened to a ticket; `none` when nothing did. */
export type TicketAction = "opened" | "updated" | "promoted" | "resolved" | "closed" | "none";

/** One lifecycle call that changed a ticket: what happened, the row and the message. */
export interface TicketChange {
  readonly action: Exclude<TicketAction, "none">;
  readonly ticket: TicketRecord;
  /** The validated `ticket` message to publish. */
  readonly message: Ticket;
  /** The `app.ticket_closures` row, on a technician's close only. */
  readonly closure: TicketClosureRow | null;
}

/** One lifecycle call that changed nothing; the caller publishes nothing. */
export interface TicketUnchanged {
  readonly action: "none";
  readonly ticket: TicketRecord | null;
  readonly message: null;
  readonly closure: null;
}

/** The result of one lifecycle call. */
export type TicketOutcome = TicketChange | TicketUnchanged;

/** What {@link createTicketManager} is composed of. */
export interface TicketManagerPorts {
  /** Write-through persistence; the pipeline composes the manager without one. */
  readonly repo?: TicketRepo;
  /** A fresh `ticket_id`; `ids.ts` `newId` in the runtime, a counter in tests. */
  readonly ids: () => string;
  /** Wall time for `wall_ts`, the three wall stamps and the closure. */
  readonly wall: WallClock;
}

/** The ticket lifecycle over the tickets of one process. */
export interface TicketManager {
  /**
   * Open, promote or update the ticket of `episode` from one decision.
   *
   * `episode` is the episode that owns (or will own) the ticket — the merge
   * target when the decision was taken on a merged episode — and `candidate`
   * is the catalog entry the decision chose, `undefined` when it chose
   * `none_of_these`. `event` is the suspect event the decision was taken on.
   *
   * @throws Error when the decision names a fault and no candidate is given.
   */
  applyDecision(
    episode: Episode,
    decision: Decision,
    gate: GateResult,
    candidate: CatalogEntry | undefined,
    event: SuspectEvent,
  ): Promise<TicketOutcome>;
  /**
   * Resolve a live ticket because its episode ended without a technician.
   *
   * @throws UnknownTicketError when no ticket carries that id.
   */
  resolve(ticketId: string, reason: TicketResolveReason, simTs: string): Promise<TicketOutcome>;
  /**
   * Close a ticket on a technician's verdict.
   *
   * @throws UnknownTicketError when no ticket carries that id.
   * @throws TicketClosedError when a technician has closed it already.
   */
  close(ticketId: string, verdict: TicketVerdict, simTs: string): Promise<TicketChange>;
  byId(ticketId: string): TicketRecord | undefined;
  byEpisode(episodeId: string): TicketRecord | undefined;
  /** Every ticket the manager holds, oldest first. */
  list(): readonly TicketRecord[];
  /** Tickets a technician still has to look at: `review` and `open`. */
  openCount(): number;
  /** Replace everything with `rows`, as read back from `app.tickets`. */
  hydrate(rows: readonly TicketRecord[]): void;
}

/** Thrown when a ticket id names nothing the manager holds (HTTP 404). */
export class UnknownTicketError extends Error {
  readonly ticketId: string;

  constructor(ticketId: string) {
    super(`no ticket with id ${ticketId} is known`);
    this.name = "UnknownTicketError";
    this.ticketId = ticketId;
  }
}

/** Thrown when a verdict arrives for a ticket that already has one (HTTP 409). */
export class TicketClosedError extends Error {
  readonly ticketId: string;

  constructor(ticketId: string) {
    super(`ticket ${ticketId} is already closed; a verdict is given once`);
    this.name = "TicketClosedError";
    this.ticketId = ticketId;
  }
}

/** A ticket that is still being written to by decisions. */
function isLive(ticket: TicketRecord): boolean {
  return ticket.status === "review" || ticket.status === "open";
}

/** Nothing changed; `ticket` is the one that stayed as it was, when there is one. */
function unchanged(ticket: TicketRecord | null): TicketUnchanged {
  return { action: "none", ticket, message: null, closure: null };
}

/** The closure block of the message: optional fields absent rather than undefined. */
function closureBlock(closure: TicketClosure): NonNullable<Ticket["closure"]> {
  return {
    verdict: closure.verdict,
    ...(closure.note === undefined ? {} : { note: closure.note }),
    ...(closure.closed_by === undefined ? {} : { closed_by: closure.closed_by }),
    wall_ts: closure.wall_ts,
  };
}

/**
 * One ticket as the contract carries it.
 *
 * `action` says what this message announces and `status` where the ticket
 * stands, and the two are deliberately independent: a promotion is an
 * `updated` message whose status changed from `review` to `open`.
 *
 * @throws SchemaValidationError when the ticket does not fit the contract.
 */
export function toTicketMessage(
  ticket: TicketRecord,
  action: Ticket["action"],
  wallTs: string,
): Ticket {
  return assertValid("ticket", {
    schema: TICKET_SCHEMA,
    unit_id: ticket.unit_id,
    wall_ts: wallTs,
    ticket_id: ticket.ticket_id,
    episode_id: ticket.episode_id,
    action,
    status: ticket.status,
    fault_id: ticket.fault_id,
    condition_id: ticket.condition_id,
    title: ticket.title,
    cause: ticket.cause,
    checks: [...ticket.checks],
    remedy: ticket.remedy,
    manual_ref: ticket.manual_ref,
    evidence: [...ticket.evidence],
    confidence: ticket.confidence,
    probabilities: { ...ticket.probabilities },
    severity: ticket.severity,
    backend: ticket.backend,
    model: ticket.model,
    ...(ticket.rationale === null ? {} : { rationale: ticket.rationale }),
    latest_decision_id: ticket.latest_decision_id,
    opened_sim_ts: ticket.opened_sim_ts,
    updated_sim_ts: ticket.updated_sim_ts,
    resolved_sim_ts: ticket.resolved_sim_ts,
    close_reason: ticket.close_reason,
    update_count: ticket.update_count,
    closure: ticket.closure === null ? null : closureBlock(ticket.closure),
  });
}

/** The ticket lifecycle over one in-memory set of tickets. */
export function createTicketManager(ports: TicketManagerPorts): TicketManager {
  const { repo, ids, wall } = ports;
  const byId = new Map<string, TicketRecord>();
  const byEpisode = new Map<string, string>();

  function remember(ticket: TicketRecord): void {
    byId.set(ticket.ticket_id, ticket);
    byEpisode.set(ticket.episode_id, ticket.ticket_id);
  }

  function known(ticketId: string): TicketRecord {
    const ticket = byId.get(ticketId);
    if (ticket === undefined) throw new UnknownTicketError(ticketId);
    return ticket;
  }

  /**
   * Build the message, persist, then remember.
   *
   * The message is built first so an off-contract ticket is refused before
   * anything is written, and the store is updated last so a failed write
   * leaves the manager holding what the database holds.
   */
  async function commit(
    ticket: TicketRecord,
    action: Ticket["action"],
    reported: TicketChange["action"],
    wallTs: string,
    closure: TicketClosureRow | null = null,
  ): Promise<TicketChange> {
    const message = toTicketMessage(ticket, action, wallTs);
    if (repo !== undefined) {
      await repo.save(ticket);
      if (closure !== null) await repo.saveClosure(closure);
    }
    remember(ticket);
    return { action: reported, ticket, message, closure };
  }

  const manager: TicketManager = {
    async applyDecision(episode, decision, gate, candidate, event) {
      const existing = manager.byEpisode(episode.episode_id) ?? null;
      if (decision.status !== "ok" || decision.choice === NONE_OF_THESE) {
        return unchanged(existing);
      }
      if (candidate === undefined) {
        throw new Error(
          `applyDecision: decision ${decision.decision_id} chose ${decision.choice} ` +
            "but no catalog entry was passed to render it",
        );
      }

      const wallTs = toIsoMs(wall.now());
      const body = renderTicket(candidate, decision, event, episode.symptom_key);

      if (existing === null) {
        if (gate.outcome === "log") return unchanged(null);
        const ticket: TicketRecord = {
          ...body,
          ticket_id: ids(),
          episode_id: episode.episode_id,
          unit_id: episode.unit_id,
          status: gate.outcome === "ticket" ? "open" : "review",
          latest_decision_id: decision.decision_id,
          opened_sim_ts: decision.sim_ts,
          updated_sim_ts: decision.sim_ts,
          resolved_sim_ts: null,
          close_reason: null,
          opened_wall_ts: wallTs,
          updated_wall_ts: wallTs,
          resolved_wall_ts: null,
          update_count: 0,
          closure: null,
        };
        return commit(ticket, "opened", "opened", wallTs);
      }

      // A ticket a technician has judged, or one the machine has resolved, is
      // finished: later decisions are recorded in `app.decisions` and nowhere
      // else.
      if (!isLive(existing)) return unchanged(existing);

      const promoting = existing.status === "review" && gate.outcome === "ticket";
      const updated: TicketRecord = {
        ...existing,
        ...body,
        status: promoting ? "open" : existing.status,
        latest_decision_id: decision.decision_id,
        updated_sim_ts: decision.sim_ts,
        updated_wall_ts: wallTs,
        update_count: existing.update_count + 1,
      };
      return commit(updated, "updated", promoting ? "promoted" : "updated", wallTs);
    },

    async resolve(ticketId, reason, simTs) {
      const existing = known(ticketId);
      if (!isLive(existing)) return unchanged(existing);
      const wallTs = toIsoMs(wall.now());
      const resolved: TicketRecord = {
        ...existing,
        status: "resolved",
        close_reason: reason,
        resolved_sim_ts: simTs,
        resolved_wall_ts: wallTs,
      };
      return commit(resolved, "resolved", "resolved", wallTs);
    },

    async close(ticketId, verdict, simTs) {
      const existing = known(ticketId);
      if (existing.status === "closed") throw new TicketClosedError(ticketId);
      const wallTs = toIsoMs(wall.now());
      const closure: TicketClosure = {
        verdict: verdict.verdict,
        ...(verdict.note === undefined ? {} : { note: verdict.note }),
        ...(verdict.closed_by === undefined ? {} : { closed_by: verdict.closed_by }),
        wall_ts: wallTs,
      };
      // A ticket the machine had already resolved keeps the moment it did; the
      // verdict's own sim time is the closure row's.
      const closed: TicketRecord = {
        ...existing,
        status: "closed",
        close_reason: "technician",
        resolved_sim_ts: existing.resolved_sim_ts ?? simTs,
        resolved_wall_ts: existing.resolved_wall_ts ?? wallTs,
        closure,
      };
      const row: TicketClosureRow = {
        ticket_id: closed.ticket_id,
        verdict: closure.verdict,
        note: closure.note ?? null,
        closed_by: closure.closed_by ?? null,
        sim_ts: simTs,
        wall_ts: wallTs,
      };
      return commit(closed, "closed", "closed", wallTs, row);
    },

    byId(ticketId) {
      return byId.get(ticketId);
    },

    byEpisode(episodeId) {
      const id = byEpisode.get(episodeId);
      return id === undefined ? undefined : byId.get(id);
    },

    list() {
      return [...byId.values()];
    },

    openCount() {
      let open = 0;
      for (const ticket of byId.values()) if (isLive(ticket)) open += 1;
      return open;
    },

    hydrate(rows) {
      byId.clear();
      byEpisode.clear();
      for (const ticket of rows) remember(ticket);
    },
  };

  return manager;
}
