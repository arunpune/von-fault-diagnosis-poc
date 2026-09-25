// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Rows into `telemetry-samples` batches: the replay engine's front door.
//
// What comes out is what the gateway publishes and nothing else — the same
// envelope, the same `seq` from 1, the same flags, the same batches of at most
// 25 — because that is the only thing the pipeline under test is allowed to see
// (docs/architecture.md#ground-truth-isolation). The labels stay on the harness
// side of the boundary, and no module under `src/replay/` reads
// `@fdp/ground-truth` at run time: the injection definitions are handed to
// `createReplaySource`, never loaded by it.
//
// Per row the order is the simulator's own (as
// `services/modbus/internal/sim/engine.go` `emit` implements it):
//
//   classify (untouched values) -> ambient -> overlay -> alarms -> quantise
//
// and it is an order, not a preference. The `when` guard of an injection reads
// the recorded state, so `classify` must run before any overlay rewrites the
// row; the ambient lane is filled before the overlays because
// `high_ambient_temperature` *adds to* the synthetic value and would
// otherwise be overwritten by it; and the controller is evaluated *before* the
// slot is encoded — `emit` calls `ctrl7.Step` on the overlaid values and
// `regmap.EncodeSlot` after it — so the port compares the same float64 the
// machine compares, not the register value it would land on. `ReplayHooks` is
// where the overlay, the ambient model and the CTRL-7 port plug into those
// slots; with no hooks and no options this module replays the recorded
// telemetry faithfully and leaves the ambient lane at 0 °C. The evaluation
// host never replays that way: it asks for the synthetic ambient lane on every
// scenario, negatives and recordings included, because every sample the
// simulator writes carries it.
//
// The CTRL-7 port is not a hook a caller has to supply: with none given the
// source compiles the manual's registry (`alarm-registry.ts`) against the map
// and stamps every sample with the codes the real unit would show, which is
// what the lead-time metric reads. `alarms: false` and `EVAL_ALARMS=off` switch
// it back off, and a checkout that carries no registry at all publishes empty
// lists rather than guessing.
//
// `injections` is the short way to the first two: given the definitions and a
// list of `{ injection_id, atSimTsMs, params }`, the source builds an
// `InjectionEngine`, starts each instance on the first row at or after its
// instant, fills the ambient lane from `ambient.ts` and overlays the rest.
// `source.injections` exposes the engine, and `onInjection` reports every
// start and end so the runner can write the label beside the run.
//
// Validation is one-off by design: the first batch of every source goes
// through `assertValid("telemetry-samples", …)`, which catches a map or a hook
// that produces something the schema refuses, and the remaining batches are
// validated only when `EVAL_VALIDATE_ALL` is set — the tests set it, a
// 1.5-million-sample run does not pay for it.

import { DEFAULT_UNIT_ID, assertValid, toIsoMs } from "@fdp/contracts";
import type { Sample, TelemetrySamples } from "@fdp/contracts";

import { alarmsEnabled, defaultAlarmRegistry } from "./alarm-registry.ts";
import type { AlarmRegistry } from "./alarm-registry.ts";
import { createAlarmEvaluator } from "./alarms.ts";
import { ambient as syntheticAmbient } from "./ambient.ts";
import { readRows, resolveLanes } from "./csv.ts";
import { createInjectionEngine } from "./inject.ts";
import type { InjectionDef, InjectionEngine, InjectionSpec, InstanceInfo } from "./inject.ts";
import { quantiseRow } from "./quantise.ts";
import type {
  MachineState,
  ReplayHooks,
  ReplayLanes,
  ReplayRow,
  ReplaySourceOptions,
  ReplayStats,
} from "./types.ts";
import {
  GAP_THRESHOLD_MS,
  MAX_BATCH_SIZE,
  RUNNING_THRESHOLD_A,
  STATE_COLUMNS,
  VALIDATE_ALL_ENV,
} from "./types.ts";

export * from "./alarm-registry.ts";
export * from "./alarms.ts";
export * from "./ambient.ts";
export { HeaderError, RowError, parseRowTs, readRows, resolveLanes } from "./csv.ts";
export * from "./derived.ts";
export * from "./inject.ts";
export * from "./prng.ts";
export { quantise, quantiseRow } from "./quantise.ts";
export * from "./types.ts";

/** The schema every batch carries; the one literal this module owes the contract. */
const TELEMETRY_SAMPLES = "urn:fdp:schema:telemetry-samples:v1";

