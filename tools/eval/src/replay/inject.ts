// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The injection port: the simulator's value overlays, in TypeScript
// (docs/simulation.md).
//
// The harness must be able to replay a clean recording and score the pipeline
// on a fault that is not in it, which means the seven primitives, the state
// guard, the trapezoid envelope and the instance parameters of the Go engine
// have to exist twice. The harness accepts that duplication and pays for it
// with a parity test: `test/integration/parity.test.ts` runs the real
// `modbus-sim` and the real gateway over the same rows with the same injection
// and compares what the two produce sample by sample. Six primitives are exact;
// `noise` is compared statistically, because the generators differ on purpose
// (`prng.ts`).
//
// Every rule here is the Go engine's rule, and a difference is a defect on
// this side until the parity test says otherwise:
//
//   * transforms run in list order, instances in creation order, so a later
//     instance sees what an earlier one wrote;
//   * `when` is evaluated against the state of the **untouched** row, which is
//     why `createReplaySource` classifies before it overlays;
//   * an instance applies over the half-open window `[started, ends)`, and the
//     three primitives that ignore the magnitude — `stuck`, `duty_shift`,
//     `dropout` — take effect over exactly that window;
//   * values are SI and are overlaid **before** quantisation, where the
//     simulator overlays them.
//
// The definitions are handed in rather than read: nothing under `src/replay/`
// loads ground truth, and `GtInjectionDef` is imported for its type alone,
// which leaves no runtime edge from the telemetry path to `@fdp/ground-truth`,
// so the ground truth stays isolated from the diagnosis. The runner reads the
// catalog with `loadInjections()` and passes it here.

import type { GtInjectionDef } from "@fdp/ground-truth";

import { normalDraw } from "./prng.ts";
import { resolveLanes } from "./csv.ts";
import type { MachineState, RegisterMap } from "./types.ts";

/** One injection definition, as `packages/ground-truth/data/injections.json` records it. */
export type InjectionDef = GtInjectionDef;

/** One per-tag overlay of a definition. */
export type InjectionTransform = InjectionDef["transforms"][number];

/** The seven transform primitives. */
export type InjectionOp = InjectionTransform["op"];

/** The machine-state guard of a transform. */
export type StateGuard = InjectionTransform["when"];

/**
 * Where a `ramp` measures its elapsed minutes from: the instance start, the entry into the
 * current machine state, or the moment the transform's own guard started to hold, which a
 * change of state inside the guard (unloaded → off under `not_loaded`) does not move.
 */
export type RampAnchor = "injection_start" | "state_entry" | "guard_entry";

/** Why an instance stopped; the port ends instances by expiry only. */
export type StopReason = "expired";

/** The parameter every definition declares, and the only one the envelope scales by. */
export const MAGNITUDE_PARAM = "magnitude";

/** The parameter every definition accepts implicitly; its default is the definition's own. */
export const DURATION_PARAM = "duration_sim_min";

/** The longest an instance may run: ten simulated days. */
export const MAX_DURATION_SIM_MIN = 14_400;

/** The shortest an instance may run. */
export const MIN_DURATION_SIM_MIN = 1;

/** Simulated milliseconds in one simulated minute; every envelope and ramp is stated in minutes. */
export const MS_PER_SIM_MIN = 60_000;

/** Simulated milliseconds in one simulated second; `duty_shift` is stated in seconds. */
const MS_PER_SIM_S = 1_000;

/** What a scenario asks for: one injection, at one simulated instant, with its parameters. */
export interface InjectionSpec {
  /** The `injection_id` of a definition the engine was built with. */
  readonly injection_id: string;
  /** The simulated instant the instance starts at, in epoch milliseconds. */
  readonly atSimTsMs: number;
  /** Overrides for `magnitude` and `duration_sim_min`; the definition's defaults otherwise. */
  readonly params?: Readonly<Record<string, number>>;
}

/** The two parameters an instance runs with, after defaults and bounds. */
export interface InstanceParams {
  readonly magnitude: number;
  readonly duration_sim_min: number;
}

