// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The replay speeds the slider offers: simulated seconds per wall second, from real time to one
// hour per second, the bounds the simulator accepts. The slider moves over the positions of
// this list, so each step is a speed worth choosing and a drag from 1× to 3600× takes twelve
// positions instead of 3600.

export const SPEED_STEPS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const;

/** The speed the README tour starts at; the slider rests here until the first status. */
export const DEFAULT_SPEED = 600;

/** The speed at a slider position, clamped to the list. */
export function speedAt(index: number): number {
  const position = Math.min(Math.max(Math.round(index), 0), SPEED_STEPS.length - 1);
  // The clamp keeps the position inside the list; the fallback only satisfies the index type.
  return SPEED_STEPS[position] ?? DEFAULT_SPEED;
}

/**
 * The slider position closest to `speed` on a log scale, so a speed set elsewhere (450× from a
 * script) still puts the thumb where it reads right: between 300× and 600×, nearer 600×.
 */
export function nearestSpeedIndex(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) {
    return 0;
  }
  const target = Math.log(speed);
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  SPEED_STEPS.forEach((step, index) => {
    const distance = Math.abs(Math.log(step) - target);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
}
