// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * One knob for every wall-clock bound in the test suites.
 *
 * A container start, a broker round trip and a shutdown all take longer on a
 * loaded CI runner than on a laptop, and a fixed timeout there is a flaky test.
 * `FDP_TIMING_SLACK` multiplies every such bound: 1 locally, 3 in CI.
 *
 * It never multiplies an assertion about the data — only about how long the
 * test is willing to wait.
 */

import process from "node:process";

/** The multiplier, read from the environment; 1 when unset or unusable. */
export function timingSlack(): number {
  const raw = process.env.FDP_TIMING_SLACK;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** `ms` stretched by the slack factor, rounded up to whole milliseconds. */
export function withSlack(ms: number): number {
  return Math.ceil(ms * timingSlack());
}
