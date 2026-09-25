// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffDelay,
  DEFAULT_BACKOFF,
  DEFAULT_IDLE_TIMEOUT_MS,
  IDLE_CLOSE_CODE,
  parseFrame,
  WsClient,
  wsUrl,
  type DroppedFrameReason,
  type WsClientOptions,
  type WsLinkState,
} from "@/api/ws-client";
import type { ServerFrame } from "@/api/ws-types";
import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { frames } from "@/test/msw/fixtures";

const URL = "ws://dashboard.test/ws";

interface Harness {
  client: WsClient;
  delivered: ServerFrame[];
  states: WsLinkState[];
  drops: DroppedFrameReason[];
}

let clients: WsClient[] = [];

/** A client over FakeWebSockets with jitter pinned to the middle (no spread) unless overridden. */
function harness(options: Partial<WsClientOptions> = {}): Harness {
  const delivered: ServerFrame[] = [];
  const states: WsLinkState[] = [];
  const drops: DroppedFrameReason[] = [];
  const client = new WsClient({
    url: URL,
    createSocket: createFakeSocket,
    onFrame: (frame) => delivered.push(frame),
    onState: (state) => states.push(state),
    onDrop: (reason) => drops.push(reason),
    random: () => 0.5,
    ...options,
  });
  clients.push(client);
  return { client, delivered, states, drops };
}

function socketCount(): number {
  return FakeWebSocket.instances.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  for (const client of clients) {
    client.stop();
  }
  clients = [];
  vi.useRealTimers();
});

