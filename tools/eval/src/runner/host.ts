// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The in-process pipeline host: one bound scenario, one backend, one run.
//
// The host is the evaluation's stand-in for the runtime, and it is deliberately
// thin. It composes `createPipeline` from `@fdp/backend/pipeline` with the
// pipeline's own catalog retriever and the handle's decision backend, replays
// the scenario through the replay engine (the slice or the full CSV, the
// synthetic ambient lane, the injections, the CTRL-7 alarm port), pushes every
// `telemetry-samples` batch in order and awaits it, and writes down everything
// the pipeline says. It never decides, detects or gates anything itself.
//
// Four properties are the point of it.
//
// **Only telemetry crosses the boundary**, so the ground truth stays isolated
// from the diagnosis (docs/architecture.md#ground-truth-isolation). The
// pipeline is handed its ports — a wall clock, a retriever over the catalog,
// the decision backend, the register map and the prices — and
// `telemetry-samples` batches, exactly what the gateway would publish. The
// ground truth this module reads (the injection definitions) goes to the replay
// engine, which overlays the injections on the rows before they become samples;
// no label, window or id of it reaches a port.
//
// **Wall time is fake.** A `FakeWallClock` starts at a fixed instant and
// advances 1 ms per pushed batch, so every `wall_ts` and every latency is a
// function of the replay and two runs of the same scenario are identical.
// Nothing in the pipeline paces on wall time; sim time comes from the rows.
//
// **Every output is kept with its sim time.** Each `PipelineOutput` is
// recorded with the `sim_ts` of the last sample of the batch that produced it,
// and the controller's alarm transitions are kept twice over: every raise (the
// activations the lead-time metric reads) and the first raise of each code.
//
// **Episodes are never forced shut.** When the replay ends, the host stops. An
// episode closes by silence only when pushed samples say so; pushing a
// fabricated sample with a jumped `sim_ts` would abort the episodes on a
// discontinuity instead, which is not what happened. What is still open is
// scored as it stands, and the recorder lists it as open at the end.

import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { DEFAULT_UNIT_ID, REGISTER_MAP, SIGNALS } from "@fdp/contracts";
import type { TelemetrySamples } from "@fdp/contracts";
import { loadInjections } from "@fdp/ground-truth";
import { createCatalogRetriever, createPipeline } from "@fdp/backend/pipeline";
import type {
  AlarmTransition,
  Pipeline,
  PipelineConfig,
  PipelineOutput,
  PipelinePorts,
  Prices as MessagePrices,
  WallClock,
} from "@fdp/backend/pipeline";

import type { BackendHandle, BackendMode } from "../backends/types.ts";
import { gateFor } from "../config.ts";
import type { BackendName, EvalCatalog, EvalConfig } from "../config.ts";
import type { AlarmActivation, Prices } from "../metrics/types.ts";
import { createReplaySource } from "../replay/index.ts";
import type { AlarmRegistry, InjectionDef, ReplayRunOptions } from "../replay/index.ts";
import type { BoundScenario } from "../scenario/index.ts";
import { requireSlice } from "../slices.ts";

/** The instant every fake wall clock starts at, so `wall_ts` never depends on the machine. */
export const FAKE_WALL_START = "2026-01-01T00:00:00.000Z";

/** How far the fake wall clock moves per pushed batch. */
export const WALL_STEP_MS = 1;

/** A wall clock that moves only when the host says so. */
export interface FakeWallClock extends WallClock {
  /** Moves the clock forward and returns the new instant. */
  advance(ms: number): Date;
}

/**
 * A fake wall clock at `start`.
 *
 * @throws TypeError when `start` names no instant, or when `advance` is asked to go backwards.
 */