/**
 * One running copy of a definition, as the ground-truth topics describe it.
 *
 * The timestamps are epoch milliseconds rather than ISO strings: this is the replay's own
 * clock, and the runner formats them when it writes a label.
 */
export interface InstanceInfo {
  /** `inj-000001`, `inj-000002`, … counted per engine. */
  readonly instance_id: string;
  readonly injection_id: string;
  /** The cause of `manual/spec/faults.yaml` this injection stands for. */
  readonly fault_id: string;
  /** True when the cause is a normal operating condition rather than a defect. */
  readonly benign: boolean;
  readonly started_sim_ts: number;
  readonly ends_sim_ts: number;
  readonly params: InstanceParams;
}

/** One instance that has ended, with the reason a `gt/#` consumer would be told. */
export interface StoppedInstance {
  readonly instance: InstanceInfo;
  readonly reason: StopReason;
}

/** The SI values of one row, indexed by the lanes of `resolveLanes`. */
export interface InjectionValues {
  readonly analog: Float64Array;
  readonly digital: Uint8Array;
}

/** Why `start` refused, in the vocabulary of the `control-ack` error codes. */
export type InjectionErrorCode = "unknown_injection" | "bad_args";

/** Thrown by `start` for an unknown injection or a parameter the definition refuses. */
export class InjectionError extends Error {
  readonly code: InjectionErrorCode;

  constructor(code: InjectionErrorCode, message: string) {
    super(message);
    this.name = "InjectionError";
    this.code = code;
  }
}

/** Thrown by `createInjectionEngine` for a catalog the register map cannot carry. */
export class InjectionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectionCatalogError";
  }
}

/** The overlay engine: instances are started, applied per row, and expire on their own. */
export interface InjectionEngine {
  /**
   * Starts one instance.
   *
   * @throws InjectionError `unknown_injection` for an id the catalog does not offer,
   * `bad_args` for a parameter it does not declare or a value outside its bounds.
   */
  start(spec: InjectionSpec): InstanceInfo;
  /** Applies every active instance to one row's SI values, in place. */
  apply(values: InjectionValues, state: MachineState, simTsMs: number): void;
  /** Removes the instances whose duration has run out, oldest first. */
  expire(simTsMs: number): StoppedInstance[];
  /** The running instances, oldest start first. */
  active(): InstanceInfo[];
}

/** The lane and the kind one transform's tag resolves to. */
interface TagSlot {
  readonly lane: number;
  readonly digital: boolean;
}

/** A transform with its tag already resolved, so `apply` does no lookup per row. */
interface CompiledTransform {
  readonly transform: InjectionTransform;
  readonly slot: TagSlot;
}

/** A definition whose transforms are resolved against the register map, validated once. */
interface CompiledDef {
  readonly def: InjectionDef;
  readonly transforms: readonly CompiledTransform[];
}

/** One instance's trapezoid, in simulated milliseconds. */
interface Envelope {
  readonly startMs: number;
  readonly endMs: number;
  readonly rampInMs: number;
  readonly rampOutMs: number;
}

/**
 * Places a definition's ramps inside an instance's own duration.
 *
 * A definition's ramps always fit its default duration — `createInjectionEngine` refuses one
 * that does not — but an instance may ask for a shorter run, and the two ramps would then
 * overlap. Both are scaled down by the same factor, which turns the trapezoid into a
 * triangle instead of letting the hold go negative; the simulator does the same
 * (`services/modbus/internal/injection/envelope.go`).
 */
export function createEnvelope(
  startMs: number,
  endMs: number,
  ramp: { readonly ramp_in_min: number; readonly ramp_out_min: number },
): Envelope {
  const total = endMs - startMs;
  let rampInMs = ramp.ramp_in_min * MS_PER_SIM_MIN;
  let rampOutMs = ramp.ramp_out_min * MS_PER_SIM_MIN;
  if (rampInMs + rampOutMs > total) {
    rampInMs = Math.floor((total * rampInMs) / (rampInMs + rampOutMs));
    rampOutMs = total - rampInMs;
  }
  return { startMs, endMs, rampInMs, rampOutMs };
}

