// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Detection-shaped calibration events for the rules twin.
 *
 * The first calibration ran on five hand-built events whose raw signals sat
 * normal and flat, a picture detection never sends. The events here come out of
 * the real detector instead: each one is a run of synthetic telemetry written
 * from the manual — the cause descriptions of `manual/spec/faults.yaml` as the
 * reference catalog carries them, the operating chapter
 * (`manual/content/06-operation.md`) — and from `manual/spec/machine.yaml` and
 * `settings.yaml`, replayed through `createDetector` exactly as the pipeline
 * replays telemetry. Nothing here is read from a labelled window, a scenario
 * file, the injection catalog or a recorded reading of the core-10.
 *
 * Every run starts from the first-month cycle of `waveform.ts` (the reference
 * operation of machine.yaml) and moves only what the manual says the cause
 * moves. Each number that is not the reference operation's names its source
 * where it is declared.
 *
 * Two things every run adds to the waveform:
 *
 * - **Instrument jitter.** A few millibar, hundredths of a degree and of an
 *   ampere, far inside each sensor's stated accuracy, as a pure function of the
 *   sample. A real transducer never repeats itself to the millibar for minutes
 *   on end, and a run that did would read as a stalled logger to the frozen
 *   guard and the stale-frame test of the rule registry rather than as a machine.
 * - **The simulator's ambient.** `runRows` already carries it;
 *   only the hot-room run overrides it.
 *
 * Which event a case is: the event detection raises when a symptom starts
 * firing, or — where the case is about a moment later in the same episode —
 * the event a re-decision would send at that moment (`Detector.buildEvent`),
 * which is what the pipeline decides on every
 * `DECISION_INTERVAL_SIM_MIN` while the symptom keeps firing.
 *
 * The last three sections are not for the twin: they write the manual's own
 * start failure (alarm S304) for the state builder, which names a load request
 * the motor does not answer, a dryer whose towers stop changing over, whose
 * state row carries the sentence of the rule that saw it, and a condensate
 * drain that stays open while the unit idles, whose separator row carries the
 * sentence of the rule that saw it.
 */

import { SIGNALS, type MachineMode, type Sample } from "@fdp/contracts";

import { fixedClock } from "../../../src/clock.ts";
import {
  createDetector,
  resolveRoles,
  type FeatureFrame,
  type RuleHit,
  type SuspectEventMessage,
} from "../../../src/detection/index.ts";
import { VALUE_WINDOW_S } from "../../../src/detection/features.ts";
import { ambientC } from "../telemetry/ambient.ts";
import { toBatches, type DecodedRow } from "../telemetry/rows.ts";
import {
  BASELINE_CYCLE,
  CUT_IN_BAR,
  CUT_OUT_BAR,
  cyclePhases,
  cycles,
  DISCHARGE_VENTED_BAR,
  MOTOR_OFF_A,
  NORMAL_DECAY_BAR_PER_MIN,
  runRows,
  SEPARATOR_LOADED_BAR,
  type CycleShape,
  type Phase,
} from "./waveform.ts";

/** The unit every calibration run is published for. */
export const CALIBRATION_UNIT_ID = "cau-7";

/** Line pressure rise while loaded, `reference_operation.pressure_rise_loaded` of machine.yaml. */
const PRESSURE_RISE_BAR_PER_MIN = 1.1;

/** `settings.yaml` `purge_pressure_warning`: the controller calls the purge line high above it. */
const PURGE_PRESSURE_WARNING_BAR = 0.5;

/** `settings.yaml` `motor_current_low_warning`: the controller calls the loaded current low under it. */
const MOTOR_CURRENT_LOW_WARNING_A = 5.0;

/** `settings.yaml` `oil_temperature_warning` and `oil_temperature_shutdown_warning`. */
const OIL_WARNING_C = 75;
const OIL_SHUTDOWN_WARNING_C = 85;

/** `machine.yaml` `limits.ambient_operating.max`, also the controller's high-ambient warning. */
const AMBIENT_OPERATING_MAX_C = 40;

/** A mild spring day: the simulator's ambient stays between 13 and 23 °C all day. */
const MILD_DAY = "2020-05-12T06:00:00.000Z";

/** A January midnight: the simulator's ambient is about 5 °C. */
const COLD_NIGHT = "2020-01-15T00:00:00.000Z";

/**
 * Reference cycles every run starts with: two hours of the first-month cycle,
 * enough to fill the warm-up guard, the two-hour oil trend and the five-cycle
 * history the behaviours are compared against.
 */
const LEAD_CYCLES = 4;

/** One calibration event and what its frames were written from. */
export interface CalibrationEvent {
  readonly name: string;
  /** The manual's description the frames follow, in a sentence. */
  readonly writtenFrom: string;
  readonly event: SuspectEventMessage;
}

/** The three machine states an event can be decided in. */
export type RunningMode = Exclude<MachineMode, "unknown">;

type TagValues = Readonly<Record<string, number | boolean>>;

