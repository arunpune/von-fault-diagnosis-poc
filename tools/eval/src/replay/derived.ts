// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The six derived quantities a CTRL-7 trigger may compare.
//
// They belong to the controller, not to the backend: the panel shows the
// continuous load time and the starts per hour because the controller counts
// them, and a message that trips on one of them has to see the same number the
// real unit would. So they are accumulated here, incrementally, one fold per
// sample, from the sample stream and the machine state — never recomputed over
// a window of history.
//
// This module is the twin of `derivedState` in
// `services/modbus/internal/ctrl7/derived.go`, and the Go side owns the
// semantics. Three of them are worth spelling out because they are easy to get
// subtly different:
//
//   * every accumulator advances by `dtMs`, the sim time since the previous
//     sample, which is zero on the first sample of a stretch — so nothing
//     accumulates *across* a discontinuity, and `reset()` drops what came
//     before it;
//   * `time_in_state` is a *continuous* timer: it is zero the moment the unit
//     leaves the state, not merely paused;
//   * `seconds_since_change` with `reset_on_state_exit` is held at zero
//     outside that state, so the hours a stopped unit spends waiting never
//     count towards a changeover timeout.
//
// Where the Go file hard-codes the four tags its quantities read, this one
// takes them from the `derived:` block of `signals.yaml` and resolves each to a
// lane of the register map. The two agree on the manual's registry, and a
// fixture that declares fewer quantities builds fewer accumulators instead of
// failing.

import type { DerivedDeclaration, DerivedKind } from "./alarm-registry.ts";
import type { MachineState, ReplayLanes, ReplayRow } from "./types.ts";

/** Milliseconds per unit of a duration quantity; the only conversion needed here. */
const MS_PER_UNIT: Readonly<Record<string, number>> = { s: 1_000, min: 60_000, h: 3_600_000 };

/** The one event `signals.yaml` declares: an `off` → running transition. */
export const START_EVENT = "start_event";

/** Thrown when a declaration cannot be bound to the register map or to a known kind. */
export class DerivedError extends Error {
  constructor(message: string) {
    super(`@fdp/eval: ${message}`);
    this.name = "DerivedError";
  }
}

/** Where each tag sits in a `ReplayRow`, resolved once per replay. */
export interface LaneIndex {
  readonly analog: ReadonlyMap<string, number>;
  readonly digital: ReadonlyMap<string, number>;
}

/** Maps the lanes of a register map by tag, so nothing downstream counts positions. */
export function createLaneIndex(lanes: ReplayLanes): LaneIndex {
  const analog = new Map<string, number>();
  const digital = new Map<string, number>();
  lanes.analog.forEach((signal, lane) => analog.set(signal.tag, lane));
  lanes.digital.forEach((signal, lane) => digital.set(signal.tag, lane));
  return { analog, digital };
}

/** The analog lane of `tag`, or an error naming who asked for it. */
export function analogLane(index: LaneIndex, tag: string, where: string): number {
  const lane = index.analog.get(tag);
  if (lane !== undefined) return lane;
  if (index.digital.has(tag)) {
    throw new DerivedError(`${where}: ${tag} is a digital tag, not an analog one`);
  }
  throw new DerivedError(`${where}: the register map replays no ${tag}`);
}

/** The digital lane of `tag`, or an error naming who asked for it. */
export function digitalLane(index: LaneIndex, tag: string, where: string): number {
  const lane = index.digital.get(tag);
  if (lane !== undefined) return lane;
  if (index.analog.has(tag)) {
    throw new DerivedError(`${where}: ${tag} is an analog tag, not a digital one`);
  }
  throw new DerivedError(`${where}: the register map replays no ${tag}`);
}

/** One accumulated quantity: its declaration, its current value and how it folds a sample. */
export interface DerivedQuantity {
  readonly id: string;
  readonly kind: DerivedKind;
  /** The unit `value` is expressed in, as `signals.yaml` declares it. */
  readonly unit: string;
  /** The value after the last `step`; zero before the first one and after `reset`. */
  readonly value: number;
  /** Folds one sample in. `dtMs` is 0 on the first sample of a stretch. */
  step(row: ReplayRow, state: MachineState, simTsMs: number, dtMs: number, started: boolean): void;
  /** Drops everything carried between samples, which is what a discontinuity does. */
  reset(): void;
}

/** Every declared quantity, advanced together, read by id. */
export interface DerivedEngine {
  readonly quantities: readonly DerivedQuantity[];
  step(row: ReplayRow, state: MachineState, simTsMs: number, dtMs: number, started: boolean): void;
  /** The value of `id` after the last `step`. */
  value(id: string): number;
  has(id: string): boolean;
  reset(): void;
}

/** The milliseconds-per-unit factor of a duration quantity. */
function msPerUnit(declaration: DerivedDeclaration): number {
  const factor = MS_PER_UNIT[declaration.unit];
  if (factor === undefined) {
    throw new DerivedError(
      `derived ${declaration.id}: unit ${declaration.unit} is not a duration ` +
        `(${Object.keys(MS_PER_UNIT).join(" | ")})`,
    );
  }
  return factor;
}

/** `|a − b|` or `a − b` of two analog lanes, recomputed from every sample. */
function createDelta(declaration: DerivedDeclaration, index: LaneIndex): DerivedQuantity {
  const where = `derived ${declaration.id}`;
  const [first, second] = declaration.inputs ?? [];
  if (first === undefined || second === undefined) {
    throw new DerivedError(`${where}: needs exactly two inputs`);
  }
  const a = analogLane(index, first, where);
  const b = analogLane(index, second, where);
  const absolute = declaration.kind === "abs_delta";
  let value = 0;

  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    get value() {
      return value;
    },
    step(row) {
      const difference = (row.analog[a] ?? 0) - (row.analog[b] ?? 0);
      value = absolute ? Math.abs(difference) : difference;
    },
    reset() {
      value = 0;
    },
  };
}

