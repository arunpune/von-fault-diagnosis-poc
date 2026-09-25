// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The shapes the replay engine passes around.
//
// One rule governs this whole directory: nothing here names a tag id or a
// column index. Every lane a row carries is resolved from the register map of
// `@fdp/contracts` at run time, so a signal the manual renames or reorders
// moves the lanes rather than breaking a literal buried in a parser. The two
// names that are written down are the CSV's own `timestamp` column, which is
// the one column the dataset requires by name (the Go replay declares it the
// same way, `services/modbus/internal/replay/csv.go`), and the three columns
// the machine-state rule is itself written over.
//
// The other rule is ground-truth isolation: no module under `src/replay/`
// imports `@fdp/ground-truth`. The engine converts rows into the
// `telemetry-samples` batches a gateway would publish and knows nothing about
// labels.

import type { Readable } from "node:stream";

import type { Signal } from "@fdp/contracts";

/** The load state of the unit; the guard of every injection and alarm. */
export type MachineState = "loaded" | "unloaded" | "off";

/** The group a signal belongs to, as the register map records it. */
export type SignalGroup = Signal["group"];

/**
 * What the replay needs of one register-map signal.
 *
 * It is a structural subset of the `Signal` of `@fdp/contracts`, widened by one optional field:
 * `invert`. The generated map carries no `invert` today — the manual defines tag semantics to
 * match the recorded polarity, so the simulator writes the column value as is — but the replay
 * must apply one if the map ever declares it, which is what "digital invert applied per the
 * map" means. Reading it from an optional field is how that stays true in both worlds.
 */
export interface ReplaySignal {
  readonly tag: string;
  /** The CSV column this signal is replayed from, or `null` for a synthetic extra. */
  readonly metropt_column: string | null;
  readonly group: SignalGroup;
  /** Registers per unit; the quantisation step of an analog value. */
  readonly scale: number;
  /** True when the recorded polarity is the opposite of the tag's meaning. */
  readonly invert?: boolean;
}

/** What the replay needs of the register map: its signals, in map order. */
export interface RegisterMap {
  readonly signals: readonly ReplaySignal[];
}

/**
 * The lane layout one register map produces, computed once per replay.
 *
 * `analog` is the analog signals of the map in map order followed by its synthetic extras, so
 * the ambient slot is the last entry; `digital` is the digital signals in map order. A
 * `ReplayRow` is indexed by these positions and by nothing else.
 */
export interface ReplayLanes {
  readonly analog: readonly ReplaySignal[];
  readonly digital: readonly ReplaySignal[];
  /** Index into `analog` of the synthetic ambient lane, or `null` when the map has none. */
  readonly ambientIndex: number | null;
}

/**
 * One source row in SI units, before quantisation.
 *
 * `analog` and `digital` are indexed by the lanes of `ReplayLanes`. The extras at the end of
 * `analog` have no column and start as `NaN`; the ambient hook fills them. Both arrays are
 * mutable on purpose: an overlay rewrites values in place, exactly where the simulator applies
 * them (row → state → overlays → ambient → encode).
 */
export interface ReplayRow {
  simTsMs: number;
  analog: Float64Array;
  digital: Uint8Array;
  /** True when at least one bound column of this row could not be parsed. */
  missing: boolean;
}

/** How much of a source is replayed, and how it is cut into batches. */
export interface ReplayOptions {
  /** Inclusive lower bound in the dataset clock; earlier rows are skipped. */
  readonly from?: Date;
  /** Exclusive upper bound in the dataset clock; the read stops there. */
  readonly to?: Date;
  /** Samples per `telemetry-samples` batch: 1 to `MAX_BATCH_SIZE`, default `MAX_BATCH_SIZE`. */
  readonly batchSize?: number;
  /** The source step above which a sample is flagged `discontinuity`; default `GAP_THRESHOLD_MS`. */
  readonly gapThresholdMs?: number;
  /** The unit the batches are published for; default `DEFAULT_UNIT_ID` of `@fdp/contracts`. */
  readonly unitId?: string;
}

