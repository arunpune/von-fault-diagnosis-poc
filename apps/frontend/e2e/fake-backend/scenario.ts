// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scripted scenario behind the fake backend: a simulator clock, the seven replay commands,
// the overlay (markers and injections), the statuses and the scripted pipeline, all driven by
// `tick()` against an injected wall clock so a test can step it deterministically.
//
// The clock plays the synthetic waveform at `speed` simulated seconds per wall second, one sample
// every ten simulated seconds, so `speed / 10` samples per wall second. `status.sim` goes out on
// every change and once a second while playing; `status.gateway` and `status.backend` every five
// seconds. A command answers like the backend's `POST /api/sim/:cmd`: 400 for arguments the
// control-cmd schema refuses, otherwise 202 with the simulator's acknowledgement — `ok: false`
// and an error code for an unknown preset or injection or an out-of-range instant — whose
// `status` is the replay status after the command. A jump or a reset is a discontinuity: it stops
// the running injections, resolves the open tickets, drops the pending scripts, emits an
// `overlay.marker` and flags the next sample.
//
// `/__test/stream { samples_per_s, seconds }` replays at exactly that sample rate for that long,
// whatever the speed, and restores the replay state afterwards.

import { DATASET, findInjection, findPreset, OVERLAY_CATALOG } from "./data.ts";
import { createHistory, type SeriesQuery } from "./history.ts";
import {
  F3_AIR_LEAK,
  GATE,
  MODELS,
  OIL_COOLER,
  runScript,
  type BackendMode,
  type Script,
} from "./pipeline.ts";
import { createIdSource } from "./random.ts";
import { apiError, argumentIssue, closeBodyOf, injectArgsOf, isRecord } from "./requests.ts";
import { createStore, type Store } from "./store.ts";
import {
  DEFAULT_SEED,
  modeSinceMs,
  readingsAt,
  sampleValues,
  SAMPLE_INTERVAL_MS,
  type InjectionRun,
} from "./waveform.ts";

import type {
  ApiErrorBody,
  ApiHealth,
  ApiSimCommandResult,
  ApiStatus,
  ApiTelemetrySeries,
  ControlAck,
  ControlError,
  HelloPayload,
  InjectArgs,
  OverlayInjection,
  OverlayInjectionActive,
  OverlayMarker,
  RunningInstance,
  Sample,
  ServerFrameType,
  SimCommandName,
  SimulatorState,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
  Ticket,
} from "@/api/types";
import type { FrameOf, ServerFrame } from "@/api/ws-types";

/** The frame types the hub builds itself; the scenario emits every other one. */
type HubFrameType = "hello" | "snapshot" | "heartbeat" | "telemetry.samples" | "telemetry.series";

export type ScenarioFrameType = Exclude<ServerFrameType, HubFrameType>;

export type FramePayload<T extends ServerFrameType> = FrameOf<T>["payload"];

/** Where the scenario's output goes: frames at once, samples to the next telemetry flush. */
export interface ScenarioSink {
  frame<T extends ScenarioFrameType>(type: T, payload: FramePayload<T>): void;
  samples(samples: readonly [Sample, ...Sample[]]): void;
}

export interface ScenarioOptions {
  /** The decision backend to play: `jev` (the default) or `rules`. */
  readonly backend?: BackendMode;
  readonly unitId?: string;
  readonly seed?: number;
  /** Wall clock in epoch milliseconds. */
  readonly wall: () => number;
  readonly sink: ScenarioSink;
}

/** A route's answer: an HTTP status and its body. */
export interface Reply<T> {
  readonly status: number;
  readonly body: T | ApiErrorBody;
}

/** The records the list routes read. */
export type Records = Omit<
  Store,
  | "addEvent"
  | "addDecision"
  | "putTicket"
  | "putEpisode"
  | "bill"
  | "putAlert"
  | "addMarker"
  | "openInterval"
  | "closeInterval"
>;

