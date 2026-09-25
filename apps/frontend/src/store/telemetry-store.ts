// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The recorder's store: the one telemetry buffer of the page, the flush scheduler that turns its
// writes into at most four store versions a second, and the hooks the recorder reads through
// `useSyncExternalStore`.
//
// Frames never reach React one by one. The handlers registered below (at import time) write each
// frame into the buffer and ask for a flush; the scheduler publishes a version at most every
// 250 ms — every second while the tab is hidden — aligned to an animation frame. Each hook derives
// its view once per published version and returns the very same object while the data behind it is
// unchanged, so a lane re-renders only when its own slice moved.
//
// History comes from `GET /api/telemetry/series`: when the buffer first receives data, after a
// jump marker (which also empties it) and on every `link.open`, anchored on the replay's
// position while nothing is buffered. Seed requests never overlap; one asked for while another
// is in flight runs after it.

import { useSyncExternalStore } from "react";

import { getSeries } from "@/api/endpoints";
import type { SignalDef } from "@/api/types";
import { registerFrameHandler } from "@/api/ws-dispatch";
import { breakGaps, GAP_MS, lttb, type ChartPoint, type Transition } from "@/lib/downsample";
import type { MachineState } from "@/lib/machine-state";
import { parseIso, spansUtcDays } from "@/lib/time";
import { getLiveState, setDerivedSimNow } from "@/store/live-store";
import {
  ALARMS_KEY,
  STATE_KEY,
  TelemetryBuffer,
  type AlarmCodes,
  type DigitalLevel,
  type TelemetryBatch,
} from "@/store/telemetry-buffer";

/** At most one store version per this many milliseconds while the page is visible. */
export const FLUSH_INTERVAL_MS = 250;
/** At most one store version per this many milliseconds while the tab is hidden. */
export const HIDDEN_FLUSH_INTERVAL_MS = 1_000;
/** The most points a lane series draws (LTTB). */
export const LANE_POINTS = 600;
/** How much history a seed asks for, and at what resolution. */
export const SEED_WINDOW_MS = 86_400_000;
export const SEED_POINTS = 2_000;
/** Ticks on the shared time axis. */
export const AXIS_TICKS = 6;
/**
 * A step wider than this many times a series' mean spacing breaks its line. Coarse data — the
 * 2 000-point history of a 24 h seed, or a lane reduced to 600 points — has neighbours far more
 * than 60 s apart; this keeps those lines whole while still breaking at real gaps.
 */
export const GAP_SPACING_FACTOR = 5;

// --- flush scheduler ------------------------------------------------------------------------

export interface FlushSchedulerDeps {
  publish: () => void;
  /** Milliseconds from a monotonic clock. */
  now: () => number;
  isHidden: () => boolean;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  requestFrame: (callback: () => void) => unknown;
  cancelFrame: (handle: unknown) => void;
}

export interface FlushScheduler {
  /** Asks for a publish; requests made before it happens coalesce into one. */
  request(): void;
  /** Drops a pending publish and forgets when the last one happened. */
  cancel(): void;
}

/**
 * The throttle: after a request, publish once the interval since the previous publish has passed —
 * on the next animation frame while visible, straight from the timer while hidden (a hidden tab
 * runs no animation frames).
 */
export function createFlushScheduler(deps: FlushSchedulerDeps): FlushScheduler {
  let lastPublish = -Infinity;
  let pending = false;
  let timer: unknown = null;
  let frame: unknown = null;

  function run(): void {
    timer = null;
    frame = null;
    pending = false;
    lastPublish = deps.now();
    deps.publish();
  }

  function onTimer(): void {
    timer = null;
    if (deps.isHidden()) {
      run();
    } else {
      frame = deps.requestFrame(run);
    }
  }

  return {
    request() {
      if (pending) {
        return;
      }
      pending = true;
      const interval = deps.isHidden() ? HIDDEN_FLUSH_INTERVAL_MS : FLUSH_INTERVAL_MS;
      timer = deps.setTimer(onTimer, Math.max(0, lastPublish + interval - deps.now()));
    },
    cancel() {
      if (timer !== null) {
        deps.clearTimer(timer);
      }
      if (frame !== null) {
        deps.cancelFrame(frame);
      }
      timer = null;
      frame = null;
      pending = false;
      lastPublish = -Infinity;
    },
  };
}

/** The browser's clocks and frames, looked up on every call so test fake timers apply. */
const browserDeps: Omit<FlushSchedulerDeps, "publish"> = {
  now: () => performance.now(),
  isHidden: () => typeof document !== "undefined" && document.hidden,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle as number),
};

