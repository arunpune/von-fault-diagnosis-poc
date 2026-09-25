// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's telemetry buffer. WebSocket frames write into it synchronously and cheaply —
// typed-array stores, never React state — and the flush scheduler of `telemetry-store.ts` reads
// slices out of it at most four times a second.
//
// Per analog tag it keeps a time-ordered ring of `(t, v)` pairs in two Float64Arrays (epoch ms,
// value; NaN is a break in the line), per digital tag a list of level transitions, and one list
// each for the controller's active alarm codes and the machine state derived from the replayed
// digitals (`lib/machine-state.ts`). The live feed is the backend's decimated `telemetry.series`
// frames (min and max per flush bucket per tag); raw `telemetry.samples` are accepted too, for the
// debug channel and the tests. `seed()` loads the downsampled history of
// `GET /api/telemetry/series` underneath what the live feed already delivered.
//
// Data time can jump: a source gap collapsed by the simulator, a jump to a preset, a reset or a
// loop. A jump backwards means the replay starts over, so the buffer is emptied; a jump forwards
// breaks every line and row at the jump, so a window never draws across it.

import type { Sample, SeriesResponse, SignalDef, TelemetrySeries } from "@/api/types";
import { clipTransitions, lowerBound, upperBound, type Transition } from "@/lib/downsample";
import {
  deriveState,
  digitalLevel,
  isInvertedDigital,
  MACHINE_STATE,
  resolveStateColumns,
  type MachineState,
  type StateColumns,
} from "@/lib/machine-state";
import { parseIso } from "@/lib/time";

/** Points kept per analog tag: ≈ 7.5 sim days at 10 s. */
export const RING_CAPACITY = 65_536;

/** Transitions kept per digital tag, and for the alarm and state rows. */
export const TRANSITION_CAPACITY = 65_536;

/** The level of a digital or state row while nothing is known, e.g. across a jump. */
export const UNKNOWN_LEVEL = MACHINE_STATE.unknown;

export type DigitalLevel = 0 | 1 | typeof UNKNOWN_LEVEL;

/** The controller alarm codes active from a transition on, ascending; empty when none is. */
export type AlarmCodes = readonly string[];

/** The revision key of the derived machine-state row. */
export const STATE_KEY = "#state";
/** The revision key of the controller alarm row. */
export const ALARMS_KEY = "#alarms";

/** A window of one analog tag: views into the ring, valid until the next write. */
export interface SeriesSlice {
  readonly t: Float64Array;
  readonly v: Float64Array;
}

export interface PushResult {
  /** True when data time jumped in this batch (the buffer was reset or broken). */
  readonly discontinuity: boolean;
}

/** What `push` takes: a decimated chart frame, or raw samples. */
export type TelemetryBatch = TelemetrySeries | readonly Sample[];

type SignalKind = "analog" | "digital";

type TimedValue = readonly [t: number, value: number];

const EMPTY_SLICE: SeriesSlice = Object.freeze({
  t: new Float64Array(0),
  v: new Float64Array(0),
});

/** The first backing size of a ring; it doubles up to capacity plus slack. */
const INITIAL_RING_SIZE = 1_024;

/** Free room kept behind a full ring or list, so compaction runs once per this many writes. */
function slackFor(capacity: number): number {
  return Math.max(1, capacity >> 2);
}

/**
 * A fixed-capacity ring of `(t, v)` pairs, laid out as a sliding window over two typed arrays so
 * any time range is one contiguous `subarray` view. Appends are amortised O(1): once the backing
 * arrays are full the newest `capacity` pairs are copied to the front, which happens once every
 * `capacity / 4` writes. Times strictly ascend; an append at or before the last time is refused.
 */
