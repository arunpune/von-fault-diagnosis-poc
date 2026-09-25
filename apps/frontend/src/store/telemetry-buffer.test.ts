// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { toSeries } from "@/api/endpoints";
import type { Sample, SeriesResponse, SignalDef, TelemetrySeries } from "@/api/types";
import { MACHINE_STATE } from "@/lib/machine-state";
import { toIsoMs } from "@/lib/time";
import {
  ALARMS_KEY,
  RING_CAPACITY,
  STATE_KEY,
  TelemetryBuffer,
  UNKNOWN_LEVEL,
} from "@/store/telemetry-buffer";
import { fixtures, frames } from "@/test/msw/fixtures";

const T0 = Date.parse("2020-06-05T09:00:00.000Z");
const SIGNALS = fixtures.signals.signals;

/** Epoch ms of `seconds` after T0. */
function at(seconds: number): number {
  return T0 + seconds * 1_000;
}

interface SampleOptions {
  discontinuity?: boolean;
  missing?: boolean;
  alarms?: string[];
}

/** A loaded-state sample of the signals.json tags at `seconds` after T0. */
function sample(
  seconds: number,
  values: Sample["values"] = {},
  { discontinuity = false, missing = false, alarms = [] }: SampleOptions = {},
): Sample {
  return {
    seq: seconds,
    sim_ts: toIsoMs(at(seconds)),
    flags: { discontinuity, missing },
    values: {
      line_pressure: 8 + seconds / 1_000,
      motor_current: 6.0,
      intake_closed: false,
      load_valve: true,
      low_pressure_switch: false,
      ...values,
    },
    alarms,
  };
}

function seriesFrame(
  points: Record<string, [number, number | null][]>,
  {
    discontinuity = false,
    last = {},
  }: { discontinuity?: boolean; last?: TelemetrySeries["last"] } = {},
): TelemetrySeries {
  const times = Object.values(points).flatMap((list) => list.map(([seconds]) => seconds));
  return {
    from_sim_ts: toIsoMs(at(Math.min(...times))),
    to_sim_ts: toIsoMs(at(Math.max(...times))),
    bucket_ms: 1_000,
    series: Object.entries(points).map(([tag, list]) => ({
      tag,
      points: list.map(([seconds, value]): [string, number | null] => [
        toIsoMs(at(seconds)),
        value,
      ]),
    })),
    last,
    discontinuity,
  };
}

function configured(capacity?: number): TelemetryBuffer {
  const buffer = new TelemetryBuffer({ capacity });
  buffer.configure(SIGNALS);
  return buffer;
}

function times(buffer: TelemetryBuffer, tag: string, from = -Infinity, to = Infinity): number[] {
  return Array.from(buffer.range(tag, from, to).t);
}

function values(buffer: TelemetryBuffer, tag: string, from = -Infinity, to = Infinity): number[] {
  return Array.from(buffer.range(tag, from, to).v);
}

