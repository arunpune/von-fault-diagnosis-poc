// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The WebSocket hub with fake sockets and fake timers: hello first, the
// snapshot after it, one decimated series frame per flush, the raw samples
// only on request and in frames of at most 25, the subscribe filter, ping,
// the heartbeat, the jump that cuts a flush, the slow-client policy and the
// shutdown. Every frame the hub sends in these
// tests is checked against `ws-server-message` (`validation: "every"`).

import { fixturesFor } from "@fdp/contracts/testing";
import { isValid, type Decision, type SnapshotPayload, type Ticket } from "@fdp/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { systemClock } from "../clock.ts";
import { FakeSocket, sampleAt, samplesFrom, START, STEP_MS } from "./fakes.test-helper.ts";
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY_VIOLATION,
  createHub,
  DEFAULT_TELEMETRY_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  SAMPLED_VALIDATION_EVERY,
  SLOW_CLOSE_AFTER_MS,
  type Hub,
  type HubLog,
  type HubOptions,
} from "./hub.ts";

const WALL = "2026-09-22T10:00:00.000Z";

function fixture<T>(schema: string, file: string): T {
  const found = fixturesFor(schema).valid.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no fixture ${schema}/${file}`);
  return structuredClone(found.data) as T;
}

const TICKET = fixture<Ticket>("ticket", "valid-opened.json");
const DECISION = fixture<Decision>("decision", "valid-von-ticket.json");
const SNAPSHOT = fixture<{ payload: SnapshotPayload }>(
  "ws-server-message",
  "valid-snapshot.json",
).payload;

function logger(): HubLog & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const write = (level: string) => (_object: Record<string, unknown>, message: string) => {
    lines.push({ level, message });
  };
  return { lines, debug: write("debug"), warn: write("warn"), error: write("error") };
}

let hubs: Hub[];

function hub(options: Partial<HubOptions> = {}): Hub {
  const created = createHub({
    wall: systemClock,
    info: { serverVersion: "1.0.0", decisionBackend: "rules", model: "rules-v1", unitId: "cau-7" },
    validation: "every",
    ...options,
  });
  hubs.push(created);
  return created;
}

/** A socket attached to `target`, with its hello (and snapshot) cleared. */
function attached(target: Hub): FakeSocket {
  const socket = new FakeSocket();
  target.attach(socket);
  socket.clear();
  return socket;
}

/** Let the snapshot promise settle; only intervals and Date are faked. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function flush(): void {
  vi.advanceTimersByTime(DEFAULT_TELEMETRY_INTERVAL_MS);
}

beforeEach(() => {
  hubs = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(WALL));
});

afterEach(() => {
  for (const created of hubs) created.closeAll();
  vi.useRealTimers();
});

describe("attach", () => {
  it("sends hello first, with the backend, the model and the schema major", () => {
    const socket = new FakeSocket();
    hub().attach(socket);
    expect(socket.types()).toEqual(["hello"]);
    const [hello] = socket.frames();
    expect(isValid("ws-server-message", hello)).toBe(true);
    expect(hello).toMatchObject({
      schema: "urn:fdp:schema:ws-server-message:v1",
      unit_id: "cau-7",
      wall_ts: WALL,
      payload: {
        server_version: "1.0.0",
        schema_major: 1,
        decision_backend: "rules",
        model: "rules-v1",
        unit_id: "cau-7",
      },
    });
  });

  it("sends the runtime's snapshot right after hello", async () => {
    const socket = new FakeSocket();
    hub({ snapshot: () => Promise.resolve(SNAPSHOT) }).attach(socket);
    await settle();
    expect(socket.types()).toEqual(["hello", "snapshot"]);
  });

  it("keeps the socket when the snapshot fails, and logs why", async () => {
    const log = logger();
    const socket = new FakeSocket();
    const target = hub({ snapshot: () => Promise.reject(new Error("database away")), logger: log });
    target.attach(socket);
    await settle();
    expect(socket.types()).toEqual(["hello"]);
    expect(socket.closedWith).toBeUndefined();
    expect(log.lines).toEqual([
      { level: "warn", message: "the snapshot for a new WebSocket client failed" },
    ]);
    expect(target.counters().clients).toBe(1);
  });

  it("forgets a socket once it closes", () => {
    const target = hub();
    const socket = attached(target);
    expect(target.counters().clients).toBe(1);
    socket.close(1000, "bye");
    expect(target.counters().clients).toBe(0);
    target.broadcast("ticket", TICKET);
    expect(socket.sent).toEqual([]);
  });
});

describe("telemetry.series", () => {
  it("sends nothing before the flush and one decimated frame per flush", () => {
    const target = hub();
    const socket = attached(target);
    const samples = samplesFrom(90, (position) => ({
      line_pressure: 8 + position * 0.01,
      load_valve: position < 40,
    }));
    target.pushSamples(samples.slice(0, 30));
    target.pushSamples(samples.slice(30));
    expect(socket.sent).toEqual([]);

    flush();
    const frames = socket.framesOf("telemetry.series");
    expect(socket.types()).toEqual(["telemetry.series"]);
    expect(isValid("ws-server-message", frames[0])).toBe(true);
    const payload = frames[0]?.payload;
    expect(payload?.from_sim_ts).toBe(samples[0]?.sim_ts);
    expect(payload?.to_sim_ts).toBe(samples.at(-1)?.sim_ts);
    expect(payload?.discontinuity).toBe(false);
    for (const series of payload?.series ?? [])
      expect(series.points.length).toBeLessThanOrEqual(64);
    expect(payload?.last).toEqual({
      line_pressure: samples.at(-1)?.values.line_pressure,
      load_valve: false,
    });
  });

  it("sends no frame for a flush without samples", () => {
    const target = hub();
    const socket = attached(target);
    flush();
    flush();
    expect(socket.sent).toEqual([]);
  });

  it("flushes at the configured interval", () => {
    const target = hub({ telemetryIntervalMs: 1_000 });
    const socket = attached(target);
    target.pushSamples(samplesFrom(3, () => ({ line_pressure: 9 })));
    vi.advanceTimersByTime(999);
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.types()).toEqual(["telemetry.series"]);
  });

  it("cuts the flush where data time jumps, so each frame is in ascending time", () => {
    const target = hub();
    const socket = attached(target);
    const before = samplesFrom(5, () => ({ line_pressure: 9 }));
    const jumpMs = Date.parse(START) - 3_600_000;
    const after = [
      sampleAt(1, jumpMs, { line_pressure: 7 }, true),
      sampleAt(2, jumpMs + STEP_MS, { line_pressure: 7.1 }),
    ];
    target.pushSamples([...before, ...after]);
    flush();

    const frames = socket.framesOf("telemetry.series");
    expect(frames.map((frame) => frame.payload.discontinuity)).toEqual([false, true]);
    expect(frames[1]?.payload.from_sim_ts).toBe(after[0]?.sim_ts);
  });

  it("treats a sample older than the one before it as a jump even without the flag", () => {
    const target = hub();
    const socket = attached(target);
    target.pushSamples(samplesFrom(3, () => ({ line_pressure: 9 })));
    flush();
    target.pushSamples(
      samplesFrom(2, () => ({ line_pressure: 9 }), { start: "2020-06-04T00:00:00.000Z" }),
    );
    flush();
    expect(socket.framesOf("telemetry.series").map((frame) => frame.payload.discontinuity)).toEqual(
      [false, true],
    );
  });

  it("buffers nothing while no client is connected", () => {
    const target = hub();
    target.pushSamples(samplesFrom(10, () => ({ line_pressure: 9 })));
    const socket = attached(target);
    flush();
    expect(socket.sent).toEqual([]);
  });
});

describe("telemetry.samples (debug channel)", () => {
  it("is not sent to a client that did not ask for it", () => {
    const target = hub();
    const socket = attached(target);
    target.pushSamples(samplesFrom(10, () => ({ line_pressure: 9 })));
    flush();
    expect(socket.types()).not.toContain("telemetry.samples");
  });

  it("is coalesced into frames of at most 25 samples for a client that subscribed", () => {
    const target = hub();
    const debug = attached(target);
    const plain = attached(target);
    debug.receive(
      JSON.stringify({ type: "subscribe", channels: ["telemetry.samples", "telemetry.series"] }),
    );
    const samples = samplesFrom(60, () => ({ line_pressure: 9 }));
    target.pushSamples(samples);
    flush();

    const raw = debug.framesOf("telemetry.samples");
    expect(raw.map((frame) => frame.payload.samples.length)).toEqual([25, 25, 10]);
    expect(raw.flatMap((frame) => frame.payload.samples.map((sample) => sample.seq))).toEqual(
      samples.map((sample) => sample.seq),
    );
    for (const frame of raw) expect(isValid("ws-server-message", frame)).toBe(true);
    expect(debug.framesOf("telemetry.series")).toHaveLength(1);
    expect(plain.types()).toEqual(["telemetry.series"]);
  });
});

describe("subscribe and ping", () => {
  it("replaces the channels a socket receives", () => {
    const target = hub();
    const socket = attached(target);
    socket.receive(JSON.stringify({ type: "subscribe", channels: ["ticket"] }));
    target.broadcast("decision", DECISION);
    target.broadcast("ticket", TICKET);
    target.pushSamples(samplesFrom(3, () => ({ line_pressure: 9 })));
    flush();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.types()).toEqual(["ticket"]);
  });

  it("mutes every channel with an empty list", () => {
    const target = hub();
    const socket = attached(target);
    socket.receive(JSON.stringify({ type: "subscribe", channels: [] }));
    target.broadcast("ticket", TICKET);
    expect(socket.sent).toEqual([]);
  });

  it("accepts ping and answers nothing", () => {
    const target = hub();
    const socket = attached(target);
    socket.receive(JSON.stringify({ type: "ping" }));
    expect(socket.sent).toEqual([]);
    target.broadcast("ticket", TICKET);
    expect(socket.types()).toEqual(["ticket"]);
  });

  it.each([
    ["text that is not JSON", "{subscribe", false],
    ["an unknown frame type", JSON.stringify({ type: "command", cmd: "play" }), false],
    [
      "an unknown channel",
      JSON.stringify({ type: "subscribe", channels: ["gt.injection"] }),
      false,
    ],
    ["a binary frame", JSON.stringify({ type: "subscribe", channels: [] }), true],
  ])("ignores %s and keeps the socket and its subscription", (_name, text, binary) => {
    const target = hub();
    const socket = attached(target);
    socket.receive(Buffer.from(text), binary);
    target.broadcast("ticket", TICKET);
    expect(socket.types()).toEqual(["ticket"]);
    expect(socket.closedWith).toBeUndefined();
  });
});

describe("broadcast", () => {
  it("sends each frame at once to every subscribed socket", () => {
    const target = hub();
    const first = attached(target);
    const second = attached(target);
    target.broadcast("alarm.native", { code: "W101", active: true, sim_ts: START });
    for (const socket of [first, second]) {
      expect(socket.frames()).toEqual([
        {
          schema: "urn:fdp:schema:ws-server-message:v1",
          unit_id: "cau-7",
          wall_ts: WALL,
          type: "alarm.native",
          payload: { code: "W101", active: true, sim_ts: START },
        },
      ]);
    }
  });

  it("refuses an off-contract frame in every mode by throwing", () => {
    const target = hub();
    attached(target);
    expect(() =>
      target.broadcast("alarm.native", { code: "not-a-code", active: true, sim_ts: START }),
    ).toThrow(/ws-server-message/);
  });

  it("checks one frame in a hundred in sampled mode, and drops and logs one that fails", () => {
    const log = logger();
    const target = hub({ validation: "sampled", logger: log });
    const socket = attached(target); // hello was the first frame, and it was checked
    for (let frame = 1; frame < SAMPLED_VALIDATION_EVERY; frame += 1) {
      target.broadcast("ticket", TICKET);
    }
    socket.clear();

    target.broadcast("alarm.native", { code: "not-a-code", active: true, sim_ts: START });
    expect(socket.sent).toEqual([]);
    expect(target.counters().invalidFrames).toBe(1);
    expect(log.lines.map((line) => line.level)).toEqual(["error"]);
  });
});

describe("heartbeat", () => {
  it("sends the wall time and the newest data time every ten seconds", () => {
    const target = hub();
    const socket = attached(target);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.framesOf("heartbeat").map((frame) => frame.payload)).toEqual([
      { wall_ts: "2026-09-22T10:00:10.000Z", sim_ts: null },
    ]);

    const samples = samplesFrom(4, () => ({ line_pressure: 9 }));
    target.pushSamples(samples);
    socket.clear();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(socket.framesOf("heartbeat").map((frame) => frame.payload.sim_ts)).toEqual([
      samples.at(-1)?.sim_ts,
    ]);
  });
});

describe("slow clients", () => {
  it("drops telemetry frames above 1 MB of backlog and keeps every other frame", () => {
    const target = hub();
    const slow = attached(target);
    const fast = attached(target);
    slow.bufferedAmount = 2 * 1_048_576;
    target.pushSamples(samplesFrom(5, () => ({ line_pressure: 9 })));
    flush();
    target.broadcast("ticket", TICKET);

    expect(slow.types()).toEqual(["ticket"]);
    expect(fast.types()).toEqual(["telemetry.series", "ticket"]);
    expect(target.counters().telemetryDropped).toBe(1);
    expect(slow.closedWith).toBeUndefined();
  });

  it("closes with 1008 a socket that stays above 4 MB for ten seconds", () => {
    const target = hub();
    const socket = attached(target);
    socket.bufferedAmount = 5 * 1_048_576;
    vi.advanceTimersByTime(SLOW_CLOSE_AFTER_MS);
    expect(socket.closedWith).toBeUndefined();
    flush();
    expect(socket.closedWith).toEqual({ code: CLOSE_POLICY_VIOLATION, reason: "slow client" });
    expect(target.counters()).toMatchObject({ clients: 0, slowClosed: 1 });
  });

  it("starts the ten seconds again once the backlog drains", () => {
    const target = hub();
    const socket = attached(target);
    socket.bufferedAmount = 5 * 1_048_576;
    vi.advanceTimersByTime(8_000);
    socket.bufferedAmount = 0;
    flush();
    socket.bufferedAmount = 5 * 1_048_576;
    vi.advanceTimersByTime(8_000);
    expect(socket.closedWith).toBeUndefined();
  });
});

describe("closeAll", () => {
  it("closes every socket with 1001, stops the timers and refuses later sockets", () => {
    const target = hub();
    const first = attached(target);
    const second = attached(target);
    target.pushSamples(samplesFrom(3, () => ({ line_pressure: 9 })));
    target.closeAll(CLOSE_GOING_AWAY);

    for (const socket of [first, second]) {
      expect(socket.closedWith).toEqual({ code: CLOSE_GOING_AWAY, reason: "server shutting down" });
    }
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect([...first.sent, ...second.sent]).toEqual([]);

    const late = new FakeSocket();
    target.attach(late);
    expect(late.sent).toEqual([]);
    expect(late.closedWith?.code).toBe(CLOSE_GOING_AWAY);
    expect(target.counters().clients).toBe(0);
  });
});
