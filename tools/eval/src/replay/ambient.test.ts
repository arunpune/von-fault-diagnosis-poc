// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The synthetic ambient model (docs/simulation.md).
//
// Two things are worth proving here and neither needs the simulator. The first
// is that the day-of-year arithmetic — written out rather than delegated to
// `Date` so it matches the Go model by construction — really is the day of the
// year, leap years included; the test compares it with `Date` over four years
// of daily instants, which is the implementation it replaced. The second is
// that the model is a pure function of the instant, with the simulator's
// shape: mean 15 °C, a seasonal term crossing that mean going up on day
// 105 and a diurnal term peaking at 15:00 UTC.

import { describe, expect, it } from "vitest";

import {
  AMBIENT_DIURNAL_AMPLITUDE_C,
  AMBIENT_MEAN_C,
  AMBIENT_SEASONAL_AMPLITUDE_C,
  AMBIENT_SEASONAL_PEAK_DOY,
  ambient,
  dayOfYear,
  hourOfDay,
} from "./ambient.ts";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** The day of the year through `Date`, which is what the arithmetic above must reproduce. */
function dayOfYearByDate(simTsMs: number): number {
  const instant = new Date(simTsMs);
  const yearStart = Date.UTC(instant.getUTCFullYear(), 0, 1);
  return Math.floor((simTsMs - yearStart) / MS_PER_DAY) + 1;
}

function utc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

describe("dayOfYear", () => {
  it("agrees with Date over four years, leap day included", () => {
    const start = utc(2019, 1, 1);
    const days = 4 * 366;
    const disagreements: string[] = [];
    for (let day = 0; day < days; day += 1) {
      const instant = start + day * MS_PER_DAY + 13 * MS_PER_HOUR;
      const mine = dayOfYear(instant);
      const theirs = dayOfYearByDate(instant);
      if (mine !== theirs) {
        disagreements.push(`${new Date(instant).toISOString()}: ${mine} != ${theirs}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("numbers the days of a leap year to 366", () => {
    expect(dayOfYear(utc(2020, 1, 1))).toBe(1);
    expect(dayOfYear(utc(2020, 2, 29))).toBe(60);
    expect(dayOfYear(utc(2020, 3, 1))).toBe(61);
    expect(dayOfYear(utc(2020, 12, 31, 23, 59, 59))).toBe(366);
  });

  it("numbers the days of a common year to 365", () => {
    expect(dayOfYear(utc(2021, 3, 1))).toBe(60);
    expect(dayOfYear(utc(2021, 12, 31))).toBe(365);
  });
});

describe("hourOfDay", () => {
  it("is the fractional UTC hour", () => {
    expect(hourOfDay(utc(2020, 2, 1))).toBe(0);
    expect(hourOfDay(utc(2020, 2, 1, 6, 30))).toBe(6.5);
    expect(hourOfDay(utc(2020, 2, 1, 23, 59, 59))).toBeCloseTo(23.99972, 4);
  });
});

describe("ambient", () => {
  it("is the same number for the same instant, however often it is asked", () => {
    const instant = utc(2020, 6, 5, 7, 20);
    const first = ambient(instant);
    for (let repeat = 0; repeat < 5; repeat += 1) expect(ambient(instant)).toBe(first);
  });

  it("crosses the mean going up on day 105 and peaks a quarter of a year later", () => {
    // At the zero crossing the diurnal term is zero too, so what is left is the mean.
    const crossing =
      utc(2020, 1, 1) + (AMBIENT_SEASONAL_PEAK_DOY - 1) * MS_PER_DAY + 9 * MS_PER_HOUR;
    expect(ambient(crossing)).toBeCloseTo(AMBIENT_MEAN_C, 6);

    const peak = crossing + Math.round(365 / 4) * MS_PER_DAY;
    const trough = crossing + Math.round((3 * 365) / 4) * MS_PER_DAY;
    expect(ambient(peak)).toBeCloseTo(AMBIENT_MEAN_C + AMBIENT_SEASONAL_AMPLITUDE_C, 1);
    expect(ambient(trough)).toBeCloseTo(AMBIENT_MEAN_C - AMBIENT_SEASONAL_AMPLITUDE_C, 1);
  });

  it("peaks at 15:00 and bottoms at 03:00 UTC on a given day", () => {
    const day = utc(2020, 2, 1);
    const hours = Array.from({ length: 24 }, (_, hour) => ambient(day + hour * MS_PER_HOUR));
    const warmest = hours.indexOf(Math.max(...hours));
    const coldest = hours.indexOf(Math.min(...hours));
    expect(warmest).toBe(15);
    expect(coldest).toBe(3);
    expect(Math.max(...hours) - Math.min(...hours)).toBeCloseTo(2 * AMBIENT_DIURNAL_AMPLITUDE_C, 6);
  });

  it("puts a February day near 9 °C on the mean and an August day near 22 °C", () => {
    // The simulator's documentation states the two daily means to a whole degree; the
    // model's own numbers are 8.34 °C and 21.27 °C.
    const meanOf = (dayStart: number): number => {
      let total = 0;
      for (let hour = 0; hour < 24; hour += 1) total += ambient(dayStart + hour * MS_PER_HOUR);
      return total / 24;
    };
    expect(meanOf(utc(2020, 2, 1))).toBeCloseTo(8.34, 2);
    expect(meanOf(utc(2020, 8, 10))).toBeCloseTo(21.27, 2);
  });

  it("stays inside the amplitudes it is built from", () => {
    const span = AMBIENT_SEASONAL_AMPLITUDE_C + AMBIENT_DIURNAL_AMPLITUDE_C;
    const start = utc(2020, 2, 1);
    for (let step = 0; step < 2000; step += 1) {
      const value = ambient(start + step * 3 * MS_PER_HOUR);
      expect(value).toBeGreaterThanOrEqual(AMBIENT_MEAN_C - span);
      expect(value).toBeLessThanOrEqual(AMBIENT_MEAN_C + span);
    }
  });
});