class TimeSeriesRing {
  private t: Float64Array;
  private v: Float64Array;
  private start = 0;
  private end = 0;
  private readonly capacity: number;
  private readonly maxBacking: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.maxBacking = capacity + slackFor(capacity);
    const initial = Math.min(this.maxBacking, INITIAL_RING_SIZE);
    this.t = new Float64Array(initial);
    this.v = new Float64Array(initial);
  }

  get size(): number {
    return this.end - this.start;
  }

  /** The newest time, NaN when empty. */
  lastTime(): number {
    return this.size === 0 ? Number.NaN : (this.t[this.end - 1] ?? Number.NaN);
  }

  /** The newest finite value, or null. */
  lastFinite(): number | null {
    for (let index = this.end - 1; index >= this.start; index -= 1) {
      const value = this.v[index] ?? Number.NaN;
      if (Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  append(time: number, value: number): boolean {
    if (this.size > 0 && !(time > this.lastTime())) {
      return false;
    }
    if (this.end === this.t.length) {
      this.makeRoom();
    }
    this.t[this.end] = time;
    this.v[this.end] = value;
    this.end += 1;
    if (this.size > this.capacity) {
      this.start += 1;
    }
    return true;
  }

  /** Every pair with `from ≤ t ≤ to`, as views into the backing arrays. */
  slice(from: number, to: number): SeriesSlice {
    const times = this.t.subarray(this.start, this.end);
    const first = lowerBound(times, from);
    const end = Math.max(first, upperBound(times, to));
    return {
      t: this.t.subarray(this.start + first, this.start + end),
      v: this.v.subarray(this.start + first, this.start + end),
    };
  }

  /** The pairs from the first one at or after `from`, copied. */
  pairsFrom(from: number): TimedValue[] {
    const { t, v } = this.slice(from, Infinity);
    return Array.from(t, (time, index): TimedValue => [time, v[index] ?? Number.NaN]);
  }

  clear(): void {
    this.start = 0;
    this.end = 0;
  }

  private makeRoom(): void {
    const size = this.size;
    if (this.t.length < this.maxBacking) {
      const grown = Math.min(this.maxBacking, this.t.length * 2);
      const t = new Float64Array(grown);
      const v = new Float64Array(grown);
      t.set(this.t.subarray(this.start, this.end));
      v.set(this.v.subarray(this.start, this.end));
      this.t = t;
      this.v = v;
    } else {
      this.t.copyWithin(0, this.start, this.end);
      this.v.copyWithin(0, this.start, this.end);
    }
    this.start = 0;
    this.end = size;
  }
}

/**
 * A time-ordered list of value changes, capped at `capacity` entries (the oldest dropped). A
 * value equal to the one in force is not recorded; a second value at the same instant replaces
 * the first; a value older than the newest entry is refused.
 */
class TransitionLog<V> {
  private entries: Transition<V>[] = [];
  private readonly capacity: number;
  private readonly same: (a: V, b: V) => boolean;

  constructor(capacity: number, same: (a: V, b: V) => boolean) {
    this.capacity = capacity;
    this.same = same;
  }

  lastValue(): V | undefined {
    return this.entries.at(-1)?.[1];
  }

  record(time: number, value: V): boolean {
    const last = this.entries.at(-1);
    if (last !== undefined && time < last[0]) {
      return false;
    }
    if (last !== undefined && time === last[0]) {
      if (this.same(last[1], value)) {
        return false;
      }
      this.entries.pop();
      const before = this.entries.at(-1);
      if (before === undefined || !this.same(before[1], value)) {
        this.entries.push([time, value]);
      }
      return true;
    }
    if (last !== undefined && this.same(last[1], value)) {
      return false;
    }
    this.entries.push([time, value]);
    if (this.entries.length > this.capacity + slackFor(this.capacity)) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return true;
  }

  /** The entries from the first one at or after `from`. */
  entriesFrom(from: number): Transition<V>[] {
    const index = this.entries.findIndex(([time]) => time >= from);
    return index === -1 ? [] : this.entries.slice(index);
  }

  replaceWith(entries: readonly Transition<V>[]): void {
    this.entries = [];
    for (const [time, value] of entries) {
      this.record(time, value);
    }
  }

  clip(from: number, to: number, cap?: number): Transition<V>[] {
    return clipTransitions(this.entries, from, to, cap);
  }

  clear(): void {
    this.entries = [];
  }
}

function sameLevel(a: number, b: number): boolean {
  return a === b;
}

function sameCodes(a: AlarmCodes, b: AlarmCodes): boolean {
  return a.length === b.length && a.every((code, index) => code === b[index]);
}

/** The points of a track as `[t, v]`, in the order given; null values become NaN. */
function toTimedValues(points: readonly (readonly [string, number | null])[]): TimedValue[] {
  const values: TimedValue[] = [];
  for (const [iso, value] of points) {
    const time = parseIso(iso);
    if (Number.isFinite(time)) {
      values.push([time, value ?? Number.NaN]);
    }
  }
  return values;
}

/** The points after the last step back in time: what follows a jump backwards inside a frame. */
function afterLastStepBack(values: readonly TimedValue[]): readonly TimedValue[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous !== undefined && current !== undefined && current[0] <= previous[0]) {
      return values.slice(index);
    }
  }
  return values;
}