/**
 * The envelope at a simulated instant: zero outside the window, a linear rise over the ramp
 * in, one through the hold and a linear fall over the ramp out.
 *
 * A zero ramp in means the envelope is already at one on the instance's first row.
 */
export function envelopeAt(envelope: Envelope, simTsMs: number): number {
  if (simTsMs < envelope.startMs || simTsMs >= envelope.endMs) return 0;
  if (envelope.rampInMs > 0 && simTsMs < envelope.startMs + envelope.rampInMs) {
    return (simTsMs - envelope.startMs) / envelope.rampInMs;
  }
  if (envelope.rampOutMs > 0 && simTsMs > envelope.endMs - envelope.rampOutMs) {
    return (envelope.endMs - simTsMs) / envelope.rampOutMs;
  }
  return 1;
}

/** `v + value·m`. */
export function applyOffset(v: number, value: number, m: number): number {
  return v + value * m;
}

/** `v × (1 + (factor − 1)·m)`: `m = 0` leaves the value alone, `m = 1` multiplies by `factor`. */
export function applyScale(v: number, factor: number, m: number): number {
  return v * (1 + (factor - 1) * m);
}

/** `v + clamp(rate·minutes·m, ±cap)`. */
export function applyRamp(
  v: number,
  ratePerMin: number,
  capAbs: number,
  m: number,
  minutes: number,
): number {
  return v + Math.max(-capAbs, Math.min(capAbs, ratePerMin * minutes * m));
}

/** `v + draw·sigma·m`: the draw carries no `sigma`, so the deviation scales linearly with it. */
export function applyNoise(v: number, sigma: number, m: number, draw: number): number {
  return v + draw * sigma * m;
}

/** True when the guard admits the state. */
export function guardHolds(when: StateGuard, state: MachineState): boolean {
  switch (when) {
    case "any":
      return true;
    case "loaded":
      return state === "loaded";
    case "not_loaded":
      return state !== "loaded";
    case "unloaded":
      return state === "unloaded";
    case "off":
      return state === "off";
    default:
      return false;
  }
}

/**
 * The per-instance, per-transform bookkeeping of a `duty_shift`.
 *
 * The transform sees one row at a time, so it tracks the runs of the level it stretches as
 * they pass. A run that was already under way when the instance started is not tracked — its
 * beginning is unknown — so `duty_shift` only stretches or suppresses runs it watched begin,
 * exactly as `services/modbus/internal/injection/primitives.go` does.
 */
class DutyState {
  private seen = false;
  private previous = false;
  private runOpen = false;
  private runStartMs = 0;
  private ending = false;
  private endedMs = 0;

  /** The value the tag reports for this row, and the bookkeeping for the next one. */
  step(value: boolean, runValue: boolean, extendS: number, simTsMs: number): boolean {
    const { previous, seen } = this;
    this.previous = value;
    this.seen = true;

    if (value !== runValue) {
      // The stretched level has gone; a positive extension keeps reporting it
      // for its own seconds past the end of the run.
      if (seen && previous === runValue) {
        this.ending = true;
        this.endedMs = simTsMs;
      }
      this.runOpen = false;
      if (this.ending) {
        if (extendS > 0 && simTsMs - this.endedMs < extendS * MS_PER_SIM_S) return runValue;
        this.ending = false;
      }
      return value;
    }

    this.ending = false;
    if (seen && previous !== runValue) {
      // A watched start: the run is tracked from this row on.
      this.runOpen = true;
      this.runStartMs = simTsMs;
    } else if (!this.runOpen) {
      return value;
    }
    if (extendS < 0 && simTsMs - this.runStartMs < -extendS * MS_PER_SIM_S) return !runValue;
    return value;
  }
}

/**
 * One transform's view of its own guard: whether it held on the instance's previous row, and
 * since when it has held — the anchor of a `guard_entry` ramp. Like the state tracker, the
 * instance's first row counts as an entry when the guard holds there, and a change of machine
 * state that keeps the guard holding is not one (`services/modbus/internal/injection/engine.go`,
 * `guardState`).
 */