describe("the analog rings", () => {
  it("keep the newest `capacity` points in order once they wrap around", () => {
    const buffer = configured(8);
    buffer.push(Array.from({ length: 20 }, (_, index) => sample(index * 10)));

    expect(times(buffer, "line_pressure")).toEqual(
      Array.from({ length: 8 }, (_, index) => at((12 + index) * 10)),
    );
    expect(buffer.latestSimTs()).toBe(at(190));
  });

  it("stay contiguous across many compactions", () => {
    const buffer = configured(16);
    for (let index = 0; index < 1_000; index += 1) {
      buffer.push([sample(index * 10, { line_pressure: index })]);
    }

    expect(values(buffer, "line_pressure")).toEqual(
      Array.from({ length: 16 }, (_, index) => 984 + index),
    );
    expect(RING_CAPACITY).toBe(65_536);
  });

  it("slice a window by binary search, both bounds inclusive", () => {
    const buffer = configured();
    buffer.push([0, 10, 20, 30, 40].map((seconds) => sample(seconds)));

    expect(times(buffer, "line_pressure", at(10), at(30))).toEqual([at(10), at(20), at(30)]);
    expect(times(buffer, "line_pressure", at(5), at(35))).toEqual([at(10), at(20), at(30)]);
    expect(times(buffer, "line_pressure", at(41), at(50))).toEqual([]);
    expect(times(buffer, "line_pressure", at(30), at(10))).toEqual([]);
    expect(times(buffer, "unknown_tag")).toEqual([]);
  });

  it("return views, not copies, of the ring", () => {
    const buffer = configured();
    buffer.push([sample(0), sample(10)]);

    const { t } = buffer.range("line_pressure", -Infinity, Infinity);

    expect(t.buffer.byteLength).toBeGreaterThan(t.byteLength);
  });

  it("store NaN for a sample flagged missing, and read the latest finite value", () => {
    const buffer = configured();
    buffer.push([sample(0, { line_pressure: 8.1 }), sample(10, {}, { missing: true })]);

    expect(values(buffer, "line_pressure")).toEqual([8.1, Number.NaN]);
    expect(buffer.latestValue("line_pressure")).toBe(8.1);
    expect(buffer.latestValue("unknown_tag")).toBeNull();
    expect(buffer.stateRange(-Infinity, Infinity).at(-1)?.[1]).toBe(MACHINE_STATE.unknown);
  });

  it("ignore samples at or before the newest point", () => {
    const buffer = configured();
    buffer.push([sample(10, { line_pressure: 1 })]);
    buffer.push([sample(10, { line_pressure: 2 }), sample(5, { line_pressure: 3 })]);

    expect(values(buffer, "line_pressure")).toEqual([1]);
  });
});

describe("discontinuities", () => {
  it("reset the buffer when data time goes back, as after a reset or a jump back", () => {
    const buffer = configured();
    buffer.push([0, 10, 20].map((seconds) => sample(seconds)));

    const result = buffer.push([sample(-3_600, { line_pressure: 7 }, { discontinuity: true })]);

    expect(result).toEqual({ discontinuity: true });
    expect(times(buffer, "line_pressure")).toEqual([at(-3_600)]);
    expect(buffer.latestSimTs()).toBe(at(-3_600));
  });

  it("break every line and row, keeping the history, when data time jumps forwards", () => {
    const buffer = configured();
    buffer.push([sample(0), sample(10)]);

    buffer.push([sample(610, { line_pressure: 9 }, { discontinuity: true })]);

    expect(times(buffer, "line_pressure")).toEqual([at(0), at(10), at(310), at(610)]);
    expect(values(buffer, "line_pressure")[2]).toBeNaN();
    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(310), MACHINE_STATE.unknown],
      [at(610), MACHINE_STATE.loaded],
    ]);
    expect(buffer.digitalRange("load_valve", -Infinity, Infinity)).toEqual([
      [at(0), 1],
      [at(310), UNKNOWN_LEVEL],
      [at(610), 1],
    ]);
  });

  it("start cleanly when the first sample ever carries the flag", () => {
    const buffer = configured();

    expect(buffer.push([sample(0, {}, { discontinuity: true })])).toEqual({ discontinuity: true });
    expect(times(buffer, "line_pressure")).toEqual([at(0)]);
  });
});

