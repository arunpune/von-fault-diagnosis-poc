// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Samples and sockets for the hub and decimation tests.
 *
 * {@link samplesFrom} builds a run of telemetry samples on a fixed data-time
 * step with values a test chooses per position, so a spike or a transition
 * sits exactly where the assertion expects it. {@link FakeSocket} is the part
 * of a `ws` socket the hub uses — `readyState`, `bufferedAmount`, `send`,
 * `close` and the two events — with the frames it was sent kept for the
 * assertions and a settable backlog for the slow-client policy.
 *
 * The file is named `*.test-helper.ts` so Vitest does not collect it as a
 * suite of its own.
 */

import type { Sample, SampleValue, WsServerMessage } from "@fdp/contracts";

import type { HubSocket } from "./hub.ts";

/** Ten seconds, the recording's sample period. */
export const STEP_MS = 10_000;

/** The data time of the first sample every run starts at unless told otherwise. */
export const START = "2020-06-05T09:00:00.000Z";

/** One sample at `simMs`; `seq` from its position. */
export function sampleAt(
  seq: number,
  simMs: number,
  values: Readonly<Record<string, SampleValue>>,
  discontinuity = false,
): Sample {
  return {
    seq,
    sim_ts: new Date(simMs).toISOString(),
    flags: { discontinuity, missing: false },
    values: { ...values },
    alarms: [],
  };
}

/**
 * `count` samples from `start`, `stepMs` apart, with the values `valuesAt`
 * returns for each position; `firstSeq` numbers the first one.
 */
export function samplesFrom(
  count: number,
  valuesAt: (position: number) => Readonly<Record<string, SampleValue>>,
  options: { start?: string; stepMs?: number; firstSeq?: number } = {},
): Sample[] {
  const startMs = Date.parse(options.start ?? START);
  const stepMs = options.stepMs ?? STEP_MS;
  const firstSeq = options.firstSeq ?? 1;
  return Array.from({ length: count }, (_, position) =>
    sampleAt(firstSeq + position, startMs + position * stepMs, valuesAt(position)),
  );
}

type MessageListener = (data: unknown, isBinary: boolean) => void;

/** A socket double: records what it was sent and how it was closed. */
export class FakeSocket implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | undefined;

  private readonly messageListeners: MessageListener[] = [];
  private readonly closeListeners: (() => void)[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    for (const listener of this.closeListeners) listener();
  }

  on(event: "message", listener: MessageListener): this;
  on(event: "close", listener: () => void): this;
  on(event: "message" | "close", listener: MessageListener | (() => void)): this {
    if (event === "message") this.messageListeners.push(listener as MessageListener);
    else this.closeListeners.push(listener as () => void);
    return this;
  }

  /** Deliver one client frame, as `ws` would: a Buffer, flagged binary or not. */
  receive(data: string | Buffer, isBinary = false): void {
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    for (const listener of this.messageListeners) listener(payload, isBinary);
  }

  /** The frames received so far, parsed. */
  frames(): WsServerMessage[] {
    return this.sent.map((text) => JSON.parse(text) as WsServerMessage);
  }

  /** The types of the frames received so far, in order. */
  types(): string[] {
    return this.frames().map((frame) => frame.type);
  }

  /** The frames of one type. */
  framesOf<T extends WsServerMessage["type"]>(type: T): Extract<WsServerMessage, { type: T }>[] {
    return this.frames().filter(
      (frame): frame is Extract<WsServerMessage, { type: T }> => frame.type === type,
    );
  }

  /** Forget what was sent so far. */
  clear(): void {
    this.sent.length = 0;
  }
}