class GuardState {
  private held = false;
  enteredMs = 0;

  track(holds: boolean, simTsMs: number): void {
    if (holds && !this.held) this.enteredMs = simTsMs;
    this.held = holds;
  }
}

/** One running instance and everything it remembers between rows. */
class Instance {
  readonly info: InstanceInfo;

  private readonly transforms: readonly CompiledTransform[];
  private readonly envelope: Envelope;
  private readonly duty: readonly DutyState[];
  private readonly guards: readonly GuardState[];

  private stateKnown = false;
  private lastState: MachineState = "off";
  private stateEnteredMs = 0;

  constructor(info: InstanceInfo, transforms: readonly CompiledTransform[], envelope: Envelope) {
    this.info = info;
    this.transforms = transforms;
    this.envelope = envelope;
    this.duty = transforms.map(() => new DutyState());
    this.guards = transforms.map(() => new GuardState());
  }

  /** The envelope at `simTsMs` times the instance's `magnitude`: the transforms' `m`. */
  magnitudeAt(simTsMs: number): number {
    return envelopeAt(this.envelope, simTsMs) * this.info.params.magnitude;
  }

  /** True while `simTsMs` falls inside the instance's half-open window. */
  isActive(simTsMs: number): boolean {
    return simTsMs >= this.envelope.startMs && simTsMs < this.envelope.endMs;
  }

  /** Overlays this instance on one row's values. */
  apply(values: InjectionValues, state: MachineState, simTsMs: number): void {
    if (!this.isActive(simTsMs)) return;
    this.trackState(state, simTsMs);

    const m = this.magnitudeAt(simTsMs);
    this.transforms.forEach(({ transform, slot }, index) => {
      const holds = guardHolds(transform.when, state);
      this.guards[index]?.track(holds, simTsMs);
      if (!holds) return;
      if (slot.digital) {
        if (slot.lane >= values.digital.length) return;
        const current = values.digital[slot.lane] === 1;
        const next = this.digital(current, transform, index, simTsMs);
        values.digital[slot.lane] = next ? 1 : 0;
        return;
      }
      if (slot.lane >= values.analog.length) return;
      values.analog[slot.lane] = this.analog(
        values.analog[slot.lane] ?? 0,
        transform,
        m,
        index,
        simTsMs,
      );
    });
  }

  /**
   * Notes when the current machine state was entered, which is the anchor of a `state_entry`
   * ramp. The instance's first row counts as an entry: the state may have been held for hours
   * before the injection started, and a ramp may not credit itself with that time.
   */
  private trackState(state: MachineState, simTsMs: number): void {
    if (!this.stateKnown || state !== this.lastState) {
      this.stateKnown = true;
      this.lastState = state;
      this.stateEnteredMs = simTsMs;
    }
  }

  private analog(
    v: number,
    transform: InjectionTransform,
    m: number,
    index: number,
    simTsMs: number,
  ): number {
    switch (transform.op) {
      case "offset":
        return applyOffset(v, transform.value, m);
      case "scale":
        return applyScale(v, transform.factor, m);
      case "ramp":
        return applyRamp(
          v,
          transform.rate_per_min,
          transform.cap,
          m,
          this.minutesSince(transform.anchor, index, simTsMs),
        );
      case "noise":
        return applyNoise(v, transform.sigma, m, normalDraw(this.info.instance_id, simTsMs, index));
      case "stuck":
        return typeof transform.value === "number" ? transform.value : v;
      case "dropout":
        return typeof transform.value === "number" ? transform.value : 0;
      default:
        return v;
    }
  }

  private digital(
    v: boolean,
    transform: InjectionTransform,
    index: number,
    simTsMs: number,
  ): boolean {
    switch (transform.op) {
      case "stuck":
        return transform.value === true;
      case "dropout":
        return false;
      case "duty_shift":
        return this.duty[index]?.step(v, transform.run_value, transform.extend_s, simTsMs) ?? v;
      default:
        return v;
    }
  }