describe("digital, alarm and state rows", () => {
  it("record a digital only when its level changes", () => {
    const buffer = configured();
    buffer.push([
      sample(0, { low_pressure_switch: false }),
      sample(10, { low_pressure_switch: false }),
      sample(20, { low_pressure_switch: true }),
      sample(30, { low_pressure_switch: true }),
      sample(40, { low_pressure_switch: false }),
    ]);

    expect(buffer.digitalRange("low_pressure_switch", at(5), at(40))).toEqual([
      [at(5), 0],
      [at(20), 1],
      [at(40), 0],
    ]);
    expect(buffer.digitalRange("never_seen", at(0), at(40))).toEqual([]);
  });

  it("show a digital the registry marks inverted after inversion", () => {
    const buffer = new TelemetryBuffer();
    const inverted = (signal: SignalDef): SignalDef => {
      const polarised = { ...signal, digital_polarity: "inverted" };
      return polarised;
    };
    buffer.configure(
      SIGNALS.map((signal) =>
        signal.signal_id === "low_pressure_switch" ? inverted(signal) : signal,
      ),
    );
    buffer.push([sample(0, { low_pressure_switch: false })]);

    expect(buffer.digitalRange("low_pressure_switch", at(0), at(0))).toEqual([[at(0), 1]]);
  });

  it("derive the machine state at every sample, recording its changes", () => {
    const buffer = configured();
    buffer.push([
      sample(0, { intake_closed: false, load_valve: true, motor_current: 6.0 }),
      sample(10, { intake_closed: true, load_valve: false, motor_current: 3.77 }),
      sample(20, { intake_closed: true, load_valve: false, motor_current: 3.8 }),
      sample(30, { intake_closed: true, load_valve: false, motor_current: 0.038 }),
    ]);

    expect(buffer.stateRange(at(0), at(30))).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(10), MACHINE_STATE.unloaded],
      [at(30), MACHINE_STATE.off],
    ]);
  });

  it("keep no state row without the state inputs in the registry", () => {
    const buffer = new TelemetryBuffer();
    buffer.push([sample(0)]);

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([]);
  });

  it("track the active alarm codes from samples and from alarm.native", () => {
    const buffer = configured();
    buffer.push([sample(0), sample(10, {}, { alarms: ["W104", "W102"] }), sample(20)]);
    buffer.recordAlarm("W110", true, toIsoMs(at(25)));
    buffer.recordAlarm("W110", true, toIsoMs(at(26)));
    buffer.recordAlarm("W110", false, toIsoMs(at(30)));
    buffer.recordAlarm("W110", true, "not a time");

    expect(buffer.alarmRange(at(5), at(40))).toEqual([
      [at(5), []],
      [at(10), ["W102", "W104"]],
      [at(20), []],
      [at(25), ["W110"]],
      [at(30), []],
    ]);
  });
});

describe("telemetry.series frames", () => {
  it("append the decimated points of the fixture frame", () => {
    const buffer = configured();
    const frame = frames["telemetry.series"].payload;

    expect(buffer.push(frame)).toEqual({ discontinuity: false });

    expect(values(buffer, "line_pressure")).toEqual([8.29, 8.41, 8.31, 8.38]);
    expect(values(buffer, "oil_temperature")).toEqual([82.1, 82.6]);
    expect(buffer.digitalRange("load_valve", -Infinity, Infinity)).toEqual([
      [Date.parse("2020-06-05T09:41:10.000Z"), 1],
      [Date.parse("2020-06-05T09:41:11.400Z"), 0],
    ]);
    expect(buffer.latestSimTs()).toBe(Date.parse("2020-06-05T09:41:11.900Z"));
  });

  it("take a digital's level from `last` when the frame carries no transition for it", () => {
    const buffer = configured();
    buffer.push(
      seriesFrame(
        {
          motor_current: [
            [0, 6.0],
            [1, 6.1],
          ],
        },
        { last: { motor_current: 6.1, intake_closed: false, load_valve: true } },
      ),
    );

    expect(buffer.digitalRange("intake_closed", -Infinity, Infinity)).toEqual([[at(0), 0]]);
    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([[at(0), MACHINE_STATE.loaded]]);

    buffer.push(seriesFrame({ motor_current: [[2, 3.77]] }, { last: { intake_closed: true } }));
    expect(buffer.digitalRange("intake_closed", -Infinity, Infinity)).toEqual([[at(0), 0]]);
  });

  it("derive the state from the three inputs merged in time order", () => {
    const buffer = configured();
    buffer.push(
      seriesFrame({
        intake_closed: [
          [0, 0],
          [100, 1],
        ],
        load_valve: [
          [0, 1],
          [101, 0],
        ],
        motor_current: [
          [0, 6.0],
          [50, 6.2],
          [102, 3.77],
          [500, 0.04],
        ],
      }),
    );

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(100), MACHINE_STATE.unloaded],
      [at(500), MACHINE_STATE.off],
    ]);
  });

  it("reset for a frame whose data starts before the newest point", () => {
    const buffer = configured();
    buffer.push(
      seriesFrame({
        line_pressure: [
          [0, 8],
          [10, 9],
        ],
      }),
    );

    buffer.push(
      seriesFrame(
        {
          line_pressure: [
            [20, 9.5],
            [-500, 7],
            [-490, 7.1],
          ],
        },
        { discontinuity: true },
      ),
    );

    expect(times(buffer, "line_pressure")).toEqual([at(-500), at(-490)]);
  });

  it("break at the widest step of a frame that jumps forwards", () => {
    const buffer = configured();
    buffer.push(
      seriesFrame({
        line_pressure: [
          [0, 8],
          [10, 9],
        ],
      }),
    );

    buffer.push(
      seriesFrame(
        {
          line_pressure: [
            [20, 9.1],
            [30, 9.2],
            [630, 8.5],
          ],
          load_valve: [[640, 1]],
        },
        { discontinuity: true, last: { intake_closed: false } },
      ),
    );

    expect(times(buffer, "line_pressure")).toEqual([
      at(0),
      at(10),
      at(20),
      at(30),
      at(330),
      at(630),
    ]);
    expect(values(buffer, "line_pressure")[4]).toBeNaN();
    expect(buffer.digitalRange("intake_closed", -Infinity, Infinity)).toEqual([[at(630), 0]]);
  });

  it("change nothing for a frame with no points", () => {
    const buffer = configured();
    const empty = seriesFrame({ line_pressure: [[0, 8]] });
    empty.series = [];

    expect(buffer.push(empty)).toEqual({ discontinuity: false });
    expect(buffer.latestSimTs()).toBeNull();
  });
});

