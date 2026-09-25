// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The CTRL-7 controller, ported.
//
// The lead-time metric asks "how long before the controller would have shown
// something did the pipeline say it?", so the replay has to stamp every sample
// with the messages the real unit would be showing. That is what this module
// does: it takes the manual's resolved registry, compiles each message once,
// and then answers one question per sample — which codes are set — in
// ascending bit order, the order `regmap.AlarmCodes` produces from
// `alarm_bits` and therefore the order the gateway publishes.
//
// `services/modbus/internal/ctrl7` owns these semantics: this file is a port,
// and where the two disagree the Go side is right. Four things are copied from
// it deliberately, because each one is a decision rather than an implementation
// detail:
//
//   1. **What a message is compiled into.** The manual writes every condition
//      as `{signal, op, threshold}`, but the contracts generator translates a
//      leaf before the simulator ever sees it: a digital tag becomes an
//      equality on a level, a `time_in_state` derived quantity becomes a
//      state-duration rule whose dwell *replaces* `for_s`, and a `delta` or
//      `abs_delta` becomes a differential on two lanes. The same translation
//      happens here, so a message cannot mean one thing in Go and another here.
//   2. **How the dwell runs.** The timer runs on sim time and fires at
//      `simTs − since >= for_s`, so a replay at 3600× raises the same messages
//      at the same samples as one at 1×.
//   3. **What a discontinuity does.** Pending dwells start over, the derived
//      quantities start from zero and manual latches are released — but a bit
//      that is already set survives the sample that carries the discontinuity
//      if, and only if, its condition still holds there.
//   4. **When the reset band applies.** `auto_hysteresis` widens the
//      comparison only while the bit is set, and only for a single-leaf
//      condition; the branches of an `all` / `any` are always asked without it.
//
// The values it reads are the overlaid SI values, *before* quantisation: the
// simulator evaluates the controller and then encodes the slot
// (`internal/sim/engine.go` `emit`), and a port that compared register values
// instead would disagree with it on any sample that sits on a rounding
// boundary.
//
// No ground truth is read here. A controller message is machine behaviour, not
// a label.

import type {
  AlarmRegistry,
  Condition,
  Leaf,
  LeafOp,
  ResolvedAlarm,
  TriggerState,
} from "./alarm-registry.ts";
import { conditionLeaves, isAllCondition, isAnyCondition } from "./alarm-registry.ts";
import { resolveLanes } from "./csv.ts";
import { analogLane, createDerivedEngine, createLaneIndex, digitalLane } from "./derived.ts";
import type { DerivedEngine, LaneIndex } from "./derived.ts";
import type { MachineState, RegisterMap, ReplayRow } from "./types.ts";

/** Milliseconds per second; every dwell and mask in the registry is in seconds. */
const MS_PER_SECOND = 1_000;

/** Seconds per minute; `time_in_state` thresholds arrive in minutes. */
const SECONDS_PER_MINUTE = 60;

/** Seconds per hour, for a `time_in_state` quantity declared in hours. */
const SECONDS_PER_HOUR = 3_600;

/** The empty list every quiet sample shares; `toSample` copies before publishing. */
const NO_ALARMS: readonly string[] = Object.freeze([]);

/** Thrown when a registry cannot be compiled against a register map. */
export class AlarmEvaluatorError extends Error {
  constructor(message: string) {
    super(`@fdp/eval: ${message}`);
    this.name = "AlarmEvaluatorError";
  }
}

/** What one replay's controller did, read after the run or while it is going. */
export interface AlarmStats {
  /** Samples evaluated. */
  readonly samples: number;
  /** Samples that carried a discontinuity, each of which restarted every timer. */
  readonly discontinuities: number;
  /** Manual latches a discontinuity released; the count is reported. */
  readonly manualClears: number;
  /** How often each code went from clear to set, by code, in bit order. */
  readonly activations: ReadonlyMap<string, number>;
}

/** The controller of one replay; `evaluate` is called once per sample, in order. */
export interface AlarmEvaluator {
  /** The registry this evaluator was compiled from. */
  readonly registry: AlarmRegistry;
  /** The derived quantities, for a test or a report that wants the numbers behind a code. */
  readonly derived: DerivedEngine;
  readonly stats: AlarmStats;
  /**
   * The codes set on this sample, in ascending bit order — the order
   * `regmap.AlarmCodes` produces from `alarm_bits`, and therefore the order the gateway
   * publishes them in.
   */
  evaluate(
    row: ReplayRow,
    state: MachineState,
    simTsMs: number,
    discontinuity: boolean,
  ): readonly string[];
}

