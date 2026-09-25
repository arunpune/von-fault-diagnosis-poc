// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The synthetic ambient temperature.
 *
 * The recording has no ambient column, so the simulator adds one and publishes
 * it as `values.ambient_temperature` like any other tag. A fixture built here
 * has to carry the same number the simulator would have published for the same
 * instant, or a detection test would see an ambient the running stack never
 * shows.
 *
 *     ambient(t) = 15 + 7·sin(2π·(doy(t) − 105)/365)
 *                     + 4·sin(2π·(hour(t) − 9)/24)
 *                     + n(t)   °C
 *
 * `n(t)` is a hash of the instant rather than a draw from a generator, so there
 * is no state to seed and the same instant always yields the same value. This
 * is a port of `services/modbus/internal/sim/ambient.go`; `ambient.test.ts`
 * pins it against values printed by that implementation.
 */

const MEAN_C = 15;
const SEASONAL_AMPLITUDE_C = 7;
const SEASONAL_PEAK_DOY = 105;
const DAYS_PER_YEAR = 365;
const DIURNAL_AMPLITUDE_C = 4;
const DIURNAL_ZERO_HOUR = 9;
const HOURS_PER_DAY = 24;

/** Half-width of the deterministic noise term, in °C. */
export const AMBIENT_NOISE_C = 0.3;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const FNV_OFFSET_BASIS = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const UINT64_MASK = (1n << 64n) - 1n;

/** The 1-based day of the year of an epoch-millisecond instant read as UTC. */
function dayOfYear(simTsMs: number): number {
  const instant = new Date(simTsMs);
  const startOfYear = Date.UTC(instant.getUTCFullYear(), 0, 1);
  const startOfDay = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
  );
  return Math.round((startOfDay - startOfYear) / MS_PER_DAY) + 1;
}

/** FNV-1a over the eight big-endian bytes of `value`. */
function fnv1a64(value: bigint): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    hash ^= (value >> shift) & 0xffn;
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash;
}

/** The hash of the instant, mapped uniformly onto [−AMBIENT_NOISE_C, +AMBIENT_NOISE_C]. */
function ambientNoise(simTsMs: number): number {
  // The top 53 bits of the hash are as many bits as a float64 mantissa holds,
  // so the quotient is a uniform value in [0, 1).
  const unit = Number(fnv1a64(BigInt(simTsMs)) >> 11n) / 2 ** 53;
  return (2 * unit - 1) * AMBIENT_NOISE_C;
}

/** The ambient temperature in °C the simulator would publish for `simTsMs`. */
export function ambientC(simTsMs: number): number {
  const seasonal =
    SEASONAL_AMPLITUDE_C *
    Math.sin((2 * Math.PI * (dayOfYear(simTsMs) - SEASONAL_PEAK_DOY)) / DAYS_PER_YEAR);
  const hour = (simTsMs % MS_PER_DAY) / MS_PER_HOUR;
  const diurnal =
    DIURNAL_AMPLITUDE_C * Math.sin((2 * Math.PI * (hour - DIURNAL_ZERO_HOUR)) / HOURS_PER_DAY);
  return MEAN_C + seasonal + diurnal + ambientNoise(simTsMs);
}