describe("seed", () => {
  function history(): SeriesResponse {
    return toSeries(fixtures.series["api-telemetry-series"]);
  }

  it("loads the history and breaks it at every listed discontinuity", () => {
    const buffer = configured();
    buffer.seed(history());

    const seeded = buffer.range("line_pressure", -Infinity, Infinity);
    expect(Array.from(seeded.t).map(toIsoMs)).toEqual([
      "2020-06-05T09:40:00.000Z",
      "2020-06-05T09:40:18.000Z",
      "2020-06-05T09:40:27.000Z",
      "2020-06-05T09:40:36.000Z",
      "2020-06-05T09:40:54.000Z",
      "2020-06-05T09:41:12.000Z",
    ]);
    expect(Array.from(seeded.v)).toEqual([9.12, 8.87, Number.NaN, Number.NaN, 8.51, 8.34]);
    expect(buffer.latestSimTs()).toBe(Date.parse("2020-06-05T09:41:12.000Z"));
    expect(
      buffer.digitalRange("load_valve", -Infinity, Infinity).map(([, level]) => level),
    ).toEqual([1, UNKNOWN_LEVEL, 0, 1]);
  });

  it("then appends live points after the history, ignoring older ones", () => {
    const buffer = configured();
    buffer.seed(history());

    // 09:41:00 is older than the seeded 09:41:12; 09:41:20 is newer.
    buffer.push(
      seriesFrame({
        line_pressure: [
          [2_460, 8.2],
          [2_480, 8.25],
        ],
      }),
    );
    buffer.push(frames["telemetry.series"].payload);

    expect(times(buffer, "line_pressure").slice(-2).map(toIsoMs)).toEqual([
      "2020-06-05T09:41:12.000Z",
      "2020-06-05T09:41:20.000Z",
    ]);
    expect(values(buffer, "line_pressure").slice(-2)).toEqual([8.34, 8.25]);
  });

  it("slides under live points, dropping what is older than the seeded window", () => {
    const buffer = configured();
    buffer.push([sample(-86_400 * 2, { line_pressure: 1 })]);
    buffer.push(seriesFrame({ line_pressure: [[2_460, 8.2]] }));

    buffer.seed(history());

    expect(values(buffer, "line_pressure")).toEqual([
      9.12,
      8.87,
      Number.NaN,
      Number.NaN,
      8.51,
      8.2,
    ]);
    expect(buffer.latestSimTs()).toBe(Date.parse("2020-06-05T09:41:12.000Z"));
  });

  it("keeps the live points the seed overlaps and takes only the older history", () => {
    const buffer = configured();
    buffer.push(seriesFrame({ line_pressure: [[2_418, 5]] }));

    buffer.seed(history());

    expect(times(buffer, "line_pressure").map(toIsoMs)).toEqual([
      "2020-06-05T09:40:00.000Z",
      "2020-06-05T09:40:18.000Z",
    ]);
    expect(values(buffer, "line_pressure")).toEqual([9.12, 5]);
  });

  it("derives the state history from the seeded inputs", () => {
    const buffer = configured();
    const point = (seconds: number, value: number): [string, number] => [
      toIsoMs(at(seconds)),
      value,
    ];
    buffer.seed({
      from: toIsoMs(at(0)),
      to: toIsoMs(at(300)),
      series: [
        { tag: "intake_closed", kind: "digital", unit: "", points: [point(0, 0), point(120, 1)] },
        { tag: "load_valve", kind: "digital", unit: "", points: [point(0, 1), point(120, 0)] },
        {
          tag: "motor_current",
          kind: "analog",
          unit: "A",
          points: [point(0, 6), point(120, 3.8), point(240, 0.04)],
        },
      ],
      discontinuities: [],
    });

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(120), MACHINE_STATE.unloaded],
      [at(240), MACHINE_STATE.off],
    ]);
  });

  it("ignores a history without a readable window", () => {
    const buffer = configured();
    buffer.seed({ ...history(), from: "not a time" });

    expect(buffer.latestSimTs()).toBeNull();
  });
});