// --- the store --------------------------------------------------------------------------------

/** What the recorder draws, from the signal registry (set by the recorder panel). */
export interface RecorderConfig {
  readonly signals: readonly SignalDef[];
  /** Every tag the recorder charts or derives from; the history seed asks for these. */
  readonly tags: readonly string[];
  /** The digital tags of the LPS and Towers rows, null when the registry lacks one. */
  readonly strips: { readonly lps: string | null; readonly towers: string | null };
}

interface Published {
  readonly version: number;
  /** Epoch ms of the newest point at the flush, null before the first one. */
  readonly now: number | null;
}

const buffer = new TelemetryBuffer();
const listeners = new Set<() => void>();
let published: Published = { version: 0, now: null };
let config: RecorderConfig | null = null;
let configVersion = 0;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function publish(): void {
  const now = buffer.latestSimTs();
  published = { version: published.version + 1, now };
  setDerivedSimNow(now);
  notify();
}

const scheduler = createFlushScheduler({ ...browserDeps, publish });

/** Asks for a store version; many requests before the next flush make one. */
export function requestFlush(): void {
  scheduler.request();
}

/** Subscribes to store versions and to the seed's start and end. */
export function subscribeRecorder(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The number of versions published so far. */
export function recorderVersion(): number {
  return published.version;
}

/**
 * Tells the store what the recorder draws: the registry (digital kinds, the machine-state
 * inputs), the tags the history seed asks for and the tags of the LPS and Towers rows.
 */
export function configureRecorder(next: RecorderConfig): void {
  config = next;
  configVersion += 1;
  buffer.configure(next.signals);
  requestFlush();
}

// --- history seed -----------------------------------------------------------------------------

/** Bumped by every jump marker: a seed started before it is stale when it answers. */
let seedEpoch = 0;
/** The seed on its way, if any; a finished seed that is no longer this one does nothing. */
let activeSeed: object | null = null;
let queuedAnchor: number | null = null;
/** The buffer generation the last seed was asked for; a new generation needs its own. */
let seededGeneration = -1;

async function fetchAndSeed(anchor: number, epoch: number): Promise<void> {
  const tags = config?.tags ?? [];
  try {
    const history = await getSeries({
      tags: tags.length > 0 ? tags : undefined,
      from: anchor - SEED_WINDOW_MS,
      to: anchor,
      points: SEED_POINTS,
    });
    if (epoch === seedEpoch) {
      buffer.seed(history);
      requestFlush();
    }
  } catch (error) {
    // The live feed keeps drawing; the window just has no history before it.
    console.warn("recorder: the history seed failed", error);
  }
}

/** Loads the 24 h of history ending at `anchor` (epoch ms), after any seed in flight. */
function reseed(anchor: number): void {
  seededGeneration = buffer.generation;
  if (activeSeed !== null) {
    queuedAnchor = anchor;
    return;
  }
  const seed = {};
  activeSeed = seed;
  notify();
  void fetchAndSeed(anchor, seedEpoch).finally(() => {
    if (activeSeed !== seed) {
      return;
    }
    activeSeed = null;
    const next = queuedAnchor;
    queuedAnchor = null;
    if (next === null) {
      notify();
    } else {
      reseed(next);
    }
  });
}

// --- frame handlers ---------------------------------------------------------------------------

function ingest(batch: TelemetryBatch): void {
  buffer.push(batch);
  requestFlush();
  const latest = buffer.latestSimTs();
  if (latest !== null && buffer.generation !== seededGeneration) {
    reseed(latest);
  }
}

registerFrameHandler("telemetry.series", (frame) => {
  ingest(frame.payload);
});

// The raw samples are a debug channel the UI does not subscribe to; when they do arrive they are
// the same data, so they feed the same buffer.
registerFrameHandler("telemetry.samples", (frame) => {
  ingest(frame.payload.samples);
});

// The chart feed carries no alarm codes; the alarm row follows the backend's transitions.
registerFrameHandler("alarm.native", (frame) => {
  const { code, active, sim_ts: simTs } = frame.payload;
  buffer.recordAlarm(code, active, simTs);
  requestFlush();
});

// A jump, reset or loop: the replay continues elsewhere in data time, so the recorder empties
// and re-anchors on the marker's target instead of drawing across the jump.
registerFrameHandler("overlay.marker", (frame) => {
  const target = parseIso(frame.payload.sim_ts_to);
  seedEpoch += 1;
  buffer.reset();
  requestFlush();
  if (Number.isFinite(target)) {
    reseed(target);
  }
});

/**
 * Where the replay stands once it has left the dataset's first row, in epoch ms; null before
 * that, and while no simulator status is known.
 */
function replayPosition(): number | null {
  const { sim } = getLiveState();
  if (sim === null) {
    return null;
  }
  const at = parseIso(sim.sim_ts);
  return Number.isFinite(at) && at > parseIso(sim.dataset.first_ts) ? at : null;
}

// After a reconnect the backend may hold data this page missed while the link was down. A page
// that opens on a paused replay receives no frame at all, so with nothing buffered yet it seeds
// the history up to where the replay stands (the live feed applied `GET /api/status` first).
registerFrameHandler("link.open", () => {
  const anchor = buffer.latestSimTs() ?? replayPosition();
  if (anchor !== null) {
    reseed(anchor);
  }
});

// --- views ------------------------------------------------------------------------------------

/** One series of a lane: a key the chart names it by and the tag it reads. */
export interface LaneSeriesSpec {
  readonly key: string;
  readonly tag: string;
}

/** What a lane draws; `features/recorder/lanes.ts` builds these from the registry. */
export interface LaneSpec {
  readonly id: string;
  readonly series: readonly LaneSeriesSpec[];
}

/** A lane's data at one version: the drawn points and the newest value of each series. */
export interface LaneSeries {
  /** Per series, in the lane's order: at most `LANE_POINTS` points plus the gap breaks. */
  readonly points: readonly (readonly ChartPoint[])[];
  /** Per series, the newest finite value inside the window, or null. */
  readonly latest: readonly (number | null)[];
}

/** The shared time axis of every lane and row. */
export interface RecorderAxis {
  readonly from: number;
  readonly to: number;
  readonly ticks: readonly number[];
  /** True when the window spans two UTC days, so the ticks show the date. */
  readonly withDate: boolean;
}

export type StripKind = "state" | "lps" | "towers" | "alarms";

interface StripValues {
  state: MachineState;
  lps: DigitalLevel;
  towers: DigitalLevel;
  alarms: AlarmCodes;
}

export type StripTransitions<K extends StripKind> = readonly Transition<StripValues[K]>[];

interface CacheEntry<T> {
  version: number;
  signature: string;
  value: T;
}

const EMPTY_LANE: LaneSeries = Object.freeze({ points: [], latest: [] });
const EMPTY_STRIP: readonly never[] = Object.freeze([]);

const laneCache = new Map<string, CacheEntry<LaneSeries>>();
const stripCache = new Map<string, CacheEntry<StripTransitions<StripKind>>>();
const axisCache = new Map<string, CacheEntry<RecorderAxis>>();

/**
 * The cached view for `key` at the published version: the same object while the version is
 * unchanged, the same object again when a new version left its `signature` unchanged, and a new
 * one from `compute` only when its inputs moved.
 */
function cached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  signature: () => string,
  compute: (previous: T | undefined) => T,
): T {
  const entry = cache.get(key);
  if (entry?.version === published.version) {
    return entry.value;
  }
  const next = signature();
  if (entry?.signature === next) {
    entry.version = published.version;
    return entry.value;
  }
  const value = compute(entry?.value);
  cache.set(key, { version: published.version, signature: next, value });
  return value;
}

