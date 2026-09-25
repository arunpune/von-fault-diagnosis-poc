// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The CTRL-7 port against three days of the real recording.
//
// `src/replay/alarms.test.ts` says what each rule does on a stream written for
// it. This file asks the only question that stream cannot answer: replayed over
// MetroPT-3 itself, does the port raise the messages the machine would have
// raised, at the times the data says it would?
//
// Three days, three questions (docs/dataset.md, "The failure table"):
//
//   * **F3, 5 June.** Signature A: the unit goes stuck-loaded at 09:48:30 with
//     the purge pressure high and never reaches cut-out. W102 (continuous load)
//     and W103 (purge pressure) must both appear inside the first hour, and
//     W101 must never appear at all — the low-pressure switch does not close on
//     a signature-A leak, which is precisely why the manual has W102 and W103.
//   * **F4, 15 July.** Signature B: stuck loaded from 14:25, and the
//     low-pressure switch closes at 17:20:11 and stays closed until 18:49:46.
//     W101 must appear one dwell after the switch closes, and W102 one
//     continuous-load time after the run begins.
//   * **3 February, the baseline day.** Nothing may be raised at all, and W106
//     in particular must not be: the day carries a start peak above the
//     provisional current warning, and the start mask is what keeps it quiet.
//
// Every number that belongs to the registry — the dwells, the thresholds, the
// mask — is read from the loaded registry at test time, so the manual changing
// a default moves the expectation with it. The instants belong to the dataset
// and are quoted from the analysis of the recording, which is where they were
// measured.
//
// Both registries are exercised: the committed provisional fixture, which runs
// in any checkout, and the manual's own `manual/spec` when it is there. They
// disagree on the numbers by design, and the assertions hold for both.
//
// No row of MetroPT-3 is committed, so this file reads the slices
// `make fixtures` cuts and skips when they are absent — unless
// `FDP_REQUIRE_DATASET=1` says the dataset was supposed to be there.

import { join } from "node:path";

import { REGISTER_MAP } from "@fdp/contracts";
import type { Sample } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  PROVISIONAL_SPEC_DIR,
  loadAlarmRegistry,
  resolveSpecDir,
} from "../../src/replay/alarm-registry.ts";
import type { AlarmRegistry, ResolvedAlarm } from "../../src/replay/alarm-registry.ts";
import { conditionLeaves } from "../../src/replay/alarm-registry.ts";
import { createClassifier, createReplaySource, resolveLanes } from "../../src/replay/index.ts";
import type { MachineState, RegisterMap } from "../../src/replay/types.ts";
import { REPO_ROOT, datasetRequired, requireSlice, sliceIsCut } from "../../src/slices.ts";

const MAP = REGISTER_MAP as RegisterMap;
const LANES = resolveLanes(MAP);

/** The wall clock every batch is stamped from; nothing here reads it. */
const WALL = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));

/** The recording's sample period; every "± one sample" below is this wide. */
const SAMPLE_MS = 10_000;

/** The three days, and the slices they are cut into. */
const F3_SLICE = "f3-jun05";
const F4_SLICE = "f4-jul15";
const BASELINE_SLICE = "baseline-feb03";
const SLICES = [F3_SLICE, F4_SLICE, BASELINE_SLICE] as const;

/**
 * The instants measured in the data itself.
 *
 * `F3_ONSET` is the start of the stuck-loaded stretch of 5 June ("09:49", refined to 09:48:30
 * by the F3 scenario); `F4_STUCK_LOADED` and `F4_LPS_CLOSED` are the two instants of the 15
 * July row ("stuck loaded 14:25 → 18:53; LPS 17:20:11 → 18:49:46"), and `F4_PRECURSOR` the
 * short switch closure of the evening before ("fast decay from ≤ 07-14 21:28").
 */
