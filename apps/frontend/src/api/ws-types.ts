// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The frames the UI handles: the eighteen server frame types of the contracts'
// `ws-server-message` — `hello` then `snapshot` on connect, `heartbeat` every 10 s, the decimated
// `telemetry.series` chart feed, statuses, pipeline records, the overlay and `cost.update` — plus
// `link.open`, which never crosses the wire: the app dispatches it after every successful
// (re)connect so a module can reseed without importing the WebSocket client. The browser never
// sends frames (commands are REST).

import type { ServerFrameType, WsServerMessage } from "@/api/types";

/** Every frame the server may push, discriminated by `type`. */
export type ServerFrame = WsServerMessage;

/** Dispatched by the app itself after each successful (re)connect. */
export interface LinkOpenFrame {
  type: "link.open";
  /** Wall-clock time the link opened. */
  wall_ts: string;
}

export type WsFrame = ServerFrame | LinkOpenFrame;

export type WsFrameType = WsFrame["type"];

/** The frame of one type, with its payload narrowed. */
export type FrameOf<T extends WsFrameType> = Extract<WsFrame, { type: T }>;

// A record rather than a list, so the compiler rejects both a missing and an unknown type when
// the contract changes.
const SERVER_FRAME_TYPE_KEYS = {
  hello: true,
  snapshot: true,
  heartbeat: true,
  "telemetry.samples": true,
  "telemetry.series": true,
  "status.sim": true,
  "status.gateway": true,
  "status.backend": true,
  "event.suspect": true,
  decision: true,
  ticket: true,
  "alert.system": true,
  "alarm.native": true,
  "overlay.catalog": true,
  "overlay.injection": true,
  "overlay.injection_active": true,
  "overlay.marker": true,
  "cost.update": true,
} as const satisfies Record<ServerFrameType, true>;

/** The eighteen server frame types, in the contract's order. */
export const SERVER_FRAME_TYPES = Object.keys(SERVER_FRAME_TYPE_KEYS) as readonly ServerFrameType[];

/** The UI-internal frame types, never sent by the server. */
export const INTERNAL_FRAME_TYPES: readonly WsFrameType[] = ["link.open"];

const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set<string>([
  ...SERVER_FRAME_TYPES,
  ...INTERNAL_FRAME_TYPES,
]);

/**
 * True for a type this build of the UI knows; a newer server may send others
 * (packages/contracts/VERSIONING.md).
 */
export function isKnownFrameType(type: string): type is WsFrameType {
  return KNOWN_FRAME_TYPES.has(type);
}