function windowOf(now: number, windowMs: number): { from: number; to: number } {
  return { from: now - windowMs, to: now };
}

/** The line-breaking distance for a series: 60 s, or more for coarse data (see the factor). */
function gapFor(points: readonly ChartPoint[]): number {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) {
    return GAP_MS;
  }
  return Math.max(GAP_MS, (GAP_SPACING_FACTOR * (last.t - first.t)) / (points.length - 1));
}

function lanePoints(tag: string, from: number, to: number): readonly ChartPoint[] {
  const { t, v } = buffer.range(tag, from, to);
  const reduced = lttb(t, v, LANE_POINTS);
  return breakGaps(reduced, gapFor(reduced));
}

function newestFinite(tag: string, from: number, to: number): number | null {
  const { v } = buffer.range(tag, from, to);
  for (let index = v.length - 1; index >= 0; index -= 1) {
    const value = v[index] ?? Number.NaN;
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function sameValues(a: readonly (number | null)[], b: readonly (number | null)[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function laneSnapshot(lane: LaneSpec, windowMs: number): LaneSeries {
  const now = published.now;
  if (now === null) {
    return EMPTY_LANE;
  }
  const { from, to } = windowOf(now, windowMs);
  const tags = lane.series.map((series) => series.tag);
  return cached(
    laneCache,
    `${lane.id}|${tags.join(",")}|${windowMs}`,
    () => `${from}|${to}|${tags.map((tag) => buffer.revision(tag)).join(",")}`,
    (previous) => {
      const latest = tags.map((tag) => newestFinite(tag, from, to));
      return {
        points: tags.map((tag) => lanePoints(tag, from, to)),
        latest:
          previous !== undefined && sameValues(previous.latest, latest) ? previous.latest : latest,
      };
    },
  );
}

function stripKey(kind: StripKind): string | null {
  switch (kind) {
    case "state":
      return STATE_KEY;
    case "alarms":
      return ALARMS_KEY;
    case "lps":
      return config?.strips.lps ?? null;
    case "towers":
      return config?.strips.towers ?? null;
  }
}

function stripTransitions(kind: StripKind, key: string, from: number, to: number) {
  switch (kind) {
    case "state":
      return buffer.stateRange(from, to);
    case "alarms":
      return buffer.alarmRange(from, to);
    case "lps":
    case "towers":
      return buffer.digitalRange(key, from, to);
  }
}

function stripSnapshot<K extends StripKind>(kind: K, windowMs: number): StripTransitions<K> {
  const now = published.now;
  const key = stripKey(kind);
  if (now === null || key === null) {
    return EMPTY_STRIP;
  }
  const { from, to } = windowOf(now, windowMs);
  // The strip cache is keyed by kind, so each entry holds that kind's transitions.
  return cached(
    stripCache,
    `${kind}|${key}|${windowMs}`,
    () => `${from}|${to}|${configVersion}|${buffer.revision(key)}`,
    () => stripTransitions(kind, key, from, to),
  ) as StripTransitions<K>;
}

/** Six ticks inside `(from, to]`, on multiples of a sixth of the window (UTC-aligned). */
function axisTicks(from: number, to: number, windowMs: number): number[] {
  const step = windowMs / AXIS_TICKS;
  const ticks: number[] = [];
  for (let tick = Math.floor(from / step) * step + step; tick <= to; tick += step) {
    ticks.push(tick);
  }
  return ticks;
}

function axisSnapshot(windowMs: number): RecorderAxis | null {
  const now = published.now;
  if (now === null) {
    return null;
  }
  const { from, to } = windowOf(now, windowMs);
  return cached(
    axisCache,
    String(windowMs),
    () => `${from}|${to}`,
    () => ({ from, to, ticks: axisTicks(from, to, windowMs), withDate: spansUtcDays(from, to) }),
  );
}

// --- hooks --------------------------------------------------------------------------------------

/** Epoch ms of the recorder's newest point as of the last flush; null before the first one. */
export function useRecorderNow(): number | null {
  return useSyncExternalStore(subscribeRecorder, () => published.now);
}

/** True while a history seed is on its way: the recorder shows "Re-anchoring…". */
export function useReanchoring(): boolean {
  return useSyncExternalStore(subscribeRecorder, () => activeSeed !== null);
}

/** A lane's points and newest values over the last `windowMs` of data time. */
export function useLaneSeries(lane: LaneSpec, windowMs: number): LaneSeries {
  return useSyncExternalStore(subscribeRecorder, () => laneSnapshot(lane, windowMs));
}

/** A row's transitions over the last `windowMs`, led by the value in force at its start. */
export function useStrip<K extends StripKind>(kind: K, windowMs: number): StripTransitions<K> {
  return useSyncExternalStore(subscribeRecorder, () => stripSnapshot(kind, windowMs));
}

/** The shared `[from, to]` domain and its ticks, computed once per flush; null before data. */
export function useAxis(windowMs: number): RecorderAxis | null {
  return useSyncExternalStore(subscribeRecorder, () => axisSnapshot(windowMs));
}

/**
 * Test support: empties the buffer, drops pending work and every cached view, and forgets the
 * configuration, without notifying (the components of the test are about to unmount).
 */
export function resetTelemetryStore(): void {
  scheduler.cancel();
  buffer.reset();
  published = { version: 0, now: null };
  config = null;
  configVersion = 0;
  seedEpoch += 1;
  activeSeed = null;
  queuedAnchor = null;
  seededGeneration = -1;
  laneCache.clear();
  stripCache.clear();
  axisCache.clear();
}