/** Where one sample sits in its run. */
interface SampleContext {
  readonly simTsMs: number;
  readonly mode: RunningMode;
  /** Seconds since the fault began; negative in the reference lead. */
  readonly faultS: number;
  /** Seconds since the fault began that the machine spent loaded. */
  readonly faultLoadedS: number;
}

/** Tag values an effect writes over the waveform's: a number for an analog tag, a boolean for a digital one. */
type Overrides = Readonly<Record<string, number | boolean>>;

/** What a cause does to one sample beyond the pressures its phases already carry. */
type Effect = (values: TagValues, at: SampleContext) => Overrides;

/** An effect's answer for a sample the cause leaves as the waveform wrote it. */
const UNCHANGED: Overrides = {};

/** A calibration run: reference cycles, then the cause. */
interface Script {
  readonly startSimTs: string;
  readonly lead: readonly Phase[];
  readonly fault: readonly Phase[];
  readonly effect?: Effect;
  /**
   * Tags written exactly as the waveform and the effect give them, without the
   * instrument jitter: for a case that has to sit on a threshold to the digit.
   */
  readonly unjittered?: readonly string[];
}

/**
 * A moment of the run at which the pipeline would re-decide.
 *
 * `within` marks the frames of a stretch of the run; the moment is its first
 * frame, or its last one — the frame deepest into the stretch, where every
 * window of the frame has had the longest time to fill with it.
 */
interface Moment {
  readonly name: string;
  readonly within: (frame: FeatureFrame, firing: readonly RuleHit[]) => boolean;
  readonly take: "first" | "last";
}

/** What detection said over one run. */
interface Replay {
  /** Every event detection raised, in order: each is a symptom that started firing. */
  readonly raised: readonly SuspectEventMessage[];
  /** The re-decision event of each moment that came, by name. */
  readonly rebuilt: ReadonlyMap<string, SuspectEventMessage>;
}

/** The machine state of one decoded row. */
function modeOf(values: TagValues): RunningMode {
  if (values.intake_closed === false && values.load_valve === true) return "loaded";
  return (values.motor_current as number) >= 1 ? "unloaded" : "off";
}

function secondsOf(phases: readonly Phase[]): number {
  return phases.reduce((total, phase) => total + phase.seconds, 0);
}

/**
 * The instrument jitter of one tag on one sample, in [−1, 1].
 *
 * A fixed hash of the sample and the tag, so a run is the same run every time
 * it is built and no generator has to be seeded.
 */
