// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ambientC, AMBIENT_NOISE_C } from "./ambient.ts";

/**
 * Values printed by `services/modbus/internal/sim`'s own `Ambient`, so this
 * port and the simulator publish the same number for the same instant. If the
 * simulator's model ever changes, this table is what says so.
 */
const FROM_THE_SIMULATOR: readonly (readonly [string, number, number])[] = [
  ["2020-02-01T00:00:00.000Z", 1_580_515_200_000, 5.369204679892],
  ["2020-02-02T00:00:00.000Z", 1_580_601_600_000, 5.70168235974],
  ["2020-06-05T08:00:00.000Z", 1_591_344_000_000, 19.552417814391],
  ["2020-07-05T00:00:00.000Z", 1_593_907_200_000, 18.942890670569],
  ["2020-05-19T22:02:00.000Z", 1_589_925_720_000, 17.827430400295],
  ["2020-06-22T13:20:00.000Z", 1_592_832_000_000, 25.239959900919],
];

describe("ambientC", () => {
  it("agrees with the simulator to the printed precision", () => {
    for (const [label, ms, expected] of FROM_THE_SIMULATOR) {
      expect(Date.parse(label)).toBe(ms);
      expect(ambientC(ms)).toBeCloseTo(expected, 9);
    }
  });

  it("is a pure function of the instant", () => {
    const ms = Date.parse("2020-06-05T09:49:00.000Z");
    expect(ambientC(ms)).toBe(ambientC(ms));
  });

  it("is colder in February than in August, and colder at night than in the afternoon", () => {
    const february = ambientC(Date.parse("2020-02-15T12:00:00.000Z"));
    const august = ambientC(Date.parse("2020-08-15T12:00:00.000Z"));
    expect(february).toBeLessThan(august);

    const night = ambientC(Date.parse("2020-06-15T03:00:00.000Z"));
    const afternoon = ambientC(Date.parse("2020-06-15T15:00:00.000Z"));
    expect(night).toBeLessThan(afternoon);
  });

  it("keeps the noise term inside its declared half-width", () => {
    let widest = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const ms = Date.parse("2020-03-01T00:00:00.000Z") + index * 10_000;
      const smooth = (ambientC(ms - 1) + ambientC(ms + 1)) / 2;
      widest = Math.max(widest, Math.abs(ambientC(ms) - smooth));
    }
    expect(widest).toBeLessThanOrEqual(2 * AMBIENT_NOISE_C);
  });
});