/** One compiled trigger. `active` turns the reset band on; branches never see it true. */
interface CompiledCondition {
  holds(row: ReplayRow, state: MachineState, derived: DerivedEngine, active: boolean): boolean;
}

/** One compiled message and the four fields that carry its state between samples. */
interface CompiledAlarm {
  readonly code: string;
  readonly bit: number;
  readonly when: TriggerState;
  readonly delayMs: number;
  readonly startMaskMs: number;
  /** True for `manual` and `manual_service`: the bit latches until a discontinuity. */
  readonly manual: boolean;
  readonly condition: CompiledCondition;
  /** True while the condition held at the previous sample. */
  holding: boolean;
  /** The sim instant the condition started to hold. */
  since: number;
  /** True once it has held for `delayMs`. */
  active: boolean;
  /** True while a manual reset keeps the bit set after its condition released. */
  latched: boolean;
}

/**
 * Applies `op`, widening the comparison by the reset band while the bit is set.
 *
 * A message raised by `value > threshold` clears only once the value is back below
 * `threshold − hysteresis`, and the mirrored band applies to `lt`; a zero band — every
 * message whose reset mode is `auto` — degenerates to the plain comparison
 * (`internal/ctrl7/condition.go` `compare`).
 */
export function compare(
  value: number,
  op: LeafOp,
  threshold: number,
  hysteresis: number,
  active: boolean,
): boolean {
  switch (op) {
    case "gt":
      return value > (active ? threshold - hysteresis : threshold);
    case "ge":
      return value >= (active ? threshold - hysteresis : threshold);
    case "lt":
      return value < (active ? threshold + hysteresis : threshold);
    case "le":
      return value <= (active ? threshold + hysteresis : threshold);
    case "eq":
      return value === threshold;
    case "ne":
      return value !== threshold;
  }
}

/**
 * The trigger-state guard: the condition is looked at only in the declared state.
 *
 * `running` is the union `machine_states.aliases.running` declares, which is loaded and
 * unloaded.
 */
export function guardHoldsForState(
  when: TriggerState,
  state: MachineState,
  running: readonly MachineState[],
): boolean {
  switch (when) {
    case "any":
      return true;
    case "running":
      return running.includes(state);
    default:
      return state === when;
  }
}

/** Seconds per unit for the duration a `time_in_state` threshold is written in. */
function secondsPerUnit(unit: string, where: string): number {
  switch (unit) {
    case "s":
      return 1;
    case "min":
      return SECONDS_PER_MINUTE;
    case "h":
      return SECONDS_PER_HOUR;
    default:
      throw new AlarmEvaluatorError(`${where}: ${unit} is not a duration unit (s | min | h)`);
  }
}

/** A comparison a leaf may not use on an analog or derived quantity. */
function refuseEquality(op: LeafOp, where: string, what: string): void {
  if (op === "eq" || op === "ne") {
    throw new AlarmEvaluatorError(`${where}: ${what} is compared with gt, ge, lt or le, not ${op}`);
  }
}

/** What compiling one leaf produced: a condition, and the dwell it imposes on the message. */
interface CompiledLeaf {
  readonly condition: CompiledCondition;
  /**
   * Set only by a `time_in_state` leaf, whose threshold *is* the dwell: the generator turns
   * it into `duration_s` and the Go evaluator uses that instead of `for_s`
   * (`internal/ctrl7/alarms.go` `compile`).
   */
  readonly delayMs?: number;
}

