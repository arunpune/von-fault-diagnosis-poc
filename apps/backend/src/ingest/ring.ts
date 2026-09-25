// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-memory sample ring.
 *
 * A struct of arrays, not an array of structs: one typed array per column, so
 * 65,536 samples of sixteen tags cost about four megabytes and a chart query
 * walks one contiguous `Float32Array` instead of chasing sixteen thousand
 * objects. That is the whole reason this file exists — `downsample.ts` reads
 * the columns directly and never materialises a sample it does not return.
 *
 * Two ideas carry the rest:
 *
 *   * **Positions, not indices.** Every sample the ring has ever seen has a
 *     position, counted from the first one; the slot it lives in is
 *     `position & mask`. A position older than `newest - capacity` has been
 *     overwritten, which is a comparison rather than a wrap-around case.
 *   * **Segments.** Data time only moves forward between two discontinuities,
 *     so the ring is a sequence of segments and a binary search runs inside
 *     one. A jump backwards in `sim_ts` is a new segment, never a broken
 *     search. The ring is never cleared on a discontinuity: the samples before
 *     the jump stay readable, they are simply not comparable with the ones
 *     after it.
 */

import { ALARMS, SIGNALS, type Signal } from "@fdp/contracts";

import {
  FLAG_DISCONTINUITY,
  FLAG_MISSING,
  signalKind,
  type DecodedSample,
  type SignalKind,
} from "./types.ts";

/** Capacity of the runtime ring: ≈ 7.6 sim days at 10 s. */
export const RING_CAPACITY = 65_536;

/** One sample read back out of the ring. */
export interface RingSample {
  readonly position: number;
  readonly seq: number;
  readonly simTsMs: number;
  readonly segment: number;
  readonly discontinuity: boolean;
  readonly missing: boolean;
  readonly alarmBits: number;
  /** One number per stored tag; a digital state is `0` or `1`. */
  readonly values: Record<string, number>;
}

/** A run of positions whose data time is non-decreasing. */
export interface RingSegment {
  readonly segment: number;
  /** First position of the run. */
  readonly start: number;
  /** One past the last position of the run. */
  readonly end: number;
  readonly fromMs: number;
  readonly toMs: number;
}

/** The positions of one segment that fall inside a requested window. */
export interface RingRange {
  readonly segment: number;
  readonly start: number;
  readonly end: number;
}

export interface RingBufferOptions {
  /** The signal registry the columns are built from; the contracts one by default. */
  readonly signals?: readonly Signal[];
  /** A power of two; {@link RING_CAPACITY} by default. Tests use a small one. */
  readonly capacity?: number;
}

/** Where one segment begins, and which segment it is. */
interface SegmentStart {
  readonly segment: number;
  readonly start: number;
}

/**
 * The fixed-size ring of decoded samples.
 *
 * Every write is a plain typed-array store, so `push` allocates nothing once
 * the columns exist.
 */
export class RingBuffer {
  readonly capacity: number;
  readonly signals: readonly Signal[];

  private readonly mask: number;
  private readonly seqColumn: Uint32Array;
  private readonly simTsColumn: Float64Array;
  private readonly flagsColumn: Uint8Array;
  private readonly alarmBitsColumn: Uint32Array;
  private readonly segmentColumn: Uint32Array;
  private readonly analogColumns: Map<string, Float32Array>;
  private readonly digitalColumns: Map<string, Uint8Array>;

  /** How many samples have ever been pushed; the next position to write. */
  private written = 0;
  private segment = 0;
  private segmentStarts: SegmentStart[] = [];

  constructor(options: RingBufferOptions = {}) {
    const capacity = options.capacity ?? RING_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new RangeError(`ring capacity must be a positive power of two, got ${capacity}`);
    }
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.signals = options.signals ?? SIGNALS;