describe("wsUrl", () => {
  it("opens /ws on the page's own host, over TLS when the page is", () => {
    expect(wsUrl({ protocol: "http:", host: "localhost:8080" })).toBe("ws://localhost:8080/ws");
    expect(wsUrl({ protocol: "https:", host: "demo.example" })).toBe("wss://demo.example/ws");
  });

  it("reads the current page by default", () => {
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws`);
  });
});

describe("parseFrame", () => {
  it("accepts an object of schema major v1 with a string type, whatever the type", () => {
    const result = parseFrame(JSON.stringify(frames.heartbeat));
    expect(result).toEqual({ ok: true, frame: frames.heartbeat });

    const unknownType = { ...frames.heartbeat, type: "telemetry.future" };
    expect(parseFrame(JSON.stringify(unknownType)).ok).toBe(true);
  });

  it.each([
    ["binary data", new ArrayBuffer(4), "not_json"],
    ["text that is not JSON", "{ nope", "not_json"],
    ["a JSON array", "[1, 2]", "not_an_object"],
    ["JSON null", "null", "not_an_object"],
    ["a number", "42", "not_an_object"],
    ["no schema", JSON.stringify({ type: "hello" }), "unknown_schema"],
    [
      "schema major v2",
      JSON.stringify({ schema: "urn:fdp:schema:ws-server-message:v2", type: "hello" }),
      "unknown_schema",
    ],
    [
      "a type that is not a string",
      JSON.stringify({ schema: "urn:fdp:schema:ws-server-message:v1", type: 7 }),
      "no_type",
    ],
  ])("drops %s", (_name, data, reason) => {
    expect(parseFrame(data)).toEqual({ ok: false, reason });
  });
});

describe("backoffDelay", () => {
  it("doubles from 500 ms and stops at 10 s when the jitter draws the middle", () => {
    const delays = Array.from({ length: 8 }, (_, attempt) =>
      backoffDelay(attempt, DEFAULT_BACKOFF, () => 0.5),
    );
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
  });

  it("spreads each delay by at most ±25 % and never exceeds the ceiling", () => {
    const draws = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999_999];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const nominal = Math.min(500 * 2 ** attempt, 10_000);
      for (const draw of draws) {
        const delay = backoffDelay(attempt, DEFAULT_BACKOFF, () => draw);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(nominal * 0.75));
        expect(delay).toBeLessThanOrEqual(Math.min(10_000, Math.ceil(nominal * 1.25)));
      }
    }
  });

  it("reaches both ends of the spread", () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(375);
    expect(backoffDelay(2, DEFAULT_BACKOFF, () => 0.999_999)).toBe(2_500);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0)).toBe(7_500);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0.999_999)).toBe(10_000);
  });
});

describe("WsClient", () => {
  it("connects to the URL, reports connecting then open, and never sends", () => {
    const { client, states } = harness();
    expect(client.state).toBe("closed");

    client.start();
    expect(socketCount()).toBe(1);
    expect(FakeWebSocket.latest().url).toBe(URL);
    expect(states).toEqual(["connecting"]);

    FakeWebSocket.latest().open();
    expect(states).toEqual(["connecting", "open"]);
    expect(client.state).toBe("open");

    FakeWebSocket.latest().message(frames.hello);
    expect(FakeWebSocket.latest().sent).toEqual([]);
  });

  it("opens one socket however often start() is called", () => {
    const { client } = harness();
    client.start();
    client.start();
    expect(socketCount()).toBe(1);
  });

  it("delivers frames in the order they arrived", () => {
    const { client, delivered } = harness();
    client.start();
    const socket = FakeWebSocket.latest();
    socket.open();

    const sequence = [
      frames.hello,
      frames.snapshot,
      frames["status.sim"],
      frames.heartbeat,
      frames.decision,
      frames.ticket,
    ];
    for (const frame of sequence) {
      socket.message(frame);
    }

    expect(delivered.map((frame) => frame.type)).toEqual([
      "hello",
      "snapshot",
      "status.sim",
      "heartbeat",
      "decision",
      "ticket",
    ]);
    expect(delivered[2]).toEqual(frames["status.sim"]);
  });

  it("drops and counts malformed frames and keeps delivering the good ones", () => {
    const { client, delivered, drops } = harness();
    client.start();
    const socket = FakeWebSocket.latest();
    socket.open();

    socket.message(frames.hello);
    socket.message("not json at all");
    socket.message({ ...frames["status.sim"], schema: "urn:fdp:schema:ws-server-message:v2" });
    socket.message([frames.heartbeat]);
    socket.message({ schema: "urn:fdp:schema:ws-server-message:v1", payload: {} });
    socket.message(frames["status.backend"]);

    expect(delivered.map((frame) => frame.type)).toEqual(["hello", "status.backend"]);
    expect(drops).toEqual(["not_json", "unknown_schema", "not_an_object", "no_type"]);
    expect(client.droppedFrames).toBe(4);
    expect(client.state).toBe("open");
  });

  it("works without a drop listener", () => {
    const { client } = harness({ onDrop: undefined });
    client.start();
    FakeWebSocket.latest().open();

    FakeWebSocket.latest().message("{");

    expect(client.droppedFrames).toBe(1);
  });

  describe("idle timeout", () => {
    it("closes a socket silent for 25 s and reconnects", () => {
      const { client, states } = harness();
      client.start();
      const first = FakeWebSocket.latest();
      first.open();

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS - 1);
      expect(first.readyState).toBe(FakeWebSocket.OPEN);

      vi.advanceTimersByTime(1);
      expect(first.readyState).toBe(FakeWebSocket.CLOSED);
      expect(client.state).toBe("reconnecting");

      vi.advanceTimersByTime(DEFAULT_BACKOFF.baseMs);
      expect(socketCount()).toBe(2);
      FakeWebSocket.latest().open();
      expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
    });

    it("closes the silent socket with the private idle code", () => {
      const { client } = harness();
      client.start();
      const first = FakeWebSocket.latest();
      first.open();
      const closes: number[] = [];
      first.addEventListener("close", (event) => closes.push((event as CloseEvent).code));

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

      expect(closes).toEqual([IDLE_CLOSE_CODE]);
    });

    it("is pushed back by every frame, heartbeats included", () => {
      const { client, states } = harness();
      client.start();
      const socket = FakeWebSocket.latest();
      socket.open();

      for (let second = 0; second < 120; second += 10) {
        vi.advanceTimersByTime(10_000);
        socket.message(frames.heartbeat);
      }

      expect(socketCount()).toBe(1);
      expect(states).toEqual(["connecting", "open"]);
    });

    it("is pushed back by a malformed message too, since the socket is alive", () => {
      const { client } = harness();
      client.start();
      const socket = FakeWebSocket.latest();
      socket.open();

      vi.advanceTimersByTime(20_000);
      socket.message("garbage");
      vi.advanceTimersByTime(20_000);

      expect(client.state).toBe("open");
    });

    it("bounds a connection attempt that never opens", () => {
      const { client } = harness();
      client.start();
      const hanging = FakeWebSocket.latest();

      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

      expect(hanging.readyState).toBe(FakeWebSocket.CLOSED);
      expect(client.state).toBe("reconnecting");
    });

    it("honours a custom timeout", () => {
      const { client } = harness({ idleTimeoutMs: 1_000 });
      client.start();
      FakeWebSocket.latest().open();

      vi.advanceTimersByTime(1_000);

      expect(client.state).toBe("reconnecting");
    });
  });

  describe("reconnect", () => {
    /** Fails the latest socket and returns how long the next one took to appear. */
    function nextRetryDelay(): number {
      const before = socketCount();
      FakeWebSocket.latest().close(1006);
      let waited = 0;
      while (socketCount() === before) {
        vi.advanceTimersByTime(1);
        waited += 1;
        if (waited > 20_000) {
          throw new Error("no retry within 20 s");
        }
      }
      return waited;
    }

    it("retries after 500, 1000, 2000 … ms, capped at 10 s, while the server stays away", () => {
      const { client, states } = harness();
      client.start();

      const delays = Array.from({ length: 8 }, nextRetryDelay);

      expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
      expect(states).toEqual(["connecting", "reconnecting"]);
      expect(client.state).toBe("reconnecting");
    });

    it("keeps each jittered delay inside ±25 % of the nominal one and under the ceiling", () => {
      let draw = 0;
      const draws = [0, 0.999_999, 0.3, 0.8, 0, 0.999_999, 0.5];
      const { client } = harness({ random: () => draws[draw++ % draws.length] ?? 0.5 });
      client.start();

      const delays = Array.from({ length: draws.length }, nextRetryDelay);

      expect(delays).toEqual([375, 1_250, 1_800, 4_600, 6_000, 10_000, 10_000]);
      const nominal = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000];
      delays.forEach((delay, index) => {
        const expected = nominal[index] ?? 0;
        expect(delay).toBeGreaterThanOrEqual(expected * 0.75);
        expect(delay).toBeLessThanOrEqual(Math.min(10_000, expected * 1.25));
      });
    });

    it("starts again from 500 ms after a successful open", () => {
      const { client } = harness();
      client.start();
      nextRetryDelay();
      nextRetryDelay();
      nextRetryDelay();

      FakeWebSocket.latest().open();
      expect(client.state).toBe("open");

      expect(nextRetryDelay()).toBe(500);
      expect(nextRetryDelay()).toBe(1_000);
    });

    it("counts an error followed by its close as one loss", () => {
      const { client, states } = harness();
      client.start();
      const socket = FakeWebSocket.latest();
      socket.open();

      socket.error();
      socket.close(1006);

      expect(states).toEqual(["connecting", "open", "reconnecting"]);
      expect(client.state).toBe("reconnecting");
      vi.advanceTimersByTime(DEFAULT_BACKOFF.baseMs - 1);
      expect(socketCount()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(socketCount()).toBe(2);
      vi.advanceTimersByTime(5_000);
      expect(socketCount()).toBe(2);
    });

    it("retries when the socket cannot even be created", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let calls = 0;
      const { client } = harness({
        createSocket: (url) => {
          calls += 1;
          if (calls === 1) {
            throw new DOMException("blocked", "SecurityError");
          }
          return createFakeSocket(url);
        },
      });

      client.start();
      expect(client.state).toBe("reconnecting");
      expect(warn).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(DEFAULT_BACKOFF.baseMs);
      FakeWebSocket.latest().open();
      expect(client.state).toBe("open");
    });

    it("ignores events of a socket it already replaced", () => {
      const { client, delivered } = harness();
      client.start();
      const first = FakeWebSocket.latest();
      first.open();
      vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

      first.message(frames.hello);

      expect(delivered).toEqual([]);
      expect(client.state).toBe("reconnecting");
    });
  });

  describe("stop", () => {
    it("closes the socket normally and never reconnects", () => {
      const { client, states } = harness();
      client.start();
      const socket = FakeWebSocket.latest();
      socket.open();
      const closes: number[] = [];
      socket.addEventListener("close", (event) => closes.push((event as CloseEvent).code));

      client.stop();

      expect(closes).toEqual([1000]);
      expect(states).toEqual(["connecting", "open", "closed"]);
      vi.advanceTimersByTime(120_000);
      expect(socketCount()).toBe(1);
    });

    it("cancels a pending retry", () => {
      const { client } = harness();
      client.start();
      FakeWebSocket.latest().close(1006);
      expect(client.state).toBe("reconnecting");

      client.stop();
      vi.advanceTimersByTime(120_000);

      expect(socketCount()).toBe(1);
      expect(client.state).toBe("closed");
    });

    it("does nothing before start and can start again after", () => {
      const { client, states } = harness();
      client.stop();
      expect(states).toEqual([]);

      client.start();
      client.stop();
      client.start();

      expect(socketCount()).toBe(2);
      expect(states).toEqual(["connecting", "closed", "connecting"]);
    });
  });
});