/** Halfway across the widest step of `latest` followed by the ascending `times`. */
function widestStepMidpoint(latest: number, times: readonly number[]): number {
  let previous = latest;
  let widest = -Infinity;
  let midpoint = latest;
  for (const time of times) {
    if (time - previous > widest) {
      widest = time - previous;
      midpoint = previous + widest / 2;
    }
    previous = time;
  }
  return midpoint;
}

/**
 * Inserts `[t, NaN]` halfway between two points whenever a listed discontinuity (ascending)
 * falls after the first and at or before the second, so the history breaks at every jump.
 */
function withBreaks(values: readonly TimedValue[], breaks: readonly number[]): TimedValue[] {
  const broken: TimedValue[] = [];
  let next = 0;
  let previous = -Infinity;
  for (const pair of values) {
    const [time] = pair;
    while (next < breaks.length && (breaks[next] ?? Infinity) <= previous) {
      next += 1;
    }
    if (previous > -Infinity && (breaks[next] ?? Infinity) <= time) {
      broken.push([previous + (time - previous) / 2, Number.NaN]);
    }
    broken.push(pair);
    previous = time;
  }
  return broken;
}

interface TrackEvent {
  readonly t: number;
  readonly tag: string;
  readonly value: number;
}

function byTime(a: TrackEvent, b: TrackEvent): number {
  return a.t - b.t;
}

export interface TelemetryBufferOptions {
  /** Points per analog tag; `RING_CAPACITY` by default (tests use a small one). */
  capacity?: number;
  /** Entries per transition list; `TRANSITION_CAPACITY` by default. */
  transitionCapacity?: number;
}

/** The recorder's store of live and seeded telemetry; one per page (`telemetry-store.ts`). */
export class TelemetryBuffer {
  private readonly capacity: number;
  private readonly transitionCapacity: number;
  private readonly rings = new Map<string, TimeSeriesRing>();
  private readonly digitals = new Map<string, TransitionLog<DigitalLevel>>();
  private readonly alarms: TransitionLog<AlarmCodes>;
  private readonly states: TransitionLog<MachineState>;
  private readonly kinds = new Map<string, SignalKind>();
  private readonly invertedDigitals = new Set<string>();
  private stateColumns: StateColumns | null = null;
  /** The newest raw value of each machine-state input, carried across frames and breaks. */
  private stateInputs: Record<string, number | boolean> = {};
  private latest = Number.NaN;
  private revisionCounter = 0;
  private resetRevision = 0;
  private resets = 0;
  private readonly revisions = new Map<string, number>();

  constructor(options: TelemetryBufferOptions = {}) {
    this.capacity = options.capacity ?? RING_CAPACITY;
    this.transitionCapacity = options.transitionCapacity ?? TRANSITION_CAPACITY;
    this.alarms = new TransitionLog<AlarmCodes>(this.transitionCapacity, sameCodes);
    this.states = new TransitionLog<MachineState>(this.transitionCapacity, sameLevel);
  }

  /**
   * Learns the signal registry: which tags are digital, which digitals read inverted, and the
   * three inputs of the machine state. Data already buffered is kept as it is.
   */
  configure(signals: readonly SignalDef[]): void {
    this.kinds.clear();
    this.invertedDigitals.clear();
    for (const signal of signals) {
      this.kinds.set(signal.signal_id, signal.kind);
      if (signal.kind === "digital" && isInvertedDigital(signal)) {
        this.invertedDigitals.add(signal.signal_id);
      }
    }
    this.stateColumns = resolveStateColumns(signals);
  }

  /** How many times the buffer was emptied: by `reset()`, or by data time going back. */
  get generation(): number {
    return this.resets;
  }

  /** Epoch ms of the newest point pushed or seeded, or null while the buffer is empty. */
  latestSimTs(): number | null {
    return Number.isNaN(this.latest) ? null : this.latest;
  }

  /**
   * A number that grows whenever the data behind `key` changes: a tag id, `STATE_KEY` or
   * `ALARMS_KEY`. Equal revisions mean equal data, so a view can keep what it derived.
   */
  revision(key: string): number {
    return Math.max(this.revisions.get(key) ?? 0, this.resetRevision);
  }

  /** Appends a decimated chart frame or raw samples; either may carry a discontinuity. */
  push(batch: TelemetryBatch): PushResult {
    return isSampleList(batch) ? this.pushSamples(batch) : this.pushSeries(batch);
  }

