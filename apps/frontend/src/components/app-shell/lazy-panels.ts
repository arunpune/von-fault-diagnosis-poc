// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The regions the first paint does not need, each in its own chunk: the decision and ticket
// sheets and the Review, Events and Cost tabs. They are imported from fixed paths, so the
// features change the files and never touch App.tsx. Whatever opens one — a tab trigger here,
// an alert item or a table row in a feature — calls its `preload()` on hover or focus.

import { lazyWithPreload } from "@/lib/lazy";

export const LazyDecisionSheet = lazyWithPreload(
  () => import("@/features/decisions/DecisionSheet"),
);

export const LazyTicketSheet = lazyWithPreload(() => import("@/features/tickets/TicketSheet"));

export const LazyReviewTab = lazyWithPreload(() => import("@/features/review/ReviewTab"));

export const LazyEventsTab = lazyWithPreload(() => import("@/features/events/EventsTab"));

export const LazyCostTab = lazyWithPreload(() => import("@/features/cost/CostTab"));
