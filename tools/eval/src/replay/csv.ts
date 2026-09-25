// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The MetroPT-3 CSV, streamed into replay rows.
//
// The full file is 218 MB and a slice is a few hundred KB; both go through the
// same path, because a loader that behaves differently on the fixture than on
// the file it was cut from is a loader that proves nothing. Nothing is ever
// buffered whole: a path is opened with `createReadStream` (through
// `createGunzip` when it ends in `.gz`), a stream is taken as it comes, and
// `node:readline` hands out one line at a time.
//
// Columns are resolved from the header against `metropt_column` of the
// register map, exactly as the Go replay resolves them
// (`services/modbus/internal/replay/csv.go`): `timestamp` is required by name,
// the dataset's unnamed integer index column is ignored, a mapped column the
// header does not have is an error that names it, and two signals may not
// claim the same column. A signal without a column — the synthetic ambient
// extra — has no source and stays `NaN` until a hook fills it.
//
// Timestamps are the dataset clock (docs/dataset.md): fixed-width
// `YYYY-MM-DD HH:MM:SS`, read as UTC. Two consequences are used here. The
// first is that the format is its own sort key, so `[from, to)` is decided by
// comparing the field with two precomputed strings before any number is
// parsed, and so is the strictly-increasing check. The second is that the
// field can be decoded in place with `Date.UTC` instead of `Date.parse`, which
// is what keeps the full file under the throughput the integration test
// asserts. `parseRowTs` and the `parseCsvTs` of `../time.ts` are two
// implementations of one rule, and `csv.test.ts` pins them to each other.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { formatCsvTs } from "../time.ts";
import type { RegisterMap, ReplayLanes, ReplayOptions, ReplayRow, ReplaySignal } from "./types.ts";
import { TIMESTAMP_COLUMN } from "./types.ts";

/** The extension that makes a path a gzip stream rather than plain text. */
const GZIP_EXTENSION = ".gz";

/** The width of a dataset timestamp, `YYYY-MM-DD HH:MM:SS`. */
const TS_LENGTH = 19;

/** A UTF-8 byte-order mark, which a spreadsheet may have left on the header line. */
const BYTE_ORDER_MARK = "﻿";

/** What one CSV column feeds. */
type BindKind = "ignore" | "timestamp" | "analog" | "digital";

/** One resolved column: what it feeds and, for a signal, which lane of the row. */
interface Binding {
  readonly kind: BindKind;
  readonly lane: number;
}

const IGNORED: Binding = { kind: "ignore", lane: -1 };

/** Thrown when a header cannot be resolved against the register map. */
export class HeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeaderError";
  }
}

/** Thrown when a row is unusable: no timestamp, a malformed one, or one that goes backwards. */
export class RowError extends Error {
  /** The 1-based line number in the source, the header line counted. */
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = "RowError";
    this.line = line;
  }
}

/**
 * The lane layout of a register map: analog signals, then the synthetic extras, then the
 * digital signals in map order.
 *
 * The extras land at the end of the analog lanes, which is what makes "the ambient slot is
 * the last entry" true without naming the tag. A map with several extras keeps them all, in
 * map order; `ambientIndex` is the first of them, because that is the one the ambient hook
 * supplies.
 */
export function resolveLanes(map: RegisterMap): ReplayLanes {
  const analog: ReplaySignal[] = [];
  const digital: ReplaySignal[] = [];
  const extras: ReplaySignal[] = [];

  for (const signal of map.signals) {
    if (signal.group === "analog") analog.push(signal);
    else if (signal.group === "digital") digital.push(signal);
    else extras.push(signal);
  }

  const ambientIndex = extras.length === 0 ? null : analog.length;
  return { analog: [...analog, ...extras], digital, ambientIndex };
}

/** The column names of a header line, without a byte-order mark and without padding. */
function headerColumns(header: string): string[] {
  return header
    .replace(BYTE_ORDER_MARK, "")
    .split(",")
    .map((name) => name.trim());
}

/**
 * Maps a header line onto the lanes, one binding per column.
 *
 * The result is trimmed after the last bound column, so a row parse stops as soon as it has
 * everything the map asked for.
 */