  /** Loads the downsampled history of a window underneath the live points already held. */
  seed(series: SeriesResponse): void {
    const from = parseIso(series.from);
    if (!Number.isFinite(from)) {
      return;
    }
    const breaks = series.discontinuities
      .map(parseIso)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const events: TrackEvent[] = [];
    for (const track of series.series) {
      const values = withBreaks(toTimedValues(track.points), breaks);
      if (this.kindOf(track.tag, track.kind) === "digital") {
        this.seedDigital(track.tag, values, from);
      } else {
        this.seedAnalog(track.tag, values, from);
      }
      if (this.isStateInput(track.tag)) {
        for (const [t, value] of values) {
          events.push({ t, tag: track.tag, value });
        }
      }
      this.noteLatest(values.at(-1)?.[0] ?? Number.NaN);
    }
    this.seedStates(events.sort(byTime), from);
  }

  /** Forgets everything buffered: the replay starts over. */
  reset(): void {
    for (const ring of this.rings.values()) {
      ring.clear();
    }
    for (const log of this.digitals.values()) {
      log.clear();
    }
    this.alarms.clear();
    this.states.clear();
    this.stateInputs = {};
    this.latest = Number.NaN;
    this.revisionCounter += 1;
    this.resetRevision = this.revisionCounter;
    this.resets += 1;
  }

  /** The points of an analog tag with `from ≤ t ≤ to`; empty for a tag never seen. */
  range(tag: string, fromMs: number, toMs: number): SeriesSlice {
    return this.rings.get(tag)?.slice(fromMs, toMs) ?? EMPTY_SLICE;
  }

  /** The newest finite value of an analog tag, or null. */
  latestValue(tag: string): number | null {
    return this.rings.get(tag)?.lastFinite() ?? null;
  }

  /** A digital tag's transitions in the window, led by its level at `fromMs` (display polarity). */
  digitalRange(
    tag: string,
    fromMs: number,
    toMs: number,
    cap?: number,
  ): Transition<DigitalLevel>[] {
    return this.digitals.get(tag)?.clip(fromMs, toMs, cap) ?? [];
  }

  /** The active controller alarm codes in the window, led by those active at `fromMs`. */
  alarmRange(fromMs: number, toMs: number, cap?: number): Transition<AlarmCodes>[] {
    return this.alarms.clip(fromMs, toMs, cap);
  }

  /** The derived machine state in the window, led by the state at `fromMs`. */
  stateRange(fromMs: number, toMs: number, cap?: number): Transition<MachineState>[] {
    return this.states.clip(fromMs, toMs, cap);
  }

  /** One controller alarm raised or cleared at `simTs` (the `alarm.native` frame). */
  recordAlarm(code: string, active: boolean, simTs: string): void {
    const time = parseIso(simTs);
    if (!Number.isFinite(time)) {
      return;
    }
    const current = this.alarms.lastValue() ?? [];
    const next = active
      ? [...new Set([...current, code])].sort()
      : current.filter((held) => held !== code);
    if (this.alarms.record(time, next)) {
      this.touch(ALARMS_KEY);
    }
  }

  // --- live feed ---------------------------------------------------------------------------

  private pushSamples(samples: readonly Sample[]): PushResult {
    let discontinuity = false;
    for (const sample of samples) {
      const time = parseIso(sample.sim_ts);
      if (!Number.isFinite(time)) {
        continue;
      }
      if (sample.flags.discontinuity) {
        discontinuity = true;
        this.beginSegment(time);
      } else if (time <= this.latest) {
        continue;
      }
      this.appendSample(sample, time);
    }
    return { discontinuity };
  }

  private appendSample(sample: Sample, time: number): void {
    const missing = sample.flags.missing;
    for (const [tag, value] of Object.entries(sample.values)) {
      const kind = typeof value === "boolean" ? "digital" : this.kindOf(tag);
      if (kind === "digital") {
        this.appendDigital(tag, time, missing ? Number.NaN : Number(value));
      } else {
        this.appendAnalog(tag, time, missing ? Number.NaN : Number(value));
      }
      if (this.isStateInput(tag) && !missing) {
        this.stateInputs[tag] = value;
      }
    }
    const codes = [...sample.alarms].sort();
    if (this.alarms.record(time, codes)) {
      this.touch(ALARMS_KEY);
    }
    this.recordState(time, missing ? MACHINE_STATE.unknown : this.currentState());
    this.noteLatest(time);
  }

