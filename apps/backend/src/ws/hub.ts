// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The WebSocket hub: every frame the browser receives on `GET /ws`
 * (contracts `ws-server-message` and `ws-client-message`).
 *
 * The hub is framework-agnostic: it takes anything shaped like a `ws` socket
 * ({@link HubSocket}), so the route in `index.ts` hands it the sockets
 * `@fastify/websocket` accepts and the unit tests hand it fakes.
 *
 * What a socket receives, in order:
 *
 * 1. `hello` — always first, before anything else can be sent to it;
 * 2. `snapshot` — when the runtime gave the hub a snapshot source;
 * 3. then, filtered by the socket's subscription:
 *    - `telemetry.series` — ONE frame per `telemetryIntervalMs` (250 ms by
 *      default) with the samples of that flush decimated to at most 64 points
 *      per tag (`decimate.ts`); nothing when no sample arrived;
 *    - `telemetry.samples` — the raw samples of the same flush in frames of
 *      at most 25 samples (the schema's cap), only for a socket that asked for
 *      the channel by name: it is a debugging channel, not a chart feed;
 *    - `heartbeat` — every ten seconds of wall time, with the newest data
 *      time, so a client tells a quiet unit from a dead socket;
 *    - everything the runtime broadcasts (`status.*`, `event.suspect`,
 *      `decision`, `ticket`, `alert.system`, `alarm.native`, `overlay.*`,
 *      `cost.update`) — at once.
 *
 * A socket's subscription starts as every channel except `telemetry.samples`
 * and is replaced by each `subscribe {channels}` it sends; `ping` is accepted
 * and answered by nothing. A flush is cut where data time jumps (the
 * discontinuity flag, or a sample older than the one before it), so every
 * frame is in ascending data time and the one after a jump says
 * `discontinuity: true`.
 *
 * Slow clients: a telemetry frame is not sent to a socket holding more than
 * 1 MB of unsent data (the next flush brings the chart up to date), and a
 * socket above 4 MB for ten seconds is closed with 1008. The other frames are
 * never dropped.
 *
 * Every frame is checked against `ws-server-message` before it is sent: each
 * one in `every` mode (the tests), one in {@link SAMPLED_VALIDATION_EVERY} in
 * `sampled` mode (production), where a frame that fails is logged and not
 * sent.
 */

import {
  assertValid,
  parseIsoMs,
  toIsoMs,
  validate,
  type DecisionBackend,
  type FrameType,
  type Sample,
  type SnapshotPayload,
  type TelemetrySamples,
  type WsServerMessage,
} from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import { decimate } from "./decimate.ts";

/** The schema id every frame repeats. */
export const WS_SERVER_SCHEMA = "urn:fdp:schema:ws-server-message:v1";

/** The schema id of the raw `telemetry.samples` payload. */
export const TELEMETRY_SAMPLES_SCHEMA = "urn:fdp:schema:telemetry-samples:v1";

/** The flush interval when the environment names none (`WS_TELEMETRY_INTERVAL_MS`). */
export const DEFAULT_TELEMETRY_INTERVAL_MS = 250;

/** Wall time between two `heartbeat` frames; the client's idle timer is 25 s. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** The `telemetry-samples` schema's cap on one batch. */
export const MAX_SAMPLES_PER_FRAME = 25;

/** Above this much unsent data a socket gets no telemetry frame. */
export const SLOW_DROP_BYTES = 1_048_576;

/** Above this much unsent data for {@link SLOW_CLOSE_AFTER_MS} a socket is closed. */
export const SLOW_CLOSE_BYTES = 4 * 1_048_576;

export const SLOW_CLOSE_AFTER_MS = 10_000;

/** Close codes: policy violation for a slow client, going away on shutdown. */
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_GOING_AWAY = 1001;

/** In `sampled` mode, one frame in this many is checked against the contract. */
export const SAMPLED_VALIDATION_EVERY = 100;

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** The channels a socket receives before it subscribes: all but the raw samples. */
export const DEFAULT_CHANNELS: readonly FrameType[] = [
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

/** The payload of one frame type. */
export type FramePayload<T extends FrameType> = Extract<WsServerMessage, { type: T }>["payload"];

/** The frames the hub makes itself; the runtime broadcasts every other type. */
type OwnFrame = "hello" | "snapshot" | "heartbeat" | "telemetry.samples" | "telemetry.series";

/** The frame types the runtime hands to {@link Hub.broadcast}. */
export type BroadcastType = Exclude<FrameType, OwnFrame>;

/** What the hub needs of a socket; a `ws` WebSocket is one. */
export interface HubSocket {
  readonly readyState: number;
  /** Bytes queued for the network and not yet sent. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** The levels the hub writes. */
export interface HubLog {
  debug(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/** What the `hello` frame says about this process. */
export interface HubInfo {
  readonly serverVersion: string;
  readonly decisionBackend: DecisionBackend;
  readonly model: string;
  readonly unitId: string;
}

export interface HubOptions {
  /** Wall time for `wall_ts`, the heartbeat and the slow-client clock. */
  readonly wall: WallClock;
  readonly info: HubInfo;
  /** `WS_TELEMETRY_INTERVAL_MS`; {@link DEFAULT_TELEMETRY_INTERVAL_MS} when absent. */
  readonly telemetryIntervalMs?: number;
  /** The runtime's `snapshot` frame, sent right after `hello`. */
  readonly snapshot?: () => SnapshotPayload | Promise<SnapshotPayload>;
  /** `every` checks each frame and throws; `sampled` (the default) checks some and drops. */
  readonly validation?: "every" | "sampled";
  readonly logger?: HubLog;
}

/** What the hub has done, for `/api/health` counters and the tests. */
export interface HubCounters {
  readonly clients: number;
  /** Telemetry frames not sent to a socket above {@link SLOW_DROP_BYTES}. */
  readonly telemetryDropped: number;
  /** Sockets closed with 1008 for staying above {@link SLOW_CLOSE_BYTES}. */
  readonly slowClosed: number;
  /** Frames not sent because they failed the `sampled` contract check. */
  readonly invalidFrames: number;
}

export interface Hub {
  /** Take a new socket: send `hello` (and the snapshot), then keep it fed until it closes. */
  attach(socket: HubSocket): void;
  /** Send one frame to every socket subscribed to its type, at once. */
  broadcast<T extends BroadcastType>(type: T, payload: FramePayload<T>): void;
  /** Queue samples, in arrival order, for the next flush. */
  pushSamples(samples: readonly Sample[]): void;
  counters(): HubCounters;
  /** Close every socket with `code` and stop the timers; the hub takes no socket after this. */
  closeAll(code?: number, reason?: string): void;
}

/** One connected socket and what the hub knows about it. */
interface Client {
  readonly socket: HubSocket;
  channels: ReadonlySet<FrameType>;
  /** Wall milliseconds since which the socket has held more than {@link SLOW_CLOSE_BYTES}. */
  slowSinceMs: number | undefined;
}

/** Samples of one flush in ascending data time; a jump starts the next run. */
interface Run {
  readonly samples: Sample[];
  readonly discontinuity: boolean;
}

/** The text of a client frame, or `undefined` for a binary one. */
function textOf(data: unknown, isBinary: boolean): string | undefined {
  if (isBinary) return undefined;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return undefined;
}

/** A `telemetry-samples` batch: one to {@link MAX_SAMPLES_PER_FRAME} samples. */
type Batch = TelemetrySamples["samples"];

/** Split `samples` into batches of at most {@link MAX_SAMPLES_PER_FRAME}. */
function chunks(samples: readonly Sample[]): Batch[] {
  const batches: Batch[] = [];
  for (let start = 0; start < samples.length; start += MAX_SAMPLES_PER_FRAME) {
    const [head, ...rest] = samples.slice(start, start + MAX_SAMPLES_PER_FRAME);
    if (head !== undefined) batches.push([head, ...rest]);
  }
  return batches;
}

export function createHub(options: HubOptions): Hub {
  const { wall, info, logger } = options;
  const validation = options.validation ?? "sampled";
  const clients = new Set<Client>();

  let runs: Run[] = [];
  let lastSimMs: number | undefined;
  let lastSimTs: string | null = null;
  let checked = 0;
  let closed = false;
  let telemetryDropped = 0;
  let slowClosed = 0;
  let invalidFrames = 0;

  /** The frame as JSON, or `undefined` when a sampled check refused it. */
  function encode(type: FrameType, payload: unknown): string | undefined {
    const frame = {
      schema: WS_SERVER_SCHEMA,
      unit_id: info.unitId,
      wall_ts: toIsoMs(wall.now()),
      type,
      payload,
    };
    if (validation === "every") {
      assertValid("ws-server-message", frame);
    } else {
      checked += 1;
      if (checked % SAMPLED_VALIDATION_EVERY === 1) {
        const result = validate("ws-server-message", frame);
        if (!result.ok) {
          invalidFrames += 1;
          logger?.error(
            { type, issue: result.errors[0]?.text },
            "a frame does not match ws-server-message; it was not sent",
          );
          return undefined;
        }
      }
    }
    return JSON.stringify(frame);
  }

  function drop(client: Client): void {
    clients.delete(client);
  }

  /** Close a socket that has held more than 4 MB for ten seconds. */
  function watchBacklog(client: Client, nowMs: number): void {
    if (client.socket.bufferedAmount <= SLOW_CLOSE_BYTES) {
      client.slowSinceMs = undefined;
      return;
    }
    client.slowSinceMs ??= nowMs;
    if (nowMs - client.slowSinceMs < SLOW_CLOSE_AFTER_MS) return;
    slowClosed += 1;
    logger?.warn(
      { buffered_bytes: client.socket.bufferedAmount },
      "closing a WebSocket client that stopped reading",
    );
    drop(client);
    client.socket.close(CLOSE_POLICY_VIOLATION, "slow client");
  }

  function deliver(client: Client, frame: string, telemetry: boolean): void {
    if (client.socket.readyState !== OPEN) return;
    if (telemetry && client.socket.bufferedAmount > SLOW_DROP_BYTES) {
      telemetryDropped += 1;
      return;
    }
    client.socket.send(frame);
  }

  /** One frame to every socket subscribed to its type. */
  function fanOut(type: FrameType, payload: unknown, telemetry = false): void {
    const receivers = [...clients].filter((client) => client.channels.has(type));
    if (receivers.length === 0) return;
    const frame = encode(type, payload);
    if (frame === undefined) return;
    for (const client of receivers) deliver(client, frame, telemetry);
  }

  function sendTo(client: Client, type: FrameType, payload: unknown): void {
    const frame = encode(type, payload);
    if (frame !== undefined) deliver(client, frame, false);
  }

  function rawFrame(samples: Batch): TelemetrySamples {
    return {
      schema: TELEMETRY_SAMPLES_SCHEMA,
      unit_id: info.unitId,
      wall_ts: toIsoMs(wall.now()),
      samples,
    };
  }

  function flush(): void {
    const nowMs = wall.now().getTime();
    for (const client of [...clients]) watchBacklog(client, nowMs);

    const flushed = runs;
    runs = [];
    for (const run of flushed) {
      fanOut("telemetry.series", decimate(run.samples, run.discontinuity), true);
      if ([...clients].some((client) => client.channels.has("telemetry.samples"))) {
        for (const batch of chunks(run.samples)) fanOut("telemetry.samples", rawFrame(batch), true);
      }
    }
  }

  function heartbeat(): void {
    fanOut("heartbeat", { wall_ts: toIsoMs(wall.now()), sim_ts: lastSimTs });
  }

  function onClientFrame(client: Client, data: unknown, isBinary: boolean): void {
    const text = textOf(data, isBinary);
    let parsed: unknown;
    try {
      parsed = text === undefined ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const message = validate("ws-client-message", parsed);
    if (!message.ok) {
      logger?.debug(
        { issue: message.errors[0]?.text },
        "ignored a client frame that is not a ws-client-message",
      );
      return;
    }
    if (message.value.type === "subscribe") client.channels = new Set(message.value.channels);
  }

  function sendSnapshot(client: Client): void {
    const source = options.snapshot;
    if (source === undefined) return;
    Promise.resolve()
      .then(source)
      .then((snapshot) => {
        if (clients.has(client)) sendTo(client, "snapshot", snapshot);
      })
      .catch((error: unknown) => {
        logger?.warn({ err: error }, "the snapshot for a new WebSocket client failed");
      });
  }

  const flushTimer = setInterval(
    flush,
    options.telemetryIntervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS,
  );
  flushTimer.unref();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  return {
    attach(socket: HubSocket): void {
      if (closed) {
        socket.close(CLOSE_GOING_AWAY, "server shutting down");
        return;
      }
      const client: Client = {
        socket,
        channels: new Set(DEFAULT_CHANNELS),
        slowSinceMs: undefined,
      };
      clients.add(client);
      socket.on("close", () => drop(client));
      socket.on("message", (data, isBinary) => onClientFrame(client, data, isBinary));
      sendTo(client, "hello", {
        server_version: info.serverVersion,
        schema_major: 1,
        decision_backend: info.decisionBackend,
        model: info.model,
        unit_id: info.unitId,
      });
      sendSnapshot(client);
    },

    broadcast(type, payload): void {
      if (!closed) fanOut(type, payload);
    },

    pushSamples(samples: readonly Sample[]): void {
      for (const sample of samples) {
        const simMs = parseIsoMs(sample.sim_ts).getTime();
        const jumped = sample.flags.discontinuity || (lastSimMs !== undefined && simMs < lastSimMs);
        lastSimMs = simMs;
        lastSimTs = sample.sim_ts;
        if (closed || clients.size === 0) continue;
        const current = runs.at(-1);
        if (current === undefined || jumped) {
          runs.push({ samples: [sample], discontinuity: jumped });
        } else {
          current.samples.push(sample);
        }
      }
    },

    counters(): HubCounters {
      return { clients: clients.size, telemetryDropped, slowClosed, invalidFrames };
    },

    closeAll(code: number = CLOSE_GOING_AWAY, reason = "server shutting down"): void {
      closed = true;
      clearInterval(flushTimer);
      clearInterval(heartbeatTimer);
      runs = [];
      for (const client of [...clients]) {
        drop(client);
        client.socket.close(code, reason);
      }
    },
  };
}