  /** The simulated minutes the ramp of transform `index` has run for. */
  private minutesSince(anchor: string, index: number, simTsMs: number): number {
    let from = this.envelope.startMs;
    if (anchor === "state_entry") from = this.stateEnteredMs;
    else if (anchor === "guard_entry") from = this.guards[index]?.enteredMs ?? from;
    return simTsMs <= from ? 0 : (simTsMs - from) / MS_PER_SIM_MIN;
  }
}

/** The primitives that read and write a number. */
const ANALOG_ONLY: readonly InjectionOp[] = ["offset", "scale", "ramp", "noise"];

/** The primitives that only make sense on a two-level tag. */
const DIGITAL_ONLY: readonly InjectionOp[] = ["duty_shift"];

/** The five state guards. */
const GUARDS: readonly string[] = ["any", "loaded", "not_loaded", "unloaded", "off"];

/** The three ramp anchors. */
const ANCHORS: readonly string[] = ["injection_start", "state_entry", "guard_entry"];

/** Every primitive, so an op outside the seven is named rather than silently skipped. */
const OPS: readonly string[] = [
  "offset",
  "scale",
  "ramp",
  "noise",
  "stuck",
  "duty_shift",
  "dropout",
];

function reject(injectionId: string, message: string): never {
  throw new InjectionCatalogError(`@fdp/eval: injection "${injectionId}": ${message}`);
}

/** Resolves every tag of the register map to its lane, the way `resolveLanes` numbers them. */
function tagSlots(map: RegisterMap): ReadonlyMap<string, TagSlot> {
  const lanes = resolveLanes(map);
  const slots = new Map<string, TagSlot>();
  lanes.analog.forEach((signal, lane) => slots.set(signal.tag, { lane, digital: false }));
  lanes.digital.forEach((signal, lane) => slots.set(signal.tag, { lane, digital: true }));
  return slots;
}

/** Checks the fields one primitive needs; the caller names the injection and the index. */
function validateOpFields(
  injectionId: string,
  index: number,
  transform: InjectionTransform,
  digital: boolean,
): void {
  const at = (message: string): never => reject(injectionId, `transforms[${index}]: ${message}`);

  switch (transform.op) {
    case "offset":
      if (typeof transform.value !== "number") at("offset needs a numeric value");
      return;
    case "scale":
      if (!(transform.factor > 0)) at(`scale needs a positive factor, not ${transform.factor}`);
      return;
    case "ramp":
      if (!ANCHORS.includes(transform.anchor)) {
        at(`anchor "${transform.anchor}" is not one of ${ANCHORS.join(", ")}`);
      }
      if (transform.cap < 0) at(`ramp cap ${transform.cap} must not be negative`);
      if (transform.rate_per_min === 0) at("ramp needs a non-zero rate_per_min");
      return;
    case "noise":
      if (transform.sigma < 0) at(`noise sigma ${transform.sigma} must not be negative`);
      return;
    case "stuck":
      if (transform.value === undefined) at("stuck needs a value to freeze the tag at");
      if (digital && typeof transform.value !== "boolean") {
        at(`value is a number but "${transform.tag}" is a digital tag`);
      }
      if (!digital && typeof transform.value !== "number") {
        at(`value is a boolean but "${transform.tag}" is an analog tag`);
      }
      return;
    case "duty_shift":
      if (transform.extend_s === 0) at("duty_shift needs a non-zero extend_s");
      return;
    case "dropout":
      if (transform.value === undefined) return;
      if (digital && typeof transform.value !== "boolean") {
        at(`value is a number but "${transform.tag}" is a digital tag`);
      }
      if (!digital && typeof transform.value !== "number") {
        at(`value is a boolean but "${transform.tag}" is an analog tag`);
      }
      return;
    default:
      at(`op "${String((transform as { op: string }).op)}" is not one of the seven primitives`);
  }
}