function jitterUnit(index: number, channel: number): number {
  const x = Math.sin((index + 1) * 12.9898 + channel * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

/**
 * Jitter amplitude and published resolution per analog tag: the register map's
 * scale (int16 / 1000 for a pressure, / 100 for a temperature or a current)
 * and a few of its steps, far inside the accuracy machine.yaml states.
 */
const JITTER: readonly { tag: string; amplitude: number; step: number }[] = [
  { tag: "discharge_pressure", amplitude: 0.002, step: 0.001 },
  { tag: "line_pressure", amplitude: 0.002, step: 0.001 },
  { tag: "separator_discharge_pressure", amplitude: 0.002, step: 0.001 },
  { tag: "dryer_purge_pressure", amplitude: 0.002, step: 0.001 },
  { tag: "reservoir_pressure", amplitude: 0.002, step: 0.001 },
  { tag: "oil_temperature", amplitude: 0.05, step: 0.01 },
  { tag: "motor_current", amplitude: 0.01, step: 0.01 },
];

function withJitter(
  values: TagValues,
  index: number,
  exact: ReadonlySet<string>,
): Record<string, number | boolean> {
  const jittered: Record<string, number | boolean> = { ...values };
  JITTER.forEach(({ tag, amplitude, step }, channel) => {
    const value = values[tag];
    if (typeof value !== "number" || exact.has(tag)) return;
    const moved = value + amplitude * jitterUnit(index, channel);
    jittered[tag] = Math.round(moved / step) * step;
  });
  return jittered;
}

/** The samples of a run, as the gateway would have published them. */
function samplesOf(script: Script): Sample[] {
  const rows = runRows([...script.lead, ...script.fault], { startSimTs: script.startSimTs });
  const faultStartMs = Date.parse(script.startSimTs) + secondsOf(script.lead) * 1000;
  const exact = new Set(script.unjittered ?? []);

  let faultLoadedS = 0;
  let previousMs: number | undefined;
  const written: DecodedRow[] = rows.map((row, index) => {
    const mode = modeOf(row.values);
    const faultS = (row.simTsMs - faultStartMs) / 1000;
    if (faultS > 0 && mode === "loaded" && previousMs !== undefined) {
      faultLoadedS += (row.simTsMs - previousMs) / 1000;
    }
    previousMs = row.simTsMs;
    const at: SampleContext = { simTsMs: row.simTsMs, mode, faultS, faultLoadedS };
    const values = { ...row.values, ...script.effect?.(row.values, at) };
    return { ...row, values: withJitter(values, index, exact) };
  });

  return toBatches(written, {
    unitId: CALIBRATION_UNIT_ID,
    wallStartMs: Date.parse("2026-09-23T00:00:00.000Z"),
  }).flatMap((batch) => batch.samples);
}

/** Replay a run through the real detector, as the pipeline would. */
function replay(samples: readonly Sample[], moments: readonly Moment[] = []): Replay {
  let next = 0;
  const detector = createDetector({
    roles: resolveRoles(SIGNALS),
    unitId: CALIBRATION_UNIT_ID,
    wall: fixedClock("2026-09-23T00:00:00.000Z"),
    newEventId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
  });

  const raised: SuspectEventMessage[] = [];
  const rebuilt = new Map<string, SuspectEventMessage>();
  /** The latest frame of a `last` moment's stretch, until the stretch ends. */
  const pending = new Map<string, SuspectEventMessage>();

  function settle(name: string): void {
    const event = pending.get(name);
    if (event === undefined) return;
    rebuilt.set(name, event);
    pending.delete(name);
  }

  for (const sample of samples) {
    const output = detector.push(sample);
    raised.push(...output.events);
    const frame = output.frame;
    if (frame === undefined) continue;
    for (const moment of moments) {
      if (rebuilt.has(moment.name)) continue;
      if (!moment.within(frame, output.firing)) {
        settle(moment.name);
        continue;
      }
      const event = detector.buildEvent();
      if (event === undefined) continue;
      if (moment.take === "first") rebuilt.set(moment.name, event);
      else pending.set(moment.name, event);
    }
  }
  for (const name of [...pending.keys()]) settle(name);
  return { raised, rebuilt };
}

/** The first event raised under `symptom`; a run that raises none is a broken fixture. */
function raisedUnder(run: Replay, symptom: string, name: string): SuspectEventMessage {
  const event = run.raised.find((candidate) => candidate.symptom_key === symptom);
  if (event === undefined) {
    const seen = run.raised.map((candidate) => candidate.symptom_key).join(", ") || "none";
    throw new Error(`calibration ${name}: detection raised no ${symptom} event (raised: ${seen})`);
  }
  return event;
}

function rebuiltAt(run: Replay, moment: string, name: string): SuspectEventMessage {
  const event = run.rebuilt.get(moment);
  if (event === undefined)
    throw new Error(`calibration ${name}: the moment "${moment}" never came`);
  return event;
}

function firingUnder(firing: readonly RuleHit[], symptom: string): boolean {
  return firing.some((hit) => hit.symptom_key === symptom);
}

/** The reference cycles of machine.yaml, `count` of them. */
function referenceCycles(count: number = LEAD_CYCLES): Phase[] {
  return cycles(BASELINE_CYCLE, count);
}

// ---------------------------------------------------------------------------
// The reference operation.
// ---------------------------------------------------------------------------

/**
 * The events detection raises over four hours of the reference operation.
 *
 * None, by design: every detection rule sits above what the manual
 * calls normal, so the healthy machine is never put in front of the twin.
 */
export function referenceOperationEvents(): readonly SuspectEventMessage[] {
  const script: Script = { startSimTs: MILD_DAY, lead: referenceCycles(8), fault: [] };
  return replay(samplesOf(script)).raised;
}

// ---------------------------------------------------------------------------
// Signature A: the dryer purge valve no longer closes.
// ---------------------------------------------------------------------------

/**
 * Where the line creeps to while the delivery only just covers the loss: midway
 * between cut-in and cut-out, above the low-pressure switch and short of cut-out.
 */
const SIGNATURE_A_PLATEAU_BAR = (CUT_IN_BAR + CUT_OUT_BAR) / 2;

/** How long the frames keep the unit loaded: "loaded for hours on end". */
const SIGNATURE_A_LOADED_S = 90 * 60;

/** Twice the purge-pressure warning: the purge line is pressurised continuously. */
const SIGNATURE_A_PURGE_BAR = 2 * PURGE_PRESSURE_WARNING_BAR;

/** Under the controller's low-current warning: the element works against a lower plateau. */
const SIGNATURE_A_MOTOR_A = MOTOR_CURRENT_LOW_WARNING_A - 0.4;

/** A gradual climb while the unit stays loaded for hours on end. */
const SIGNATURE_A_OIL_RISE_C_PER_H = 3;

/**
 * Signature A (`dryer_purge_leak`): the event detection raises once the unit
 * has stayed loaded long enough for `continuous_load` to start.
 *
 * Written from the cause: the purge valve no longer closes, dried air escapes
 * through the regeneration line continuously, and the unit delivers against
 * that loss without reaching its cut-out while the line stays above the
 * low-pressure switch. The purge pressure is high while loaded, the loaded run
 * does not end — the line creeps from cut-in towards a plateau short of
 * cut-out — the motor current is low and the oil climbs slowly.
 */
export function signatureA(): CalibrationEvent {
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: [
      {
        mode: "loaded",
        seconds: SIGNATURE_A_LOADED_S,
        fromBar: CUT_IN_BAR,
        toBar: SIGNATURE_A_PLATEAU_BAR,
      },
    ],
    effect: (values, at) => {
      if (at.faultS < 0 || at.mode !== "loaded") return UNCHANGED;
      return {
        dryer_purge_pressure: SIGNATURE_A_PURGE_BAR,
        motor_current: SIGNATURE_A_MOTOR_A,
        oil_temperature:
          (values.oil_temperature as number) +
          (SIGNATURE_A_OIL_RISE_C_PER_H * at.faultLoadedS) / 3600,
      };
    },
  };
  return {
    name: "signature A",
    writtenFrom:
      "dryer_purge_leak: purge line pressurised while loaded, no cut-out, line above the " +
      "low-pressure switch, motor current low, oil climbing slowly",
    event: raisedUnder(replay(samplesOf(script)), "continuous_load", "signature A"),
  };
}

// ---------------------------------------------------------------------------
// A leak in the distribution network, before and after the switch closes.
// ---------------------------------------------------------------------------

/** The leak, as a share of what the unit delivers while loaded. */
const EARLY_LEAK_SHARE = 0.25;
const LATE_LEAK_SHARE = 1.25;

/** A cycle whose loaded run and idle decay both carry a leak of `share` of the delivery. */
function leakCycle(share: number): CycleShape {
  const leakBarPerMin = share * PRESSURE_RISE_BAR_PER_MIN;
  const netRise = PRESSURE_RISE_BAR_PER_MIN - leakBarPerMin;
  return {
    ...BASELINE_CYCLE,
    loadedS: ((CUT_OUT_BAR - CUT_IN_BAR) / netRise) * 60,
    decayBarPerMin: BASELINE_CYCLE.decayBarPerMin + leakBarPerMin,
  };
}

/** The two moments of a downstream leak the calibration decides on. */
export interface DownstreamLeak {
  readonly beforeSwitch: CalibrationEvent;
  readonly afterSwitch: CalibrationEvent;
}

/**
 * A leak in the plant (`downstream_air_leak`).
 *
 * Written from the cause: air escapes behind the reservoirs day and night and
 * the loss grows. First the idle decay grows faster, the unit loads more often
 * and each loaded run lasts longer, while the line still reaches cut-out
 * (a quarter of the delivery lost); late in the fault the loss outgrows the
 * delivery, the line sinks while the unit is still loaded and the
 * low-pressure switch closes (a quarter more than the unit delivers).
 *
 * `beforeSwitch` is the first event detection raises while the switch is still
 * open; `afterSwitch` is the event a re-decision sends as soon as the
 * low-pressure-switch rule fires with the motor running.
 */
export function downstreamLeak(): DownstreamLeak {
  const earlyCycles = cycles(leakCycle(EARLY_LEAK_SHARE), 8);
  const lateNetBarPerMin = (LATE_LEAK_SHARE - 1) * PRESSURE_RISE_BAR_PER_MIN;
  const lateLoadedS = 10 * 60;
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: [
      ...earlyCycles,
      {
        mode: "loaded",
        seconds: lateLoadedS,
        fromBar: CUT_IN_BAR,
        toBar: CUT_IN_BAR - (lateNetBarPerMin * lateLoadedS) / 60,
      },
    ],
  };
  const run = replay(samplesOf(script), [
    {
      name: "switch closed",
      within: (_frame, firing) => firing.some((hit) => hit.rule_id === "low_pressure_switch"),
      take: "first",
    },
  ]);

  const switchClosedAt = run.rebuilt.get("switch closed")?.sim_ts;
  const before = run.raised.find(
    (event) => switchClosedAt === undefined || event.sim_ts < switchClosedAt,
  );
  if (before === undefined) {
    throw new Error("calibration downstream leak: detection raised nothing before the switch");
  }
  return {
    beforeSwitch: {
      name: "downstream leak, before the switch closes",
      writtenFrom:
        "downstream_air_leak, early: idle decay faster, more load cycles, longer loaded runs, " +
        "cut-out still reached",
      event: before,
    },
    afterSwitch: {
      name: "downstream leak, after the switch closes",
      writtenFrom:
        "downstream_air_leak, late: the line falls while loaded and the low-pressure switch " +
        "closes with the motor running",
      event: rebuiltAt(run, "switch closed", "downstream leak"),
    },
  };
}