export function resolveBindings(header: string, lanes: ReplayLanes): Binding[] {
  const names = headerColumns(header);
  const byName = new Map<string, number>();
  names.forEach((name, index) => {
    if (name === "") return; // the dataset's unnamed integer index column
    const first = byName.get(name);
    if (first !== undefined) {
      throw new HeaderError(
        `column "${name}" appears twice in the header, at ${first} and ${index}`,
      );
    }
    byName.set(name, index);
  });

  const timestampAt = byName.get(TIMESTAMP_COLUMN);
  if (timestampAt === undefined) {
    throw new HeaderError(`the required column "${TIMESTAMP_COLUMN}" is missing from the header`);
  }

  const bindings: Binding[] = names.map(() => IGNORED);
  bindings[timestampAt] = { kind: "timestamp", lane: -1 };

  const bind = (signals: readonly ReplaySignal[], kind: "analog" | "digital"): void => {
    signals.forEach((signal, lane) => {
      if (signal.metropt_column === null) return; // a synthetic extra: no column to read
      const column = byName.get(signal.metropt_column);
      if (column === undefined) {
        throw new HeaderError(
          `column "${signal.metropt_column}" of signal "${signal.tag}" is missing from the header`,
        );
      }
      if (bindings[column] !== IGNORED) {
        throw new HeaderError(
          `column "${signal.metropt_column}" is claimed by more than one signal`,
        );
      }
      bindings[column] = { kind, lane };
    });
  };

  bind(lanes.analog, "analog");
  bind(lanes.digital, "digital");

  let last = -1;
  bindings.forEach((binding, index) => {
    if (binding !== IGNORED) last = index;
  });
  return bindings.slice(0, last + 1);
}

/** Reads `count` digits of `text` at `at`, or `-1` when any of them is not a digit. */
function digits(text: string, at: number, count: number): number {
  let value = 0;
  for (let index = at; index < at + count; index += 1) {
    const code = text.charCodeAt(index) - 0x30;
    if (code < 0 || code > 9) return -1;
    value = value * 10 + code;
  }
  return value;
}

/**
 * One dataset timestamp as epoch milliseconds, UTC.
 *
 * The layout is fixed, so the field is decoded in place: the separators must sit where the
 * layout puts them, every other character must be a digit, and the calendar date must exist
 * — `Date.UTC` would otherwise roll `2020-02-30` over into 1 March instead of rejecting it.
 *
 * @throws TypeError when the field does not have the dataset's shape or names no instant.
 */
export function parseRowTs(text: string): number {
  const year = text.length === TS_LENGTH ? digits(text, 0, 4) : -1;
  if (
    year < 0 ||
    text.charCodeAt(4) !== 0x2d /* - */ ||
    text.charCodeAt(7) !== 0x2d ||
    text.charCodeAt(10) !== 0x20 /* space */ ||
    text.charCodeAt(13) !== 0x3a /* : */ ||
    text.charCodeAt(16) !== 0x3a
  ) {
    throw new TypeError(`not a MetroPT-3 timestamp: ${JSON.stringify(text)}`);
  }

  const month = digits(text, 5, 2);
  const day = digits(text, 8, 2);
  const hour = digits(text, 11, 2);
  const minute = digits(text, 14, 2);
  const second = digits(text, 17, 2);
  if (month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0) {
    throw new TypeError(`not a MetroPT-3 timestamp: ${JSON.stringify(text)}`);
  }

  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    throw new TypeError(`MetroPT-3 timestamp names no instant: ${text}`);
  }
  return milliseconds;
}

/**
 * One numeric field, or `undefined` when it carries no value.
 *
 * Empty, `NaN`, `Infinity` and anything `Number()` cannot read are all the same answer: the
 * lane keeps what the previous row put there and the row is flagged `missing`, which is what
 * the simulator does.
 */