function compileLeaf(
  leaf: Leaf,
  hysteresis: number,
  registry: AlarmRegistry,
  index: LaneIndex,
  where: string,
): CompiledLeaf {
  const signal = registry.signals.get(leaf.signal);
  if (signal !== undefined) {
    if (signal.group === "digital") {
      // The generator refuses anything but `eq` on a digital tag and turns the
      // threshold into a level, so a registry that used another comparison
      // could never reach the Go evaluator at all.
      if (leaf.op !== "eq") {
        throw new AlarmEvaluatorError(
          `${where}: a digital tag is compared with op: eq, not ${leaf.op}`,
        );
      }
      const lane = digitalLane(index, leaf.signal, where);
      const want = leaf.threshold !== 0;
      return { condition: { holds: (row) => (row.digital[lane] === 1) === want } };
    }
    refuseEquality(leaf.op, where, "an analog tag");
    const lane = analogLane(index, leaf.signal, where);
    const { op, threshold } = leaf;
    return {
      condition: {
        holds: (row, _state, _derived, active) =>
          compare(row.analog[lane] ?? 0, op, threshold, hysteresis, active),
      },
    };
  }

  const derived = registry.derived.get(leaf.signal);
  if (derived === undefined) {
    throw new AlarmEvaluatorError(
      `${where}: ${leaf.signal} is neither a signals.yaml tag nor a derived quantity`,
    );
  }
  refuseEquality(leaf.op, where, "a derived quantity");

  if (derived.kind === "time_in_state") {
    const wanted = derived.state;
    if (wanted === undefined) {
      throw new AlarmEvaluatorError(`${where}: derived ${derived.id} declares no state`);
    }
    const seconds = leaf.threshold * secondsPerUnit(derived.unit, where);
    if (!Number.isInteger(seconds)) {
      throw new AlarmEvaluatorError(`${where}: ${seconds} is not a whole number of seconds`);
    }
    return {
      condition: { holds: (_row, state) => state === wanted },
      delayMs: seconds * MS_PER_SECOND,
    };
  }

  if (derived.kind === "abs_delta" || derived.kind === "delta") {
    const [first, second] = derived.inputs ?? [];
    if (first === undefined || second === undefined) {
      throw new AlarmEvaluatorError(`${where}: derived ${derived.id} needs exactly two inputs`);
    }
    const a = analogLane(index, first, where);
    const b = analogLane(index, second, where);
    const absolute = derived.kind === "abs_delta";
    const { op, threshold } = leaf;
    return {
      condition: {
        holds: (row, _state, _derived, active) => {
          const difference = (row.analog[a] ?? 0) - (row.analog[b] ?? 0);
          return compare(
            absolute ? Math.abs(difference) : difference,
            op,
            threshold,
            hysteresis,
            active,
          );
        },
      },
    };
  }

  const id = derived.id;
  const { op, threshold } = leaf;
  return {
    condition: {
      holds: (_row, _state, quantities, active) =>
        compare(quantities.value(id), op, threshold, hysteresis, active),
    },
  };
}

/** Compiles one level of `all` / `any`; a branch never carries the message's reset band. */
function compileBranches(
  leaves: readonly Leaf[],
  registry: AlarmRegistry,
  index: LaneIndex,
  where: string,
): CompiledCondition[] {
  return leaves.map((leaf, position) => {
    const compiled = compileLeaf(leaf, 0, registry, index, `${where}[${position}]`);
    if (compiled.delayMs !== undefined) {
      throw new AlarmEvaluatorError(
        `${where}[${position}]: a state-duration leaf cannot be a branch of all/any`,
      );
    }
    return compiled.condition;
  });
}

function compileCondition(
  condition: Condition,
  hysteresis: number,
  registry: AlarmRegistry,
  index: LaneIndex,
  where: string,
): CompiledLeaf {
  if (isAllCondition(condition)) {
    const branches = compileBranches(condition.all, registry, index, `${where}.all`);
    return {
      condition: {
        holds: (row, state, derived) =>
          branches.every((branch) => branch.holds(row, state, derived, false)),
      },
    };
  }
  if (isAnyCondition(condition)) {
    const branches = compileBranches(condition.any, registry, index, `${where}.any`);
    return {
      condition: {
        holds: (row, state, derived) =>
          branches.some((branch) => branch.holds(row, state, derived, false)),
      },
    };
  }
  return compileLeaf(condition, hysteresis, registry, index, where);
}

/** Compiles one message against the register map. */
function compileAlarm(
  alarm: ResolvedAlarm,
  registry: AlarmRegistry,
  index: LaneIndex,
): CompiledAlarm {
  const where = `alarm ${alarm.code}`;
  const hysteresis = alarm.reset.hysteresis ?? 0;
  if (alarm.reset.mode === "auto_hysteresis" && conditionLeaves(alarm.condition).length !== 1) {
    throw new AlarmEvaluatorError(`${where}: auto_hysteresis needs a single leaf condition`);
  }
  const compiled = compileCondition(alarm.condition, hysteresis, registry, index, where);

  return {
    code: alarm.code,
    bit: alarm.bit,
    when: alarm.state,
    delayMs: compiled.delayMs ?? alarm.for_s * MS_PER_SECOND,
    startMaskMs: alarm.exclude_start_s * MS_PER_SECOND,
    manual: alarm.reset.mode === "manual" || alarm.reset.mode === "manual_service",
    condition: compiled.condition,
    holding: false,
    since: 0,
    active: false,
    latched: false,
  };
}

