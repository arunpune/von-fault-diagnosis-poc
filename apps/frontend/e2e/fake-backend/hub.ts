// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend's WebSocket hub, shaped like the real one (docs/api.md, "WebSocket"). A socket
// receives `hello`, then `snapshot`, then:
//
//   * one decimated `telemetry.series` frame per flush (every 250 ms) with at most 64 points per
//     tag, cut where data time jumps so every frame runs forwards;
//   * the raw `telemetry.samples` of the same flush, in frames of at most 25, only once the socket
//     subscribed to that channel by name;
//   * a `heartbeat` every ten seconds with the newest data time;
//   * every other frame the scenario (or the control API) emits, at once.
//
// A `subscribe { channels }` frame replaces a socket's channels; `ping` is accepted and answered by
// nothing; anything else is ignored.

import type { RawData, WebSocket } from "ws";

import { decimateFrame } from "./decimate.ts";
import { isRecord } from "./requests.ts";
import type { FramePayload } from "./scenario.ts";

import type {
  HelloPayload,
  Sample,
  ServerFrameType,
  SnapshotPayload,
  TelemetrySamples,
} from "@/api/types";
import type { ServerFrame } from "@/api/ws-types";

/** Wall time between two telemetry flushes (`WS_TELEMETRY_INTERVAL_MS`). */
export const FLUSH_INTERVAL_MS = 250;

/** Wall time between two `heartbeat` frames. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** The `telemetry-samples` schema's cap on one batch. */
const MAX_SAMPLES_PER_FRAME = 25;

/** Close code of `/__test/restart-ws` and `/__test/reset`: the service restarts. */
export const CLOSE_SERVICE_RESTART = 1012;

const FRAME_SCHEMA = "urn:fdp:schema:ws-server-message:v1";

/** Every channel but the raw samples, which a socket must ask for. */
const DEFAULT_CHANNELS: readonly ServerFrameType[] = [
  "hello",
  "snapshot",
  "heartbeat",
  "telemetry.series",
  "status.sim",
  "status.gateway",
  "status.backend",
  "event.suspect",
  "decision",
  "ticket",
  "alert.system",
  "alarm.native",
  "overlay.catalog",
  "overlay.injection",
  "overlay.injection_active",
  "overlay.marker",
  "cost.update",
];

const KNOWN_CHANNELS: ReadonlySet<string> = new Set([...DEFAULT_CHANNELS, "telemetry.samples"]);

/** What the hub asks of the scenario in force. */
export interface HubSource {
  hello(): HelloPayload;
  snapshot(): SnapshotPayload;
  lastSampleSimTs(): string | null;
}

export interface HubOptions {
  readonly unitId: string;
  readonly wall: () => number;
  /** The scenario in force; a reset replaces it, so the hub asks every time. */
  readonly source: () => HubSource;
}

export interface Hub {
  /** Take a new socket: `hello`, `snapshot`, then everything it is subscribed to. */
  attach(socket: WebSocket): void;
  /** Send one frame to every socket subscribed to its type. */
  frame<T extends ServerFrameType>(type: T, payload: FramePayload<T>): void;
  /** Send a complete frame unchanged; returns how many sockets it reached. */
  send(frame: ServerFrame): number;
  /** Queue samples for the next flush. */
  pushSamples(samples: readonly Sample[]): void;
  /** Turn the queued samples into telemetry frames now. */
  flush(): void;
  heartbeat(): void;
  /** Close every socket; returns how many were open. */
  closeAll(code: number, reason: string): number;
  clientCount(): number;
}

interface Client {
  readonly socket: WebSocket;
  channels: ReadonlySet<string>;
}

type Run = [Sample, ...Sample[]];

/** Cut the queued samples where data time jumps: the flag, or time running backwards. */
function runsOf(samples: readonly Sample[]): Run[] {
  const runs: Run[] = [];
  let previousMs = -Infinity;
  for (const sample of samples) {
    const ms = Date.parse(sample.sim_ts);
    const current = runs.at(-1);
    if (current === undefined || sample.flags.discontinuity || ms <= previousMs) {
      runs.push([sample]);
    } else {
      current.push(sample);
    }
    previousMs = ms;
  }
  return runs;
}

function batchesOf(run: Run): Run[] {
  const batches: Run[] = [];
  for (let start = 0; start < run.length; start += MAX_SAMPLES_PER_FRAME) {
    const [head, ...rest] = run.slice(start, start + MAX_SAMPLES_PER_FRAME);
    if (head !== undefined) {
      batches.push([head, ...rest]);
    }
  }
  return batches;
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
}

export function createHub(options: HubOptions): Hub {
  const { unitId, wall, source } = options;
  const clients = new Set<Client>();
  let queued: Sample[] = [];

  function encode(type: ServerFrameType, payload: unknown): string {
    return JSON.stringify({
      schema: FRAME_SCHEMA,
      unit_id: unitId,
      wall_ts: new Date(wall()).toISOString(),
      type,
      payload,
    });
  }

  function deliver(type: string, text: string): number {
    let reached = 0;
    for (const client of clients) {
      if (client.channels.has(type) && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(text);
        reached += 1;
      }
    }
    return reached;
  }

  function broadcast<T extends ServerFrameType>(type: T, payload: FramePayload<T>): void {
    if ([...clients].some((client) => client.channels.has(type))) {
      deliver(type, encode(type, payload));
    }
  }

  function onMessage(client: Client, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(textOf(data)) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message) || message.type !== "subscribe" || !Array.isArray(message.channels)) {
      return;
    }
    client.channels = new Set(
      message.channels.filter(
        (channel): channel is string => typeof channel === "string" && KNOWN_CHANNELS.has(channel),
      ),
    );
  }

  function rawSamples(batch: Run): TelemetrySamples {
    return {
      schema: "urn:fdp:schema:telemetry-samples:v1",
      unit_id: unitId,
      wall_ts: new Date(wall()).toISOString(),
      samples: batch,
    };
  }

  return {
    attach(socket) {
      const client: Client = { socket, channels: new Set(DEFAULT_CHANNELS) };
      clients.add(client);
      socket.on("close", () => clients.delete(client));
      socket.on("message", (data, isBinary) => onMessage(client, data, isBinary));
      const current = source();
      socket.send(encode("hello", current.hello()));
      socket.send(encode("snapshot", current.snapshot()));
    },
    frame: broadcast,
    send(frame) {
      return deliver(frame.type, JSON.stringify(frame));
    },
    pushSamples(samples) {
      queued.push(...samples);
    },
    flush() {
      const pending = queued;
      queued = [];
      const wantsRaw = [...clients].some((client) => client.channels.has("telemetry.samples"));
      for (const run of runsOf(pending)) {
        broadcast("telemetry.series", decimateFrame(run, run[0].flags.discontinuity));
        if (wantsRaw) {
          for (const batch of batchesOf(run)) {
            broadcast("telemetry.samples", rawSamples(batch));
          }
        }
      }
    },
    heartbeat() {
      const now = new Date(wall()).toISOString();
      broadcast("heartbeat", { wall_ts: now, sim_ts: source().lastSampleSimTs() });
    },
    closeAll(code, reason) {
      const open = [...clients];
      clients.clear();
      for (const client of open) {
        client.socket.close(code, reason);
      }
      return open.length;
    },
    clientCount() {
      return clients.size;
    },
  };
}