/** Resolves and checks one definition's transforms against the register map. */
function compileTransforms(
  def: InjectionDef,
  slots: ReadonlyMap<string, TagSlot>,
): CompiledTransform[] {
  if (def.transforms.length === 0) {
    reject(def.injection_id, "transforms is empty; an injection that changes nothing is not one");
  }
  return def.transforms.map((transform, index) => {
    const where = (message: string): never =>
      reject(def.injection_id, `transforms[${index}]: ${message}`);

    const slot = slots.get(transform.tag);
    if (slot === undefined) {
      where(`tag "${transform.tag}" is not a signal of the register map`);
      throw new Error("unreachable");
    }
    if (!OPS.includes(transform.op)) {
      where(`op "${String(transform.op)}" is not one of the seven primitives`);
    }
    if (!GUARDS.includes(transform.when)) {
      where(`when "${String(transform.when)}" is not a state guard`);
    }
    if (slot.digital && ANALOG_ONLY.includes(transform.op)) {
      where(`op "${transform.op}" reads a number but "${transform.tag}" is a digital tag`);
    }
    if (!slot.digital && DIGITAL_ONLY.includes(transform.op)) {
      where(
        `op "${transform.op}" reads a two-level signal but "${transform.tag}" is an analog tag`,
      );
    }
    validateOpFields(def.injection_id, index, transform, slot.digital);
    return { transform, slot };
  });
}

/** Checks the parameter declarations of one definition. */
function validateParams(def: InjectionDef): void {
  if (def.params.length === 0) {
    reject(def.injection_id, "params is empty; every injection declares magnitude");
  }
  const names = new Set<string>();
  def.params.forEach((param, index) => {
    if (names.has(param.name)) {
      reject(def.injection_id, `params[${index}].name "${param.name}" is declared twice`);
    }
    names.add(param.name);
    if (param.min > param.max) {
      reject(
        def.injection_id,
        `params[${index}] (${param.name}): min ${param.min} is above max ${param.max}`,
      );
    }
    if (param.default < param.min || param.default > param.max) {
      reject(
        def.injection_id,
        `params[${index}] (${param.name}): default ${param.default} is outside ` +
          `${param.min}..${param.max}`,
      );
    }
  });
  if (!names.has(MAGNITUDE_PARAM)) {
    reject(def.injection_id, `params declares no "${MAGNITUDE_PARAM}"`);
  }
}

/** Checks the envelope and the duration of one definition. */
function validateEnvelope(def: InjectionDef): void {
  const { ramp_in_min: rampIn, ramp_out_min: rampOut } = def.envelope;
  const duration = def.default_duration_sim_min;
  if (duration < MIN_DURATION_SIM_MIN || duration > MAX_DURATION_SIM_MIN) {
    reject(
      def.injection_id,
      `default_duration_sim_min is ${duration}, outside ` +
        `${MIN_DURATION_SIM_MIN}..${MAX_DURATION_SIM_MIN}`,
    );
  }
  if (rampIn < 0 || rampOut < 0) {
    reject(
      def.injection_id,
      `envelope ramp_in_min ${rampIn} and ramp_out_min ${rampOut} must not be negative`,
    );
  }
  if (rampIn + rampOut > duration) {
    reject(
      def.injection_id,
      `envelope ramp_in_min ${rampIn} plus ramp_out_min ${rampOut} exceeds ` +
        `default_duration_sim_min ${duration}, so the hold would be negative`,
    );
  }
}

/** The bounds of one instance parameter: the definition's own, or 1…14400 for the duration. */
function paramBounds(def: InjectionDef, name: string): { min: number; max: number } {
  const declared = def.params.find((param) => param.name === name);
  if (declared !== undefined) return { min: declared.min, max: declared.max };
  return { min: MIN_DURATION_SIM_MIN, max: MAX_DURATION_SIM_MIN };
}