const F3_ONSET = Date.parse("2020-06-05T09:48:30Z");
const F4_STUCK_LOADED = Date.parse("2020-07-15T14:25:00Z");
const F4_LPS_CLOSED = Date.parse("2020-07-15T17:20:11Z");
const F4_LPS_OPENED = Date.parse("2020-07-15T18:49:46Z");
const F4_PRECURSOR = Date.parse("2020-07-14T21:28:05Z");

/** "Within the first hour" of the onset. */
const ONE_HOUR_MS = 3_600_000;

/** How far after the run begins W102 may appear beyond its own continuous-load time. */
const STUCK_LOADED_SLACK_MS = 120_000;

const slicesCut = SLICES.every((slice) => sliceIsCut(slice));
const absence =
  `the ${SLICES.join(", ")} slices are not cut; run \`make fixtures\` with the dataset in ` +
  "place (set FDP_REQUIRE_DATASET=1 to make this a failure)";

/** The committed fixture, plus the manual's registry when this checkout carries it. */
function registries(): { readonly name: string; readonly registry: AlarmRegistry }[] {
  const found = [
    {
      name: "provisional",
      registry: loadAlarmRegistry({ specDir: join(REPO_ROOT, PROVISIONAL_SPEC_DIR) }),
    },
  ];
  if (resolveSpecDir()?.source === "manual") {
    found.push({ name: "manual", registry: loadAlarmRegistry() });
  }
  return found;
}

const REGISTRIES = registries();

/** One replayed slice: the published samples and the state of each one. */
interface Replayed {
  readonly samples: readonly Sample[];
  readonly states: readonly MachineState[];
}

const replays = new Map<string, Promise<Replayed>>();

/** Replays `slice` with `registry`, once per pair per run. */
function replay(
  slice: string,
  entry: { name: string; registry: AlarmRegistry },
): Promise<Replayed> {
  const key = `${slice}:${entry.name}`;
  const cached = replays.get(key);
  if (cached !== undefined) return cached;

  const started = (async (): Promise<Replayed> => {
    const classify = createClassifier(LANES);
    const states: MachineState[] = [];
    const source = createReplaySource({
      source: requireSlice(slice),
      map: MAP,
      wall: () => WALL,
      ambient: true,
      alarms: entry.registry,
      hooks: {
        classify: (row) => {
          const state = classify(row);
          states.push(state);
          return state;
        },
      },
    });
    const samples: Sample[] = [];
    for await (const batch of source) samples.push(...batch.samples);
    return { samples, states };
  })();
  replays.set(key, started);
  return started;
}

/** The instants at which `code` went from clear to set. */
function activationsOf(replayed: Replayed, code: string): number[] {
  const at: number[] = [];
  let previous = false;
  for (const sample of replayed.samples) {
    const now = sample.alarms.includes(code);
    if (now && !previous) at.push(Date.parse(sample.sim_ts));
    previous = now;
  }
  return at;
}

/** The last instant at which `code` was set, or undefined when it never was. */
function lastActiveOf(replayed: Replayed, code: string): number | undefined {
  for (let index = replayed.samples.length - 1; index >= 0; index -= 1) {
    const sample = replayed.samples[index];
    if (sample !== undefined && sample.alarms.includes(code)) return Date.parse(sample.sim_ts);
  }
  return undefined;
}

/** Every code the day carried, with how often it was raised. */
function raisedOn(replayed: Replayed): Map<string, number> {
  const counts = new Map<string, number>();
  const codes = new Set<string>();
  for (const sample of replayed.samples) for (const code of sample.alarms) codes.add(code);
  for (const code of codes) counts.set(code, activationsOf(replayed, code).length);
  return counts;
}

/** The message `code` carries in `registry`, or a failure naming what is there instead. */
function alarmOf(registry: AlarmRegistry, code: string): ResolvedAlarm {
  const alarm = registry.alarms.find((entry) => entry.code === code);
  expect(
    alarm,
    `the registry declares no ${code}, only ${registry.alarms.map((a) => a.code).join(", ")}`,
  ).toBeDefined();
  return alarm as ResolvedAlarm;
}

