// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the controller itself said, as a stream of changes.
 *
 * Every sample carries the alarm codes that were active on that row, so the
 * interesting part is not the list but its edges: the sample where a code
 * appears is a `raised`, the sample where it disappears is a `cleared`. Those
 * rows are what `tools/eval` compares the diagnosis against — how long before
 * the controller's own alarm did the backend open a ticket — so they carry the
 * `seq` and the `sim_ts` of the sample that produced them and nothing derived.
 *
 * Transitions of one sample come back in ascending alarm-bit order, with codes
 * the register map does not declare after them in code order. The order is
 * fixed so that a replay writes the same rows twice.
 */

import { ALARMS } from "@fdp/contracts";

import type { AlarmTransition, DecodedSample } from "./types.ts";

export interface AlarmTracker {
  /** Diff this sample's alarms against the previous one. */
  push(sample: DecodedSample): AlarmTransition[];
  /** The codes active after the last sample, in the order they were declared. */
  active(): string[];
  /** Forget the active set; a replay that starts again raises everything again. */
  reset(): void;
}

/** The bit each declared alarm occupies, for the ordering of a sample's changes. */
const ALARM_ORDER: ReadonlyMap<string, number> = new Map(
  ALARMS.map((alarm) => [alarm.code, alarm.bit] as const),
);

/** The alarm differ. */
export function createAlarmTracker(): AlarmTracker {
  let previous = new Set<string>();

  return {
    push(sample: DecodedSample): AlarmTransition[] {
      const current = new Set(sample.alarms);
      const changed: string[] = [];
      for (const code of current) if (!previous.has(code)) changed.push(code);
      for (const code of previous) if (!current.has(code)) changed.push(code);
      previous = current;
      if (changed.length === 0) return [];

      changed.sort(byDeclaredOrder);
      return changed.map((code) => ({
        code,
        state: current.has(code) ? ("raised" as const) : ("cleared" as const),
        sim_ts: sample.simTs,
        seq: sample.seq,
      }));
    },

    active(): string[] {
      return [...previous].sort(byDeclaredOrder);
    },

    reset(): void {
      previous = new Set<string>();
    },
  };
}

/** Declared alarms first, in bit order; anything else after them, by code. */
function byDeclaredOrder(left: string, right: string): number {
  const a = ALARM_ORDER.get(left);
  const b = ALARM_ORDER.get(right);
  if (a !== undefined && b !== undefined) return a - b;
  if (a !== undefined) return -1;
  if (b !== undefined) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
