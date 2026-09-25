// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The page's one WebSocket to the backend. The client opens `/ws` on the page's own origin, hands
// every well-formed frame to `onFrame` in the order it arrived and reports its link state; it
// knows no feature — the app routes frames through `ws-dispatch.ts`. It never sends: commands are
// REST, and the server's default subscription already leaves the raw `telemetry.samples` debug
// channel out.
//
// Liveness: the backend sends a `heartbeat` frame every 10 s, so any message restarts an idle
// timer of 25 s, and two missed heartbeats close the socket and reconnect. The same timer bounds
// a connection attempt that never opens. A lost socket is retried with capped exponential backoff
// and jitter, for ever: the link lamp says "reconnecting" and the app shows a banner after 5 s.
// A message that is not JSON, not an object, not of schema major v1 or without a string `type`
// is dropped and counted.

import type { ServerFrame } from "@/api/ws-types";

/** Where the client stands: `closed` before `start()` and after `stop()`. */
export type WsLinkState = "connecting" | "open" | "reconnecting" | "closed";

export interface BackoffPolicy {
  /** The delay before the first retry, in ms; each further retry doubles it. */
  readonly baseMs: number;
  /** The ceiling of every delay, jitter included, in ms. */
  readonly maxMs: number;
  /** The relative spread drawn around each delay: 0.25 draws from −25 % to +25 %. */
  readonly jitter: number;
}

/** Why a message was dropped instead of delivered. */
export type DroppedFrameReason = "not_json" | "not_an_object" | "unknown_schema" | "no_type";

export interface WsClientOptions {
  /** The socket URL, normally `wsUrl()`. */
  url: string;
  /** Opens the socket; a test injects `createFakeSocket`. */
  createSocket?: (url: string) => WebSocket;
  /** Receives every well-formed frame, in arrival order. */
  onFrame: (frame: ServerFrame) => void;
  /** Receives every change of the link state. */
  onState: (state: WsLinkState) => void;
  /** Hears about every dropped message; the app counts them in the live store. */
  onDrop?: (reason: DroppedFrameReason) => void;
  /** How long the socket may stay silent before it is replaced, in ms. */
  idleTimeoutMs?: number;
  backoff?: BackoffPolicy;
  /** The source of jitter, uniform on [0, 1); tests pin it. */
  random?: () => number;
}

/** Two missed heartbeats (the backend sends one every 10 s) and a margin. */
export const DEFAULT_IDLE_TIMEOUT_MS = 25_000;

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 500,
  maxMs: 10_000,
  jitter: 0.25,
});

/** The close code the client sends when it gives up on a silent socket (4000–4999: private use). */
export const IDLE_CLOSE_CODE = 4000;

/** The close code of `stop()`: a normal closure. */
const STOP_CLOSE_CODE = 1000;

/**
 * Frames of any other schema major are dropped: this build reads v1 only
 * (packages/contracts/VERSIONING.md).
 */
const SCHEMA_MAJOR_SUFFIX = ":v1";

/** The page's own `/ws`, over TLS when the page is. */
export function wsUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

/**
 * The delay before retry number `attempt` (0 for the first): `baseMs · 2^attempt`, capped at
 * `maxMs`, spread by ±`jitter` so a fleet of pages does not reconnect in step, and capped again so
 * no delay exceeds `maxMs`.
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const exponential = Math.min(policy.baseMs * 2 ** attempt, policy.maxMs);
  const spread = 1 + policy.jitter * (2 * random() - 1);
  return Math.min(policy.maxMs, Math.round(exponential * spread));
}

export type ParsedFrame =
  | { readonly ok: true; readonly frame: ServerFrame }
  | { readonly ok: false; readonly reason: DroppedFrameReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one message: JSON text holding an object with a `schema` of major v1 and a string `type`.
 * The payload is not validated (types only in the browser); an unknown `type` is left to the
 * dispatcher, which counts and ignores it.
 */
export function parseFrame(data: unknown): ParsedFrame {
  if (typeof data !== "string") {
    return { ok: false, reason: "not_json" };
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "not_an_object" };
  }
  if (typeof value.schema !== "string" || !value.schema.endsWith(SCHEMA_MAJOR_SUFFIX)) {
    return { ok: false, reason: "unknown_schema" };
  }
  if (typeof value.type !== "string") {
    return { ok: false, reason: "no_type" };
  }
  // Envelope checked above; the payload's shape is the contract's promise.
  return { ok: true, frame: value as unknown as ServerFrame };
}

function openSocket(url: string): WebSocket {
  return new WebSocket(url);
}

export class WsClient {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly onFrame: (frame: ServerFrame) => void;
  private readonly onState: (state: WsLinkState) => void;
  private readonly onDrop: ((reason: DroppedFrameReason) => void) | undefined;
  private readonly idleTimeoutMs: number;
  private readonly backoff: BackoffPolicy;
  private readonly random: () => number;

  private linkState: WsLinkState = "closed";
  private socket: WebSocket | null = null;
  /** Retries since the last successful open. */
  private attempt = 0;
  private dropped = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsClientOptions) {
    this.url = options.url;
    this.createSocket = options.createSocket ?? openSocket;
    this.onFrame = options.onFrame;
    this.onState = options.onState;
    this.onDrop = options.onDrop;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
  }

  get state(): WsLinkState {
    return this.linkState;
  }

  /** Messages dropped as malformed since the client was created. */
  get droppedFrames(): number {
    return this.dropped;
  }

  /** Opens the socket and keeps it open until `stop()`; a second call does nothing. */
  start(): void {
    if (this.linkState !== "closed") {
      return;
    }
    this.attempt = 0;
    this.setState("connecting");
    this.connect();
  }

  /** Closes the socket and cancels every timer; the client stays closed until `start()`. */
  stop(): void {
    if (this.linkState === "closed") {
      return;
    }
    this.clearReconnect();
    this.clearIdle();
    this.releaseSocket(STOP_CLOSE_CODE, "client stopped");
    this.setState("closed");
  }

  private connect(): void {
    this.reconnectTimer = null;
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url);
    } catch (error) {
      console.warn(`ws-client: could not open ${this.url}`, error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.handleOpen();
    };
    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };
    socket.onclose = () => {
      this.handleLoss();
    };
    socket.onerror = () => {
      this.handleLoss();
    };
    this.armIdle();
  }

  private handleOpen(): void {
    this.attempt = 0;
    this.armIdle();
    this.setState("open");
  }

  private handleMessage(event: MessageEvent): void {
    this.armIdle();
    const parsed = parseFrame(event.data);
    if (!parsed.ok) {
      this.dropped += 1;
      this.onDrop?.(parsed.reason);
      return;
    }
    this.onFrame(parsed.frame);
  }

  /** An error or a close: a browser fires both for one failure, and only the first one counts. */
  private handleLoss(): void {
    this.releaseSocket(STOP_CLOSE_CODE, "connection lost");
    this.scheduleReconnect();
  }

  private handleIdle(): void {
    this.idleTimer = null;
    this.releaseSocket(IDLE_CLOSE_CODE, "idle timeout");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearIdle();
    this.setState("reconnecting");
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Detaches the current socket before closing it, so the close it causes is not taken for a new
   * loss; a socket that already failed is only detached.
   */
  private releaseSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === socket.CONNECTING || socket.readyState === socket.OPEN) {
      socket.close(code, reason);
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.handleIdle();
    }, this.idleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: WsLinkState): void {
    if (next === this.linkState) {
      return;
    }
    this.linkState = next;
    this.onState(next);
  }
}
