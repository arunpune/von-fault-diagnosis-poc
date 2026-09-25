// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The values that change every second and have one consumer each: the link state, the three
// retained statuses, the raised system alerts, the running injections and the sim clock. They live
// in this small `useSyncExternalStore` store instead of the query cache, and each hook selects one
// field, so a new simulator status re-renders the clock and the play button but not the lamps.
//
// The exported API is final: the status bar, the simulation controls, the alerts and the
// recorder code against these names. The store is fed by the WebSocket: the frame handlers below
// are registered when this module is imported, the app's live feed (`api/live-feed.ts`) reports
// the link state and the dropped frames and, on every open, applies a fresh `GET /api/status`
// through `applyStatusSnapshot`. A status older than the one held — by its `wall_ts` — never
// overwrites it, whichever path it came by.

import { useSyncExternalStore } from "react";

import type {
  AlertSystem,
  ApiStatus,
  DecisionBackend,
  HelloPayload,
  RunningInstance,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
} from "@/api/types";
import type { WsLinkState } from "@/api/ws-client";
import { registerFrameHandler } from "@/api/ws-dispatch";

/** The state of the live feed, as the status bar's link lamp shows it. */
export type LinkState = WsLinkState;

/** The decision backend that answers and the model it calls, as the backend chip names it. */
export interface BackendIdentity {
  readonly name: DecisionBackend;
  readonly model: string;
}

export interface LiveState {
  readonly link: LinkState;
  /** Why the link is open but not understood (a schema major this build does not read). */
  readonly linkNote: string | null;
  /** Messages the WebSocket client dropped as malformed since the page loaded. */
  readonly droppedFrames: number;
  readonly sim: StatusSim | null;
  readonly gateway: StatusGateway | null;
  readonly backend: StatusBackend | null;
  /** The backend and model the `hello` frame announced; the chip's fallback until a status. */
  readonly hello: BackendIdentity | null;
  /** The backend status's identity, else the `hello` one; kept by reference while unchanged. */
  readonly decisionBackend: BackendIdentity | null;
  readonly alertsActive: readonly AlertSystem[];
  readonly injectionsActive: readonly RunningInstance[];
  /** Epoch ms of the recorder's latest point, published by its flush; null before the first. */
  readonly derivedSimNow: number | null;
}

/** The only frame schema major this build reads (`hello.schema_major`). */
const SCHEMA_MAJOR = 1;

const INITIAL_STATE: LiveState = Object.freeze({
  link: "connecting",
  linkNote: null,
  droppedFrames: 0,
  sim: null,
  gateway: null,
  backend: null,
  hello: null,
  decisionBackend: null,
  alertsActive: [],
  injectionsActive: [],
  derivedSimNow: null,
});