// ---------------------------------------------------------------------------
// A fouled oil cooler, on a mild day and on a cold night.
// ---------------------------------------------------------------------------

/** Midway between the oil-temperature warning and the shutdown warning of settings.yaml. */
const FOULED_COOLER_OIL_C = (OIL_WARNING_C + OIL_SHUTDOWN_WARNING_C) / 2;

/**
 * Weeks of fouling have already happened: the oil runs hot in every state
 * while the duty (the reference cycle), the room (the simulator's ambient) and
 * the current stay as they always were.
 */
function fouledCoolerScript(startSimTs: string): Script {
  return {
    startSimTs,
    lead: [],
    fault: referenceCycles(10),
    effect: () => ({ oil_temperature: FOULED_COOLER_OIL_C }),
  };
}

const OIL_COOLER_SOURCE =
  "oil_cooler_fouled: the oil runs hotter in every state while the duty, the room and the " +
  "motor current stay as they were";

/** The re-decision at the end of the first stretch of each state while the oil rule fires. */
function endOfEachState(run: readonly Sample[]): Replay {
  const modes: readonly RunningMode[] = ["off", "unloaded", "loaded"];
  return replay(
    run,
    modes.map((mode) => ({
      name: mode,
      within: (frame, firing) => frame.mode === mode && firingUnder(firing, "oil_temperature_high"),
      take: "last",
    })),
  );
}