  private pushSeries(frame: TelemetrySeries): PushResult {
    const tracks = new Map<string, readonly TimedValue[]>();
    for (const entry of frame.series) {
      const values = toTimedValues(entry.points);
      tracks.set(entry.tag, frame.discontinuity ? afterLastStepBack(values) : values);
    }
    const events: TrackEvent[] = [];
    for (const [tag, values] of tracks) {
      for (const [t, value] of values) {
        events.push({ t, tag, value });
      }
    }
    events.sort(byTime);
    // The break, when there is one, lies halfway before one of the events, so the loop reaches it.
    let breakAt = frame.discontinuity ? this.discontinuityInFrame(events.map(({ t }) => t)) : null;
    // A stable sort: a primed level goes in just before the first point at its instant.
    const ordered = [...this.primedFromLast(frame, tracks, events, breakAt), ...events].sort(
      byTime,
    );
    for (const event of ordered) {
      if (breakAt !== null && event.t > breakAt) {
        this.insertBreak(breakAt);
        breakAt = null;
      }
      this.appendEvent(event);
    }
    return { discontinuity: frame.discontinuity };
  }

  /**
   * Where a frame flagged as discontinuous jumped. A frame that starts at or before the newest
   * point replays older data: the buffer is emptied and nothing needs breaking (null). Otherwise
   * the jump is the widest step in data time, and the break goes halfway across it.
   */
  private discontinuityInFrame(ascendingTimes: readonly number[]): number | null {
    const first = ascendingTimes[0];
    if (first === undefined || Number.isNaN(this.latest)) {
      return null;
    }
    if (first <= this.latest) {
      this.reset();
      return null;
    }
    return widestStepMidpoint(this.latest, ascendingTimes);
  }

  /**
   * A frame carries a digital only when it changes, and its `last` map holds every tag's newest
   * value. A digital without a point in this frame whose level is not known — after a reset,
   * across the break this frame inserts, or as a machine-state input the live feed has not
   * carried yet — takes its level from `last` at the frame's first instant after the break, so
   * the rows and the machine state do not stay unknown until the digital next changes.
   */
  private primedFromLast(
    frame: TelemetrySeries,
    tracks: ReadonlyMap<string, readonly TimedValue[]>,
    events: readonly TrackEvent[],
    breakAt: number | null,
  ): TrackEvent[] {
    const firstAfterBreak = events.find(({ t }) => breakAt === null || t > breakAt)?.t;
    const time = firstAfterBreak ?? parseIso(frame.to_sim_ts);
    if (!Number.isFinite(time)) {
      return [];
    }
    const primed: TrackEvent[] = [];
    for (const [tag, value] of Object.entries(frame.last)) {
      const hasPoints = (tracks.get(tag)?.length ?? 0) > 0;
      if (hasPoints || this.kindOf(tag, typeof value === "boolean") !== "digital") {
        continue;
      }
      const known = this.digitals.get(tag)?.lastValue();
      const unknownInput = this.isStateInput(tag) && this.stateInputs[tag] === undefined;
      if (breakAt !== null || known === undefined || known === UNKNOWN_LEVEL || unknownInput) {
        primed.push({ t: time, tag, value: Number(value) });
      }
    }
    return primed;
  }

  private appendEvent({ t, tag, value }: TrackEvent): void {
    if (this.kindOf(tag) === "digital") {
      this.appendDigital(tag, t, value);
    } else {
      this.appendAnalog(tag, t, value);
    }
    if (this.isStateInput(tag)) {
      if (Number.isFinite(value)) {
        this.stateInputs[tag] = value;
      }
      this.recordState(t, this.currentState());
    }
    this.noteLatest(t);
  }

  /** Starts a new segment at `time`: empties the buffer for a jump back, breaks it otherwise. */
  private beginSegment(time: number): void {
    if (Number.isNaN(this.latest)) {
      return;
    }
    if (time <= this.latest) {
      this.reset();
    } else {
      this.insertBreak(this.latest + (time - this.latest) / 2);
    }
  }

  /** Breaks every line and row at `time`: NaN in each ring, unknown in each list. */
  private insertBreak(time: number): void {
    for (const [tag, ring] of this.rings) {
      if (ring.append(time, Number.NaN)) {
        this.touch(tag);
      }
    }
    for (const [tag, log] of this.digitals) {
      if (log.record(time, UNKNOWN_LEVEL)) {
        this.touch(tag);
      }
    }
    if (this.alarms.record(time, [])) {
      this.touch(ALARMS_KEY);
    }
    this.recordState(time, MACHINE_STATE.unknown);
  }