export interface Scenario {
  readonly backend: BackendMode;
  readonly records: Records;
  /** Advance the replay to the wall clock's now and emit whatever is due. */
  tick(): void;
  /** `POST /api/sim/:segment` with its body. */
  command(segment: string, body: unknown): Reply<ApiSimCommandResult>;
  /** `POST /api/tickets/:id/close` with its body. */
  closeTicket(ticketId: string, body: unknown): Reply<Ticket>;
  /** `/__test/stream`: replay at `samplesPerS` for `seconds` of wall time. */
  stream(samplesPerS: number, seconds: number): void;
  /** `/__test/emit`: take in the record a frame carries, as if the pipeline had produced it. */
  ingest(frame: ServerFrame): void;
  status(): ApiStatus;
  health(): ApiHealth;
  hello(): HelloPayload;
  snapshot(): SnapshotPayload;
  /** Data time of the newest sample, null before the first one. */
  lastSampleSimTs(): string | null;
  series(query: SeriesQuery): ApiTelemetrySeries;
  overlayActive(): OverlayInjectionActive;
}

export const UNIT_ID = "cau-7";

/** The version the fake reports in `hello`, `status.backend` and `/api/health`. */
const FAKE_VERSION = "0.0.0-fake";

/** The replay speed before any `speed` command: the README's 600×. */
const DEFAULT_SPEED = 600;

/** A tick never emits more than this many samples; a longer stall drops the backlog. */
const MAX_SAMPLES_PER_TICK = 2000;

const STATUS_SIM_EVERY_MS = 1000;
const STATUS_PERIODIC_EVERY_MS = 5000;

/** What the fake gateway reports as its poll interval; each tick while playing counts as a poll. */
const GATEWAY_POLL_INTERVAL_MS = 200;

/** The preset whose jump switches the waveform to signature A and runs the F3 script. */
const F3_PRESET_ID = "f3_air_leak_jun05";

/** Scripts that follow a jump to a preset. */
const PRESET_SCRIPTS: Readonly<Record<string, Script>> = { [F3_PRESET_ID]: F3_AIR_LEAK };

/** Scripts that follow an injection. */
const INJECTION_SCRIPTS: Readonly<Record<string, Script>> = { oil_cooler_fouling: OIL_COOLER };

/** The route segment of each command and the command it names. */
const SEGMENT_COMMANDS: Readonly<Record<string, SimCommandName>> = {
  play: "play",
  pause: "pause",
  speed: "set_speed",
  jump: "jump",
  inject: "inject",
  clear: "clear_injections",
  reset: "reset",
};

const FIRST_MS = Date.parse(DATASET.first_ts);
const LAST_MS = Date.parse(DATASET.last_ts);

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

interface PendingScript {
  readonly script: Script;
  readonly dueMs: number;
  readonly triggerMs: number;
  /** The injection instance that triggered it, or null for a jump. */
  readonly instanceId: string | null;
}

interface Stream {
  readonly samplesPerS: number;
  readonly untilWallMs: number;
  /** The replay state to return to when the stream ends. */
  readonly resume: SimulatorState;
}

