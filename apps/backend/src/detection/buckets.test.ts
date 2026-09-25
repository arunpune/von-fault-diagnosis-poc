// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Numbers become words.
 *
 * The boundary tables below are the whole point of the module: a value one
 * millibar either side of a percentile must land in the right word, because
 * that word is all the decision backend ever sees. The round trip matters for
 * the same reason — `decision/state.ts` reads back what detection wrote, so
 * the two must agree on every one of the 210 combinations.
 */

import { describe, expect, it } from "vitest";

import {
  FIRST_MONTH_ANALOG_BANDS,
  FIRST_MONTH_CYCLE_BANDS,
  SENSOR_ACCURACY,
  type BandedMode,
  type MeasuredAnalogRole,
} from "./baseline.ts";
import {
  AMBIENT_COLD_C,
  AMBIENT_HOT_C,
  AMBIENT_WARM_C,
  ambientBucket,
  bucketString,
  cycleLevel,
  DURATION_BOUNDARIES_S,
  duration,
  ERRATIC_BAND_WIDTHS,
  ERRATIC_TRANSITIONS,
  isAnalogRole,
  level,
  levelInBand,
  parseBucket,
  toContractLevel,
  toContractTrend,
  TREND_THRESHOLDS,
  trend,
} from "./buckets.ts";
import { SIGNAL_ROLES } from "./signals.ts";
import type { Duration, Level, Trend } from "./types.ts";

const LEVELS: readonly Level[] = [
  "far_below_normal",
  "below_normal",
  "normal",
  "above_normal",
  "far_above_normal",
];

const TRENDS: readonly Trend[] = [
  "rising_sharply",
  "rising",
  "flat",
  "falling",
  "falling_sharply",
  "stuck",
  "erratic",
];

const DURATIONS: readonly Duration[] = [
  "seconds",
  "minutes",
  "about_an_hour",
  "several_hours",
  "about_a_day",
  "days",
];

describe("levelInBand", () => {
  const band = { p1: 1, p5: 2, p50: 5, p95: 8, p99: 9 };

  it.each([
    [0.999, "far_below_normal"],
    [1, "below_normal"],
    [1.999, "below_normal"],
    [2, "normal"],
    [5, "normal"],
    [8, "normal"],
    [8.001, "above_normal"],
    [9, "above_normal"],
    [9.001, "far_above_normal"],
  ])("puts %s in %s", (value, expected) => {
    expect(levelInBand(band, value)).toBe(expected);
  });
});

describe("level", () => {
  it("reads an analog against the band of the state it was measured in", () => {
    const loaded = FIRST_MONTH_ANALOG_BANDS.tp3.loaded;
    expect(level("tp3", "loaded", loaded.p50)).toBe("normal");
    expect(level("tp3", "loaded", loaded.p1 - 2 * SENSOR_ACCURACY.tp3)).toBe("far_below_normal");
    // The same pressure is normal loaded and low for a machine running on.
    expect(level("tp3", "unloaded", loaded.p5)).toBe("far_below_normal");
  });

  it("says nothing when the state is unknown", () => {
    expect(level("tp3", "unknown", 0)).toBe("normal");
    expect(level("lps", "unknown", 1)).toBe("normal");
  });

  it("reads a digital off how often the first month showed that value", () => {
    // The low-pressure switch was on in one row of the whole month.
    expect(level("lps", "loaded", 1)).toBe("far_above_normal");
    expect(level("lps", "loaded", 0)).toBe("normal");
    // The dryer pulses its tower over during every loaded run, so both values
    // are ordinary there and only there.
    expect(level("towers", "loaded", 0)).toBe("normal");
    expect(level("towers", "loaded", 1)).toBe("normal");
    expect(level("towers", "off", 0)).toBe("far_below_normal");
    // The oil level never read low in the first month.
    expect(level("oil_level", "loaded", 0)).toBe("far_below_normal");
    expect(level("oil_level", "loaded", 1)).toBe("normal");
  });

  it("reads the synthetic ambient temperature off its own boundaries", () => {
    expect(level("ambient_temperature", "off", AMBIENT_COLD_C - 1)).toBe("below_normal");
    expect(level("ambient_temperature", "off", 18)).toBe("normal");
    expect(level("ambient_temperature", "off", AMBIENT_WARM_C + 1)).toBe("above_normal");
    expect(level("ambient_temperature", "off", AMBIENT_HOT_C + 1)).toBe("far_above_normal");
  });

  it("knows which roles are numbers", () => {
    expect(SIGNAL_ROLES.filter((role) => isAnalogRole(role))).toHaveLength(8);
    expect(isAnalogRole("tp3")).toBe(true);
    expect(isAnalogRole("lps")).toBe(false);
  });
});