describe("capacity", () => {
  it("grows the rings past their first allocation up to the full capacity", () => {
    const buffer = configured();
    buffer.push(
      Array.from({ length: 3_000 }, (_, index) => sample(index * 10, { line_pressure: index })),
    );

    const held = values(buffer, "line_pressure");
    expect(held).toHaveLength(3_000);
    expect(held[0]).toBe(0);
    expect(held.at(-1)).toBe(2_999);
  });

  it("drops the oldest transitions beyond the list capacity", () => {
    const buffer = new TelemetryBuffer({ transitionCapacity: 4 });
    buffer.configure(SIGNALS);
    buffer.push(
      Array.from({ length: 12 }, (_, index) =>
        sample(index * 10, { low_pressure_switch: index % 2 === 0 }),
      ),
    );

    const kept = buffer.digitalRange("low_pressure_switch", -Infinity, Infinity);
    expect(kept.length).toBeLessThanOrEqual(5);
    expect(kept.at(-1)).toEqual([at(110), 0]);
  });
});

describe("edge cases", () => {
  it("skip a sample whose time cannot be read", () => {
    const buffer = configured();
    buffer.push([{ ...sample(0), sim_ts: "not a time" }, sample(10)]);

    expect(times(buffer, "line_pressure")).toEqual([at(10)]);
  });

  it("start cleanly when the first frame ever carries the discontinuity flag", () => {
    const buffer = configured();

    buffer.push(seriesFrame({ line_pressure: [[0, 8]] }, { discontinuity: true }));

    expect(times(buffer, "line_pressure")).toEqual([at(0)]);
  });

  it("prime a digital from `last` at the frame's end when the frame has no points", () => {
    const buffer = configured();
    const quiet = seriesFrame({ line_pressure: [[30, 8]] }, { last: { load_valve: true } });
    quiet.series = [];

    buffer.push(quiet);

    expect(buffer.digitalRange("load_valve", -Infinity, Infinity)).toEqual([[at(30), 1]]);
  });

  it("seed without a state row when the registry is not known yet, reading kinds from the tracks", () => {
    const buffer = new TelemetryBuffer();
    buffer.seed(toSeries(fixtures.series["api-telemetry-series"]));

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([]);
    expect(buffer.digitalRange("load_valve", -Infinity, Infinity)).toHaveLength(4);
    expect(times(buffer, "load_valve")).toEqual([]);
  });

  it("break a seed at each of several discontinuities", () => {
    const buffer = configured();
    const point = (seconds: number, value: number): [string, number] => [
      toIsoMs(at(seconds)),
      value,
    ];
    buffer.seed({
      from: toIsoMs(at(0)),
      to: toIsoMs(at(100)),
      series: [
        {
          tag: "line_pressure",
          kind: "analog",
          unit: "bar",
          points: [point(0, 8), point(20, 8.2), point(40, 8.4), point(60, 8.6)],
        },
      ],
      discontinuities: [toIsoMs(at(40)), toIsoMs(at(20))],
    });

    expect(times(buffer, "line_pressure")).toEqual([at(0), at(10), at(20), at(30), at(40), at(60)]);
  });

  it("give the live feed the state inputs of the seeded history", () => {
    const buffer = configured();
    const point = (seconds: number, value: number): [string, number] => [
      toIsoMs(at(seconds)),
      value,
    ];
    buffer.seed({
      from: toIsoMs(at(0)),
      to: toIsoMs(at(60)),
      series: [
        { tag: "intake_closed", kind: "digital", unit: "", points: [point(0, 1)] },
        { tag: "load_valve", kind: "digital", unit: "", points: [point(0, 0)] },
        { tag: "motor_current", kind: "analog", unit: "A", points: [point(0, 3.77)] },
      ],
      discontinuities: [],
    });

    // The live frames carry no digital point while nothing changes: without the seeded inputs
    // the run-on and the stop that follow would read as unknown.
    buffer.push(
      seriesFrame({
        motor_current: [
          [70, 3.8],
          [80, 0.04],
        ],
      }),
    );

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([
      [at(0), MACHINE_STATE.unloaded],
      [at(80), MACHINE_STATE.off],
    ]);
  });

  it("take a state input from `last` once the registry arrives after the data", () => {
    const buffer = new TelemetryBuffer();
    buffer.push([sample(0)]);
    buffer.configure(SIGNALS);

    buffer.push(
      seriesFrame(
        { motor_current: [[10, 6]] },
        { last: { intake_closed: false, load_valve: true, motor_current: 6 } },
      ),
    );

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([[at(10), MACHINE_STATE.loaded]]);
  });

  it("keep the live state transitions a seed overlaps", () => {
    const buffer = configured();
    buffer.push([sample(60, { motor_current: 3.77, intake_closed: true, load_valve: false })]);
    const point = (seconds: number, value: number): [string, number] => [
      toIsoMs(at(seconds)),
      value,
    ];

    buffer.seed({
      from: toIsoMs(at(0)),
      to: toIsoMs(at(120)),
      series: [
        { tag: "intake_closed", kind: "digital", unit: "", points: [point(0, 0), point(90, 0)] },
        { tag: "load_valve", kind: "digital", unit: "", points: [point(0, 1)] },
        { tag: "motor_current", kind: "analog", unit: "A", points: [point(0, 6), point(90, 6)] },
      ],
      discontinuities: [],
    });

    expect(buffer.stateRange(-Infinity, Infinity)).toEqual([
      [at(0), MACHINE_STATE.loaded],
      [at(60), MACHINE_STATE.unloaded],
    ]);
  });
});

describe("revisions", () => {
  it("grow for the keys whose data changed and for every key on reset", () => {
    const buffer = configured();
    buffer.push([sample(0)]);
    const pressure = buffer.revision("line_pressure");
    const oil = buffer.revision("oil_temperature");
    const state = buffer.revision(STATE_KEY);

    buffer.push([sample(10, { line_pressure: 9 })]);
    expect(buffer.revision("line_pressure")).toBeGreaterThan(pressure);
    expect(buffer.revision("oil_temperature")).toBe(oil);
    expect(buffer.revision(STATE_KEY)).toBe(state);

    const alarms = buffer.revision(ALARMS_KEY);
    buffer.reset();
    expect(buffer.revision("oil_temperature")).toBeGreaterThan(oil);
    expect(buffer.revision(ALARMS_KEY)).toBeGreaterThan(alarms);
    expect(buffer.latestSimTs()).toBeNull();
  });
});