export function createFakeWallClock(start: Date | string = FAKE_WALL_START): FakeWallClock {
  let currentMs = typeof start === "string" ? Date.parse(start) : start.getTime();
  if (Number.isNaN(currentMs)) {
    throw new TypeError(`createFakeWallClock: ${String(start)} is not an instant`);
  }
  return {
    now: () => new Date(currentMs),
    advance(ms: number): Date {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new TypeError(`createFakeWallClock: cannot advance by ${ms} ms`);
      }
      currentMs += ms;
      return new Date(currentMs);
    },
  };
}

/** One pipeline output, stamped with the `sim_ts` of the last sample of its batch. */
export type TimedOutput = PipelineOutput & { readonly batchSimTs: string };

/** The configuration the host reads; everything else in `EvalConfig` belongs to the loop. */
export type HostConfig = Pick<
  EvalConfig,
  | "gate"
  | "jevGate"
  | "decisionIntervalSimMin"
  | "episodeClearSimMin"
  | "persistSimMin"
  | "rulesDisabled"
  | "csvPath"
  | "seed"
  | "prices"
>;

/** The catalog the host reads: the entries the retriever ranks and the conditions it queries by. */
export type HostCatalog = Pick<EvalCatalog, "entries" | "conditions">;

/** What one run counted, beside what it recorded. */
export interface ScenarioRunStats {
  readonly samples: number;
  readonly batches: number;
  /** Samples flagged `discontinuity`, the first one included. */
  readonly discontinuities: number;
  /** Real elapsed time of the replay, for the throughput line of the log. */
  readonly wallMs: number;
  /** Samples per real second; `null` when the run took no measurable time. */
  readonly samplesPerS: number | null;
  /** Decision outputs, answered or failed. */
  readonly decisions: number;
  /** Decision outputs whose call failed (`status: failed`). */
  readonly failures: number;
}

/** Everything one scenario, replayed against one backend, produced. */
export interface ScenarioRun {
  readonly scenarioId: string;
  readonly backend: BackendName;
  readonly model: string;
  readonly mode: BackendMode;
  /** `--seed` when given, else the scenario's own; recorded for the report. */
  readonly seed: number;
  /** Every pipeline output, in the order the pipeline emitted it. */
  readonly events: readonly TimedOutput[];
  /** Every raise of a controller alarm, in order: what `scoreScenario` reads. */
  readonly alarms: readonly AlarmActivation[];
  /** The first raise of each code, in the order the codes first appeared. */
  readonly firstAlarms: readonly AlarmActivation[];
  /** Every raise and clear, as ingest reported them. */
  readonly alarmTransitions: readonly AlarmTransition[];
  readonly stats: ScenarioRunStats;
}

/** How a caller, usually a test, may reach into a run. */
export interface HostOptions {
  /** The run's wall clock; a fresh one at `FAKE_WALL_START` by default. */
  readonly wall?: FakeWallClock;
  /** The injection catalog; `loadInjections()` of `@fdp/ground-truth` by default. */
  readonly injectionDefs?: readonly InjectionDef[];
  /** The CTRL-7 port: on (the default), off, or a registry to compile instead. */
  readonly alarms?: boolean | AlarmRegistry;
  /** The pipeline factory; the backend's `createPipeline` by default. */
  readonly createPipeline?: (ports: PipelinePorts, cfg: Partial<PipelineConfig>) => Pipeline;
  /** A monotonic millisecond timer for `stats.wallMs`; `performance.now` by default. */
  readonly elapsedMs?: () => number;
  /**
   * Called after every pushed batch with the sim time it reached and its sample count; the full
   * profile's month progress listens here (`src/runner/full.ts`). It observes, never alters.
   */
  readonly onBatch?: (progress: { readonly simTs: string; readonly samples: number }) => void;
}

/** Thrown when `source.kind = csv` and `METROPT_CSV` names no file. */
export class MissingCsvError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `METROPT_CSV: ${path} does not exist; point it at the MetroPT-3 CSV (\`make fetch-dataset\`)`,
    );
    this.name = "MissingCsvError";
    this.path = path;
  }
}

