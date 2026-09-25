// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * How long each symptom's evidence has held without a break.
 *
 * A review item or a ticket may be created for an episode only once the
 * evidence behind it has persisted for `GATE_PERSIST_SIM_MIN` sim minutes: the
 * alarm on-delay of industrial practice, applied to the ticket rather than to
 * detection. Detection is not touched. Its rules keep their thresholds, holds
 * and clear timers, and a one-minute blip still raises its suspect event; what
 * changes is that nothing a technician has to act on is opened on it.
 *
 * "Persisted" is measured as **continuous firing of the symptom key**, and the
 * run starts where detection says it does:
 *
 *   * a run begins at the earliest `since_sim_ts` of the rules firing under the
 *     key. That instant is when the rule's condition first held, so a rule
 *     that already waited out a hold of its own (half an hour for
 *     `oil_temperature_high`) brings that time with it and is not delayed a
 *     second time;
 *   * the run goes on for as long as at least one rule of the key is firing on
 *     every sample. Detection's own clear timers decide what counts as firing,
 *     so a rule's hysteresis bridges exactly the gaps it was written to bridge
 *     and no other;
 *   * the run ends on the first sample without the key, and on a reset: a
 *     discontinuity, a guard, a stale frame. The next run starts from zero.
 *
 * The clock is kept per symptom key, not per episode. One episode is open per
 * key, and a key's evidence is the same fact whichever episode it lands on.
 *
 * Like the episode manager's last-firing instants it lives in memory only: it
 * records what detection saw, which a rejected push does not undo, and a
 * restarted backend starts it from nothing because detection starts over too.
 */

import { simMinutesBetween } from "@fdp/contracts";

/** The part of a detection rule hit the clock reads (`RuleHit`). */
export interface EvidenceHit {
  readonly symptom_key: string;
  /** When the rule's condition first held, hold included; `iso_ts`. */
  readonly since_sim_ts: string;
}

/** The uninterrupted run of evidence of every symptom key that is firing. */
export interface EvidenceClock {
  /**
   * Fold in what detection reports as firing after one sample.
   *
   * Every sample, not only a new frame: a reset clears detection's rules
   * between frames, and a key missing from one report ends its run.
   */
  observe(hits: readonly EvidenceHit[]): void;
  /** When the key's current run began, or `undefined` while the key is not firing. */
  since(symptomKey: string): string | undefined;
  /** Sim minutes the key's current run has lasted at `simTs`; 0 while it is not firing. */
  persistedSimMin(symptomKey: string, simTs: string): number;
  /** Forget every run: the windows behind them no longer mean anything. */
  reset(): void;
}

/**
 * The earlier of two `iso_ts` instants.
 *
 * Both are `iso_ts` strings, whose fixed width makes string order time order.
 */
function earlier(a: string, b: string | undefined): string {
  return b !== undefined && b < a ? b : a;
}

/** An empty evidence clock. */
export function createEvidenceClock(): EvidenceClock {
  const runs = new Map<string, string>();

  return {
    observe(hits) {
      const firing = new Map<string, string>();
      for (const hit of hits) {
        firing.set(hit.symptom_key, earlier(hit.since_sim_ts, firing.get(hit.symptom_key)));
      }
      for (const key of [...runs.keys()]) {
        if (!firing.has(key)) runs.delete(key);
      }
      for (const [key, since] of firing) {
        // A key that was already firing keeps the start of its run: two rules
        // under one key that overlap are one uninterrupted stretch of evidence,
        // even when the one that started it has stopped.
        runs.set(key, earlier(since, runs.get(key)));
      }
    },

    since(symptomKey) {
      return runs.get(symptomKey);
    },

    persistedSimMin(symptomKey, simTs) {
      const since = runs.get(symptomKey);
      if (since === undefined) return 0;
      return Math.max(0, simMinutesBetween(since, simTs));
    },

    reset() {
      runs.clear();
    },
  };
}