/**
 * The fouled cooler of `oil_cooler_fouled`, decided once in each machine state.
 *
 * One run on a mild day. Each event is the re-decision the pipeline would send
 * at the last frame of the first stretch of that state after
 * `oil_temperature_high` started firing: the frame deepest into the state, so
 * the stopped and idling pictures are read with every window inside them. A
 * loaded run of the reference cycle lasts under two minutes, so the loaded
 * picture still carries the cut-in in its five-minute trends, as it does on
 * the machine. The evidence is the same in all three; only the state the
 * machine happens to be in when the decision falls differs.
 */
export function oilCoolerByMode(): Readonly<Record<RunningMode, CalibrationEvent>> {
  const run = endOfEachState(samplesOf(fouledCoolerScript(MILD_DAY)));
  const byMode = (mode: RunningMode): CalibrationEvent => ({
    name: `oil cooler, ${mode}`,
    writtenFrom: OIL_COOLER_SOURCE,
    event: rebuiltAt(run, mode, `oil cooler (${mode})`),
  });
  return { off: byMode("off"), unloaded: byMode("unloaded"), loaded: byMode("loaded") };
}

/**
 * The same fouled cooler on a January night, the simulator's ambient near
 * 5 °C, decided at the same moment as the mild day's stopped picture: the end
 * of the first stretch with the motor off. Only the room differs.
 */
export function coldNightOilCooler(): CalibrationEvent {
  const run = endOfEachState(samplesOf(fouledCoolerScript(COLD_NIGHT)));
  return {
    name: "oil cooler, cold night",
    writtenFrom: `${OIL_COOLER_SOURCE}, on a night when the room is cold`,
    event: rebuiltAt(run, "off", "cold-night oil cooler"),
  };
}

// ---------------------------------------------------------------------------
// A hot room: the benign cause of hot oil.
// ---------------------------------------------------------------------------

/**
 * Close to the hottest room the unit is rated for: 18 °C above the 20 °C
 * reference conditions and 2 °C under the operating limit (and the
 * controller's high-ambient warning) of machine.yaml.
 */
const HOT_ROOM_C = AMBIENT_OPERATING_MAX_C - 2;

/** How long the room takes to warm from its usual temperature to {@link HOT_ROOM_C}. */
const HOT_ROOM_WARMING_S = 2 * 3600;

/**
 * A room much warmer than usual (`high_ambient_temperature`): the event
 * detection raises when `oil_temperature_high` starts.
 *
 * Written from the cause: the unit and its cooling circuit are sound; the
 * cooling air is hot, and the oil keeps the difference to it that it always
 * had, so both sit higher. The room warms from the simulator's ambient to
 * {@link HOT_ROOM_C} over two hours and stays there; the oil follows it degree
 * for degree.
 */
export function hotRoom(): CalibrationEvent {
  const lead = referenceCycles();
  const faultStartMs = Date.parse(MILD_DAY) + secondsOf(lead) * 1000;
  const usualC = ambientC(faultStartMs);
  const script: Script = {
    startSimTs: MILD_DAY,
    lead,
    fault: referenceCycles(10),
    effect: (values, at) => {
      if (at.faultS < 0) return UNCHANGED;
      const share = Math.min(1, at.faultS / HOT_ROOM_WARMING_S);
      const roomC = usualC + share * (HOT_ROOM_C - usualC);
      return {
        ambient_temperature: roomC,
        oil_temperature: (values.oil_temperature as number) + (roomC - usualC),
      };
    },
  };
  return {
    name: "hot room",
    writtenFrom:
      "high_ambient_temperature: the cooling air is hot, the oil keeps its usual difference to " +
      "it, the duty and the current are unchanged",
    event: raisedUnder(replay(samplesOf(script)), "oil_temperature_high", "hot room"),
  };
}

// ---------------------------------------------------------------------------
// Baseline and depot: the two cases the calibration wants only logged.
// ---------------------------------------------------------------------------

/**
 * An idle decay at which the off phase just drops under `frequent_cycling`'s
 * 250 s median: 235 s. It lies above the manual's typical
 * band (0.05–0.15 bar/min, machine.yaml) and inside the first month's own
 * p95–p99 (0.149–0.288 bar/min, `baseline.ts`), under `fast_decay`'s floor.
 */
