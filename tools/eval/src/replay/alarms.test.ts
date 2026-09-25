// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The CTRL-7 port, on tables written for the occasion.
//
// Everything here runs offline on synthetic streams: a registry is written into
// a temporary directory, loaded, compiled against the real register map and fed
// rows whose values the test chose. That is what lets one case say one thing —
// "the dwell is a dwell", "the mask masks", "a manual message latches" — instead
// of a day of MetroPT-3 saying all of them at once, which is
// `test/replay/alarms-slices.test.ts`.
//
// Two of the cases are worth naming, because they are the ones that would let
// the port drift away from `services/modbus/internal/ctrl7` without anybody
// noticing:
//
//   * "the compiled table is the one the register-map generator produced"
//     compares every resolved threshold, dwell, mask and reset band with
//     `ALARMS` of `@fdp/contracts` — the table the Go evaluator is built from.
//     If the manual changes a number, both move together or this fails.
//   * "a bit already set survives a discontinuity while its condition holds"
//     pins the one place where a discontinuity does *not* clear everything,
//     which is `Evaluator.restart` leaving `active` alone.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALARMS, REGISTER_MAP } from "@fdp/contracts";
import { stringify } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

import {
  AlarmRegistryError,
  conditionLeaves,
  loadAlarmRegistry,
  resolveSpecDir,
} from "./alarm-registry.ts";
import type { AlarmRegistry, Leaf } from "./alarm-registry.ts";
import { AlarmEvaluatorError, compare, createAlarmEvaluator } from "./alarms.ts";
import { resolveLanes } from "./csv.ts";
import { DerivedError, createDerivedEngine, createLaneIndex } from "./derived.ts";
import type { DerivedDeclaration } from "./alarm-registry.ts";
import type { MachineState, RegisterMap, ReplayRow } from "./types.ts";

const MAP = REGISTER_MAP as RegisterMap;
const LANES = resolveLanes(MAP);
const INDEX = createLaneIndex(LANES);

/** Ten seconds: the MetroPT-3 sample period, and the step every synthetic stream uses. */
const STEP_MS = 10_000;

/** An arbitrary but fixed simulated instant; nothing here reads a wall clock. */
const START_MS = Date.UTC(2020, 1, 3, 0, 0, 0);

/** The signal block every hand-written registry gets: the register map's own tags. */
const SIGNALS = MAP.signals.map((signal) => ({
  id: signal.tag,
  group: signal.group,
  unit: signal.group === "digital" ? "bool" : unitOfTag(signal.tag),
}));

/** The unit `manual/spec/signals.yaml` gives a tag, read from the generated map. */
function unitOfTag(tag: string): string {
  const entry = REGISTER_MAP.signals.find((signal) => signal.tag === tag);
  return entry?.unit ?? "";
}

/** The manual's own derived block, restated here so a case can drop or change one entry. */
const DERIVED: readonly Record<string, unknown>[] = [
  {
    id: "reservoir_line_delta",
    kind: "abs_delta",
    inputs: ["reservoir_pressure", "line_pressure"],
    unit: "bar",
  },
  {
    id: "discharge_line_delta",
    kind: "delta",
    inputs: ["discharge_pressure", "line_pressure"],
    unit: "bar",
  },
  { id: "continuous_load_time", kind: "time_in_state", state: "loaded", unit: "min" },
  {
    id: "motor_starts_per_hour",
    kind: "events_per_window",
    event: "start_event",
    window_s: 3600,
    unit: "per_hour",
  },
  {
    id: "seconds_since_tower_change",
    kind: "seconds_since_change",
    input: "dryer_tower",
    reset_on_state_exit: "loaded",
    unit: "s",
  },
  { id: "run_hours", kind: "time_in_states_total", states: ["unloaded", "loaded"], unit: "h" },
];

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

/** What one hand-written registry declares; every block has a usable default. */
interface SpecOverrides {
  readonly alarms: readonly unknown[];
  readonly settings?: readonly unknown[];
  readonly signals?: readonly unknown[];
  readonly derived?: readonly unknown[];
  readonly machineStates?: unknown;
}

/** Writes the three documents into a directory of their own and returns it. */
function writeSpec(spec: SpecOverrides): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-alarms-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    join(directory, "alarms.yaml"),
    stringify({ schema_version: 1, alarms: spec.alarms }),
  );
  writeFileSync(
    join(directory, "settings.yaml"),
    stringify({ schema_version: 1, settings: spec.settings ?? [] }),
  );
  writeFileSync(
    join(directory, "signals.yaml"),
    stringify({
      schema_version: 1,
      signals: spec.signals ?? SIGNALS,
      machine_states: spec.machineStates ?? { aliases: { running: ["unloaded", "loaded"] } },
      derived: spec.derived ?? DERIVED,
    }),
  );
  return directory;
}