/** Merges a spec's parameters with the definition's defaults and checks every bound. */
function resolveParams(def: InjectionDef, asked: Readonly<Record<string, number>>): InstanceParams {
  const resolved = new Map<string, number>();
  for (const param of def.params) resolved.set(param.name, param.default);
  if (!resolved.has(DURATION_PARAM)) {
    resolved.set(DURATION_PARAM, def.default_duration_sim_min);
  }

  const bad = (message: string): never => {
    throw new InjectionError("bad_args", `@fdp/eval: injection ${def.injection_id}: ${message}`);
  };

  for (const name of Object.keys(asked).sort()) {
    const value = asked[name] ?? Number.NaN;
    if (!resolved.has(name)) bad(`unknown parameter "${name}"`);
    if (!Number.isFinite(value)) bad(`${name} is not a finite number`);
    const { min, max } = paramBounds(def, name);
    if (value < min || value > max) bad(`${name} is ${value}, outside ${min}..${max}`);
    resolved.set(name, value);
  }

  const duration = resolved.get(DURATION_PARAM) ?? def.default_duration_sim_min;
  if (!Number.isInteger(duration)) {
    bad(`${DURATION_PARAM} is ${duration}, not a whole number of minutes`);
  }
  return {
    magnitude: resolved.get(MAGNITUDE_PARAM) ?? 1,
    duration_sim_min: duration,
  };
}

/** `inj-000001`, `inj-000002`, … the instance ids this port hands out. */
function instanceId(counter: number): string {
  return `inj-${String(counter).padStart(6, "0")}`;
}

/**
 * Builds the overlay engine for one catalog and one register map.
 *
 * Every definition is validated the way the simulator's loader validates it
 * (`services/modbus/internal/injection/catalog.go`): a duplicate `injection_id`, a tag the
 * map does not declare, a primitive on the wrong kind of tag, ramps that do not fit the
 * default duration or a missing `magnitude` parameter is an error naming the injection and
 * the field, raised here rather than three replays later.
 *
 * @throws InjectionCatalogError when a definition cannot run against this register map.
 */
export function createInjectionEngine(
  defs: readonly InjectionDef[],
  map: RegisterMap,
): InjectionEngine {
  const slots = tagSlots(map);
  const catalog = new Map<string, CompiledDef>();

  for (const def of defs) {
    if (catalog.has(def.injection_id)) {
      reject(def.injection_id, "injection_id is declared twice");
    }
    validateEnvelope(def);
    validateParams(def);
    catalog.set(def.injection_id, { def, transforms: compileTransforms(def, slots) });
  }

  let counter = 0;
  let instances: Instance[] = [];

  return {
    start(spec: InjectionSpec): InstanceInfo {
      const entry = catalog.get(spec.injection_id);
      if (entry === undefined) {
        throw new InjectionError(
          "unknown_injection",
          `@fdp/eval: no injection "${spec.injection_id}" in the catalog; ` +
            `offered: ${[...catalog.keys()].join(", ")}`,
        );
      }
      const params = resolveParams(entry.def, spec.params ?? {});
      const endsSimTs = spec.atSimTsMs + params.duration_sim_min * MS_PER_SIM_MIN;
      counter += 1;
      const info: InstanceInfo = {
        instance_id: instanceId(counter),
        injection_id: entry.def.injection_id,
        fault_id: entry.def.fault_id,
        benign: entry.def.benign,
        started_sim_ts: spec.atSimTsMs,
        ends_sim_ts: endsSimTs,
        params,
      };
      instances.push(
        new Instance(
          info,
          entry.transforms,
          createEnvelope(spec.atSimTsMs, endsSimTs, entry.def.envelope),
        ),
      );
      return info;
    },

    apply(values: InjectionValues, state: MachineState, simTsMs: number): void {
      for (const instance of instances) instance.apply(values, state, simTsMs);
    },

    expire(simTsMs: number): StoppedInstance[] {
      const stopped: StoppedInstance[] = [];
      const kept: Instance[] = [];
      for (const instance of instances) {
        if (simTsMs >= instance.info.ends_sim_ts) {
          stopped.push({ instance: instance.info, reason: "expired" });
          continue;
        }
        kept.push(instance);
      }
      instances = kept;
      return stopped;
    },

    active(): InstanceInfo[] {
      return instances
        .map((instance) => instance.info)
        .sort((a, b) => a.started_sim_ts - b.started_sim_ts);
    },
  };
}