/** How a `telemetry-samples` batch is assembled once the samples exist. */
export interface BatchOptions {
  /** The unit the batches are published for; `DEFAULT_UNIT_ID` when absent. */
  readonly unitId?: string;
  /** Samples per batch: 1 to `MAX_BATCH_SIZE`, `MAX_BATCH_SIZE` when absent. */
  readonly batchSize?: number;
  /** The wall clock `wall_ts` is stamped from; a fake one in tests. */
  readonly wall: () => Date;
}

/** A replay in progress: iterate it once for the batches, read `stats` for the counts. */
export interface ReplaySource extends AsyncIterable<TelemetrySamples> {
  /** A snapshot of the counters, valid at any point of the iteration. */
  readonly stats: ReplayStats;
  /** The overlay engine, or `undefined` when the replay carries no injection. */
  readonly injections: InjectionEngine | undefined;
}

/** One instance beginning or ending, as the runner logs it beside the run. */
export interface InjectionEvent {
  readonly event: "start" | "stop";
  /** The simulated instant of the row the change was noticed on. */
  readonly simTsMs: number;
  readonly instance: InstanceInfo;
  /** Present on a stop only. */
  readonly reason?: "expired";
}

/**
 * Everything `createReplaySource` needs: a source, a map, a clock, the hooks — and the
 * injections the replay overlays on the recorded rows.
 *
 * `injections` and `injectionDefs` travel together: the specs name definitions, and the
 * definitions come from the caller (`loadInjections()` of `@fdp/ground-truth`) rather than
 * from this module, which reads no ground truth. An explicit `hooks.overlay` or
 * `hooks.ambient` wins over both, so a test can still drive the slots by hand.
 */
export interface ReplayRunOptions extends ReplaySourceOptions {
  /** The catalog the specs below are started from; required when `injections` is not empty. */
  readonly injectionDefs?: readonly InjectionDef[];
  /** The injections to start, each at its own simulated instant. */
  readonly injections?: readonly InjectionSpec[];
  /**
   * Fill the synthetic ambient lane from `ambient()`.
   *
   * It defaults to true when `injections` is not empty — an overlay on the ambient tag has to
   * have something to add to — and to false otherwise, which keeps a plain replay a faithful
   * copy of the recording's lanes. The evaluation host passes `true` for every scenario,
   * recordings included, because the simulator writes the lane into every sample and the
   * runtime always receives it. An explicit
   * `hooks.ambient` wins over both.
   */
  readonly ambient?: boolean;
  /**
   * The CTRL-7 port.
   *
   * `true` or absent compiles the registry `defaultAlarmRegistry()` resolves — the manual's
   * `manual/spec` when it is there, the provisional fixture otherwise — and stamps every
   * sample with the codes it raises; a registry passed here is compiled instead, which is
   * how a test drives a hand-written table. `false`, `EVAL_ALARMS=off` and a checkout
   * without any registry all leave `sample.alarms` empty. An explicit `hooks.alarms` wins
   * over every one of them.
   */
  readonly alarms?: boolean | AlarmRegistry;
  /** Called for every instance start and end, in the order they happen. */
  readonly onInjection?: (event: InjectionEvent) => void;
}

/** The lanes the machine-state rule reads, resolved once per replay. */
interface StateLanes {
  readonly intake: number;
  readonly loadValve: number;
  readonly motorCurrent: number;
}

function laneOf(signals: readonly { readonly metropt_column: string | null }[], column: string) {
  return signals.findIndex((signal) => signal.metropt_column === column);
}

/**
 * Builds the default classifier, the machine-state rule of docs/dataset.md, over a register
 * map's lanes:
 *
 *     loaded   := COMP == 0 and DV_eletric == 1
 *     unloaded := not loaded and Motor_current >= 1.0 A
 *     off      := not loaded and Motor_current <  1.0 A
 *
 * The three lanes are found by `metropt_column`, so a tag rename in the manual moves them
 * instead of breaking the rule. It reads the row as the CSV wrote it, which is what an
 * injection's `when` guard is evaluated against.
 *
 * @throws Error when the map replays none of the three columns, which is a map that cannot
 * carry the rule rather than a row that fails it.
 */