function parseNumber(text: string): number | undefined {
  if (text.length === 0) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Opens a replay source: a `.csv` path, a `.csv.gz` path, or a stream that is already open. */
function openSource(source: string | Readable): Readable {
  if (typeof source !== "string") return source;
  const file = createReadStream(source);
  if (!source.endsWith(GZIP_EXTENSION)) return file;

  // `pipe` does not forward errors, so a missing or truncated file would hang
  // the reader instead of rejecting it.
  const gunzip = createGunzip();
  file.on("error", (error: Error) => gunzip.destroy(error));
  return file.pipe(gunzip);
}

/**
 * The dataset-clock string a bound compares against, or `undefined` when there is no bound.
 *
 * Every row of the dataset lands on a whole second, so a bound is rounded up to one: a row
 * is inside `[from, to)` exactly when its field is `>= ceil(from)` and `< ceil(to)`, and
 * truncating instead would pull a row at `to`'s own second inside a window that ends before
 * it.
 */
function boundText(bound: Date | undefined): string | undefined {
  if (bound === undefined) return undefined;
  const milliseconds = bound.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError("replay bound is not a date");
  return formatCsvTs(Math.ceil(milliseconds / 1000) * 1000);
}

/**
 * Streams a MetroPT-3 CSV into replay rows, in file order.
 *
 * Each row is a fresh pair of typed arrays whose lanes are `resolveLanes(map)`: analog
 * signals then the synthetic extras (which have no column and stay `NaN`), and the digital
 * signals with `invert` applied where the map declares it. A field that carries no value
 * leaves its lane holding the previous row's value and sets `missing`; only the timestamp is
 * fatal, because it orders the replay.
 *
 * @throws HeaderError when the header cannot be resolved against the map, and RowError when
 * a row has no usable timestamp or does not move the clock forward.
 */
export async function* readRows(
  source: string | Readable,
  map: RegisterMap,
  opts: ReplayOptions = {},
): AsyncIterable<ReplayRow> {
  const lanes = resolveLanes(map);
  const from = boundText(opts.from);
  const to = boundText(opts.to);

  const stream = openSource(source);
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  const analog = new Float64Array(lanes.analog.length);
  const digital = new Uint8Array(lanes.digital.length);
  if (lanes.ambientIndex !== null) {
    for (let lane = lanes.ambientIndex; lane < analog.length; lane += 1) analog[lane] = Number.NaN;
  }
  const inverted = lanes.digital.map((signal) => signal.invert === true);

  let bindings: Binding[] | undefined;
  let timestampAt = -1;
  let line = 0;
  let previousTs = "";

  try {
    for await (const text of reader) {
      line += 1;
      if (bindings === undefined) {
        bindings = resolveBindings(text, lanes);
        timestampAt = bindings.findIndex((binding) => binding.kind === "timestamp");
        continue;
      }
      if (text === "") continue; // a trailing newline, not a row

      const timestamp = fieldAt(text, timestampAt);
      if (timestamp === undefined || timestamp.length !== TS_LENGTH) {
        throw new RowError(line, `no ${TIMESTAMP_COLUMN} field of the dataset's width`);
      }
      if (timestamp <= previousTs) {
        throw new RowError(line, `timestamp ${timestamp} does not follow ${previousTs}`);
      }
      previousTs = timestamp;

      if (from !== undefined && timestamp < from) continue;
      if (to !== undefined && timestamp >= to) break;

      let missing = false;
      let column = 0;
      let at = 0;
      while (column < bindings.length && at <= text.length) {
        const comma = text.indexOf(",", at);
        const end = comma < 0 ? text.length : comma;
        const binding = bindings[column] ?? IGNORED;
        if (binding.kind === "analog" || binding.kind === "digital") {
          const value = parseNumber(text.slice(at, end));
          if (value === undefined) missing = true;
          else if (binding.kind === "analog") analog[binding.lane] = value;
          else digital[binding.lane] = (value !== 0) === (inverted[binding.lane] === true) ? 0 : 1;
        }
        column += 1;
        if (comma < 0) break;
        at = comma + 1;
      }
      // Columns the line stopped short of: every bound one keeps its previous value.
      for (; column < bindings.length; column += 1) {
        if ((bindings[column] ?? IGNORED).kind !== "ignore") missing = true;
      }

      yield {
        simTsMs: parseRowTs(timestamp),
        analog: analog.slice(),
        digital: digital.slice(),
        missing,
      };
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (bindings === undefined) throw new HeaderError("the source has no header line");
}

/** The `index`-th comma-separated field of a line, or `undefined` when the line stops short. */
function fieldAt(text: string, index: number): string | undefined {
  let at = 0;
  for (let column = 0; column < index; column += 1) {
    const comma = text.indexOf(",", at);
    if (comma < 0) return undefined;
    at = comma + 1;
  }
  const comma = text.indexOf(",", at);
  return text.slice(at, comma < 0 ? text.length : comma);
}
