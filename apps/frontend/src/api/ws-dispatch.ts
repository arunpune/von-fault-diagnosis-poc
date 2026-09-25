// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The frame router. Modules register a handler per frame type when they are imported — the cache
// reducers, the live store, the telemetry store — and the WebSocket client hands every frame to
// `dispatchFrame`, knowing no feature itself. Tests call `dispatchFrame(fixture)` directly. A
// handler that throws is logged and skipped, so one broken reducer never starves the others; a
// frame type this build does not know is counted and ignored (a newer server may add types,
// packages/contracts/VERSIONING.md).

import { isKnownFrameType, type FrameOf, type WsFrame, type WsFrameType } from "@/api/ws-types";

export type FrameHandler<T extends WsFrameType> = (frame: FrameOf<T>) => void;

/** One registration; a handler registered twice is two entries with their own disposers. */
interface Registration {
  readonly run: (frame: WsFrame) => void;
}

export interface DispatchCounters {
  /** Frames whose type this build does not know. */
  readonly unknownFrames: number;
  /** Handler calls that threw. */
  readonly handlerErrors: number;
}

const registry = new Map<WsFrameType, Set<Registration>>();
let unknownFrames = 0;
let handlerErrors = 0;

/** Calls `handler` for every frame of `type` until the returned function is called. */
export function registerFrameHandler<T extends WsFrameType>(
  type: T,
  handler: FrameHandler<T>,
): () => void {
  // The registry is keyed by type, so a frame reaching this entry is always a FrameOf<T>.
  const registration: Registration = { run: handler as (frame: WsFrame) => void };
  let registrations = registry.get(type);
  if (registrations === undefined) {
    registrations = new Set();
    registry.set(type, registrations);
  }
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
    if (registrations.size === 0 && registry.get(type) === registrations) {
      registry.delete(type);
    }
  };
}

/** Hands a frame to every handler registered for its type, each in its own try/catch. */
export function dispatchFrame(frame: WsFrame): void {
  const type: string = frame.type;
  if (!isKnownFrameType(type)) {
    unknownFrames += 1;
    console.debug(`ws-dispatch: ignoring a frame of unknown type ${JSON.stringify(type)}`);
    return;
  }
  const registrations = registry.get(type);
  if (registrations === undefined) {
    return;
  }
  // A copy, so a handler that registers or unregisters during dispatch changes the next frame only.
  for (const registration of Array.from(registrations)) {
    try {
      registration.run(frame);
    } catch (error) {
      handlerErrors += 1;
      console.error(`ws-dispatch: a ${type} handler failed`, error);
    }
  }
}

/** How many frames were ignored and how many handler calls threw since the page loaded. */
export function dispatchCounters(): DispatchCounters {
  return { unknownFrames, handlerErrors };
}