export function createClassifier(lanes: ReplayLanes): (row: ReplayRow) => MachineState {
  const state: StateLanes = {
    intake: laneOf(lanes.digital, STATE_COLUMNS.intake),
    loadValve: laneOf(lanes.digital, STATE_COLUMNS.loadValve),
    motorCurrent: laneOf(lanes.analog, STATE_COLUMNS.motorCurrent),
  };
  const absent = Object.entries(STATE_COLUMNS)
    .filter(([name]) => state[name as keyof StateLanes] < 0)
    .map(([, column]) => column);
  if (absent.length > 0) {
    throw new Error(
      `@fdp/eval: the register map replays no ${absent.join(", ")} column, ` +
        "so the machine-state rule cannot be applied; pass hooks.classify",
    );
  }

  return (row) => {
    const loaded = row.digital[state.intake] === 0 && row.digital[state.loadValve] === 1;
    if (loaded) return "loaded";
    return (row.analog[state.motorCurrent] ?? 0) >= RUNNING_THRESHOLD_A ? "unloaded" : "off";
  };
}

/**
 * One quantised row as the `Sample` of the `telemetry-samples` schema.
 *
 * `values` is keyed by the tag ids of the register map — numbers for the analog lanes, the
 * synthetic ambient lane included, booleans for the digital ones — and never by a column
 * name or a position.
 */
export function toSample(
  row: ReplayRow,
  seq: number,
  flags: { readonly discontinuity: boolean },
  extras: { readonly lanes: ReplayLanes; readonly alarms: readonly string[] },
): Sample {
  const values: Record<string, number | boolean> = {};
  extras.lanes.analog.forEach((signal, lane) => {
    values[signal.tag] = row.analog[lane] ?? 0;
  });
  extras.lanes.digital.forEach((signal, lane) => {
    values[signal.tag] = row.digital[lane] === 1;
  });

  return {
    seq,
    sim_ts: toIsoMs(new Date(row.simTsMs)),
    flags: { discontinuity: flags.discontinuity, missing: row.missing },
    values,
    alarms: [...extras.alarms],
  };
}

