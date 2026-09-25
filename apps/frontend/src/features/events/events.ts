// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Which decision answers a suspect event. A decision names its event by `event_id`; an event
// that kept firing may have been decided more than once, and the Events tab opens the latest of
// those. Built once per decisions list as a map, so each row is one lookup instead of a scan of
// the list.

import type { Decision } from "@/api/types";
import { parseIso } from "@/lib/time";

/** Wall time in epoch ms; a decision without a readable time loses to any other. */
function decidedAt(decision: Decision): number {
  const ms = parseIso(decision.wall_ts);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * The latest decision of each suspect event, keyed by `event_id`, by wall time. On a tie the
 * decision listed first wins: the decisions list is newest first.
 */
export function latestDecisionByEvent(decisions: readonly Decision[]): Map<string, Decision> {
  const latest = new Map<string, Decision>();
  for (const decision of decisions) {
    const held = latest.get(decision.event_id);
    if (held === undefined || decidedAt(decision) > decidedAt(held)) {
      latest.set(decision.event_id, decision);
    }
  }
  return latest;
}