const BUSIER_HOUR_DECAY_BAR_PER_MIN =
  ((CUT_OUT_BAR - CUT_IN_BAR) / (BASELINE_CYCLE.runOnS + 235)) * 60;

/**
 * Baseline: a healthy unit on a busier hour than February, with one rule
 * firing at its threshold — the detection-shaped form of the hand-built
 * baseline event. Every other signal runs the reference operation.
 */
export function baselineBusierHour(): CalibrationEvent {
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: cycles({ ...BASELINE_CYCLE, decayBarPerMin: BUSIER_HOUR_DECAY_BAR_PER_MIN }, 6),
  };
  return {
    name: "baseline",
    writtenFrom:
      "the reference operation of machine.yaml, with the consumers drawing a little more air " +
      "for an hour",
    event: raisedUnder(replay(samplesOf(script)), "frequent_cycling", "baseline"),
  };
}

/** How long the unit stands vented at the depot. */
const DEPOT_STAND_S = 3600;

/** How long the vent takes, from cut-in pressure to zero. */
const DEPOT_VENT_S = 8 * 60;

/** The unloaded run after START, while the oil circuit fills. */
const START_UNLOADED_S = 60;

/**
 * Depot: the unit stopped, its line vented, standing with the motor off, then
 * started again — the event detection raises when the low-pressure switch has
 * been closed with the motor running.
 *
 * Written from the operating chapter: a stopped unit is vented section by
 * section before work on the air side; at START the controller runs the unit
 * unloaded while the oil circuit fills and then loads it, because the line is
 * below cut-in. Nothing is wrong with the machine: the switch is closed
 * because the line was emptied on purpose.
 */
export function depot(): CalibrationEvent {
  const restartS = ((CUT_OUT_BAR - 0) / PRESSURE_RISE_BAR_PER_MIN) * 60;
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: [
      {
        mode: "off",
        seconds: DEPOT_VENT_S,
        fromBar: CUT_IN_BAR,
        decayBarPerMin: CUT_IN_BAR / (DEPOT_VENT_S / 60),
      },
      { mode: "off", seconds: DEPOT_STAND_S, fromBar: 0, decayBarPerMin: 0 },
      { mode: "unloaded", seconds: START_UNLOADED_S, fromBar: 0, decayBarPerMin: 0 },
      { mode: "loaded", seconds: Math.round(restartS / 10) * 10, fromBar: 0, toBar: CUT_OUT_BAR },
      ...cyclePhases(BASELINE_CYCLE).slice(1),
      ...referenceCycles(2),
    ],
  };
  return {
    name: "depot",
    writtenFrom:
      "06-operation.md: a stopped unit vented before work on the air side, then started " +
      "against an empty line",
    event: raisedUnder(replay(samplesOf(script)), "low_line_pressure", "depot"),
  };
}

// ---------------------------------------------------------------------------
// A motor that does not start: the manual's S304, for the state builder.
// ---------------------------------------------------------------------------

/** `alarms.yaml` S304 "Motor start failure": the load valve is open and the motor draws less than this. */
export const S304_CURRENT_A = 1.0;

/** `alarms.yaml` S304: how long that picture holds before the controller raises the message. */
export const S304_HOLD_S = 20;

/**
 * How long the frames hold the load request the motor does not answer: three
 * minutes, past S304's hold and past detection's one-minute value window
 * (`VALUE_WINDOW_S`), so a decision can fall on a frame whose motor-current
 * median was read wholly inside the request.
 */
const START_FAILURE_REQUEST_S = 3 * 60;

/** How long the unit stands stopped after the request, until it is reset and started again. */
const START_FAILURE_STAND_S = 10 * 60;

/**
 * The mild day of the other runs, half a minute off the minute grid. The
 * feature engine recomputes a frame on every sim minute and on every change of
 * state, so the request gets a frame on its cut-in and another one half a
 * minute into it, inside the value window.
 */
const START_FAILURE_DAY = "2020-05-12T06:00:30.000Z";

/** What a start-failure run varies. */
export interface StartFailureOptions {
  /**
   * What the motor draws while the load valve is open: a motor at rest by
   * default (the reference operation's stopped current); a test puts it on
   * S304's threshold or just under it.
   */
  readonly currentA?: number;
  /**
   * Keep the oil hot for the whole run (the fouled cooler above), so a
   * symptom fires in every state and a re-decision can fall on any frame, as
   * one does every `DECISION_INTERVAL_SIM_MIN` while an episode is open.
   */
  readonly hotOil?: boolean;
}

/**
 * The moments of a start-failure run a re-decision is taken at. Each is the
 * first or last frame of its stretch on which something fires, so a test
 * reads the event's own times rather than trusting the name:
 *
 * - `cut-in`: the first frame of the load request;
 * - `first minute`: the last frame of the request younger than the value window;
 * - `past the window`: the first frame of the request at or past the value window;
 * - `end of request`: the last frame of the request;
 * - `stopped`: the first frame of the stop S304 orders;
 * - `end of stand`: the last frame of that stop; with hot oil firing through
 *   it, the motor has been at rest for longer than the value window;
 * - `restart`: the first frame of the restart, the motor turning unloaded.
 */
