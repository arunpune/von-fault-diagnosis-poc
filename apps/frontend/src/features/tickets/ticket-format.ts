// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The words and the order the ticket views share: the tickets table, the ticket sheet and the
// review queue say a status, a verdict and an update count the same way, and list tickets in the
// same order. Every enum keeps an `other` branch: a status or a verdict a newer contract adds
// reads as its own text (packages/contracts/VERSIONING.md).

import type { Ticket, TicketStatusFilter, TicketVerdict } from "@/api/types";
import { parseIso } from "@/lib/time";

export type TicketStatus = Ticket["status"];

const STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  review: "review",
  open: "open",
  resolved: "resolved",
  closed: "closed",
};

const VERDICT_LABELS: Readonly<Record<TicketVerdict, string>> = {
  correct: "correct",
  wrong: "wrong",
};

function isKnown<K extends string>(labels: Readonly<Record<K, string>>, key: string): key is K {
  return Object.hasOwn(labels, key);
}

/** The word a status badge shows; a status this build does not know shows its own text. */
export function statusLabel(status: string): string {
  return isKnown(STATUS_LABELS, status) ? STATUS_LABELS[status] : status;
}

/** The word a verdict badge shows; a verdict this build does not know shows its own text. */
export function verdictLabel(verdict: string): string {
  return isKnown(VERDICT_LABELS, verdict) ? VERDICT_LABELS[verdict] : verdict;
}

/** `update_count` as the header and the review queue say it: "updated 3×", or "no updates". */
export function updatesLabel(count: number): string {
  return count > 0 ? `updated ${count}×` : "no updates";
}

function updatedDesc(a: Ticket, b: Ticket): number {
  return parseIso(b.updated_sim_ts) - parseIso(a.updated_sim_ts);
}

/** Tickets with the most recently updated first (sim time), without touching the page. */
export function byUpdatedDesc(tickets: readonly Ticket[]): Ticket[] {
  return tickets.toSorted(updatedDesc);
}

/** The status filters of the tickets tab, in the order the toggle shows them. */
export const TICKET_FILTERS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const satisfies readonly { value: TicketStatusFilter; label: string }[];

export type TicketsTabFilter = (typeof TICKET_FILTERS)[number]["value"];

export function isTicketsTabFilter(value: string): value is TicketsTabFilter {
  return TICKET_FILTERS.some((filter) => filter.value === value);
}