describe("the instrument-accuracy floor", () => {
  const modes: readonly BandedMode[] = ["loaded", "unloaded", "off"];
  const measured = Object.keys(FIRST_MONTH_ANALOG_BANDS) as MeasuredAnalogRole[];
  /** Every measured analog role in every state, each with its band and accuracy. */
  const cases = measured.flatMap((role) =>
    modes.map((mode) => ({
      role,
      mode,
      band: FIRST_MONTH_ANALOG_BANDS[role][mode],
      accuracy: SENSOR_ACCURACY[role],
    })),
  );

  it.each(cases)(
    "reads $role $mode half an accuracy unit outside p5…p95 as normal",
    ({ role, mode, band, accuracy }) => {
      expect(level(role, mode, band.p95 + 0.5 * accuracy)).toBe("normal");
      expect(level(role, mode, band.p5 - 0.5 * accuracy)).toBe("normal");
    },
  );

  it.each(cases)(
    "reads $role $mode two accuracy units past p99 or p1 as far from normal",
    ({ role, mode, band, accuracy }) => {
      expect(level(role, mode, band.p99 + 2 * accuracy)).toBe("far_above_normal");
      expect(level(role, mode, band.p1 - 2 * accuracy)).toBe("far_below_normal");
    },
  );

  it.each(cases)(
    "never calls a $role $mode spread of half an accuracy unit erratic",
    ({ role, mode, accuracy }) => {
      expect(trend(role, 0, { mode, stdDev: 0.5 * accuracy })).toBe("flat");
    },
  );

  it("moves every edge of the band outwards by exactly one accuracy unit", () => {
    const band = FIRST_MONTH_ANALOG_BANDS.dv_pressure.loaded;
    const accuracy = SENSOR_ACCURACY.dv_pressure;
    // A tenth of a millibar, well inside the 2 mbar between p95 and p99.
    const step = 1e-4;
    expect(level("dv_pressure", "loaded", band.p95 + accuracy)).toBe("normal");
    expect(level("dv_pressure", "loaded", band.p95 + accuracy + step)).toBe("above_normal");
    expect(level("dv_pressure", "loaded", band.p99 + accuracy)).toBe("above_normal");
    expect(level("dv_pressure", "loaded", band.p99 + accuracy + step)).toBe("far_above_normal");
    expect(level("dv_pressure", "loaded", band.p5 - accuracy)).toBe("normal");
    expect(level("dv_pressure", "loaded", band.p5 - accuracy - step)).toBe("below_normal");
    expect(level("dv_pressure", "loaded", band.p1 - accuracy)).toBe("below_normal");
    expect(level("dv_pressure", "loaded", band.p1 - accuracy - step)).toBe("far_below_normal");
  });

  it("stops a band narrower than its sensor from reading noise as a deviation", () => {
    // The dryer purge pressure spans 8 mbar; its transducer resolves 85 mbar.
    const band = FIRST_MONTH_ANALOG_BANDS.dv_pressure.loaded;
    const reading = band.p95 + 0.5 * SENSOR_ACCURACY.dv_pressure;
    expect(levelInBand(band, reading)).toBe("far_above_normal");
    expect(level("dv_pressure", "loaded", reading)).toBe("normal");
    // The same holds for the motor current at rest, 5 mA wide against 0.4 A.
    const rest = FIRST_MONTH_ANALOG_BANDS.motor_current.off;
    const idle = rest.p99 + 0.5 * SENSOR_ACCURACY.motor_current;
    expect(levelInBand(rest, idle)).toBe("far_above_normal");
    expect(level("motor_current", "off", idle)).toBe("normal");
  });

  it("calls a spread erratic only once it is wider than the sensor resolves", () => {
    const band = FIRST_MONTH_ANALOG_BANDS.dv_pressure.loaded;
    const accuracy = SENSOR_ACCURACY.dv_pressure;
    // Three band widths are 24 mbar, below the 85 mbar the transducer resolves.
    expect(ERRATIC_BAND_WIDTHS * (band.p95 - band.p5)).toBeLessThan(accuracy);
    expect(trend("dv_pressure", 0, { mode: "loaded", stdDev: accuracy })).toBe("flat");
    expect(trend("dv_pressure", 0, { mode: "loaded", stdDev: 2 * accuracy })).toBe("erratic");
    expect(
      trend("motor_current", 0, { mode: "off", stdDev: 0.5 * SENSOR_ACCURACY.motor_current }),
    ).toBe("flat");
    expect(
      trend("motor_current", 0, { mode: "off", stdDev: 2 * SENSOR_ACCURACY.motor_current }),
    ).toBe("erratic");
  });

  it("leaves the behaviour levels on their raw first-month bands", () => {
    const peak = FIRST_MONTH_CYCLE_BANDS.start_current_peak;
    const half = 0.5 * SENSOR_ACCURACY.motor_current;
    expect(cycleLevel("start_current_peak", peak.p95 + half)).toBe("above_normal");
    expect(cycleLevel("start_current_peak", peak.p99 + half)).toBe("far_above_normal");
  });

  it("leaves the ambient Level on its fixed boundaries", () => {
    const half = 0.5 * SENSOR_ACCURACY.ambient_temperature;
    expect(level("ambient_temperature", "off", AMBIENT_COLD_C - half)).toBe("below_normal");
    expect(level("ambient_temperature", "off", AMBIENT_WARM_C + half)).toBe("above_normal");
    expect(level("ambient_temperature", "off", AMBIENT_HOT_C + half)).toBe("far_above_normal");
  });
});