/** The dwell of `code` in milliseconds — its own `for_s`, or the continuous-load time. */
function dwellMsOf(registry: AlarmRegistry, code: string): number {
  const alarm = alarmOf(registry, code);
  const leaves = conditionLeaves(alarm.condition);
  const leaf = leaves.length === 1 ? leaves[0] : undefined;
  const derived = leaf === undefined ? undefined : registry.derived.get(leaf.signal);
  if (derived?.kind === "time_in_state") {
    // The threshold *is* the dwell for a state-duration message (W102).
    const factor = derived.unit === "min" ? 60 : derived.unit === "h" ? 3_600 : 1;
    return (leaf?.threshold ?? 0) * factor * 1_000;
  }
  return alarm.for_s * 1_000;
}

/** How far into a message's condition the mask hides it, in milliseconds. */
function maskMsOf(registry: AlarmRegistry, code: string): number {
  return alarmOf(registry, code).exclude_start_s * 1_000;
}

describe("the CTRL-7 port over the recorded slices", () => {
  it("has the slices it needs, or their absence is allowed", () => {
    expect(slicesCut || !datasetRequired(), absence).toBe(true);
    if (!slicesCut) console.info(`alarms-slices: skipped, ${absence}`);
    expect(REGISTRIES.map((entry) => entry.name)).toContain("provisional");
  });

  describe.each(REGISTRIES)("with the $name registry", (entry) => {
    it.skipIf(!slicesCut)(
      "raises W102 and W103 inside the first hour of the F3 leak, and never W101",
      async () => {
        const replayed = await replay(F3_SLICE, entry);
        const raised = raisedOn(replayed);
        console.info(
          `alarms-slices: ${F3_SLICE} (${entry.name}) raised ${[...raised.keys()].sort().join(", ") || "nothing"}`,
        );

        for (const code of ["W102", "W103"]) {
          const at = activationsOf(replayed, code);
          expect(at.length, `${code} was never raised on the F3 slice`).toBeGreaterThan(0);
          const first = at[0] ?? 0;
          // It cannot be earlier than the onset plus its own dwell, and the port
          // must raise it inside the hour that follows the onset.
          expect(
            first,
            `${code} was raised before the onset plus its dwell`,
          ).toBeGreaterThanOrEqual(F3_ONSET + dwellMsOf(entry.registry, code) - SAMPLE_MS);
          expect(first, `${code} was raised more than an hour after the onset`).toBeLessThanOrEqual(
            F3_ONSET + ONE_HOUR_MS,
          );
        }

        expect(
          activationsOf(replayed, "W101"),
          "a signature-A leak does not close the low-pressure switch",
        ).toEqual([]);
      },
      120_000,
    );

    it.skipIf(!slicesCut)(
      "raises W101 one dwell after the F4 switch closes, and W102 through the stuck-loaded run",
      async () => {
        const replayed = await replay(F4_SLICE, entry);
        const dwell = dwellMsOf(entry.registry, "W101");
        const at = activationsOf(replayed, "W101");
        console.info(
          `alarms-slices: ${F4_SLICE} (${entry.name}) raised W101 at ` +
            at.map((instant) => new Date(instant).toISOString()).join(", "),
        );

        // The acute episode: the switch closes at 17:20:11 and the message
        // follows one dwell later, which is 17:20:21 — the instant the data gives,
        // to the sample.
        const acute = at.find((instant) => instant >= F4_LPS_CLOSED);
        expect(acute, "W101 was never raised inside the F4 window").toBeDefined();
        expect(Math.abs((acute ?? 0) - (F4_LPS_CLOSED + dwell))).toBeLessThanOrEqual(SAMPLE_MS);
        expect(lastActiveOf(replayed, "W101") ?? 0).toBeGreaterThanOrEqual(
          F4_LPS_OPENED - ONE_HOUR_MS,
        );

        // The slice begins a day earlier and carries the precursor closure of
        // 14 July, so the *first* activation of the slice is that one rather
        // than the acute episode.
        const first = at[0] ?? 0;
        expect(Math.abs(first - (F4_PRECURSOR + dwell))).toBeLessThanOrEqual(SAMPLE_MS);

        // The stuck-loaded run begins at 14:25 and lasts until 18:53, so the
        // continuous-load message follows one continuous-load time later and
        // stays set for hours.
        const continuous = activationsOf(replayed, "W102");
        expect(continuous.length, "W102 was never raised on the F4 slice").toBeGreaterThan(0);
        const raisedAt = continuous[0] ?? 0;
        const expected = F4_STUCK_LOADED + dwellMsOf(entry.registry, "W102");
        expect(raisedAt).toBeGreaterThanOrEqual(expected - SAMPLE_MS);
        expect(raisedAt).toBeLessThanOrEqual(expected + STUCK_LOADED_SLACK_MS);
        expect((lastActiveOf(replayed, "W102") ?? 0) - raisedAt).toBeGreaterThanOrEqual(
          ONE_HOUR_MS,
        );
      },
      120_000,
    );

    it.skipIf(!slicesCut)(
      "raises nothing on the baseline day, and no W106 despite the start peak",
      async () => {
        const replayed = await replay(BASELINE_SLICE, entry);
        const raised = raisedOn(replayed);
        expect(
          [...raised.keys()].sort(),
          `the baseline day raised ${[...raised].map(([code, count]) => `${code}×${count}`).join(", ")}`,
        ).toEqual([]);
        expect(raised.get("W106") ?? 0).toBe(0);

        // Not vacuous: the day does carry loaded samples above the current
        // warning, and every one of them falls inside the start mask.
        const alarm = alarmOf(entry.registry, "W106");
        const leaf = conditionLeaves(alarm.condition)[0];
        expect(leaf?.signal).toBe("motor_current");
        const mask = maskMsOf(entry.registry, "W106");
        expect(mask, "W106 carries no start mask in this registry").toBeGreaterThan(0);

        let lastStart: number | undefined;
        let previous: MachineState = "off";
        const peaks: number[] = [];
        replayed.samples.forEach((sample, index) => {
          const state = replayed.states[index] ?? "off";
          const at = Date.parse(sample.sim_ts);
          if (previous === "off" && state !== "off") lastStart = at;
          previous = state;
          if (state !== "loaded") return;
          if (Number(sample.values["motor_current"] ?? 0) <= (leaf?.threshold ?? Infinity)) return;
          peaks.push(lastStart === undefined ? Infinity : at - lastStart);
        });

        console.info(
          `alarms-slices: ${BASELINE_SLICE} (${entry.name}) carried ${peaks.length} loaded ` +
            `sample(s) above ${String(leaf?.threshold)} ${String(leaf?.unit)}, all within ` +
            `${mask / 1_000} s of a start`,
        );
        for (const sinceStart of peaks) {
          expect(sinceStart, "a peak above the warning sat outside the start mask").toBeLessThan(
            mask,
          );
        }
      },
      120_000,
    );
  });

  it.skipIf(!slicesCut)(
    "carries a start peak the mask suppresses in at least one registry",
    async () => {
      // The baseline assertion above is only worth making because one of the
      // two registries does see a peak; this is the guard that keeps it so.
      let seen = 0;
      for (const entry of REGISTRIES) {
        const replayed = await replay(BASELINE_SLICE, entry);
        const leaf = conditionLeaves(alarmOf(entry.registry, "W106").condition)[0];
        seen += replayed.samples.filter(
          (sample, index) =>
            replayed.states[index] === "loaded" &&
            Number(sample.values["motor_current"] ?? 0) > (leaf?.threshold ?? Infinity),
        ).length;
      }
      expect(seen, "no registry sees a start peak on the baseline day").toBeGreaterThan(0);
    },
    120_000,
  );
});