let state: LiveState = INITIAL_STATE;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** `next` unless it says the same as `previous`, so an unchanged value keeps its reference. */
function unchangedOr<T>(previous: T, next: T): T {
  return previous === next || JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

function identityOf(next: LiveState): BackendIdentity | null {
  if (next.backend !== null) {
    return { name: next.backend.backend.name, model: next.backend.backend.model };
  }
  return next.hello;
}

function update(patch: Partial<LiveState>): void {
  const merged: LiveState = { ...state, ...patch };
  const next: LiveState = {
    ...merged,
    decisionBackend: unchangedOr(state.decisionBackend, identityOf(merged)),
  };
  const changed = (Object.keys(next) as (keyof LiveState)[]).some(
    (key) => !Object.is(next[key], state[key]),
  );
  if (!changed) {
    return;
  }
  state = next;
  notify();
}

/** The newer of two status messages by publication time; an older one never overwrites. */
function newerStatus<T extends { wall_ts: string }>(previous: T | null, next: T | null): T | null {
  if (previous === null || next === null) {
    return unchangedOr(previous, next);
  }
  return Date.parse(next.wall_ts) < Date.parse(previous.wall_ts)
    ? previous
    : unchangedOr(previous, next);
}

interface StatusTriple {
  sim: StatusSim | null;
  gateway: StatusGateway | null;
  backend: StatusBackend | null;
}

function statusPatch(statuses: StatusTriple): Partial<LiveState> {
  return {
    sim: newerStatus(state.sim, statuses.sim),
    gateway: newerStatus(state.gateway, statuses.gateway),
    backend: newerStatus(state.backend, statuses.backend),
  };
}

/**
 * Applies a `GET /api/status` answer: the three statuses, the raised alerts and the running
 * injections. A status older than the one held — an answer overtaken by a frame or by a
 * command's acknowledgement — is ignored.
 */
export function applyStatusSnapshot(snapshot: ApiStatus): void {
  update({
    ...statusPatch(snapshot),
    alertsActive: unchangedOr(state.alertsActive, snapshot.alerts_active),
    injectionsActive: unchangedOr(state.injectionsActive, snapshot.injections_active),
  });
}

/** Applies the fresh simulator status a command's acknowledgement carries (`useSimCommand`). */
export function applyAck(status: StatusSim): void {
  update({ sim: newerStatus(state.sim, status) });
}

/** Publishes the recorder's latest point (epoch ms), or null after it reset. */
export function setDerivedSimNow(ms: number | null): void {
  update({ derivedSimNow: ms });
}

/** Reports the WebSocket client's link state (the live feed's `onState`). */
export function setLinkState(link: LinkState): void {
  update({ link });
}

/** Counts one message the WebSocket client dropped as malformed (the live feed's `onDrop`). */
export function countDroppedFrame(): void {
  update({ droppedFrames: state.droppedFrames + 1 });
}

/** The live state right now, for code outside React (the recorder's flush, the tests). */
export function getLiveState(): LiveState {
  return state;
}

/** Test support: returns every value to the start; mounted subscribers re-render with it. */
export function resetLiveStore(): void {
  state = INITIAL_STATE;
  notify();
}

// The frame handlers, registered once when the module is imported.

function applyHello(hello: HelloPayload): void {
  const major: number = hello.schema_major;
  if (major !== SCHEMA_MAJOR) {
    const note =
      `The backend speaks schema v${major}; this dashboard reads v${SCHEMA_MAJOR}. ` +
      "Reload the page once both are updated.";
    console.error(`live-store: ${note}`);
    update({ linkNote: note });
    return;
  }
  const announced: BackendIdentity = { name: hello.decision_backend, model: hello.model };
  update({ hello: unchangedOr(state.hello, announced), linkNote: null });
}

/** The status part of the `snapshot` frame; `ws-cache.ts` seeds the query cache from the rest. */
function applySnapshotFrame(snapshot: SnapshotPayload): void {
  const active = snapshot.overlay.active;
  update({
    ...statusPatch(snapshot.status),
    alertsActive: unchangedOr(state.alertsActive, snapshot.system_alerts),
    ...(active === null
      ? {}
      : { injectionsActive: unchangedOr(state.injectionsActive, active.active) }),
  });
}

/** The raised alerts with `alert` applied: upserted by id while raised, removed once cleared. */
function withAlert(alerts: readonly AlertSystem[], alert: AlertSystem): readonly AlertSystem[] {
  const index = alerts.findIndex((item) => item.alert_id === alert.alert_id);
  if (alert.state === "cleared") {
    return index === -1 ? alerts : alerts.filter((item) => item.alert_id !== alert.alert_id);
  }
  if (index === -1) {
    return [...alerts, alert];
  }
  return unchangedOr(alerts[index], alert) === alerts[index] ? alerts : alerts.with(index, alert);
}

registerFrameHandler("hello", (frame) => {
  applyHello(frame.payload);
});
registerFrameHandler("snapshot", (frame) => {
  applySnapshotFrame(frame.payload);
});
registerFrameHandler("status.sim", (frame) => {
  update({ sim: newerStatus(state.sim, frame.payload) });
});
registerFrameHandler("status.gateway", (frame) => {
  update({ gateway: newerStatus(state.gateway, frame.payload) });
});
registerFrameHandler("status.backend", (frame) => {
  update({ backend: newerStatus(state.backend, frame.payload) });
});
registerFrameHandler("alert.system", (frame) => {
  update({ alertsActive: withAlert(state.alertsActive, frame.payload) });
});
registerFrameHandler("overlay.injection_active", (frame) => {
  update({ injectionsActive: unchangedOr(state.injectionsActive, frame.payload.active) });
});

// The hooks. Each selects one field, so a component re-renders only when that field changes.

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribes to one value derived from the live state; the component re-renders only when it
 * changes (`Object.is`). `select` must return a primitive or a reference held by the state — a
 * fresh object on every call would never compare equal.
 */
export function useLiveValue<T>(select: (live: LiveState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

const selectLink = (live: LiveState): LinkState => live.link;
const selectSim = (live: LiveState): StatusSim | null => live.sim;
const selectGateway = (live: LiveState): StatusGateway | null => live.gateway;
const selectBackend = (live: LiveState): StatusBackend | null => live.backend;
const selectDecisionBackend = (live: LiveState): BackendIdentity | null => live.decisionBackend;
const selectAlerts = (live: LiveState): readonly AlertSystem[] => live.alertsActive;
const selectInjections = (live: LiveState): readonly RunningInstance[] => live.injectionsActive;

function selectSimNow(live: LiveState): number | null {
  if (live.derivedSimNow !== null) {
    return live.derivedSimNow;
  }
  if (live.sim === null) {
    return null;
  }
  const simTs = Date.parse(live.sim.sim_ts);
  return Number.isNaN(simTs) ? null : simTs;
}

export function useLinkState(): LinkState {
  return useLiveValue(selectLink);
}

export function useSimStatus(): StatusSim | null {
  return useLiveValue(selectSim);
}

export function useGatewayStatus(): StatusGateway | null {
  return useLiveValue(selectGateway);
}

export function useBackendStatus(): StatusBackend | null {
  return useLiveValue(selectBackend);
}

/** The decision backend and model: from the backend status, else from `hello`, else null. */
export function useDecisionBackend(): BackendIdentity | null {
  return useLiveValue(selectDecisionBackend);
}

/** The system alerts raised right now (a banner each). */
export function useActiveAlerts(): readonly AlertSystem[] {
  return useLiveValue(selectAlerts);
}

/** The fault injections running right now. */
export function useActiveInjections(): readonly RunningInstance[] {
  return useLiveValue(selectInjections);
}

/**
 * The sim clock in epoch ms: the recorder's latest point once it has one (so the clock and the
 * chart agree), the simulator status's `sim_ts` before that, null while neither is known.
 */
export function useSimNow(): number | null {
  return useLiveValue(selectSimNow);
}