  private appendAnalog(tag: string, time: number, value: number): void {
    if (this.ring(tag).append(time, value)) {
      this.touch(tag);
    }
  }

  private appendDigital(tag: string, time: number, value: number): void {
    if (this.digitalLog(tag).record(time, this.displayLevel(tag, value))) {
      this.touch(tag);
    }
  }

  private recordState(time: number, state: MachineState): void {
    if (this.stateColumns !== null && this.states.record(time, state)) {
      this.touch(STATE_KEY);
    }
  }

  private currentState(): MachineState {
    if (this.stateColumns === null) {
      return MACHINE_STATE.unknown;
    }
    return deriveState(this.stateInputs, this.stateColumns);
  }

  // --- history seed ------------------------------------------------------------------------

  private seedAnalog(tag: string, values: readonly TimedValue[], from: number): void {
    const ring = this.ring(tag);
    const live = ring.pairsFrom(from);
    const firstLive = live[0]?.[0] ?? Infinity;
    ring.clear();
    for (const [time, value] of values) {
      if (time < firstLive) {
        ring.append(time, value);
      }
    }
    for (const [time, value] of live) {
      ring.append(time, value);
    }
    this.touch(tag);
  }

  private seedDigital(tag: string, values: readonly TimedValue[], from: number): void {
    const log = this.digitalLog(tag);
    const live = log.entriesFrom(from);
    const firstLive = live[0]?.[0] ?? Infinity;
    const seeded = values
      .filter(([time]) => time < firstLive)
      .map(([time, value]): Transition<DigitalLevel> => [time, this.displayLevel(tag, value)]);
    log.replaceWith([...seeded, ...live]);
    this.touch(tag);
  }

  private seedStates(events: readonly TrackEvent[], from: number): void {
    if (this.stateColumns === null || events.length === 0) {
      return;
    }
    const live = this.states.entriesFrom(from);
    const firstLive = live[0]?.[0] ?? Infinity;
    const inputs: Record<string, number> = {};
    const seeded: Transition<MachineState>[] = [];
    for (const { t, tag, value } of events) {
      if (t >= firstLive) {
        break;
      }
      if (Number.isFinite(value)) {
        inputs[tag] = value;
      }
      const state = Number.isFinite(value)
        ? deriveState(inputs, this.stateColumns)
        : MACHINE_STATE.unknown;
      seeded.push([t, state]);
    }
    this.states.replaceWith([...seeded, ...live]);
    this.touch(STATE_KEY);
    // The live feed carries a digital only when it changes: an input it has not carried yet
    // starts from the history's last value, so the state does not wait for the next change.
    for (const [tag, value] of Object.entries(inputs)) {
      this.stateInputs[tag] ??= value;
    }
  }

  // --- helpers -------------------------------------------------------------------------------

  private kindOf(tag: string, hint?: SignalKind | boolean | null): SignalKind {
    const known = this.kinds.get(tag);
    if (known !== undefined) {
      return known;
    }
    if (hint === true || hint === "digital") {
      return "digital";
    }
    return "analog";
  }

  private isStateInput(tag: string): boolean {
    const columns = this.stateColumns;
    return (
      columns !== null &&
      (tag === columns.comp || tag === columns.dvElectric || tag === columns.motorCurrent)
    );
  }

  /** A raw digital value as the row shows it: inverted where the registry says so. */
  private displayLevel(tag: string, value: number): DigitalLevel {
    const level = digitalLevel(value);
    if (level === null) {
      return UNKNOWN_LEVEL;
    }
    return this.invertedDigitals.has(tag) ? ((1 - level) as 0 | 1) : level;
  }

  private ring(tag: string): TimeSeriesRing {
    let ring = this.rings.get(tag);
    if (ring === undefined) {
      ring = new TimeSeriesRing(this.capacity);
      this.rings.set(tag, ring);
    }
    return ring;
  }

  private digitalLog(tag: string): TransitionLog<DigitalLevel> {
    let log = this.digitals.get(tag);
    if (log === undefined) {
      log = new TransitionLog<DigitalLevel>(this.transitionCapacity, sameLevel);
      this.digitals.set(tag, log);
    }
    return log;
  }

  private noteLatest(time: number): void {
    if (Number.isFinite(time) && !(time <= this.latest)) {
      this.latest = time;
    }
  }

  private touch(key: string): void {
    this.revisionCounter += 1;
    this.revisions.set(key, this.revisionCounter);
  }
}

function isSampleList(batch: TelemetryBatch): batch is readonly Sample[] {
  return Array.isArray(batch);
}