export type StartFailureMoment =
  | "cut-in"
  | "first minute"
  | "past the window"
  | "end of request"
  | "stopped"
  | "end of stand"
  | "restart";

/** What detection said over a start-failure run. */
export interface StartFailure {
  /** Every event detection raised from the load request on, in order. */
  readonly raised: readonly CalibrationEvent[];
  /** The re-decision event at one moment; throws when the moment never came. */
  readonly at: (moment: StartFailureMoment) => CalibrationEvent;
}

const START_FAILURE_SOURCE =
  "alarms.yaml S304: the load valve open and the motor current under 1.0 A, past the 20 s hold";

/** The phases after the reference lead: the request, the stop, the reset and START, a refill. */
function startFailurePhases(): Phase[] {
  const fall = (fromBar: number, seconds: number): number =>
    fromBar - (NORMAL_DECAY_BAR_PER_MIN * seconds) / 60;
  const afterRequest = fall(CUT_IN_BAR, START_FAILURE_REQUEST_S);
  const afterStand = fall(afterRequest, START_FAILURE_STAND_S);
  const afterStart = fall(afterStand, START_UNLOADED_S);
  const refillS = ((CUT_OUT_BAR - afterStart) / PRESSURE_RISE_BAR_PER_MIN) * 60;
  return [
    // The request: both valves say loaded, nothing turns, the plant keeps drawing.
    { mode: "loaded", seconds: START_FAILURE_REQUEST_S, fromBar: CUT_IN_BAR, toBar: afterRequest },
    // The stop S304 orders; start stays inhibited until the message is reset.
    {
      mode: "off",
      seconds: START_FAILURE_STAND_S,
      fromBar: afterRequest,
      decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN,
    },
    // Reset and START: unloaded while the oil circuit fills, then loaded, the line being low.
    {
      mode: "unloaded",
      seconds: START_UNLOADED_S,
      fromBar: afterStand,
      decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN,
    },
    {
      mode: "loaded",
      seconds: Math.round(refillS / 10) * 10,
      fromBar: afterStart,
      toBar: CUT_OUT_BAR,
    },
    ...cyclePhases(BASELINE_CYCLE).slice(1),
  ];
}

/**
 * A start failure (`no_start`, alarm S304), replayed through the detector.
 *
 * Written from the manual: at a cut-in the controller energises the load
 * solenoid and opens the intake, and the motor draws no current, so the drive
 * never started (S304's `cause_hint`, faults.yaml `no_start`). Nothing
 * delivers: the discharge side stays vented and the line keeps falling at the
 * plant's draw. S304 is that picture, `load_valve = 1` and
 * `motor_current < 1.0 A`, held for 20 s. The manual's controller then stops
 * the unit and inhibits start until the message is reset; after a ten-minute
 * stand the unit is reset and started as the operating chapter describes,
 * unloaded while the oil circuit fills and then loaded, the line being below
 * cut-in.
 *
 * Detection reads the valve digitals and the current, not the controller's
 * intent, so the picture's length decides what it raises: every rule it could
 * fire here holds a minute or longer, and a request the controller ends at the
 * trip is over before one fires. The frames hold the picture for three
 * minutes — past S304's hold and past the value window — which is the case
 * the state builder's stopped-motor word exists for. The motor current is
 * written exactly, without jitter, so
 * a threshold case sits on S304's 1.0 A to the digit; the pressures and the
 * oil keep theirs, which is what keeps the frozen guard quiet.
 */