/** Writes a registry and loads it. */
function registryOf(spec: SpecOverrides): AlarmRegistry {
  return loadAlarmRegistry({ specDir: writeSpec(spec) });
}

/** One message in the manual's grammar, with the fields a case does not care about filled in. */
function message(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    code: "W101",
    type: "warning",
    bit: 0,
    evaluation: "sim",
    title: "Test message",
    display: "TEST",
    reset: { mode: "auto" },
    ...overrides,
  };
}

/** A row in which every analog lane is zero and every digital lane is low. */
function emptyRow(simTsMs: number): ReplayRow {
  return {
    simTsMs,
    analog: new Float64Array(LANES.analog.length),
    digital: new Uint8Array(LANES.digital.length),
    missing: false,
  };
}

/** A row carrying the named tag values; anything unnamed stays at zero. */
function rowOf(simTsMs: number, values: Readonly<Record<string, number | boolean>>): ReplayRow {
  const row = emptyRow(simTsMs);
  for (const [tag, value] of Object.entries(values)) {
    const analog = INDEX.analog.get(tag);
    if (analog !== undefined) {
      row.analog[analog] = Number(value);
      continue;
    }
    const digital = INDEX.digital.get(tag);
    if (digital === undefined) throw new Error(`the register map replays no ${tag}`);
    row.digital[digital] = value === true || value === 1 ? 1 : 0;
  }
  return row;
}

/** One sample of a synthetic stream. */
interface Step {
  readonly values?: Readonly<Record<string, number | boolean>>;
  readonly state?: MachineState;
  readonly discontinuity?: boolean;
  /** Seconds since the previous step; the sample period when absent. */
  readonly afterS?: number;
}

/** The result of feeding a stream: the codes per sample and the instants they carry. */
interface Run {
  readonly codes: string[][];
  readonly at: number[];
  readonly manualClears: number;
  readonly activations: ReadonlyMap<string, number>;
}

/** Feeds `steps` to an evaluator built from `registry` and records what it answered. */
function run(registry: AlarmRegistry, steps: readonly Step[]): Run {
  const evaluator = createAlarmEvaluator(registry, MAP);
  const codes: string[][] = [];
  const at: number[] = [];
  let simTsMs = START_MS;
  steps.forEach((step, index) => {
    if (index > 0) simTsMs += (step.afterS ?? STEP_MS / 1_000) * 1_000;
    const row = rowOf(simTsMs, step.values ?? {});
    at.push(simTsMs);
    codes.push([
      ...evaluator.evaluate(
        row,
        step.state ?? "loaded",
        simTsMs,
        step.discontinuity ?? index === 0,
      ),
    ]);
  });
  const { manualClears, activations } = evaluator.stats;
  return { codes, at, manualClears, activations };
}

/** The index of the first step carrying `code`, or -1. */
function firstOf(run: Run, code: string): number {
  return run.codes.findIndex((sample) => sample.includes(code));
}

/** A stream of `count` steps, each with the same values and state. */
function steady(count: number, step: Step): Step[] {
  return Array.from({ length: count }, () => step);
}

// ---------------------------------------------------------------------------