/** Uninterrupted time in one state; zero the moment the unit leaves it. */
function createTimeInState(declaration: DerivedDeclaration): DerivedQuantity {
  const wanted = declaration.state;
  if (wanted === undefined) {
    throw new DerivedError(`derived ${declaration.id}: declares no state`);
  }
  const factor = msPerUnit(declaration);
  let elapsedMs = 0;

  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    get value() {
      return elapsedMs / factor;
    },
    step(_row, state, _simTsMs, dtMs) {
      elapsedMs = state === wanted ? elapsedMs + dtMs : 0;
    },
    reset() {
      elapsedMs = 0;
    },
  };
}

/** Cumulative time in a set of states; it never falls back except at a discontinuity. */
function createTimeInStatesTotal(declaration: DerivedDeclaration): DerivedQuantity {
  const wanted = new Set(declaration.states ?? []);
  if (wanted.size === 0) throw new DerivedError(`derived ${declaration.id}: names no state`);
  const factor = msPerUnit(declaration);
  let elapsedMs = 0;

  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    get value() {
      return elapsedMs / factor;
    },
    step(_row, state, _simTsMs, dtMs) {
      if (wanted.has(state)) elapsedMs += dtMs;
    },
    reset() {
      elapsedMs = 0;
    },
  };
}

/** How many start events fall inside the trailing window; the value is a count. */
function createEventsPerWindow(declaration: DerivedDeclaration): DerivedQuantity {
  if (declaration.event !== START_EVENT) {
    throw new DerivedError(
      `derived ${declaration.id}: event ${String(declaration.event)} is not ${START_EVENT}`,
    );
  }
  const windowS = declaration.window_s;
  if (windowS === undefined || !(windowS > 0)) {
    throw new DerivedError(
      `derived ${declaration.id}: window_s ${String(windowS)} is not positive`,
    );
  }
  const windowMs = windowS * 1_000;
  let events: number[] = [];

  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    get value() {
      return events.length;
    },
    step(_row, _state, simTsMs, _dtMs, started) {
      if (started) events.push(simTsMs);
      let expired = 0;
      while (expired < events.length) {
        const at = events[expired] ?? 0;
        if (simTsMs < at || simTsMs - at < windowMs) break;
        expired += 1;
      }
      if (expired > 0) events = events.slice(expired);
    },
    reset() {
      events = [];
    },
  };
}

/** Time since a digital tag last changed, held at zero outside the declared state. */
function createSecondsSinceChange(
  declaration: DerivedDeclaration,
  index: LaneIndex,
): DerivedQuantity {
  const where = `derived ${declaration.id}`;
  if (declaration.input === undefined) throw new DerivedError(`${where}: declares no input`);
  const lane = digitalLane(index, declaration.input, where);
  const inside = declaration.reset_on_state_exit;
  const factor = msPerUnit(declaration);

  let elapsedMs = 0;
  let seen = false;
  let previous = false;

  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    get value() {
      return elapsedMs / factor;
    },
    step(row, state, _simTsMs, dtMs) {
      const level = row.digital[lane] === 1;
      if (!seen) {
        seen = true;
        previous = level;
        elapsedMs = 0;
      } else if (level !== previous) {
        previous = level;
        elapsedMs = 0;
      } else if (inside !== undefined && state !== inside) {
        elapsedMs = 0;
      } else {
        elapsedMs += dtMs;
      }
    },
    reset() {
      elapsedMs = 0;
      seen = false;
      previous = false;
    },
  };
}

/** Builds the accumulator one declaration asks for. */
function createQuantity(declaration: DerivedDeclaration, index: LaneIndex): DerivedQuantity {
  switch (declaration.kind) {
    case "abs_delta":
    case "delta":
      return createDelta(declaration, index);
    case "time_in_state":
      return createTimeInState(declaration);
    case "time_in_states_total":
      return createTimeInStatesTotal(declaration);
    case "events_per_window":
      return createEventsPerWindow(declaration);
    case "seconds_since_change":
      return createSecondsSinceChange(declaration, index);
  }
}

/**
 * Binds every declaration of `signals.yaml` to a lane of the register map.
 *
 * The declarations come from the registry rather than from a literal list here, so a
 * quantity the manual adds is a data change on both sides of the port. A declaration whose inputs
 * the map does not replay is an error at build time, not a silent zero at run time.
 */
export function createDerivedEngine(
  declarations: Iterable<DerivedDeclaration>,
  index: LaneIndex,
): DerivedEngine {
  const quantities: DerivedQuantity[] = [];
  const byId = new Map<string, DerivedQuantity>();

  for (const declaration of declarations) {
    if (byId.has(declaration.id)) {
      throw new DerivedError(`derived ${declaration.id}: is declared twice`);
    }
    const quantity = createQuantity(declaration, index);
    quantities.push(quantity);
    byId.set(quantity.id, quantity);
  }

  return {
    quantities,
    step(row, state, simTsMs, dtMs, started) {
      for (const quantity of quantities) quantity.step(row, state, simTsMs, dtMs, started);
    },
    value(id) {
      const quantity = byId.get(id);
      if (quantity === undefined) {
        throw new DerivedError(
          `no derived quantity ${id}; declared: ${[...byId.keys()].join(", ")}`,
        );
      }
      return quantity.value;
    },
    has(id) {
      return byId.has(id);
    },
    reset() {
      for (const quantity of quantities) quantity.reset();
    },
  };
}
