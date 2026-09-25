// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ticket vocabulary.
 *
 * It sits in a file of its own because two modules share it and neither may
 * import the other: the lifecycle in `index.ts` writes through the repository
 * in `repo.ts`, and the repository reads rows back into these records.
 */

import type { DecisionBackend, EvidenceItem, ManualReference, SeverityLevel } from "@fdp/contracts";

/** Where a ticket stands (`app.tickets.status`); `review` is the review queue. */
export type TicketStatus = "review" | "open" | "resolved" | "closed";

/** Why a ticket left the review or open state (`app.tickets.close_reason`). */
export type TicketCloseReason = "silence" | "discontinuity" | "technician";

/** How an episode ended without a technician; what the lifecycle resolves a ticket for. */
export type TicketResolveReason = Exclude<TicketCloseReason, "technician">;

/** A technician's verdict, as `POST /api/tickets/:id/close` sends it. */
export interface TicketVerdict {
  readonly verdict: "correct" | "wrong";
  readonly note?: string;
  readonly closed_by?: string;
}

/** The verdict as the `closure` block of the ticket message carries it. */
export interface TicketClosure extends TicketVerdict {
  readonly wall_ts: string;
}

/**
 * One ticket, as the manager holds it and `app.tickets` stores it.
 *
 * Every field is a column of `app.tickets` except `closure`, which is the
 * newest row of `app.ticket_closures`. The `*_sim_ts` stamps are data time and
 * the `*_wall_ts` stamps wall time.
 */
export interface TicketRecord {
  readonly ticket_id: string;
  readonly episode_id: string;
  readonly unit_id: string;
  readonly status: TicketStatus;
  readonly fault_id: string;
  readonly condition_id: string;
  readonly title: string;
  readonly cause: string;
  readonly remedy: string;
  readonly checks: readonly string[];
  readonly manual_ref: ManualReference;
  readonly evidence: readonly EvidenceItem[];
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly severity: SeverityLevel;
  readonly backend: DecisionBackend;
  readonly model: string;
  readonly rationale: string | null;
  readonly latest_decision_id: string;
  readonly opened_sim_ts: string;
  readonly updated_sim_ts: string;
  /** When the ticket left the live states; `null` while it is `review` or `open`. */
  readonly resolved_sim_ts: string | null;
  readonly close_reason: TicketCloseReason | null;
  readonly opened_wall_ts: string;
  readonly updated_wall_ts: string;
  readonly resolved_wall_ts: string | null;
  readonly update_count: number;
  readonly closure: TicketClosure | null;
}
