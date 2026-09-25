// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The machine state of the recorder's state strip, derived from the replayed signals by this rule:
//
//   loaded   := COMP == 0 and DV_eletric == 1
//   unloaded := not loaded and Motor_current >= 1.0 A     (motor running, intake closed: run-on)
//   off      := not loaded and Motor_current <  1.0 A
//   unknown  := any of the three missing
//
// It is a display aid only: detection's own state logic lives in the backend and is never
// imported here. Tag ids are fictional and known only at runtime, so the three inputs are found
// in the signal registry (`GET /api/signals`) by the recording column they come from — the
// dataset's own spelling `DV_eletric` included.

import type { SignalDef } from "@/api/types";

/** The state codes, as compact as the buffer's transition lists store them. */
export const MACHINE_STATE = { off: 0, unloaded: 1, loaded: 2, unknown: 255 } as const;

export type MachineState = (typeof MACHINE_STATE)[keyof typeof MACHINE_STATE];

/**
 * The motor draws at least this much whenever it runs: only 140 rows of the dataset fall in
 * 0.5–1.0 A.
 */
export const MOTOR_RUNNING_MIN_A = 1.0;

/** The recording columns the rule reads, as `metropt_column` names them. */
export const STATE_INPUT_COLUMNS = {
  comp: "COMP",
  dvElectric: "DV_eletric",
  motorCurrent: "Motor_current",
} as const;

/** The tag ids of the three inputs, resolved from the signal registry. */
export interface StateColumns {
  readonly comp: string;
  readonly dvElectric: string;
  readonly motorCurrent: string;
  /** The digital inputs the registry marks `digital_polarity: 'inverted'`; read as 1 − value. */
  readonly inverted?: ReadonlySet<string>;
}

/** One instant's values by tag id: numbers for analog tags, booleans or 0/1 for digital ones. */
export type StateInputs = Readonly<Record<string, number | boolean | null | undefined>>;

/**
 * True when the registry entry asks for its digital value to be inverted. The contract carries
 * no such field today (tag semantics already match the recorded polarity), so this reads it
 * defensively and a registry that adds it is honoured without a UI change.
 */
export function isInvertedDigital(signal: SignalDef): boolean {
  return "digital_polarity" in signal && signal.digital_polarity === "inverted";
}

/**
 * A digital input as 0 or 1: booleans as they are, numbers at or above one half as 1 (the
 * history's duty cycles included), anything else as unknown (null).
 */
export function digitalLevel(value: number | boolean | null | undefined): 0 | 1 | null {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0.5 ? 1 : 0;
  }
  return null;
}

function inputLevel(values: StateInputs, tag: string, columns: StateColumns): 0 | 1 | null {
  const level = digitalLevel(values[tag]);
  if (level === null || columns.inverted?.has(tag) !== true) {
    return level;
  }
  return level === 1 ? 0 : 1;
}

function analogValue(value: number | boolean | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The machine state at one instant, from the values of the three inputs. */
export function deriveState(values: StateInputs, columns: StateColumns): MachineState {
  const comp = inputLevel(values, columns.comp, columns);
  const dvElectric = inputLevel(values, columns.dvElectric, columns);
  const motorCurrent = analogValue(values[columns.motorCurrent]);
  if (comp === null || dvElectric === null || motorCurrent === null) {
    return MACHINE_STATE.unknown;
  }
  if (comp === 0 && dvElectric === 1) {
    return MACHINE_STATE.loaded;
  }
  return motorCurrent >= MOTOR_RUNNING_MIN_A ? MACHINE_STATE.unloaded : MACHINE_STATE.off;
}

/** The three inputs' tag ids, or null when the registry lacks any of them. */
export function resolveStateColumns(signals: readonly SignalDef[]): StateColumns | null {
  const byColumn = new Map<string, SignalDef>();
  for (const signal of signals) {
    if (signal.metropt_column !== null) {
      byColumn.set(signal.metropt_column, signal);
    }
  }
  const comp = byColumn.get(STATE_INPUT_COLUMNS.comp);
  const dvElectric = byColumn.get(STATE_INPUT_COLUMNS.dvElectric);
  const motorCurrent = byColumn.get(STATE_INPUT_COLUMNS.motorCurrent);
  if (comp === undefined || dvElectric === undefined || motorCurrent === undefined) {
    return null;
  }
  const inverted = new Set(
    [comp, dvElectric].filter(isInvertedDigital).map((signal) => signal.signal_id),
  );
  return {
    comp: comp.signal_id,
    dvElectric: dvElectric.signal_id,
    motorCurrent: motorCurrent.signal_id,
    inverted,
  };
}