export function startFailure(options: StartFailureOptions = {}): StartFailure {
  const currentA = options.currentA ?? MOTOR_OFF_A;
  const hotOil = options.hotOil ?? false;
  const lead = referenceCycles();
  const script: Script = {
    startSimTs: START_FAILURE_DAY,
    lead,
    fault: startFailurePhases(),
    unjittered: ["motor_current"],
    effect: (_values, at) => {
      const inRequest = at.faultS >= 0 && at.faultS < START_FAILURE_REQUEST_S;
      return {
        ...(hotOil ? { oil_temperature: FOULED_COOLER_OIL_C } : {}),
        ...(inRequest ? { motor_current: currentA, discharge_pressure: DISCHARGE_VENTED_BAR } : {}),
      };
    },
  };

  const requestFromMs = Date.parse(START_FAILURE_DAY) + secondsOf(lead) * 1000;
  const windowEndMs = requestFromMs + VALUE_WINDOW_S * 1000;
  const requestToMs = requestFromMs + START_FAILURE_REQUEST_S * 1000;
  const standToMs = requestToMs + START_FAILURE_STAND_S * 1000;
  const startToMs = standToMs + START_UNLOADED_S * 1000;
  const timeOf = (frame: FeatureFrame): number => Date.parse(frame.sim_ts);
  const inRequest = (frame: FeatureFrame): boolean =>
    frame.mode === "loaded" && timeOf(frame) >= requestFromMs && timeOf(frame) < requestToMs;
  const inStand = (frame: FeatureFrame): boolean =>
    frame.mode === "off" && timeOf(frame) >= requestToMs && timeOf(frame) < standToMs;

  const run = replay(samplesOf(script), [
    { name: "cut-in", within: inRequest, take: "first" },
    {
      name: "first minute",
      within: (frame) => inRequest(frame) && timeOf(frame) < windowEndMs,
      take: "last",
    },
    {
      name: "past the window",
      within: (frame) => inRequest(frame) && timeOf(frame) >= windowEndMs,
      take: "first",
    },
    { name: "end of request", within: inRequest, take: "last" },
    { name: "stopped", within: inStand, take: "first" },
    { name: "end of stand", within: inStand, take: "last" },
    {
      name: "restart",
      within: (frame) =>
        frame.mode === "unloaded" && timeOf(frame) >= standToMs && timeOf(frame) < startToMs,
      take: "first",
    },
  ]);

  const label = `start failure (${currentA} A${hotOil ? ", hot oil" : ""})`;
  const named = (event: SuspectEventMessage, moment?: StartFailureMoment): CalibrationEvent => ({
    name: moment === undefined ? label : `${label}, ${moment}`,
    writtenFrom: START_FAILURE_SOURCE,
    event,
  });
  return {
    raised: run.raised
      .filter((event) => Date.parse(event.sim_ts) >= requestFromMs)
      .map((event) => named(event)),
    at: (moment) => named(rebuiltAt(run, moment, label), moment),
  };
}

// ---------------------------------------------------------------------------
// The dryer towers stop changing over, for the state builder.
// ---------------------------------------------------------------------------

/** How many cycles the towers are held: past `dryer_tower_not_switching`'s three, with a margin. */
const TOWERS_HELD_CYCLES = 5;

/**
 * A dryer whose towers no longer change over (`dryer_changeover_fault`),
 * replayed through the detector.
 *
 * Written from the manual: the tower indication "stops alternating and holds
 * one position" (faults.yaml, `tower_changeover_valve_fault`; the same
 * movement opens `dryer_controller_fault`), which is what the condition "Dryer
 * towers do not change over" sees on the display, and the compressor side of
 * the unit is untouched by the fault (both causes' `load_cycle_rate
 * unchanged`). The reference cycle pulses the tower indication over shortly
 * after every cut-in (`waveform.ts`, the first month's `towers_pulse_s`); here
 * it holds its resting value through every cut-in instead, and nothing else
 * moves.
 */
export function dryerTowersHeld(): CalibrationEvent {
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: referenceCycles(TOWERS_HELD_CYCLES),
    effect: (_values, at) => (at.faultS >= 0 ? { dryer_tower: true } : UNCHANGED),
  };
  return {
    name: "dryer towers held",
    writtenFrom:
      "tower_changeover_valve_fault: the tower indication stops alternating and holds one " +
      "position; the compressor side of the unit is untouched",
    event: raisedUnder(replay(samplesOf(script)), "dryer_changeover_fault", "dryer towers held"),
  };
}

// ---------------------------------------------------------------------------
// The condensate drain stays open while the unit idles, for the state builder.
// ---------------------------------------------------------------------------

/** How many cycles the drain stays open: `separator_not_venting` fires in the first idle phase. */
const DRAIN_OPEN_CYCLES = 2;

/**
 * A condensate drain that no longer closes (`separator_pressure_abnormal`),
 * replayed through the detector.
 *
 * Written from the manual: signals.yaml has the separator discharge port
 * vented close to atmospheric while the unit delivers and standing at the line
 * pressure while it does not, and with the drain stuck open "the pressure at
 * the separator discharge collapses instead of following the line while the
 * unit idles" (faults.yaml, `condensate_drain_stuck_open`, its `near_zero` move
 * while unloaded). Here the reading keeps its vented, loaded value through
 * every idle phase once the fault has begun, so after each cut-out it never
 * comes back up to the line, and nothing else moves.
 */
export function separatorDrainOpen(): CalibrationEvent {
  const script: Script = {
    startSimTs: MILD_DAY,
    lead: referenceCycles(),
    fault: referenceCycles(DRAIN_OPEN_CYCLES),
    effect: (_values, at) =>
      at.faultS >= 0 && at.mode !== "loaded"
        ? { separator_discharge_pressure: SEPARATOR_LOADED_BAR }
        : UNCHANGED,
  };
  return {
    name: "separator drain open",
    writtenFrom:
      "condensate_drain_stuck_open: the separator discharge pressure collapses instead of " +
      "following the line while the unit idles; nothing else moves",
    event: raisedUnder(
      replay(samplesOf(script)),
      "separator_pressure_abnormal",
      "separator drain open",
    ),
  };
}