/**
 * Compiles `registry` against `map` and returns a controller for one replay.
 *
 * The evaluator carries the state of every dwell timer and every derived quantity, so one
 * belongs to one replay: a second run builds a second evaluator rather than resetting this
 * one, which is how a test cannot accidentally carry a latch across two scenarios.
 *
 * @throws AlarmEvaluatorError when a trigger uses a shape the Go evaluator would refuse, and
 * `DerivedError` when it names a tag the map does not replay or names it with the wrong kind
 * — lane resolution belongs to `derived.ts`, which is where both sides of it are decided.
 */
export function createAlarmEvaluator(registry: AlarmRegistry, map: RegisterMap): AlarmEvaluator {
  const index = createLaneIndex(resolveLanes(map));
  const derived = createDerivedEngine(registry.derived.values(), index);
  const alarms = registry.alarms.map((alarm) => compileAlarm(alarm, registry, index));
  const running = registry.runningStates;

  const activations = new Map<string, number>();
  const counters = { samples: 0, discontinuities: 0, manualClears: 0 };

  let previousSimTsMs = 0;
  let havePrevious = false;
  let previousState: MachineState = "off";
  let haveState = false;
  let lastStartMs = 0;
  let haveStart = false;

  /** Drops everything carried between samples except the bits themselves. */
  const restart = (): void => {
    for (const alarm of alarms) {
      if (alarm.latched) counters.manualClears += 1;
      alarm.holding = false;
      alarm.since = 0;
      alarm.latched = false;
    }
    derived.reset();
    havePrevious = false;
    haveState = false;
    haveStart = false;
    previousSimTsMs = 0;
    lastStartMs = 0;
    previousState = "off";
  };

  /** True while the motor-start mask still hides a message's condition. */
  const masked = (alarm: CompiledAlarm, simTsMs: number): boolean => {
    if (alarm.startMaskMs === 0 || !haveStart || simTsMs < lastStartMs) return false;
    return simTsMs - lastStartMs < alarm.startMaskMs;
  };

  return {
    registry,
    derived,
    get stats(): AlarmStats {
      return { ...counters, activations: new Map(activations) };
    },
    evaluate(row, state, simTsMs, discontinuity) {
      if (discontinuity) {
        counters.discontinuities += 1;
        restart();
      }
      counters.samples += 1;

      const dtMs = havePrevious && simTsMs > previousSimTsMs ? simTsMs - previousSimTsMs : 0;
      const started = haveState && previousState === "off" && state !== "off";
      if (started) {
        lastStartMs = simTsMs;
        haveStart = true;
      }
      derived.step(row, state, simTsMs, dtMs, started);

      let codes: string[] | undefined;
      for (const alarm of alarms) {
        const before = alarm.active || alarm.latched;
        const holds =
          guardHoldsForState(alarm.when, state, running) &&
          !masked(alarm, simTsMs) &&
          alarm.condition.holds(row, state, derived, alarm.active);

        if (holds) {
          if (!alarm.holding) {
            alarm.holding = true;
            alarm.since = simTsMs;
          }
          if (simTsMs >= alarm.since && simTsMs - alarm.since >= alarm.delayMs) alarm.active = true;
        } else {
          alarm.holding = false;
          alarm.since = 0;
          alarm.active = false;
        }
        if (alarm.active && alarm.manual) alarm.latched = true;

        const now = alarm.active || alarm.latched;
        if (now) {
          codes ??= [];
          codes.push(alarm.code);
          if (!before) activations.set(alarm.code, (activations.get(alarm.code) ?? 0) + 1);
        }
      }

      previousSimTsMs = simTsMs;
      havePrevious = true;
      previousState = state;
      haveState = true;

      // A quiet sample shares one frozen list rather than allocating an empty
      // array 1.5 million times; `toSample` copies before it publishes.
      return codes ?? NO_ALARMS;
    },
  };
}
