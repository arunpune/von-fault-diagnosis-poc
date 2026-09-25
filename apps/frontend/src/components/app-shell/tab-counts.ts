// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What each bottom tab shows beside its name: the open tickets, the review queue, the suspect
// events and the running cost. The counts come from the query layer, which reads the same
// caches the tabs render; a count that is not loaded yet is null, and the tab shows no badge
// rather than a wrong one.

import type { TabCounts } from "@/api/queries";

export { useTabCounts } from "@/api/queries";
export type { TabCounts } from "@/api/queries";

export const BOTTOM_TABS = [
  "tickets",
  "review",
  "events",
  "cost",
] as const satisfies readonly (keyof TabCounts)[];
export type BottomTab = (typeof BOTTOM_TABS)[number];