describe("cycleLevel", () => {
  it("reads a cycle metric against its first-month band", () => {
    expect(cycleLevel("loaded_s", 109)).toBe("normal");
    expect(cycleLevel("loaded_s", 320)).toBe("far_above_normal");
    expect(cycleLevel("decay_bar_per_min", 0.069)).toBe("normal");
    expect(cycleLevel("decay_bar_per_min", 0.45)).toBe("far_above_normal");
    expect(cycleLevel("cycles_per_hour", 6)).toBe("far_above_normal");
  });
});

describe("trend", () => {
  it("is flat inside the moving threshold of its kind", () => {
    expect(trend("tp3", TREND_THRESHOLDS.pressure.move - 0.001)).toBe("flat");
    expect(trend("tp3", -(TREND_THRESHOLDS.pressure.move - 0.001))).toBe("flat");
    expect(trend("oil_temperature", TREND_THRESHOLDS.temperature.move - 0.1)).toBe("flat");
    expect(trend("motor_current", TREND_THRESHOLDS.current.move - 0.01)).toBe("flat");
  });

  it("rises and falls outside it, sharply past the second threshold", () => {
    expect(trend("tp3", TREND_THRESHOLDS.pressure.move)).toBe("rising");
    expect(trend("tp3", -TREND_THRESHOLDS.pressure.move)).toBe("falling");
    expect(trend("tp3", TREND_THRESHOLDS.pressure.sharp)).toBe("rising_sharply");
    expect(trend("tp3", -TREND_THRESHOLDS.pressure.sharp)).toBe("falling_sharply");
    expect(trend("oil_temperature", TREND_THRESHOLDS.temperature.sharp)).toBe("rising_sharply");
    expect(trend("motor_current", -TREND_THRESHOLDS.current.sharp)).toBe("falling_sharply");
  });

  it("is stuck under the frozen guard, whatever the slope says", () => {
    expect(trend("tp3", 5, { frozen: true })).toBe("stuck");
    expect(trend("lps", 1, { frozen: true })).toBe("stuck");
  });

  it("is erratic when the spread is wider than three band widths", () => {
    const band = FIRST_MONTH_ANALOG_BANDS.tp3.loaded;
    const width = band.p95 - band.p5;
    expect(trend("tp3", 0, { mode: "loaded", stdDev: ERRATIC_BAND_WIDTHS * width + 0.1 })).toBe(
      "erratic",
    );
    expect(trend("tp3", 0, { mode: "loaded", stdDev: ERRATIC_BAND_WIDTHS * width - 0.1 })).toBe(
      "flat",
    );
    // Without a state there is no band, so there is nothing to compare with.
    expect(trend("tp3", 0, { stdDev: 100 })).toBe("flat");
    expect(trend("ambient_temperature", 0, { mode: "off", stdDev: 100 })).toBe("flat");
  });

  it("reads a digital as a move in the direction it changed", () => {
    expect(trend("lps", 0)).toBe("flat");
    expect(trend("lps", 0.5)).toBe("rising");
    expect(trend("lps", -0.5)).toBe("falling");
    expect(trend("lps", 0.5, { transitions: ERRATIC_TRANSITIONS - 1 })).toBe("rising");
    expect(trend("lps", 0.5, { transitions: ERRATIC_TRANSITIONS })).toBe("erratic");
  });
});

