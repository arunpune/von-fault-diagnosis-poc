// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The only arithmetic `src/metrics` does on instants.
//
// `src/time.ts` already answers these questions for the rest of the harness,
// but it reaches into `@fdp/contracts` for the message clock, and the metrics
// library is defined as plain data in, plain data out: nothing outside node
// builtins and this package's own types. Two lines of millisecond arithmetic
// are cheaper than a dependency that would make the purity test a judgement
// call.
//
// Minutes are never rounded. A lead time of 12.5 minutes is a real number, and
// rounding it here would move the decision about presentation into the metric.

/** Milliseconds in one minute, the unit every lead time and latency is reported in. */
export const MS_PER_MINUTE = 60_000;

/** Milliseconds in one machine-day, the unit `coveredMachineDays` reports. */
export const MS_PER_DAY = 86_400_000;

/**
 * Minutes from `from` to `to`, negative when `to` is earlier and never rounded.
 *
 * @throws RangeError when either instant is invalid, because a `NaN` would travel silently
 * through every aggregate that touches it.
 */
export function minutesBetween(from: Date, to: Date): number {
  return millisecondsBetween(from, to) / MS_PER_MINUTE;
}

/**
 * Milliseconds from `from` to `to`, negative when `to` is earlier.
 *
 * @throws RangeError when either instant is invalid.
 */
export function millisecondsBetween(from: Date, to: Date): number {
  return instant(to, "to") - instant(from, "from");
}

/**
 * The epoch milliseconds of a Date, rejecting the invalid one.
 *
 * Every comparison in this library goes through it, so a malformed fixture fails where it is
 * read instead of turning one window boundary into `NaN` and every comparison into `false`.
 *
 * @throws RangeError when the Date names no instant.
 */
export function instant(value: Date, what: string): number {
  const milliseconds = value.getTime();
  if (Number.isNaN(milliseconds)) throw new RangeError(`${what} is not a valid instant`);
  return milliseconds;
}