/**
 * The extension points the ambient model, the injections and the CTRL-7 port fill, called
 * once per row in this order.
 *
 * `classify` sees the untouched row, because an injection's `when` guard is evaluated against
 * the recorded state and not against the state its own overlay produces. `ambient` then
 * supplies the synthetic lane, `overlay` rewrites SI values in place, `alarms` reads the
 * overlaid row, and quantisation comes last — the simulator evaluates its controller before
 * `EncodeSlot`, so the port compares the same float64 the machine compares rather than the
 * register value it lands on.
 */
export interface ReplayHooks {
  /** The load state of this row; `defaultClassify` when absent. */
  classify?(row: ReplayRow): MachineState;
  /** Applies the active injections to `row.analog` / `row.digital`, in SI units. */
  overlay?(row: ReplayRow, state: MachineState, simTsMs: number): void;
  /** The ambient temperature in °C at this instant. */
  ambient?(simTsMs: number): number;
  /**
   * The controller alarm codes active on this row, unique and in ascending bit order.
   *
   * `createReplaySource` fills this slot from the manual's registry unless a caller supplies its
   * own hook or switches the port off (`alarms: false`, `EVAL_ALARMS=off`).
   */
  alarms?(
    row: ReplayRow,
    state: MachineState,
    simTsMs: number,
    discontinuity: boolean,
  ): readonly string[];
}

/** What a replay counted; read after the iteration, or while it runs. */
export interface ReplayStats {
  /** Rows read from the source inside `[from, to)`. */
  readonly rows: number;
  /** Samples emitted; equal to `rows`, counted separately so a filter would show. */
  readonly samples: number;
  /** Batches emitted. */
  readonly batches: number;
  /** Samples flagged `discontinuity`, the first sample of the source included. */
  readonly discontinuities: number;
  /** `sim_ts` of the first emitted sample, or `undefined` when none was. */
  readonly firstSimTs: string | undefined;
  /** `sim_ts` of the last emitted sample, or `undefined` when none was. */
  readonly lastSimTs: string | undefined;
}

/** Everything `createReplaySource` needs: a source, a map, a clock and the hooks. */
export interface ReplaySourceOptions extends ReplayOptions {
  /** A path to a `.csv` or `.csv.gz` file, or a readable stream of CSV text. */
  readonly source: string | Readable;
  readonly map: RegisterMap;
  /** The wall clock every envelope's `wall_ts` comes from; a fake one in tests. */
  readonly wall: () => Date;
  readonly hooks?: ReplayHooks;
}

/** The one CSV column the replay requires by name; every other is found through the map. */
export const TIMESTAMP_COLUMN = "timestamp";

/**
 * The columns the machine-state rule is written over.
 *
 * The rule names them, so the default classifier does too, and it resolves each to a lane
 * through `metropt_column` rather than through a tag id or a position.
 */
export const STATE_COLUMNS = {
  /** `COMP`: the intake-valve signal, 1 while there is no air intake. */
  intake: "COMP",
  /** `DV_eletric`: the outlet-valve command, 1 under load. The misspelling is upstream's. */
  loadValve: "DV_eletric",
  /** `Motor_current`: one phase of the three-phase motor, in amperes. */
  motorCurrent: "Motor_current",
} as const;

/** Motor current above which the motor counts as running. */
export const RUNNING_THRESHOLD_A = 1;

/** The source step above which two consecutive rows are a discontinuity, not an interval. */
export const GAP_THRESHOLD_MS = 60_000;

/** The largest batch the `telemetry-samples` schema accepts. */
export const MAX_BATCH_SIZE = 25;

/** Set to a non-empty, non-`0` value to validate every batch instead of only the first. */
export const VALIDATE_ALL_ENV = "EVAL_VALIDATE_ALL";