    this.seqColumn = new Uint32Array(capacity);
    this.simTsColumn = new Float64Array(capacity);
    this.flagsColumn = new Uint8Array(capacity);
    this.alarmBitsColumn = new Uint32Array(capacity);
    this.segmentColumn = new Uint32Array(capacity);
    this.analogColumns = new Map();
    this.digitalColumns = new Map();
    for (const signal of this.signals) {
      if (signalKind(signal) === "digital") {
        this.digitalColumns.set(signal.tag, new Uint8Array(capacity));
      } else {
        this.analogColumns.set(signal.tag, new Float32Array(capacity));
      }
    }
  }

  /** How many samples are readable right now. */
  get size(): number {
    return Math.min(this.written, this.capacity);
  }

  /** The oldest readable position; equal to {@link newestPosition} + 1 when empty. */
  get oldestPosition(): number {
    return Math.max(0, this.written - this.capacity);
  }

  /** The position of the newest sample, or `-1` when the ring is empty. */
  get newestPosition(): number {
    return this.written - 1;
  }

  /** True while the tag has a column in this ring. */
  has(tag: string): boolean {
    return this.analogColumns.has(tag) || this.digitalColumns.has(tag);
  }

  /** How the tag is stored, or `undefined` when the registry does not declare it. */
  kindOf(tag: string): SignalKind | undefined {
    if (this.analogColumns.has(tag)) return "analog";
    if (this.digitalColumns.has(tag)) return "digital";
    return undefined;
  }

  /**
   * Store one decoded sample, overwriting the oldest one when full.
   *
   * A sample whose `discontinuity` flag is set opens a new segment, unless it
   * is the very first sample of the ring: there is nothing before it for data
   * time to have jumped away from.
   */
  push(sample: DecodedSample): void {
    if (this.written === 0) {
      this.segmentStarts.push({ segment: this.segment, start: 0 });
    } else if (sample.discontinuity) {
      this.segment += 1;
      this.segmentStarts.push({ segment: this.segment, start: this.written });
    }

    const slot = this.written & this.mask;
    this.seqColumn[slot] = sample.seq;
    this.simTsColumn[slot] = sample.simTsMs;
    this.flagsColumn[slot] =
      (sample.discontinuity ? FLAG_DISCONTINUITY : 0) | (sample.missing ? FLAG_MISSING : 0);
    this.alarmBitsColumn[slot] = sample.alarmBits;
    this.segmentColumn[slot] = this.segment;

    for (const [tag, column] of this.analogColumns) {
      const value = sample.values[tag];
      if (value !== undefined) column[slot] = value;
    }
    for (const [tag, column] of this.digitalColumns) {
      const value = sample.values[tag];
      if (value !== undefined) column[slot] = value === 0 ? 0 : 1;
    }

    this.written += 1;
    this.forgetEvictedSegments();
  }

  /** True while `position` names a sample that has not been overwritten. */
  holds(position: number): boolean {
    return position >= this.oldestPosition && position < this.written;
  }

  /** The data time of one position, in epoch milliseconds. */
  simTsAt(position: number): number {
    this.assertHeld(position);
    return this.simTsColumn[position & this.mask] ?? Number.NaN;
  }

  /** The sequence number of one position. */
  seqAt(position: number): number {
    this.assertHeld(position);
    return this.seqColumn[position & this.mask] ?? 0;
  }

  /** The segment one position belongs to. */
  segmentAt(position: number): number {
    this.assertHeld(position);
    return this.segmentColumn[position & this.mask] ?? 0;
  }

  /** True when data time jumped immediately before this position. */
  discontinuityAt(position: number): boolean {
    this.assertHeld(position);
    return ((this.flagsColumn[position & this.mask] ?? 0) & FLAG_DISCONTINUITY) !== 0;
  }

  /** True when at least one source column of this sample was unreadable. */
  missingAt(position: number): boolean {
    this.assertHeld(position);
    return ((this.flagsColumn[position & this.mask] ?? 0) & FLAG_MISSING) !== 0;
  }

  /** The alarm bit field of one position. */
  alarmBitsAt(position: number): number {
    this.assertHeld(position);
    return this.alarmBitsColumn[position & this.mask] ?? 0;
  }

  /**
   * The value of one tag at one position, or `undefined` for an unknown tag.
   *
   * This is the hot read of the downsampler; it does no bounds checking beyond
   * the mask, so callers walk positions a {@link range} handed them.
   */
  valueAt(tag: string, position: number): number | undefined {
    const slot = position & this.mask;
    const analog = this.analogColumns.get(tag);
    if (analog !== undefined) return analog[slot];
    return this.digitalColumns.get(tag)?.[slot];
  }

  /** One position, read back as a sample. */
  sampleAt(position: number): RingSample {
    this.assertHeld(position);
    const slot = position & this.mask;
    const values: Record<string, number> = {};
    for (const [tag, column] of this.analogColumns) values[tag] = column[slot] ?? Number.NaN;
    for (const [tag, column] of this.digitalColumns) values[tag] = column[slot] ?? 0;
    return {
      position,
      seq: this.seqColumn[slot] ?? 0,
      simTsMs: this.simTsColumn[slot] ?? Number.NaN,
      segment: this.segmentColumn[slot] ?? 0,
      discontinuity: ((this.flagsColumn[slot] ?? 0) & FLAG_DISCONTINUITY) !== 0,
      missing: ((this.flagsColumn[slot] ?? 0) & FLAG_MISSING) !== 0,
      alarmBits: this.alarmBitsColumn[slot] ?? 0,
      values,
    };
  }

  /** The `count` newest samples, oldest first; fewer when the ring holds fewer. */
  latest(count = 1): RingSample[] {
    if (count <= 0 || this.written === 0) return [];
    const start = Math.max(this.oldestPosition, this.written - count);
    const out: RingSample[] = [];
    for (let position = start; position < this.written; position += 1) {
      out.push(this.sampleAt(position));
    }
    return out;
  }

  /**
   * The sample carrying `seq`, or `undefined`.
   *
   * `seq` restarts at 1 whenever the simulator does, and a restart always
   * arrives with the discontinuity flag, so the numbers ascend inside a
   * segment and the search is a binary one per segment. The newest segment is
   * searched first, which is where a caller asking about a recent sample
   * looks.
   */
  at(seq: number): RingSample | undefined {
    const segments = this.segments();
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      const position = this.findSeq(segment, seq);
      if (position !== undefined) return this.sampleAt(position);
    }
    return undefined;
  }

  /** The readable segments, oldest first. */
  segments(): RingSegment[] {
    const oldest = this.oldestPosition;
    const out: RingSegment[] = [];
    for (let index = 0; index < this.segmentStarts.length; index += 1) {
      const entry = this.segmentStarts[index];
      if (entry === undefined) continue;
      const next = this.segmentStarts[index + 1];
      const end = next?.start ?? this.written;
      const start = Math.max(entry.start, oldest);
      if (end <= start) continue;
      out.push({
        segment: entry.segment,
        start,
        end,
        fromMs: this.simTsAt(start),
        toMs: this.simTsAt(end - 1),
      });
    }
    return out;
  }

  /**
   * The positions whose data time falls in `[fromMs, toMs]`, one entry per
   * segment that overlaps the window, oldest segment first.
   *
   * Both bounds are inclusive: a chart window names the instants it wants to
   * show, not a half-open interval.
   */
  range(fromMs: number, toMs: number): RingRange[] {
    if (!(fromMs <= toMs)) return [];
    const out: RingRange[] = [];
    for (const segment of this.segments()) {
      if (segment.toMs < fromMs || segment.fromMs > toMs) continue;
      const start = this.lowerBound(segment, fromMs);
      const end = this.upperBound(segment, toMs);
      if (end <= start) continue;
      out.push({ segment: segment.segment, start, end });
    }
    return out;
  }

  /** First position of `segment` whose data time is at least `ms`. */
  private lowerBound(segment: RingSegment, ms: number): number {
    let low = segment.start;
    let high = segment.end;
    while (low < high) {
      const middle = low + ((high - low) >> 1);
      if (this.simTsAt(middle) < ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** One past the last position of `segment` whose data time is at most `ms`. */
  private upperBound(segment: RingSegment, ms: number): number {
    let low = segment.start;
    let high = segment.end;
    while (low < high) {
      const middle = low + ((high - low) >> 1);
      if (this.simTsAt(middle) <= ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** The position of `seq` inside one segment, or `undefined`. */
  private findSeq(segment: RingSegment, seq: number): number | undefined {
    let low = segment.start;
    let high = segment.end - 1;
    while (low <= high) {
      const middle = low + ((high - low) >> 1);
      const found = this.seqAt(middle);
      if (found === seq) return middle;
      if (found < seq) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  /** Drop the bookkeeping of segments no position of the ring belongs to any more. */
  private forgetEvictedSegments(): void {
    const oldest = this.oldestPosition;
    let keepFrom = 0;
    while (keepFrom + 1 < this.segmentStarts.length) {
      const next = this.segmentStarts[keepFrom + 1];
      if (next === undefined || next.start > oldest) break;
      keepFrom += 1;
    }
    if (keepFrom > 0) this.segmentStarts = this.segmentStarts.slice(keepFrom);
  }

  private assertHeld(position: number): void {
    if (!this.holds(position)) {
      throw new RangeError(
        `position ${position} is not in the ring [${this.oldestPosition}, ${this.written})`,
      );
    }
  }
}

/** The alarm bit field of a list of codes, by `REGISTER_MAP.alarms[].bit`. */
export function alarmBitsOf(codes: readonly string[]): number {
  let bits = 0;
  for (const code of codes) {
    const alarm = ALARM_BITS.get(code);
    if (alarm !== undefined) bits |= 1 << alarm;
  }
  return bits >>> 0;
}

/** The bit each alarm code occupies, built once from the register map. */
const ALARM_BITS: ReadonlyMap<string, number> = new Map(
  ALARMS.map((alarm) => [alarm.code, alarm.bit] as const),
);