/**
 * The prices the decision message's `cost` block is computed at.
 *
 * Jev bills input tokens only, the LLM both, and the rules backend nothing.
 */
export function messagePrices(backend: BackendName, prices: Prices): MessagePrices {
  switch (backend) {
    case "jev":
      return {
        price_input_per_mtok: prices.jevInputPerMtok,
        price_output_per_mtok: 0,
        prices_as_of: prices.asOf,
      };
    case "llm":
      return {
        price_input_per_mtok: prices.llmInputPerMtok,
        price_output_per_mtok: prices.llmOutputPerMtok,
        prices_as_of: prices.asOf,
      };
    case "rules":
      return { price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: prices.asOf };
  }
}

/**
 * The ports the pipeline is composed over, and nothing else.
 *
 * The retriever gets the catalog's conditions beside its entries, so the query it builds carries
 * each condition's symptom sentences as production's does from `app.catalog_conditions`.
 *
 * Exported so a test can serialise them and prove no ground truth is among them.
 */
export function buildPipelinePorts(
  handle: Pick<BackendHandle, "name" | "backend">,
  catalog: HostCatalog,
  wall: WallClock,
  prices: Prices,
): PipelinePorts {
  return {
    wall,
    retriever: createCatalogRetriever(catalog.entries, { conditions: catalog.conditions }),
    decision: handle.backend,
    signals: SIGNALS,
    prices: messagePrices(handle.name, prices),
  };
}

/**
 * The pipeline configuration, from the run's configuration, for one backend: the gate gets that
 * backend's pair, Jev's own or `GATE_*`, as the runtime's `pipelineConfig` gives it to the
 * backend it runs.
 */
export function buildPipelineConfig(cfg: HostConfig, backend: BackendName): PipelineConfig {
  const gate = gateFor(cfg, backend);
  return {
    gate: { ticketMin: gate.ticketMin, reviewMin: gate.reviewMin },
    decisionIntervalSimMin: cfg.decisionIntervalSimMin,
    episodeClearSimMin: cfg.episodeClearSimMin,
    persistSimMin: cfg.persistSimMin,
    rulesDisabled: [...cfg.rulesDisabled],
    unitId: DEFAULT_UNIT_ID,
  };
}

/** The file a bound scenario replays: its cut slice, or the full CSV. */
function sourcePath(bound: BoundScenario, csvPath: string): string {
  if (bound.source.kind === "slice") return requireSlice(bound.source.name);
  if (!existsSync(csvPath)) throw new MissingCsvError(csvPath);
  return csvPath;
}

/** The injection catalog, read only when the scenario schedules an injection. */
function injectionDefsFor(bound: BoundScenario, options: HostOptions): readonly InjectionDef[] {
  if (bound.injections.length === 0) return [];
  return options.injectionDefs ?? loadInjections()?.injections ?? [];
}

/**
 * The replay for one bound scenario, stamping `wall_ts` from the run's clock.
 *
 * `ambient` is on for every scenario, recordings included, and not only when the scenario
 * schedules an injection: the simulator writes `ambient(t)` into the ambient slot of every
 * sample and the runtime always receives it, so a replay that left the lane at 0 °C would score
 * a path production never runs.
 */
function replayOptions(
  bound: BoundScenario,
  cfg: HostConfig,
  wall: WallClock,
  options: HostOptions,
): ReplayRunOptions {
  return {
    source: sourcePath(bound, cfg.csvPath),
    map: REGISTER_MAP,
    from: bound.replay.from,
    to: bound.replay.to,
    unitId: DEFAULT_UNIT_ID,
    wall: () => wall.now(),
    injections: bound.injections.map((injection) => ({
      injection_id: injection.injection_id,
      atSimTsMs: injection.at.getTime(),
      params: injection.params,
    })),
    injectionDefs: injectionDefsFor(bound, options),
    ambient: true,
    alarms: options.alarms ?? true,
  };
}