/** The batch size to use, checked against the schema's own maximum. */
function checkBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return MAX_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(
      `@fdp/eval: batchSize ${batchSize} is not an integer in 1..${MAX_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

/**
 * Groups samples into `telemetry-samples` envelopes of at most `batchSize`.
 *
 * `poll_seq` counts the batches from 1, as a gateway counts the poll cycles it has
 * completed, and `read_ms` is 0: the harness reads no registers, and the field exists for
 * diagnostics only.
 */
export async function* batches(
  samples: AsyncIterable<Sample>,
  opts: BatchOptions,
): AsyncIterable<TelemetrySamples> {
  const size = checkBatchSize(opts.batchSize);
  const unitId = opts.unitId ?? DEFAULT_UNIT_ID;
  let pending: Sample[] = [];
  let pollSeq = 0;

  const flush = (): TelemetrySamples | undefined => {
    const [first, ...rest] = pending;
    if (first === undefined) return undefined;
    pending = [];
    pollSeq += 1;
    return {
      schema: TELEMETRY_SAMPLES,
      unit_id: unitId,
      wall_ts: toIsoMs(opts.wall()),
      samples: [first, ...rest],
      poll: { poll_seq: pollSeq, read_ms: 0 },
    };
  };

  for await (const sample of samples) {
    pending.push(sample);
    if (pending.length < size) continue;
    const batch = flush();
    if (batch !== undefined) yield batch;
  }
  const last = flush();
  if (last !== undefined) yield last;
}

/**
 * The overlay engine for a run that carries injections.
 *
 * The definitions have to come with the specs: this module reads no ground truth, so a
 * caller that asks for an injection and hands over no catalog is asking for a silent
 * no-overlay run, which would score as a clean recording.
 */
function buildEngine(options: ReplayRunOptions): InjectionEngine {
  if (options.hooks?.overlay !== undefined) {
    throw new Error(
      "@fdp/eval: hooks.overlay and injections both write the same lanes; pass one of them",
    );
  }
  const defs = options.injectionDefs;
  if (defs === undefined || defs.length === 0) {
    throw new Error(
      "@fdp/eval: injections were asked for without injectionDefs; " +
        "pass loadInjections()?.injections",
    );
  }
  return createInjectionEngine(defs, options.map);
}

/**
 * The alarm hook of one replay: the caller's, the compiled registry's, or none.
 *
 * It is built per source rather than per process because the evaluator carries dwell
 * timers, derived quantities and manual latches, and two replays must not share them.
 */
function buildAlarmHook(options: ReplayRunOptions): ReplayHooks["alarms"] | undefined {
  const given = options.hooks?.alarms;
  if (given !== undefined) return given;
  const asked = options.alarms ?? true;
  if (asked === false) return undefined;
  if (asked === true && !alarmsEnabled(process.env)) return undefined;
  const registry = asked === true ? defaultAlarmRegistry() : asked;
  if (registry === undefined) return undefined;
  const evaluator = createAlarmEvaluator(registry, options.map);
  return (row, state, simTsMs, discontinuity) =>
    evaluator.evaluate(row, state, simTsMs, discontinuity);
}

/** True when `EVAL_VALIDATE_ALL` asks for every batch to be validated, not only the first. */
function validateAll(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[VALIDATE_ALL_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Replays a CSV source as the `telemetry-samples` batches a gateway would publish.
 *
 * The returned object is iterated once — a second iteration would count the same rows twice
 * — and carries the counters of the replay in `stats` while it runs and after it ends.
 */
export function createReplaySource(options: ReplayRunOptions): ReplaySource {
  const lanes = resolveLanes(options.map);
  const gapThresholdMs = options.gapThresholdMs ?? GAP_THRESHOLD_MS;
  const hooks = options.hooks ?? {};
  const classify = hooks.classify ?? createClassifier(lanes);
  const everyBatch = validateAll(process.env);

  const pending = [...(options.injections ?? [])].sort((a, b) => a.atSimTsMs - b.atSimTsMs);
  const engine = pending.length === 0 ? undefined : buildEngine(options);
  const overlay = hooks.overlay ?? (engine === undefined ? undefined : engine.apply.bind(engine));
  const ambientOf =
    hooks.ambient ?? ((options.ambient ?? pending.length > 0) ? syntheticAmbient : undefined);
  const alarmsOf = buildAlarmHook(options);
  const report = options.onInjection;

  /** Starts every instance whose instant has been reached, in the order the specs name them. */
  const startDue = (simTsMs: number): void => {
    while (pending.length > 0 && (pending[0]?.atSimTsMs ?? Infinity) <= simTsMs) {
      const spec = pending.shift();
      if (spec === undefined || engine === undefined) return;
      const instance = engine.start(spec);
      report?.({ event: "start", simTsMs, instance });
    }
  };

  /** Ends every instance whose duration has run out on this row. */
  const expireDue = (simTsMs: number): void => {
    if (engine === undefined || report === undefined) {
      engine?.expire(simTsMs);
      return;
    }
    for (const stopped of engine.expire(simTsMs)) {
      report({ event: "stop", simTsMs, instance: stopped.instance, reason: stopped.reason });
    }
  };

  const counters = {
    rows: 0,
    samples: 0,
    batches: 0,
    discontinuities: 0,
    firstSimTs: undefined as string | undefined,
    lastSimTs: undefined as string | undefined,
  };

  async function* toSamples(): AsyncIterable<Sample> {
    let previousSimTsMs: number | undefined;
    let seq = 0;

    for await (const row of readRows(options.source, options.map, options)) {
      counters.rows += 1;
      const step = previousSimTsMs === undefined ? undefined : row.simTsMs - previousSimTsMs;
      const discontinuity = step === undefined || step > gapThresholdMs || step <= 0;
      previousSimTsMs = row.simTsMs;

      const state = classify(row);
      startDue(row.simTsMs);
      if (lanes.ambientIndex !== null && ambientOf !== undefined) {
        row.analog[lanes.ambientIndex] = ambientOf(row.simTsMs);
      }
      overlay?.(row, state, row.simTsMs);
      // The controller reads the overlaid values before the slot is encoded,
      // exactly where `emit` calls `ctrl7.Step`.
      const alarms = alarmsOf?.(row, state, row.simTsMs, discontinuity) ?? [];
      quantiseRow(row, lanes);

      seq += 1;
      const sample = toSample(row, seq, { discontinuity }, { lanes, alarms });
      counters.samples += 1;
      if (discontinuity) counters.discontinuities += 1;
      counters.firstSimTs ??= sample.sim_ts;
      counters.lastSimTs = sample.sim_ts;
      // The simulator expires an instance after the row it wrote, not before
      // it, so a row exactly at `ends_sim_ts` is the first one without the
      // overlay and the stop is reported against it.
      expireDue(row.simTsMs);
      yield sample;
    }
  }

  async function* toBatches(): AsyncIterable<TelemetrySamples> {
    for await (const batch of batches(toSamples(), options)) {
      counters.batches += 1;
      if (counters.batches === 1 || everyBatch) assertValid("telemetry-samples", batch);
      yield batch;
    }
  }

  let started = false;
  return {
    get stats(): ReplayStats {
      return { ...counters };
    },
    injections: engine,
    [Symbol.asyncIterator](): AsyncIterator<TelemetrySamples> {
      if (started) throw new Error("@fdp/eval: a replay source is iterated once");
      started = true;
      return toBatches()[Symbol.asyncIterator]();
    },
  };
}