describe("loadAlarmRegistry", () => {
  it("resolves the provisional fixture into five messages and one unevaluable", () => {
    const registry = loadAlarmRegistry({ specDir: provisionalDir() });

    expect(registry.source).toBe("provisional");
    expect(registry.alarms.map((alarm) => alarm.code)).toEqual([
      "W101",
      "W102",
      "W103",
      "W104",
      "W106",
    ]);
    expect(registry.unevaluable.map((alarm) => alarm.code)).toEqual(["S307"]);
    expect(registry.unevaluable[0]?.kind).toBe("external");
    expect(registry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.files.map((file) => file.name)).toEqual([
      "alarms.yaml",
      "settings.yaml",
      "signals.yaml",
    ]);
    expect(registry.runningStates).toEqual(["unloaded", "loaded"]);
  });

  it("resolves every setting reference of the provisional fixture into a number", () => {
    const registry = loadAlarmRegistry({ specDir: provisionalDir() });
    const byCode = new Map(registry.alarms.map((alarm) => [alarm.code, alarm]));

    // W101: a digital tag compared with a level, dwell from a setting.
    expect(leafOf(byCode.get("W101")?.condition)).toEqual({
      signal: "low_pressure_switch",
      op: "eq",
      threshold: 1,
      unit: "bool",
    } satisfies Leaf);
    expect(byCode.get("W101")?.for_s).toBe(10);

    // W102: a derived quantity, threshold in the quantity's own unit.
    expect(leafOf(byCode.get("W102")?.condition)?.threshold).toBe(10);
    expect(leafOf(byCode.get("W102")?.condition)?.unit).toBe("min");
    expect(byCode.get("W102")?.state).toBe("loaded");

    // W103 and W104: a reset band, resolved into the leaf's unit.
    expect(byCode.get("W103")?.reset).toEqual({ mode: "auto_hysteresis", hysteresis: 0.1 });
    expect(byCode.get("W104")?.reset).toEqual({ mode: "auto_hysteresis", hysteresis: 5 });
    expect(byCode.get("W104")?.state).toBe("running");

    // W106: the start mask, resolved from `motor_start_mask_time`.
    expect(byCode.get("W106")?.exclude_start_s).toBe(20);
    expect(leafOf(byCode.get("W106")?.condition)?.threshold).toBeCloseTo(6.8, 10);
  });

  it("gives two different registries two different digests", () => {
    const provisional = loadAlarmRegistry({ specDir: provisionalDir() });
    const other = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "any",
            condition: {
              signal: "oil_temperature",
              op: "gt",
              threshold: { value: 75, unit: "degC" },
            },
            for_s: 0,
          },
        }),
      ],
    });
    expect(other.sha256).not.toBe(provisional.sha256);
    expect(loadAlarmRegistry({ specDir: provisionalDir() }).sha256).toBe(provisional.sha256);
  });

  it("reads the manual's registry in this checkout", () => {
    const resolved = resolveSpecDir();
    expect(resolved?.source, "this worktree carries no manual/spec").toBe("manual");
    const registry = loadAlarmRegistry();
    expect(registry.source).toBe("manual");
    expect(registry.alarms.length).toBe(ALARMS.length);
    expect(registry.alarms.map((alarm) => alarm.bit)).toEqual(ALARMS.map((alarm) => alarm.bit));
  });

  it("compiles to the table the register-map generator produced", () => {
    // The Go evaluator reads `regmap.Alarms`, generated from the same three
    // documents by `packages/contracts/scripts/generate-regmap.ts`. Comparing
    // the two resolutions is how a threshold cannot mean 75 °C on one side of
    // the port and 7.5 on the other.
    const registry = loadAlarmRegistry();
    const problems: string[] = [];

    for (const alarm of registry.alarms) {
      const generated = ALARMS.find((entry) => entry.code === alarm.code);
      if (generated === undefined) {
        problems.push(`${alarm.code}: the generated map has no such message`);
        continue;
      }
      const trigger = generated.trigger as unknown as Record<string, unknown>;
      const leaves = conditionLeaves(alarm.condition);
      const say = (what: string, theirs: unknown, mine: unknown): void => {
        if (JSON.stringify(theirs) !== JSON.stringify(mine)) {
          problems.push(
            `${alarm.code}: ${what} ${JSON.stringify(theirs)} != ${JSON.stringify(mine)}`,
          );
        }
      };

      say("bit", generated.bit, alarm.bit);
      say("when", trigger["when"], alarm.state);
      say("reset_mode", trigger["reset_mode"], alarm.reset.mode);
      say("start_mask_s", trigger["start_mask_s"], alarm.exclude_start_s);

      const kind = String(trigger["kind"]);
      if (kind === "state_duration") {
        const leaf = leaves[0];
        const seconds = (leaf?.threshold ?? 0) * (leaf?.unit === "min" ? 60 : 1);
        say("duration_s", trigger["duration_s"], seconds);
        continue;
      }
      say("delay_s", trigger["delay_s"], alarm.for_s);
      if (kind === "composite") {
        const branches = (trigger["all"] ?? trigger["any"]) as readonly unknown[];
        say("branch count", branches.length, leaves.length);
        continue;
      }
      const leaf = leaves[0];
      const threshold =
        kind === "digital" ? (trigger["value"] === true ? 1 : 0) : trigger["threshold"];
      say("threshold", threshold, leaf?.threshold);
      say("hysteresis", trigger["hysteresis"], alarm.reset.hysteresis ?? 0);
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it.each([
    [
      "an unknown operator",
      {
        condition: {
          signal: "oil_temperature",
          op: "above",
          threshold: { value: 1, unit: "degC" },
        },
      },
      /W101.trigger.condition.op: unknown value "above"/,
    ],
    [
      "an unknown trigger state",
      {
        state: "warming",
        condition: { signal: "oil_temperature", op: "gt", threshold: { value: 1, unit: "degC" } },
      },
      /W101.trigger.state: unknown value "warming"/,
    ],
    [
      "a signal nothing declares",
      { condition: { signal: "coolant_flow", op: "gt", threshold: { value: 1, unit: "l_min" } } },
      /W101.trigger.condition.signal: coolant_flow is neither/,
    ],
    [
      "a threshold that is neither shape",
      { condition: { signal: "oil_temperature", op: "gt", threshold: { degrees: 75 } } },
      /W101.trigger.condition.threshold: a threshold is \{value, unit\}/,
    ],
    [
      "a setting nothing declares",
      { condition: { signal: "oil_temperature", op: "gt", threshold: { setting: "oil_warn" } } },
      /W101.trigger.condition.threshold: settings.yaml declares no oil_warn/,
    ],
    [
      "a condition that is both all and any",
      {
        condition: {
          all: [{ signal: "load_valve", op: "eq", threshold: { value: 1, unit: "bool" } }],
          any: [{ signal: "load_valve", op: "eq", threshold: { value: 1, unit: "bool" } }],
        },
      },
      /W101.trigger.condition: a condition is either all or any/,
    ],
    [
      "an all with a single branch",
      {
        condition: {
          all: [{ signal: "load_valve", op: "eq", threshold: { value: 1, unit: "bool" } }],
        },
      },
      /W101.trigger.condition.all: needs at least two branches/,
    ],
  ])("refuses %s", (_what, trigger, expected) => {
    expect(() =>
      registryOf({
        alarms: [message({ trigger: { kind: "signal", state: "any", for_s: 0, ...trigger } })],
      }),
    ).toThrow(expected);
  });

  it("refuses a reset mode nobody implements", () => {
    expect(() =>
      registryOf({
        alarms: [
          message({
            reset: { mode: "acknowledge" },
            trigger: {
              kind: "signal",
              condition: {
                signal: "oil_temperature",
                op: "gt",
                threshold: { value: 1, unit: "degC" },
              },
              for_s: 0,
            },
          }),
        ],
      }),
    ).toThrow(/W101.reset.mode: unknown value "acknowledge"/);
  });

  it("refuses auto_hysteresis without a band, and a band without auto_hysteresis", () => {
    const trigger = {
      kind: "signal",
      condition: { signal: "oil_temperature", op: "gt", threshold: { value: 75, unit: "degC" } },
      for_s: 0,
    };
    expect(() =>
      registryOf({ alarms: [message({ trigger, reset: { mode: "auto_hysteresis" } })] }),
    ).toThrow(/W101.reset.hysteresis: reset.mode auto_hysteresis needs a band/);
    expect(() =>
      registryOf({
        alarms: [
          message({ trigger, reset: { mode: "auto", hysteresis: { value: 1, unit: "degC" } } }),
        ],
      }),
    ).toThrow(/W101.reset.hysteresis: a band belongs to auto_hysteresis/);
  });

  it("refuses two messages on one bit and a bit outside the register", () => {
    const trigger = {
      kind: "signal",
      condition: { signal: "oil_temperature", op: "gt", threshold: { value: 75, unit: "degC" } },
      for_s: 0,
    };
    expect(() =>
      registryOf({
        alarms: [message({ trigger }), message({ code: "W102", bit: 0, trigger })],
      }),
    ).toThrow(/W102.bit: bit 0 is already taken by W101/);
    expect(() => registryOf({ alarms: [message({ bit: 32, trigger })] })).toThrow(
      /W101.bit: 32 is not an integer in 0..31/,
    );
  });

  it("refuses an evaluated message whose trigger is not a signal, and a bit on one that is not", () => {
    expect(() =>
      registryOf({
        alarms: [message({ trigger: { kind: "external", input: "emergency_stop" } })],
      }),
    ).toThrow(/W101.trigger.kind: evaluation: sim needs kind: signal, found external/);
    expect(() =>
      registryOf({
        alarms: [
          message({
            code: "S307",
            type: "shutdown",
            evaluation: "none",
            bit: 7,
            reset: { mode: "manual" },
            trigger: { kind: "external", input: "emergency_stop" },
          }),
        ],
      }),
    ).toThrow(/S307.bit: only a message with evaluation: sim carries a bit/);
  });

  it("lists an external and a counter message as unevaluable", () => {
    const registry = registryOf({
      alarms: [
        message({
          code: "S307",
          type: "shutdown",
          bit: null,
          evaluation: "none",
          reset: { mode: "manual" },
          trigger: { kind: "external", input: "emergency_stop" },
        }),
        message({
          code: "M401",
          type: "service",
          bit: null,
          evaluation: "none",
          reset: { mode: "manual_service" },
          trigger: { kind: "counter", counter: { derived: "run_hours", task: "oil_change" } },
        }),
      ],
    });
    expect(registry.alarms).toEqual([]);
    expect(registry.unevaluable.map((alarm) => `${alarm.code}:${alarm.kind}`)).toEqual([
      "S307:external",
      "M401:counter",
    ]);
  });
});

describe("compare", () => {
  it.each([
    ["gt", 10, 9, true],
    ["gt", 10, 10, false],
    ["ge", 10, 10, true],
    ["ge", 10, 10.1, false],
    ["lt", 10, 11, true],
    ["lt", 10, 10, false],
    ["le", 10, 10, true],
    ["le", 10, 9.9, false],
    ["eq", 1, 1, true],
    ["eq", 1, 0, false],
    ["ne", 1, 0, true],
    ["ne", 1, 1, false],
  ] as const)("%s %d against %d", (op, value, threshold, expected) => {
    expect(compare(value, op, threshold, 0, false)).toBe(expected);
  });

  it("widens the comparison by the band only while the message is set", () => {
    // `value > 0.5`, band 0.1: it rises at 0.51 and clears below 0.40.
    expect(compare(0.45, "gt", 0.5, 0.1, false)).toBe(false);
    expect(compare(0.45, "gt", 0.5, 0.1, true)).toBe(true);
    expect(compare(0.39, "gt", 0.5, 0.1, true)).toBe(false);
    // and the band is mirrored for `lt`.
    expect(compare(5.5, "lt", 5, 1, false)).toBe(false);
    expect(compare(5.5, "lt", 5, 1, true)).toBe(true);
    expect(compare(6.5, "lt", 5, 1, true)).toBe(false);
  });
});

describe("the derived quantities", () => {
  const engineOf = (declarations: readonly DerivedDeclaration[]) =>
    createDerivedEngine(declarations, INDEX);

  it("subtracts two lanes, with and without the absolute value", () => {
    const engine = engineOf([
      {
        id: "abs",
        kind: "abs_delta",
        inputs: ["reservoir_pressure", "line_pressure"],
        unit: "bar",
      },
      { id: "signed", kind: "delta", inputs: ["reservoir_pressure", "line_pressure"], unit: "bar" },
    ]);
    engine.step(
      rowOf(START_MS, { reservoir_pressure: 8.2, line_pressure: 9 }),
      "loaded",
      START_MS,
      0,
      false,
    );
    expect(engine.value("abs")).toBeCloseTo(0.8, 10);
    expect(engine.value("signed")).toBeCloseTo(-0.8, 10);
  });

  it("times the current state and starts again when the unit leaves it", () => {
    const engine = engineOf([
      { id: "loaded_min", kind: "time_in_state", state: "loaded", unit: "min" },
      { id: "run_h", kind: "time_in_states_total", states: ["unloaded", "loaded"], unit: "h" },
    ]);
    const states: MachineState[] = ["loaded", "loaded", "loaded", "unloaded", "loaded"];
    const seen: number[] = [];
    const total: number[] = [];
    states.forEach((state, index) => {
      const at = START_MS + index * STEP_MS;
      engine.step(rowOf(at, {}), state, at, index === 0 ? 0 : STEP_MS, false);
      seen.push(engine.value("loaded_min"));
      total.push(engine.value("run_h"));
    });
    // 0, 10 s, 20 s in minutes; the unloaded sample resets it to zero, and the
    // loaded sample after it already carries the step that led into it — the
    // timer advances by the sim time since the previous sample, exactly as
    // `derivedState.step` does.
    expect(seen).toEqual([0, 1 / 6, 2 / 6, 0, 1 / 6]);
    // the total keeps counting through the unloaded sample.
    expect(total[4]).toBeCloseTo((4 * STEP_MS) / 3_600_000, 12);
  });

  it("counts the starts of the trailing window and drops them as it slides", () => {
    const engine = engineOf([
      {
        id: "starts",
        kind: "events_per_window",
        event: "start_event",
        window_s: 3600,
        unit: "per_hour",
      },
    ]);
    const at = START_MS;
    engine.step(rowOf(at, {}), "unloaded", at, 0, true);
    expect(engine.value("starts")).toBe(1);
    engine.step(rowOf(at + 1_000, {}), "unloaded", at + 1_000, 1_000, true);
    expect(engine.value("starts")).toBe(2);
    // The first event is exactly an hour old and is dropped, the second is not.
    const later = at + 3_600_000;
    engine.step(rowOf(later, {}), "unloaded", later, 3_599_000, false);
    expect(engine.value("starts")).toBe(1);
  });

  it("holds the changeover timer at zero outside the state it belongs to", () => {
    const engine = engineOf([
      {
        id: "since_tower",
        kind: "seconds_since_change",
        input: "dryer_tower",
        reset_on_state_exit: "loaded",
        unit: "s",
      },
    ]);
    const feed = (index: number, tower: boolean, state: MachineState): number => {
      const at = START_MS + index * STEP_MS;
      engine.step(rowOf(at, { dryer_tower: tower }), state, at, index === 0 ? 0 : STEP_MS, false);
      return engine.value("since_tower");
    };
    expect(feed(0, true, "loaded")).toBe(0);
    expect(feed(1, true, "loaded")).toBe(10);
    expect(feed(2, true, "loaded")).toBe(20);
    // The tower changes: the timer starts again.
    expect(feed(3, false, "loaded")).toBe(0);
    expect(feed(4, false, "loaded")).toBe(10);
    // The unit unloads: the timer is held at zero, not merely paused.
    expect(feed(5, false, "unloaded")).toBe(0);
    expect(feed(6, false, "loaded")).toBe(10);
  });

  it("starts from zero again after a reset", () => {
    const engine = engineOf([
      { id: "loaded_s", kind: "time_in_state", state: "loaded", unit: "s" },
    ]);
    engine.step(rowOf(START_MS, {}), "loaded", START_MS, STEP_MS, false);
    expect(engine.value("loaded_s")).toBe(10);
    engine.reset();
    expect(engine.value("loaded_s")).toBe(0);
  });

  it("refuses a declaration the register map cannot carry", () => {
    expect(() =>
      engineOf([{ id: "bad", kind: "seconds_since_change", input: "oil_temperature", unit: "s" }]),
    ).toThrow(/oil_temperature is an analog tag, not a digital one/);
    expect(() =>
      engineOf([{ id: "bad", kind: "time_in_state", state: "loaded", unit: "bar" }]),
    ).toThrow(/bar is not a duration/);
  });
});

describe("the alarm evaluator", () => {
  /** A one-message registry over `oil_temperature`, with the fields a case varies. */
  function oilRegistry(
    trigger: Record<string, unknown> = {},
    reset: Record<string, unknown> = { mode: "auto" },
  ): AlarmRegistry {
    return registryOf({
      alarms: [
        message({
          reset,
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: {
              signal: "oil_temperature",
              op: "gt",
              threshold: { value: 75, unit: "degC" },
            },
            ...trigger,
          },
        }),
      ],
    });
  }

  it("raises a message the moment the condition holds when there is no dwell", () => {
    const result = run(oilRegistry(), [
      { values: { oil_temperature: 70 } },
      { values: { oil_temperature: 76 } },
      { values: { oil_temperature: 70 } },
    ]);
    expect(result.codes).toEqual([[], ["W101"], []]);
    expect(result.activations.get("W101")).toBe(1);
  });

  it("waits out the dwell in sim time and keeps waiting when the condition lapses", () => {
    const registry = oilRegistry({ for_s: 30 });
    // Three samples at 10 s: the third is exactly 30 s after the first.
    const held = run(registry, steady(4, { values: { oil_temperature: 80 } }));
    expect(held.codes).toEqual([[], [], [], ["W101"]]);

    // One sample below the threshold in the middle starts the dwell again.
    const broken = run(registry, [
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 10 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
    ]);
    expect(firstOf(broken, "W101")).toBe(6);
  });

  it("looks at the condition only inside the trigger state, running included", () => {
    const loaded = oilRegistry({ state: "loaded" });
    expect(
      run(loaded, [
        { values: { oil_temperature: 80 }, state: "unloaded" },
        { values: { oil_temperature: 80 }, state: "loaded" },
        { values: { oil_temperature: 80 }, state: "off" },
      ]).codes,
    ).toEqual([[], ["W101"], []]);

    const running = oilRegistry({ state: "running" });
    expect(
      run(running, [
        { values: { oil_temperature: 80 }, state: "off" },
        { values: { oil_temperature: 80 }, state: "unloaded" },
        { values: { oil_temperature: 80 }, state: "loaded" },
      ]).codes,
    ).toEqual([[], ["W101"], ["W101"]]);
  });

  it("hides the condition while the start mask runs, counting from the last start", () => {
    const registry = oilRegistry({ state: "loaded", exclude_start_s: 25 });
    const result = run(registry, [
      // off → loaded on the second sample: the mask starts there.
      { values: { oil_temperature: 80 }, state: "off" },
      { values: { oil_temperature: 80 }, state: "loaded" },
      { values: { oil_temperature: 80 }, state: "loaded" },
      { values: { oil_temperature: 80 }, state: "loaded" },
      { values: { oil_temperature: 80 }, state: "loaded" },
    ]);
    // 0 s and 10 s and 20 s after the start are masked; 30 s is not.
    expect(result.codes).toEqual([[], [], [], [], ["W101"]]);
  });

  it("clears a message only once the value is back beyond the band", () => {
    const registry = oilRegistry(
      {},
      { mode: "auto_hysteresis", hysteresis: { value: 5, unit: "degC" } },
    );
    const result = run(registry, [
      { values: { oil_temperature: 76 } },
      { values: { oil_temperature: 72 } },
      { values: { oil_temperature: 70.1 } },
      { values: { oil_temperature: 69 } },
      { values: { oil_temperature: 74 } },
    ]);
    // 76 raises it; 72 and 70.1 stay inside the 70 °C release band; 69 clears
    // it; 74 no longer raises it, because the band is gone once it is clear.
    expect(result.codes).toEqual([["W101"], ["W101"], ["W101"], [], []]);
  });

  it("latches a manual message and releases it on a discontinuity", () => {
    const registry = oilRegistry({}, { mode: "manual" });
    const result = run(registry, [
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 10 } },
      { values: { oil_temperature: 10 } },
      { values: { oil_temperature: 10 }, discontinuity: true },
      { values: { oil_temperature: 10 } },
    ]);
    expect(result.codes).toEqual([["W101"], ["W101"], ["W101"], [], []]);
    expect(result.manualClears).toBe(1);
  });

  it("restarts a pending dwell at a discontinuity", () => {
    const registry = oilRegistry({ for_s: 30 });
    const result = run(registry, [
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 }, discontinuity: true },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
      { values: { oil_temperature: 80 } },
    ]);
    // Without the discontinuity the message would be set on the fourth sample;
    // the dwell starts again at the third, so it is set on the sixth.
    expect(firstOf(result, "W101")).toBe(5);
  });

  it("keeps a bit that is already set through a discontinuity its condition survives", () => {
    const registry = oilRegistry({ for_s: 30 });
    const held = run(registry, [
      ...steady(4, { values: { oil_temperature: 80 } }),
      { values: { oil_temperature: 80 }, discontinuity: true },
    ]);
    expect(held.codes.at(-1)).toEqual(["W101"]);

    const released = run(registry, [
      ...steady(4, { values: { oil_temperature: 80 } }),
      { values: { oil_temperature: 10 }, discontinuity: true },
    ]);
    expect(released.codes.at(-1)).toEqual([]);
  });

  it("evaluates an all of leaves, and an any of leaves", () => {
    const all = registryOf({
      alarms: [
        message({
          reset: { mode: "manual" },
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: {
              all: [
                { signal: "load_valve", op: "eq", threshold: { value: 1, unit: "bool" } },
                { signal: "motor_current", op: "lt", threshold: { value: 1, unit: "A" } },
              ],
            },
          },
        }),
      ],
    });
    expect(
      run(all, [
        { values: { load_valve: true, motor_current: 5 } },
        { values: { load_valve: false, motor_current: 0.5 } },
        { values: { load_valve: true, motor_current: 0.5 } },
      ]).codes,
    ).toEqual([[], [], ["W101"]]);

    const any = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: {
              any: [
                { signal: "line_pressure", op: "lt", threshold: { value: -0.5, unit: "bar" } },
                { signal: "line_pressure", op: "gt", threshold: { value: 15.5, unit: "bar" } },
              ],
            },
          },
        }),
      ],
    });
    expect(
      run(any, [
        { values: { line_pressure: 9 } },
        { values: { line_pressure: -0.6 } },
        { values: { line_pressure: 16 } },
      ]).codes,
    ).toEqual([[], ["W101"], ["W101"]]);
  });

  it("turns a time_in_state leaf into the dwell the Go evaluator uses", () => {
    // `continuous_load_time > 1 min` with `for_s: 0` must not fire at once: the
    // threshold is the dwell.
    const registry = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "loaded",
            for_s: 0,
            condition: {
              signal: "continuous_load_time",
              op: "gt",
              threshold: { value: 1, unit: "min" },
            },
          },
        }),
      ],
    });
    const result = run(registry, steady(8, { state: "loaded" }));
    // 60 s after the first loaded sample is the seventh step.
    expect(firstOf(result, "W101")).toBe(6);
  });

  it("compares a differential and a counted quantity", () => {
    const registry = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: {
              signal: "reservoir_line_delta",
              op: "gt",
              threshold: { value: 0.5, unit: "bar" },
            },
          },
        }),
        message({
          code: "W108",
          bit: 7,
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: {
              signal: "motor_starts_per_hour",
              op: "gt",
              threshold: { value: 1, unit: "per_hour" },
            },
          },
        }),
      ],
    });
    const result = run(registry, [
      { values: { reservoir_pressure: 9, line_pressure: 9 }, state: "off" },
      { values: { reservoir_pressure: 8, line_pressure: 9 }, state: "unloaded" },
      { values: { reservoir_pressure: 9, line_pressure: 9 }, state: "off" },
      { values: { reservoir_pressure: 9, line_pressure: 9 }, state: "unloaded" },
    ]);
    expect(result.codes).toEqual([[], ["W101"], [], ["W108"]]);
  });

  it("answers in ascending bit order whatever order the file declares", () => {
    const always = (code: string, bit: number): Record<string, unknown> =>
      message({
        code,
        bit,
        trigger: {
          kind: "signal",
          state: "any",
          for_s: 0,
          condition: { signal: "oil_temperature", op: "gt", threshold: { value: 1, unit: "degC" } },
        },
      });
    const registry = registryOf({
      alarms: [always("S301", 21), always("W101", 0), always("X201", 17)],
    });
    expect(registry.alarms.map((alarm) => alarm.code)).toEqual(["W101", "X201", "S301"]);
    expect(run(registry, [{ values: { oil_temperature: 80 } }]).codes).toEqual([
      ["W101", "X201", "S301"],
    ]);
  });

  it("never raises a message that carries no bit", () => {
    const registry = registryOf({
      alarms: [
        message({
          code: "S307",
          type: "shutdown",
          bit: null,
          evaluation: "none",
          reset: { mode: "manual" },
          trigger: { kind: "external", input: "emergency_stop" },
        }),
      ],
    });
    expect(run(registry, steady(5, { values: { oil_temperature: 200 } })).codes).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it("counts the samples and the discontinuities it saw", () => {
    const registry = oilRegistry();
    const evaluator = createAlarmEvaluator(registry, MAP);
    evaluator.evaluate(rowOf(START_MS, {}), "loaded", START_MS, true);
    evaluator.evaluate(rowOf(START_MS + STEP_MS, {}), "loaded", START_MS + STEP_MS, false);
    expect(evaluator.stats.samples).toBe(2);
    expect(evaluator.stats.discontinuities).toBe(1);
    expect(evaluator.derived.has("continuous_load_time")).toBe(true);
  });

  it("refuses a registry the register map cannot carry", () => {
    const registry = registryOf({
      signals: [{ id: "coolant_flow", group: "analog", unit: "l_min" }],
      derived: [],
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: { signal: "coolant_flow", op: "gt", threshold: { value: 1, unit: "l_min" } },
          },
        }),
      ],
    });
    // Lane resolution belongs to `derived.ts`, so this one carries its error.
    expect(() => createAlarmEvaluator(registry, MAP)).toThrow(DerivedError);
    expect(() => createAlarmEvaluator(registry, MAP)).toThrow(/replays no coolant_flow/);
  });

  it("refuses a digital tag compared with anything but equality", () => {
    const registry = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "any",
            for_s: 0,
            condition: { signal: "load_valve", op: "gt", threshold: { value: 0, unit: "bool" } },
          },
        }),
      ],
    });
    expect(() => createAlarmEvaluator(registry, MAP)).toThrow(AlarmEvaluatorError);
    expect(() => createAlarmEvaluator(registry, MAP)).toThrow(/compared with op: eq, not gt/);
  });

  it("refuses a state-duration leaf inside an all", () => {
    const registry = registryOf({
      alarms: [
        message({
          trigger: {
            kind: "signal",
            state: "loaded",
            for_s: 0,
            condition: {
              all: [
                { signal: "continuous_load_time", op: "gt", threshold: { value: 1, unit: "min" } },
                { signal: "load_valve", op: "eq", threshold: { value: 1, unit: "bool" } },
              ],
            },
          },
        }),
      ],
    });
    expect(() => createAlarmEvaluator(registry, MAP)).toThrow(
      /a state-duration leaf cannot be a branch of all\/any/,
    );
  });
});

/** The committed provisional fixture, addressed the way the loader addresses it. */
function provisionalDir(): string {
  return join(import.meta.dirname, "..", "..", "fixtures", "alarms-provisional");
}

/** The single leaf of a condition, for a case that knows there is exactly one. */
function leafOf(
  condition: AlarmRegistry["alarms"][number]["condition"] | undefined,
): Leaf | undefined {
  if (condition === undefined) return undefined;
  const leaves = conditionLeaves(condition);
  expect(leaves.length).toBe(1);
  return leaves[0];
}

/** `AlarmRegistryError` is what every grammar failure carries. */
it("throws AlarmRegistryError for broken grammar", () => {
  expect(() =>
    registryOf({ alarms: [message({ trigger: { kind: "signal", state: "any" } })] }),
  ).toThrow(AlarmRegistryError);
});