describe("duration", () => {
  const [minute, halfHour, twoHours, twelveHours, dayAndAHalf] = DURATION_BOUNDARIES_S;

  it.each([
    [0, "seconds"],
    [(minute - 1) * 1000, "seconds"],
    [minute * 1000, "minutes"],
    [(halfHour - 1) * 1000, "minutes"],
    [halfHour * 1000, "about_an_hour"],
    [(twoHours - 1) * 1000, "about_an_hour"],
    [twoHours * 1000, "several_hours"],
    [(twelveHours - 1) * 1000, "several_hours"],
    [twelveHours * 1000, "about_a_day"],
    [(dayAndAHalf - 1) * 1000, "about_a_day"],
    [dayAndAHalf * 1000, "days"],
  ])("puts %s ms in %s", (ms, expected) => {
    expect(duration(ms)).toBe(expected);
  });

  it("treats a negative elapsed time as no time at all", () => {
    expect(duration(-5000)).toBe("seconds");
  });
});

describe("ambientBucket", () => {
  it.each([
    [undefined, "unknown"],
    [Number.NaN, "unknown"],
    [AMBIENT_COLD_C - 0.1, "cold"],
    [AMBIENT_COLD_C, "mild"],
    [AMBIENT_WARM_C, "mild"],
    [AMBIENT_WARM_C + 0.1, "warm"],
    [AMBIENT_HOT_C, "warm"],
    [AMBIENT_HOT_C + 0.1, "hot"],
  ])("puts %s °C in %s", (celsius, expected) => {
    expect(ambientBucket(celsius)).toBe(expected);
  });
});

describe("the bucket sentence", () => {
  it("joins the three words with semicolons and no underscores", () => {
    expect(bucketString("far_above_normal", "flat", "about_an_hour")).toBe(
      "far above normal; flat; about an hour",
    );
  });

  it("round trips every combination", () => {
    for (const levelWord of LEVELS) {
      for (const trendWord of TRENDS) {
        for (const since of DURATIONS) {
          const text = bucketString(levelWord, trendWord, since);
          expect(text).not.toMatch(/[_0-9]/);
          expect(parseBucket(text)).toEqual({
            level: levelWord,
            trend: trendWord,
            since,
          });
        }
      }
    }
  });

  it("tolerates the spacing a message may have travelled with", () => {
    expect(parseBucket("normal;flat;seconds")).toEqual({
      level: "normal",
      trend: "flat",
      since: "seconds",
    });
  });

  it("refuses anything it did not write", () => {
    expect(() => parseBucket("normal; flat")).toThrow(/is not "<level>; <trend>; <since>"/);
    expect(() => parseBucket("ordinary; flat; seconds")).toThrow(/"ordinary" is not a level/);
    expect(() => parseBucket("normal; wobbling; seconds")).toThrow(/is not a trend/);
    expect(() => parseBucket("normal; flat; a while")).toThrow(/is not a duration/);
    expect(() => parseBucket("far_above_normal; flat; seconds")).toThrow(/is not a level/);
  });
});

describe("narrowing to the contract enums", () => {
  it("keeps five levels and folds the two sharp trends into their direction", () => {
    expect(LEVELS.map((value) => toContractLevel(value))).toEqual([
      "far_below",
      "below",
      "normal",
      "above",
      "far_above",
    ]);
    expect(TRENDS.map((value) => toContractTrend(value))).toEqual([
      "rising",
      "rising",
      "flat",
      "falling",
      "falling",
      "stuck",
      "erratic",
    ]);
  });
});