export function createScenario(options: ScenarioOptions): Scenario {
  const { wall, sink } = options;
  const backend: BackendMode = options.backend ?? "jev";
  const unitId = options.unitId ?? UNIT_ID;
  const seed = options.seed ?? DEFAULT_SEED;
  const ids = createIdSource(seed);
  const store = createStore();
  const history = createHistory(FIRST_MS, seed);
  const startedWallMs = wall();

  let state: SimulatorState = "stopped";
  let speed = DEFAULT_SPEED;
  let simClockMs = FIRST_MS;
  let nextSampleMs = FIRST_MS;
  let cursorMs = FIRST_MS;
  let headSeq = 0;
  let pendingDiscontinuity = true;
  let lastSample: Sample | null = null;
  let lastWallMs = startedWallMs;
  let lastSimStatusWallMs = startedWallMs;
  let lastPeriodicWallMs = startedWallMs;
  let polls = 0;
  let stream: Stream | null = null;
  let active: RunningInstance[] = [];
  const effects = new Map<string, InjectionRun>();
  let instances = 0;
  let pending: PendingScript[] = [];
  let decisionsTotal = 0;
  let lastDecisionWallTs: string | null = null;

  const wallIso = (): string => isoOf(wall());

  function emit<T extends ScenarioFrameType>(type: T, payload: FramePayload<T>): void {
    sink.frame(type, payload);
  }

  // --- statuses ------------------------------------------------------------------------------

  function statusSim(): StatusSim {
    return {
      schema: "urn:fdp:schema:status-sim:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      sim_ts: isoOf(cursorMs),
      state,
      speed,
      head_seq: headSeq,
      dataset: {
        first_ts: DATASET.first_ts,
        last_ts: DATASET.last_ts,
        rows: DATASET.rows,
        source: "synthetic compressor waveform (e2e fake backend)",
      },
      loop: false,
      uptime_s: Math.floor((wall() - startedWallMs) / 1000),
    };
  }

  function sampleRate(): number {
    if (state !== "playing") {
      return 0;
    }
    return stream === null ? speed / (SAMPLE_INTERVAL_MS / 1000) : stream.samplesPerS;
  }

  function statusGateway(): StatusGateway {
    return {
      schema: "urn:fdp:schema:status-gateway:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      last_seq: headSeq,
      dropped_total: 0,
      polls_total: polls,
      poll_errors_total: 0,
      poll_interval_ms: GATEWAY_POLL_INTERVAL_MS,
      samples_per_s: sampleRate(),
      modbus: { host: "fake-sim", port: 5020, connected: true, map_major: 1, map_minor: 0 },
      last_error: null,
    };
  }

  function statusBackend(): StatusBackend {
    return {
      schema: "urn:fdp:schema:status-backend:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      backend: { name: backend, model: MODELS[backend] },
      decision: {
        total: decisionsTotal,
        ok: decisionsTotal,
        failed: 0,
        consecutive_errors: 0,
        last_ok_wall_ts: lastDecisionWallTs,
        last_error_wall_ts: null,
      },
      heartbeat: { telemetry_silent: false, decision_api_silent: false },
      episodes_open: store.openEpisodes().length,
      tickets_open: store.activeTickets().length,
      version: FAKE_VERSION,
    };
  }

  function overlayActive(): OverlayInjectionActive {
    return {
      schema: "urn:fdp:schema:gt-injection-active:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      sim_ts: isoOf(cursorMs),
      active: [...active],
    };
  }

  function announceSim(): void {
    lastSimStatusWallMs = wall();
    emit("status.sim", statusSim());
  }

  // --- injections ----------------------------------------------------------------------------

  function injectionEvent(
    instance: RunningInstance,
    event: "start" | "stop",
    atMs: number,
    reason?: NonNullable<OverlayInjection["reason"]>,
  ): OverlayInjection {
    return {
      schema: "urn:fdp:schema:gt-injection:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      sim_ts: isoOf(atMs),
      event,
      instance_id: instance.instance_id,
      injection_id: instance.injection_id,
      fault_id: instance.fault_id,
      params: instance.params,
      ends_sim_ts: instance.ends_sim_ts,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  function stopInstances(
    stopping: readonly RunningInstance[],
    reason: NonNullable<OverlayInjection["reason"]>,
    atMs: number,
  ): void {
    if (stopping.length === 0) {
      return;
    }
    const stoppingIds = new Set(stopping.map((instance) => instance.instance_id));
    active = active.filter((instance) => !stoppingIds.has(instance.instance_id));
    pending = pending.filter(
      (entry) => entry.instanceId === null || !stoppingIds.has(entry.instanceId),
    );
    for (const instance of stopping) {
      const effect = effects.get(instance.instance_id);
      if (effect !== undefined) {
        effect.endMs = Math.min(effect.endMs, atMs);
      }
      store.closeInterval(instance.instance_id, isoOf(atMs), reason);
      emit("overlay.injection", injectionEvent(instance, "stop", atMs, reason));
    }
    emit("overlay.injection_active", overlayActive());
  }

  function expireInstances(atMs: number): void {
    stopInstances(
      active.filter((instance) => Date.parse(instance.ends_sim_ts) <= atMs),
      "expired",
      atMs,
    );
  }

  // --- the pipeline --------------------------------------------------------------------------

  function schedule(script: Script, triggerMs: number, instanceId: string | null): void {
    pending.push({ script, dueMs: triggerMs + script.delayMs, triggerMs, instanceId });
    pending.sort((a, b) => a.dueMs - b.dueMs);
  }

  function runPipeline(entry: PendingScript, atMs: number): void {
    const segment = history.current();
    const run = runScript(entry.script, {
      unitId,
      backend,
      wallIso: wallIso(),
      ids,
      readings: readingsAt(atMs, segment, seed),
      atMs,
      triggerMs: entry.triggerMs,
      modeSinceMs: modeSinceMs(atMs, segment),
    });
    store.addEvent(run.event);
    emit("event.suspect", run.event);
    store.addDecision(run.decision, run.state);
    decisionsTotal += 1;
    lastDecisionWallTs = run.decision.wall_ts;
    emit("decision", run.decision);
    store.putEpisode(run.episode);
    if (run.ticket !== null) {
      store.putTicket(run.ticket);
      emit("ticket", run.ticket);
    }
    if (run.decision.backend === "jev") {
      const totals = store.bill({
        decision_id: run.decision.decision_id,
        backend: run.decision.backend,
        model: run.decision.model,
        input_tokens: run.decision.usage.input_tokens,
        output_tokens: run.decision.usage.output_tokens,
        cost_usd: run.decision.cost.usd,
        wall_ts: run.decision.wall_ts,
        sim_ts: run.decision.sim_ts,
      });
      emit("cost.update", {
        decision_id: run.decision.decision_id,
        cost_usd: run.decision.cost.usd,
        total_usd: totals.totalUsd,
        calls: totals.calls,
        backend: run.decision.backend,
      });
    }
    emit("status.backend", statusBackend());
  }

  function fireDue(atMs: number): void {
    while (pending[0] !== undefined && pending[0].dueMs <= atMs) {
      const [entry] = pending.splice(0, 1);
      if (entry !== undefined) {
        runPipeline(entry, atMs);
      }
    }
  }

  // --- tickets -------------------------------------------------------------------------------

  /** A discontinuity ends every running episode: its ticket resolves. */
  function resolveActiveTickets(atMs: number): void {
    const atIso = isoOf(atMs);
    for (const episode of store.openEpisodes()) {
      store.putEpisode({
        ...episode,
        status: "aborted",
        closed_sim_ts: atIso,
        close_reason: "discontinuity",
      });
    }
    const resolving = store.activeTickets();
    for (const ticket of resolving) {
      const resolved: Ticket = {
        ...ticket,
        wall_ts: wallIso(),
        action: "resolved",
        status: "resolved",
        updated_sim_ts: atIso,
        resolved_sim_ts: atIso,
        close_reason: "discontinuity",
      };
      store.putTicket(resolved);
      emit("ticket", resolved);
    }
    if (resolving.length > 0) {
      emit("status.backend", statusBackend());
    }
  }

  // --- the replay ----------------------------------------------------------------------------

  function emitSample(atMs: number): Sample {
    const segment = history.current();
    headSeq += 1;
    const sample: Sample = {
      seq: headSeq,
      sim_ts: isoOf(atMs),
      flags: { discontinuity: pendingDiscontinuity, missing: false },
      values: sampleValues(readingsAt(atMs, segment, seed)),
      alarms: [],
    };
    pendingDiscontinuity = false;
    history.extend(atMs);
    cursorMs = atMs;
    lastSample = sample;
    return sample;
  }

  function advance(elapsedWallMs: number): void {
    const simMsPerWallMs =
      stream === null ? speed : (stream.samplesPerS * SAMPLE_INTERVAL_MS) / 1000;
    simClockMs += elapsedWallMs * simMsPerWallMs;
    polls += 1;
    const batch: Sample[] = [];
    while (nextSampleMs <= simClockMs && batch.length < MAX_SAMPLES_PER_TICK) {
      if (nextSampleMs > LAST_MS) {
        state = "stopped";
        stream = null;
        announceSim();
        break;
      }
      const atMs = nextSampleMs;
      batch.push(emitSample(atMs));
      nextSampleMs += SAMPLE_INTERVAL_MS;
      expireInstances(atMs);
      fireDue(atMs);
    }
    if (batch.length === MAX_SAMPLES_PER_TICK) {
      simClockMs = nextSampleMs - SAMPLE_INTERVAL_MS;
    }
    const [first, ...rest] = batch;
    if (first !== undefined) {
      sink.samples([first, ...rest]);
    }
  }

  function endStream(): void {
    if (stream === null) {
      return;
    }
    state = stream.resume;
    stream = null;
    announceSim();
  }

  function periodic(nowMs: number): void {
    if (state === "playing" && nowMs - lastSimStatusWallMs >= STATUS_SIM_EVERY_MS) {
      announceSim();
    }
    if (nowMs - lastPeriodicWallMs >= STATUS_PERIODIC_EVERY_MS) {
      lastPeriodicWallMs = nowMs;
      emit("status.gateway", statusGateway());
      emit("status.backend", statusBackend());
    }
  }

  function tick(): void {
    const nowMs = wall();
    if (state === "playing") {
      // A stream plays up to its end and not a millisecond further.
      const untilMs = stream === null ? nowMs : Math.min(nowMs, stream.untilWallMs);
      advance(Math.max(0, untilMs - lastWallMs));
    }
    lastWallMs = nowMs;
    if (stream !== null && nowMs >= stream.untilWallMs) {
      endStream();
    }
    periodic(nowMs);
  }

  /** Move the replay to `targetMs` and announce it: a jump or a reset. */
  function discontinuity(
    kind: OverlayMarker["kind"],
    targetMs: number,
    presetId: string | null,
    leakSinceMs: number | null,
  ): void {
    const fromMs = cursorMs;
    stopInstances([...active], kind === "reset" ? "reset" : "jump", fromMs);
    pending = [];
    resolveActiveTickets(fromMs);
    history.begin(targetMs, leakSinceMs);
    simClockMs = targetMs;
    nextSampleMs = targetMs;
    cursorMs = targetMs;
    pendingDiscontinuity = true;
    const marker: OverlayMarker = {
      schema: "urn:fdp:schema:gt-marker:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      kind,
      ...(presetId === null ? {} : { preset_id: presetId }),
      sim_ts_from: isoOf(fromMs),
      sim_ts_to: isoOf(targetMs),
    };
    store.addMarker(marker);
    emit("overlay.marker", marker);
  }

  // --- commands ------------------------------------------------------------------------------

  function acknowledge(
    cmd: SimCommandName,
    error: ControlError | null,
    instanceId?: string,
  ): Reply<ApiSimCommandResult> {
    const ack: ControlAck = {
      schema: "urn:fdp:schema:control-ack:v1",
      unit_id: unitId,
      wall_ts: wallIso(),
      cmd_id: ids.uuid(),
      cmd,
      ok: error === null,
      error,
      status: statusSim(),
      ...(instanceId === undefined ? {} : { instance_id: instanceId }),
    };
    return { status: 202, body: { cmd_id: ack.cmd_id, accepted: true, ack } };
  }

  function refuse(
    cmd: SimCommandName,
    code: ControlError["code"],
    message: string,
  ): Reply<ApiSimCommandResult> {
    return acknowledge(cmd, { code, message });
  }

  function jump(args: Record<string, unknown>): Reply<ApiSimCommandResult> {
    let targetMs: number;
    let presetId: string | null = null;
    if (typeof args.preset_id === "string") {
      const preset = findPreset(args.preset_id);
      if (preset === undefined) {
        return refuse(
          "jump",
          "unknown_preset",
          `There is no preset ${args.preset_id} in the catalog.`,
        );
      }
      presetId = preset.preset_id;
      targetMs = Date.parse(preset.sim_ts) - preset.lead_in_min * 60_000;
    } else {
      targetMs = Date.parse(String(args.sim_ts));
    }
    targetMs = Math.floor(targetMs / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
    if (targetMs < FIRST_MS || targetMs > LAST_MS) {
      return refuse("jump", "out_of_range", "That instant lies outside the replayed rows.");
    }
    const leak = presetId === F3_PRESET_ID;
    discontinuity("jump", targetMs, presetId, leak ? targetMs : null);
    const script = presetId === null ? undefined : PRESET_SCRIPTS[presetId];
    if (script !== undefined) {
      schedule(script, targetMs, null);
    }
    announceSim();
    return acknowledge("jump", null);
  }

  function inject(args: InjectArgs): Reply<ApiSimCommandResult> {
    const definition = findInjection(args.injection_id);
    if (definition === undefined) {
      return refuse("inject", "unknown_injection", `There is no injection ${args.injection_id}.`);
    }
    const bounds = definition.params.find((param) => param.name === "magnitude");
    const magnitude = args.params?.magnitude ?? bounds?.default ?? 1;
    if (bounds !== undefined && (magnitude < bounds.min || magnitude > bounds.max)) {
      return refuse(
        "inject",
        "bad_args",
        `The magnitude must lie between ${bounds.min} and ${bounds.max}.`,
      );
    }
    const durationMin = args.params?.duration_sim_min ?? definition.default_duration_sim_min;
    instances += 1;
    const instance: RunningInstance = {
      instance_id: `inj-${instances}`,
      injection_id: definition.injection_id,
      fault_id: definition.fault_id,
      started_sim_ts: isoOf(cursorMs),
      ends_sim_ts: isoOf(cursorMs + durationMin * 60_000),
      params: { magnitude, duration_sim_min: durationMin },
    };
    const effect: InjectionRun = {
      injectionId: definition.injection_id,
      startMs: cursorMs,
      endMs: Date.parse(instance.ends_sim_ts),
      magnitude,
    };
    effects.set(instance.instance_id, effect);
    history.current().injections.push(effect);
    active = [...active, instance];
    store.openInterval({
      unit_id: unitId,
      instance_id: instance.instance_id,
      injection_id: instance.injection_id,
      fault_id: instance.fault_id,
      start_sim_ts: instance.started_sim_ts,
      end_sim_ts: null,
      reason: null,
      params: { ...instance.params },
    });
    emit("overlay.injection", injectionEvent(instance, "start", cursorMs));
    emit("overlay.injection_active", overlayActive());
    const script = INJECTION_SCRIPTS[definition.injection_id];
    if (script !== undefined) {
      schedule(script, cursorMs, instance.instance_id);
    }
    return acknowledge("inject", null, instance.instance_id);
  }

  function apply(cmd: SimCommandName, args: Record<string, unknown>): Reply<ApiSimCommandResult> {
    switch (cmd) {
      case "play":
        if (state !== "playing") {
          state = "playing";
          lastWallMs = wall();
          announceSim();
        }
        return acknowledge(cmd, null);
      case "pause":
        stream = null;
        if (state === "playing") {
          state = "paused";
          announceSim();
        }
        return acknowledge(cmd, null);
      case "set_speed":
        speed = Number(args.speed);
        announceSim();
        return acknowledge(cmd, null);
      case "jump":
        return jump(args);
      case "inject":
        return inject(injectArgsOf(args));
      case "clear_injections":
        stopInstances([...active], "cleared", cursorMs);
        return acknowledge(cmd, null);
      case "reset":
        stream = null;
        discontinuity("reset", FIRST_MS, null, null);
        state = "stopped";
        announceSim();
        return acknowledge(cmd, null);
    }
  }

  function command(segment: string, body: unknown): Reply<ApiSimCommandResult> {
    const cmd = SEGMENT_COMMANDS[segment];
    if (cmd === undefined) {
      return { status: 404, body: apiError("not_found", `no route for POST /api/sim/${segment}`) };
    }
    const args =
      body === null || body === undefined ? {} : isRecord(body) ? (body.args ?? {}) : undefined;
    if (!isRecord(args)) {
      return {
        status: 400,
        body: apiError("bad_request", "the body must be { args: {…} }", { cmd }),
      };
    }
    const issue = argumentIssue(cmd, args);
    if (issue !== null) {
      return { status: 400, body: apiError("bad_request", issue, { cmd, issues: [issue] }) };
    }
    return apply(cmd, args);
  }

  // --- tickets -------------------------------------------------------------------------------

  function closeTicket(ticketId: string, body: unknown): Reply<Ticket> {
    const verdict = closeBodyOf(body);
    if (verdict === null) {
      return {
        status: 400,
        body: apiError(
          "bad_request",
          "the body is not an api-ticket-close { verdict, note?, closed_by? }",
        ),
      };
    }
    const ticket = store.ticket(ticketId);
    if (ticket === undefined) {
      return { status: 404, body: apiError("not_found", `no ticket with id ${ticketId}`) };
    }
    if (ticket.status === "closed") {
      return {
        status: 409,
        body: apiError("conflict", `ticket ${ticketId} already has a verdict`),
      };
    }
    const nowIso = wallIso();
    const atIso = isoOf(cursorMs);
    const closed: Ticket = {
      ...ticket,
      wall_ts: nowIso,
      action: "closed",
      status: "closed",
      updated_sim_ts: atIso,
      resolved_sim_ts: ticket.resolved_sim_ts ?? atIso,
      close_reason: "technician",
      closure: { ...verdict, wall_ts: nowIso },
    };
    store.putTicket(closed);
    const episode = store.episode(ticket.episode_id);
    if (episode !== undefined && episode.status === "open") {
      store.putEpisode({
        ...episode,
        status: "closed",
        closed_sim_ts: atIso,
        close_reason: "technician",
      });
    }
    emit("ticket", closed);
    emit("status.backend", statusBackend());
    return { status: 200, body: closed };
  }

  // --- test control --------------------------------------------------------------------------

  function startStream(samplesPerS: number, seconds: number): void {
    stream = {
      samplesPerS,
      untilWallMs: wall() + seconds * 1000,
      resume: stream?.resume ?? state,
    };
    if (state !== "playing") {
      state = "playing";
      lastWallMs = wall();
    }
    announceSim();
  }

  function ingest(frame: ServerFrame): void {
    switch (frame.type) {
      case "event.suspect":
        store.addEvent(frame.payload);
        break;
      case "decision":
        store.addDecision(frame.payload);
        break;
      case "ticket":
        store.putTicket(frame.payload);
        break;
      case "alert.system":
        store.putAlert(frame.payload);
        break;
      default:
        break;
    }
  }

  // --- reads ---------------------------------------------------------------------------------

  function status(): ApiStatus {
    return {
      sim: statusSim(),
      gateway: statusGateway(),
      backend: statusBackend(),
      alerts_active: store.alerts(true),
      injections_active: [...active],
      gate: { ...GATE },
    };
  }

  function health(): ApiHealth {
    return {
      status: "ok",
      wall_ts: wallIso(),
      version: FAKE_VERSION,
      backend: { name: backend, model: MODELS[backend] },
      mqtt: { diag: "ok", ops: "ok" },
      db: { app: "ok", gt: "ok" },
      heartbeats: {
        telemetry: lastSample === null ? "unknown" : "ok",
        decision_api: decisionsTotal === 0 ? "unknown" : "ok",
      },
      sim: { state, speed, sim_ts: isoOf(cursorMs) },
      counters: { samples: headSeq, decisions: decisionsTotal },
      uptime_s: Math.floor((wall() - startedWallMs) / 1000),
    };
  }

  function hello(): HelloPayload {
    return {
      server_version: FAKE_VERSION,
      schema_major: 1,
      decision_backend: backend,
      model: MODELS[backend],
      unit_id: unitId,
    };
  }

  function snapshot(): SnapshotPayload {
    return {
      status: { sim: statusSim(), gateway: statusGateway(), backend: statusBackend() },
      latest_sample: lastSample,
      episodes: store.openEpisodes(),
      tickets: store.activeTickets(),
      decisions: store.recentDecisions(50),
      system_alerts: store.alerts(true),
      overlay: { catalog: OVERLAY_CATALOG, active: overlayActive() },
    };
  }

  function series(query: SeriesQuery): ApiTelemetrySeries {
    const answer = history.series(query);
    return {
      unit_id: unitId,
      from: isoOf(query.fromMs),
      to: isoOf(query.toMs),
      source: "ring",
      series: answer.series,
      discontinuities: answer.discontinuities,
    };
  }

  return {
    backend,
    records: store,
    tick,
    command,
    closeTicket,
    stream: startStream,
    ingest,
    status,
    health,
    hello,
    snapshot,
    lastSampleSimTs: () => lastSample?.sim_ts ?? null,
    series,
    overlayActive,
  };
}