/** The `sim_ts` of the last sample of a batch; the schema guarantees there is one. */
function lastSimTs(batch: TelemetrySamples): string {
  const last = batch.samples[batch.samples.length - 1];
  if (last === undefined) throw new Error("a telemetry-samples batch carried no sample");
  return last.sim_ts;
}

/** What the host writes down while the replay runs. */
interface EventLog {
  readonly events: TimedOutput[];
  readonly alarms: AlarmActivation[];
  readonly firstAlarms: AlarmActivation[];
  /** The codes `firstAlarms` already holds. */
  readonly raisedCodes: Set<string>;
  readonly transitions: AlarmTransition[];
  decisions: number;
  failures: number;
}

function record(log: EventLog, outputs: readonly PipelineOutput[], batchSimTs: string): void {
  for (const output of outputs) {
    log.events.push({ ...output, batchSimTs });
    if (output.type === "decision") {
      log.decisions += 1;
      if (output.decision.status === "failed") log.failures += 1;
    }
    if (output.type !== "alarm") continue;

    const { transition } = output;
    log.transitions.push(transition);
    if (transition.state !== "raised") continue;
    const activation: AlarmActivation = {
      code: transition.code,
      simTs: new Date(transition.sim_ts),
    };
    log.alarms.push(activation);
    if (!log.raisedCodes.has(transition.code)) {
      log.raisedCodes.add(transition.code);
      log.firstAlarms.push(activation);
    }
  }
}

/**
 * Replays one bound scenario through a fresh pipeline driven by one backend.
 *
 * @param bound the scenario with its ground truth resolved; only its replay range,
 * source and injections reach the replay engine, and none of it reaches the pipeline.
 * @param handle the backend to decide with; it is not closed here, because the loop reuses it.
 * @param cfg the gate, the episode timings, the rules left out, the CSV path, the seed and the
 * prices.
 * @param catalog the fault catalog the retriever ranks, with its conditions.
 * @throws MissingSliceError or MissingCsvError when the rows are not on this machine, and
 * whatever the pipeline rejects a push with, which is a fault of the host rather than of the
 * machine.
 */
export async function runScenario(
  bound: BoundScenario,
  handle: BackendHandle,
  cfg: HostConfig,
  catalog: HostCatalog,
  options: HostOptions = {},
): Promise<ScenarioRun> {
  const wall = options.wall ?? createFakeWallClock();
  const compose = options.createPipeline ?? createPipeline;
  const elapsedMs = options.elapsedMs ?? (() => performance.now());

  const pipeline = compose(
    buildPipelinePorts(handle, catalog, wall, cfg.prices),
    buildPipelineConfig(cfg, handle.name),
  );
  const source = createReplaySource(replayOptions(bound, cfg, wall, options));
  const log: EventLog = {
    events: [],
    alarms: [],
    firstAlarms: [],
    raisedCodes: new Set<string>(),
    transitions: [],
    decisions: 0,
    failures: 0,
  };

  const started = elapsedMs();
  for await (const batch of source) {
    const outputs = await pipeline.push(batch);
    const simTs = lastSimTs(batch);
    record(log, outputs, simTs);
    wall.advance(WALL_STEP_MS);
    options.onBatch?.({ simTs, samples: batch.samples.length });
  }
  const wallMs = elapsedMs() - started;

  const replayed = source.stats;
  return {
    scenarioId: bound.scenario.id,
    backend: handle.name,
    model: handle.model,
    mode: handle.mode,
    seed: cfg.seed ?? bound.scenario.seed,
    events: log.events,
    alarms: log.alarms,
    firstAlarms: log.firstAlarms,
    alarmTransitions: log.transitions,
    stats: {
      samples: replayed.samples,
      batches: replayed.batches,
      discontinuities: replayed.discontinuities,
      wallMs,
      samplesPerS: wallMs > 0 ? (replayed.samples * 1000) / wallMs : null,
      decisions: log.decisions,
      failures: log.failures,
    },
  };
}
