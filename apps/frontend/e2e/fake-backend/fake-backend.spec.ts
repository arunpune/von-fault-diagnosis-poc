// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend's scenario, stepped in process against a hand-driven wall clock: the
// waveform, the decimation, the replay clock, the seven commands, the scripted pipeline in both
// backends, ticket closure, the stream of the perf test, the series history and the hub's frame
// fan-out. No browser and no server; every frame is checked against the contract schemas.

import { expect, test } from "@playwright/test";
import type { WebSocket } from "ws";

import { asFrame, contractIssues } from "./contract.ts";
import { FRAME_POINTS_PER_TAG, decimateFrame } from "./decimate.ts";
import { createHub, type HubSource } from "./hub.ts";
import type { BackendMode } from "./pipeline.ts";
import { createScenario, type ScenarioFrameType } from "./scenario.ts";
import {
  CYCLE,
  HEALTHY,
  LEAK,
  readingsAt,
  sampleValues,
  type Conditions,
  type InjectionRun,
  type Readings,
} from "./waveform.ts";

import type { Decision, Sample, SuspectEvent, Ticket } from "@/api/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DATASET_START_MS = Date.parse("2020-02-01T00:00:00.000Z");
const F3_LANDING = "2020-06-05T06:00:00.000Z";

interface Recorded {
  readonly type: ScenarioFrameType;
  readonly payload: unknown;
}

/** A scenario on a wall clock the test moves by hand, recording everything it emits. */
function harness(backend: BackendMode = "jev") {
  let now = Date.parse("2026-09-23T08:00:00.000Z");
  const frames: Recorded[] = [];
  const samples: Sample[] = [];
  const scenario = createScenario({
    backend,
    wall: () => now,
    sink: {
      frame: (type, payload) => frames.push({ type, payload }),
      samples: (batch) => samples.push(...batch),
    },
  });
  return {
    scenario,
    frames,
    samples,
    /** Move the wall clock by `ms`, ticking every 50 ms as the server does. */
    advance(ms: number): void {
      for (let elapsed = 0; elapsed < ms; elapsed += 50) {
        now += 50;
        scenario.tick();
      }
    },
    command(segment: string, args: Record<string, unknown> = {}) {
      return scenario.command(segment, { args });
    },
    payloads<T>(type: ScenarioFrameType): T[] {
      return frames.filter((frame) => frame.type === type).map((frame) => frame.payload as T);
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** The synthetic rows of `[fromMs, fromMs + lengthMs]`, one every ten seconds. */
function rowsEvery10s(fromMs: number, lengthMs: number, conditions: Conditions): Readings[] {
  const rows: Readings[] = [];
  for (let ms = fromMs; ms <= fromMs + lengthMs; ms += 10_000) {
    rows.push(readingsAt(ms, conditions));
  }
  return rows;
}

/** The smallest and the largest value. */
function span(values: readonly number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

function expectValidFrames(frames: readonly Recorded[]): void {
  for (const frame of frames) {
    expect(
      contractIssues("ws-server-message", asFrame(frame.type, frame.payload)),
      frame.type,
    ).toEqual([]);
  }
}

/** Play at 3600× and jump to the F3 preset, then play `wallMs` of wall time. */
function jumpToF3(run: Harness, wallMs: number): void {
  expect(run.command("speed", { speed: 3600 }).status).toBe(202);
  expect(run.command("play").status).toBe(202);
  run.advance(200);
  expect(run.command("jump", { preset_id: "f3_air_leak_jun05" }).status).toBe(202);
  run.advance(wallMs);
}

test.describe("waveform", () => {
  test("plays the first-month normal cycle", () => {
    const at = (seconds: number) => readingsAt(DATASET_START_MS + seconds * 1000, HEALTHY);

    const cutIn = at(0);
    expect(cutIn.mode).toBe("loaded");
    expect(cutIn.TP3).toBeCloseTo(CYCLE.cutInBar, 1);
    expect(cutIn.TP2).toBeCloseTo(cutIn.TP3 + 0.32, 6);
    expect(cutIn.H1).toBe(-0.014);
    expect(cutIn.DV_pressure).toBeCloseTo(-0.018, 2);
    expect(cutIn.Motor_current).toBeCloseTo(6.0, 1);
    expect([cutIn.COMP, cutIn.DV_eletric, cutIn.MPG, cutIn.Towers]).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(at(59).Towers).toBe(false);
    expect(at(60).Towers).toBe(true);

    const cutOut = at(109);
    expect(cutOut.mode).toBe("unloaded");
    expect(cutOut.TP3).toBeCloseTo(CYCLE.cutOutBar, 1);
    expect(cutOut.TP2).toBe(-0.012);
    expect(cutOut.H1).toBe(cutOut.TP3);
    expect(cutOut.Motor_current).toBeCloseTo(3.77, 1);

    const off = at(109 + 407);
    expect(off.mode).toBe("off");
    expect(off.Motor_current).toBe(0.038);

    const nextCutIn = at(109 + 407 + 1329);
    expect(nextCutIn.mode).toBe("loaded");
    expect(nextCutIn.TP3).toBeCloseTo(CYCLE.cutInBar, 1);

    const cycle = rowsEvery10s(DATASET_START_MS, 1845_000, HEALTHY);
    expect(span(cycle.map((row) => row.TP3))).toEqual([
      expect.closeTo(CYCLE.cutInBar, 1),
      expect.closeTo(CYCLE.cutOutBar, 1),
    ]);
    const [oilLow, oilHigh] = span(cycle.map((row) => row.Oil_temperature));
    expect(oilLow).toBeGreaterThan(53);
    expect(oilHigh).toBeLessThan(59);
    expect(cycle.some((row) => row.LPS)).toBe(false);
  });

  test("signature A: stuck loaded, purge line pressurised, no cut-out, oil towards 76 °C", () => {
    const since = Date.parse(F3_LANDING);
    const conditions = { leakSinceMs: since, injections: [] };
    const rows = rowsEvery10s(since, 2 * HOUR_MS, conditions);
    expect(rows.every((row) => row.mode === "loaded")).toBe(true);
    const [lineLow, lineHigh] = span(rows.map((row) => row.TP3));
    expect(lineLow).toBeGreaterThan(LEAK.lineBar - 0.05);
    expect(lineHigh).toBeLessThan(LEAK.lineBar + 0.05);
    const [purgeLow, purgeHigh] = span(rows.map((row) => row.DV_pressure));
    expect(purgeLow).toBeGreaterThan(LEAK.purgeBar - 0.05);
    expect(purgeHigh).toBeLessThan(LEAK.purgeBar + 0.05);
    expect(rows.some((row) => row.LPS)).toBe(false);
    expect(readingsAt(since + 90 * MINUTE_MS, conditions).Oil_temperature).toBeCloseTo(
      LEAK.oilC,
      0,
    );
  });

  test("oil cooler fouling adds up to 14 °C over three simulated hours and keeps the cycling", () => {
    const startMs = Date.parse("2020-03-02T08:00:00.000Z");
    const fouling: InjectionRun = {
      injectionId: "oil_cooler_fouling",
      startMs,
      endMs: startMs + 10 * HOUR_MS,
      magnitude: 1,
    };
    const injected = { leakSinceMs: null, injections: [fouling] };
    const offsetAt = (ms: number) =>
      readingsAt(ms, injected).Oil_temperature - readingsAt(ms, HEALTHY).Oil_temperature;

    expect(offsetAt(startMs + 90 * MINUTE_MS)).toBeCloseTo(7, 6);
    expect(offsetAt(startMs + 3 * HOUR_MS)).toBeCloseTo(14, 6);
    expect(offsetAt(startMs + 6 * HOUR_MS)).toBeCloseTo(14, 6);
    expect(readingsAt(startMs + HOUR_MS, injected).mode).toBe(
      readingsAt(startMs + HOUR_MS, HEALTHY).mode,
    );
    const doubled = { leakSinceMs: null, injections: [{ ...fouling, magnitude: 2 }] };
    expect(
      readingsAt(startMs + 3 * HOUR_MS, doubled).Oil_temperature -
        readingsAt(startMs + 3 * HOUR_MS, HEALTHY).Oil_temperature,
    ).toBeCloseTo(28, 6);
  });

  test("is deterministic for a seed and differs between seeds", () => {
    const instant = DATASET_START_MS + 12_345_670;
    expect(sampleValues(readingsAt(instant, HEALTHY, 7))).toEqual(
      sampleValues(readingsAt(instant, HEALTHY, 7)),
    );
    expect(sampleValues(readingsAt(instant, HEALTHY, 8))).not.toEqual(
      sampleValues(readingsAt(instant, HEALTHY, 7)),
    );
  });
});

test.describe("decimation", () => {
  test("a telemetry.series frame keeps at most 64 points per tag, the extremes and every transition", () => {
    const samples: Sample[] = [];
    for (let index = 0; index < 720; index += 1) {
      const ms = DATASET_START_MS + index * 10_000;
      const values = sampleValues(readingsAt(ms, HEALTHY));
      samples.push({
        seq: index + 1,
        sim_ts: new Date(ms).toISOString(),
        flags: { discontinuity: index === 0, missing: false },
        values: index === 333 ? { ...values, dryer_purge_pressure: 6.2 } : values,
        alarms: [],
      });
    }
    const [first, ...rest] = samples;
    if (first === undefined) {
      throw new Error("no samples");
    }
    const frame = decimateFrame([first, ...rest], true);
    expect(contractIssues("ws-server-message", asFrame("telemetry.series", frame))).toEqual([]);
    expect(frame.discontinuity).toBe(true);
    for (const entry of frame.series) {
      expect(entry.points.length, entry.tag).toBeLessThanOrEqual(FRAME_POINTS_PER_TAG);
    }
    const purge = frame.series.find((entry) => entry.tag === "dryer_purge_pressure");
    expect(purge?.points.some(([, value]) => value === 6.2)).toBe(true);
    const loadValve = frame.series.find((entry) => entry.tag === "load_valve");
    // Two hours hold four cut-ins: the first state (loaded) and the seven changes that follow.
    expect(loadValve?.points.length).toBe(8);
    expect(frame.last.load_valve).toBe(false);
  });
});

test.describe("scenario", () => {
  test("plays speed / 10 samples per wall second and announces the replay state", () => {
    const run = harness();
    expect(run.command("play").status).toBe(202);
    run.advance(1000);

    // The sample at the start instant, then 600 simulated seconds at one row per ten.
    expect(run.samples).toHaveLength(61);
    expect(run.samples.map((sample) => sample.seq)).toEqual(
      run.samples.map((_, index) => index + 1),
    );
    expect(run.samples[0]?.flags.discontinuity).toBe(true);
    expect(run.samples.slice(1).every((sample) => !sample.flags.discontinuity)).toBe(true);
    expect(run.samples.at(-1)?.sim_ts).toBe("2020-02-01T00:10:00.000Z");

    const statuses = run.payloads<{ state: string; speed: number; sim_ts: string }>("status.sim");
    expect(statuses[0]).toMatchObject({ state: "playing", speed: 600 });
    expect(statuses.at(-1)?.sim_ts).toBe("2020-02-01T00:10:00.000Z");
    expect(run.scenario.status().gateway?.samples_per_s).toBe(60);
    expectValidFrames(run.frames);
  });

  test("a jump to the F3 preset flags a discontinuity, switches to signature A and runs the pipeline", () => {
    const run = harness();
    jumpToF3(run, 1600);

    const [marker] = run.payloads<{ kind: string; preset_id: string; sim_ts_to: string }>(
      "overlay.marker",
    );
    expect(marker).toMatchObject({
      kind: "jump",
      preset_id: "f3_air_leak_jun05",
      sim_ts_to: F3_LANDING,
    });
    const landing = run.samples.find((sample) => sample.sim_ts === F3_LANDING);
    expect(landing?.flags.discontinuity).toBe(true);
    const afterJump = run.samples.filter((sample) => sample.sim_ts >= F3_LANDING);
    expect(afterJump.length).toBeGreaterThan(500);
    expect(afterJump.every((sample) => sample.values.load_valve === true)).toBe(true);
    expect(afterJump.every((sample) => Number(sample.values.dryer_purge_pressure) > 2)).toBe(true);
    expect(
      afterJump.every((sample) => Number(sample.values.line_pressure) < CYCLE.cutOutBar - 1),
    ).toBe(true);

    const pipelineTypes = run.frames
      .map((frame) => frame.type)
      .filter((type) => ["event.suspect", "decision", "ticket", "cost.update"].includes(type));
    expect(pipelineTypes).toEqual(["event.suspect", "decision", "ticket", "cost.update"]);

    const [event] = run.payloads<SuspectEvent>("event.suspect");
    expect(event?.sim_ts).toBe("2020-06-05T07:30:00.000Z");
    expect(event?.rule_ids).toEqual(["stuck_loaded", "purge_pressure_high"]);
    expect(event?.observations.every((observation) => observation.level !== "unknown")).toBe(true);

    const [decision] = run.payloads<Decision>("decision");
    expect(decision).toMatchObject({
      backend: "jev",
      model: "jev-1.13.0",
      choice: "dryer_purge_leak",
      confidence: 0.91,
      gate: { outcome: "ticket", ticket_min_confidence: 0.85, review_min_confidence: 0.6 },
      severity: { level: "high", score: 2.4 },
      usage: { input_tokens: 3100, output_tokens: 0 },
      cost: { usd: 0.0001302, prices_as_of: "2026-09-19" },
      event_id: event?.event_id,
    });
    expect(decision?.candidates).toHaveLength(3);
    expect(
      decision?.candidates.every((candidate) => candidate.manual_ref.section.startsWith("8.")),
    ).toBe(true);

    const [ticket] = run.payloads<Ticket>("ticket");
    expect(ticket).toMatchObject({
      action: "opened",
      status: "open",
      fault_id: "dryer_purge_leak",
    });
    expect(run.payloads("cost.update")).toEqual([
      {
        decision_id: decision?.decision_id,
        cost_usd: 0.0001302,
        total_usd: 0.0001302,
        calls: 1,
        backend: "jev",
      },
    ]);
    expect(run.scenario.records.decision(decision?.decision_id ?? "")?.state).toBeDefined();
    expectValidFrames(run.frames);
  });

  test("the rules backend answers with medium confidence and opens a review ticket", () => {
    const run = harness("rules");
    jumpToF3(run, 1600);

    const [decision] = run.payloads<Decision>("decision");
    expect(decision).toMatchObject({
      backend: "rules",
      model: "rules-v1",
      gate: { outcome: "review" },
    });
    expect(decision?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(decision?.confidence).toBeLessThan(0.85);
    expect(run.payloads<Ticket>("ticket")[0]).toMatchObject({ status: "review", action: "opened" });
    expect(run.payloads("cost.update")).toEqual([]);
    expect(run.scenario.records.cost().totals.calls).toBe(0);
    expect(run.scenario.hello().decision_backend).toBe("rules");
    expectValidFrames(run.frames);
  });

  test("an oil-cooler-fouling injection is an overlay interval and, an hour later, a ticket for it", () => {
    const run = harness();
    run.command("speed", { speed: 3600 });
    run.command("play");
    run.advance(100);
    const reply = run.command("inject", { injection_id: "oil_cooler_fouling" });
    expect(reply.body).toMatchObject({
      accepted: true,
      ack: { ok: true, cmd: "inject", instance_id: "inj-1" },
    });
    run.advance(1100);

    const [start] = run.payloads<{ event: string; params: unknown }>("overlay.injection");
    expect(start).toMatchObject({
      event: "start",
      params: { magnitude: 1, duration_sim_min: 600 },
    });
    expect(run.scenario.overlayActive().active).toHaveLength(1);
    expect(run.scenario.records.intervals({})).toMatchObject([
      { injection_id: "oil_cooler_fouling", end_sim_ts: null },
    ]);

    const [decision] = run.payloads<Decision>("decision");
    expect(decision).toMatchObject({
      choice: "oil_cooler_fouled",
      confidence: 0.88,
      gate: { outcome: "ticket" },
    });
    expect(run.payloads<Ticket>("ticket")[0]).toMatchObject({
      status: "open",
      fault_id: "oil_cooler_fouled",
    });

    run.command("clear");
    expect(
      run.payloads<{ event: string; reason?: string }>("overlay.injection").at(-1),
    ).toMatchObject({
      event: "stop",
      reason: "cleared",
    });
    expect(run.scenario.overlayActive().active).toEqual([]);
    expectValidFrames(run.frames);
  });

  test("commands answer with the simulator's acknowledgement or the schema's refusal", () => {
    const run = harness();
    const ackError = (segment: string, args: Record<string, unknown>) => {
      const { body } = run.command(segment, args);
      return "ack" in body ? body.ack?.error?.code : undefined;
    };
    expect(ackError("jump", { preset_id: "no_such_preset" })).toBe("unknown_preset");
    expect(ackError("jump", { sim_ts: "2019-01-01T00:00:00.000Z" })).toBe("out_of_range");
    expect(ackError("inject", { injection_id: "no_such_injection" })).toBe("unknown_injection");
    expect(
      ackError("inject", { injection_id: "oil_cooler_fouling", params: { magnitude: 9 } }),
    ).toBe("bad_args");

    expect(run.command("speed", { speed: 0 }).status).toBe(400);
    expect(run.command("play", { now: true }).status).toBe(400);
    expect(run.command("jump", { preset_id: "baseline_feb", sim_ts: F3_LANDING }).status).toBe(400);
    expect(run.scenario.command("rewind", { args: {} }).status).toBe(404);

    const pause = run.command("pause");
    expect(pause.body).toMatchObject({
      ack: { ok: true, cmd: "pause", status: { state: "stopped" } },
    });
    const speed = run.command("speed", { speed: 120 });
    expect(speed.body).toMatchObject({ ack: { cmd: "set_speed", status: { speed: 120 } } });
    const play = run.command("play");
    expect(play.body).toMatchObject({ ack: { status: { state: "playing" } } });
    run.advance(500);
    const reset = run.command("reset");
    expect(reset.body).toMatchObject({
      ack: { status: { state: "stopped", sim_ts: "2020-02-01T00:00:00.000Z" } },
    });
    expect(run.payloads<{ kind: string }>("overlay.marker").at(-1)?.kind).toBe("reset");

    const validArgs: Readonly<Record<string, Record<string, unknown>>> = {
      speed: { speed: 60 },
      jump: { preset_id: "baseline_feb" },
      inject: { injection_id: "motor_overload" },
    };
    for (const segment of ["play", "pause", "speed", "jump", "inject", "clear", "reset"]) {
      const reply = run.command(segment, validArgs[segment] ?? {});
      expect(reply.status, segment).toBe(202);
      expect(contractIssues("api-sim-command-result", reply.body), segment).toEqual([]);
    }
  });

  test("closing a ticket records the verdict once", () => {
    const run = harness();
    jumpToF3(run, 1600);
    const [ticket] = run.payloads<Ticket>("ticket");
    const id = ticket?.ticket_id ?? "";

    expect(run.scenario.closeTicket(id, { outcome: "correct" }).status).toBe(400);
    const closed = run.scenario.closeTicket(id, {
      verdict: "correct",
      note: "purge valve replaced",
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      status: "closed",
      action: "closed",
      close_reason: "technician",
      closure: { verdict: "correct", note: "purge valve replaced" },
    });
    expect(contractIssues("ticket", closed.body)).toEqual([]);
    expect(run.payloads<Ticket>("ticket").at(-1)?.status).toBe("closed");
    expect(run.scenario.closeTicket(id, { verdict: "wrong" }).status).toBe(409);
    expect(run.scenario.closeTicket("no-such-ticket", { verdict: "wrong" }).status).toBe(404);
  });

  test("a jump or a reset resolves the running tickets and aborts their episodes", () => {
    const run = harness();
    jumpToF3(run, 1600);
    run.command("reset");
    expect(run.payloads<Ticket>("ticket").at(-1)).toMatchObject({
      status: "resolved",
      action: "resolved",
      close_reason: "discontinuity",
    });
    expect(run.scenario.records.openEpisodes()).toEqual([]);
    expect(run.scenario.status().sim?.state).toBe("stopped");
  });

  test("a stream replays at its own rate whatever the speed, then restores the replay", () => {
    const run = harness();
    run.command("speed", { speed: 1 });
    run.scenario.stream(360, 2);
    expect(run.scenario.status().sim?.state).toBe("playing");
    run.advance(2000);
    expect(run.samples.length).toBeGreaterThanOrEqual(720);
    expect(run.samples.length).toBeLessThanOrEqual(722);
    run.advance(100);
    expect(run.scenario.status().sim).toMatchObject({ state: "stopped", speed: 1 });
  });

  test("the series history is what was played, downsampled, with the jump as a discontinuity", () => {
    const run = harness();
    run.command("speed", { speed: 3600 });
    run.command("play");
    run.advance(1000);
    run.command("jump", { preset_id: "f3_air_leak_jun05" });
    run.advance(1000);

    const series = run.scenario.series({
      tags: ["line_pressure", "load_valve"],
      fromMs: DATASET_START_MS,
      toMs: Date.parse("2020-06-06T00:00:00.000Z"),
      points: 100,
    });
    expect(contractIssues("api-telemetry-series", series)).toEqual([]);
    expect(series.discontinuities).toEqual([F3_LANDING]);
    const [line, valve] = series.series;
    expect(line).toMatchObject({ tag: "line_pressure", kind: "analog", unit: "bar" });
    expect(valve).toMatchObject({ tag: "load_valve", kind: "digital", unit: "" });
    expect(line?.points.length).toBeLessThanOrEqual(100);
    expect(line?.points.some(([instant]) => instant < "2020-02-02")).toBe(true);
    expect(line?.points.some(([instant]) => instant >= F3_LANDING)).toBe(true);
    expect(line?.points.some(([instant]) => instant > "2020-02-02" && instant < F3_LANDING)).toBe(
      false,
    );
  });
});

test.describe("hub", () => {
  /** A socket double: records what it is sent and lets the test speak for the client. */
  function fakeSocket() {
    const sent: { type: string; payload: unknown }[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (text: string) => sent.push(JSON.parse(text) as { type: string; payload: unknown }),
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
      close: () => undefined,
    };
    return {
      socket: socket as unknown as WebSocket,
      sent,
      say: (message: unknown) =>
        listeners.get("message")?.(Buffer.from(JSON.stringify(message)), false),
    };
  }

  test("greets with hello and snapshot, cuts telemetry at jumps and sends raw samples only on request", () => {
    const run = harness();
    const source: HubSource = run.scenario;
    const hub = createHub({
      unitId: "cau-7",
      wall: () => Date.parse("2026-09-23T08:00:00.000Z"),
      source: () => source,
    });
    const charts = fakeSocket();
    const debug = fakeSocket();
    hub.attach(charts.socket);
    hub.attach(debug.socket);
    debug.say({ type: "subscribe", channels: ["telemetry.samples", "heartbeat"] });

    run.command("speed", { speed: 3600 });
    run.command("play");
    run.advance(500);
    run.command("jump", { preset_id: "f3_air_leak_jun05" });
    run.advance(300);
    hub.pushSamples(run.samples);
    hub.flush();
    hub.heartbeat();

    expect(charts.sent.slice(0, 2).map((frame) => frame.type)).toEqual(["hello", "snapshot"]);
    const series = charts.sent.filter((frame) => frame.type === "telemetry.series");
    expect(
      series.map((frame) => (frame.payload as { discontinuity: boolean }).discontinuity),
    ).toEqual([true, true]);
    expect(charts.sent.some((frame) => frame.type === "telemetry.samples")).toBe(false);
    expect(charts.sent.at(-1)).toMatchObject({
      type: "heartbeat",
      payload: { sim_ts: run.samples.at(-1)?.sim_ts },
    });

    const raw = debug.sent.filter((frame) => frame.type === "telemetry.samples");
    const counts = raw.map((frame) => (frame.payload as { samples: unknown[] }).samples.length);
    expect(counts.every((count) => count <= 25)).toBe(true);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(run.samples.length);
    expect(debug.sent.some((frame) => frame.type === "telemetry.series")).toBe(false);

    for (const frame of [...charts.sent, ...debug.sent]) {
      expect(contractIssues("ws-server-message", frame), frame.type).toEqual([]);
    }
  });
});
