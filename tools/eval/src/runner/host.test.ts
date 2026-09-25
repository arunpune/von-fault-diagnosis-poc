// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The in-process host.
//
// The scenarios here are synthetic and written to a temporary CSV in the
// MetroPT-3 layout, so every test runs offline and without the dataset. The
// waveform is the first month's compressor cycle — the same numbers the
// backend's own synthetic fixtures use — followed, where a test needs the
// pipeline to decide, by a loaded run in which line pressure falls through the
// low-pressure switch (`low_pressure_switch`). No labelled failure window of
// the recording is encoded anywhere, so no test here tunes on one.
//
// The pipeline is always the real one. Where a test must see exactly what the
// host handed it, the factory is wrapped: the ports and every pushed batch are
// captured on their way in, and nothing else is changed.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_UNIT_ID, SIGNALS, validate } from "@fdp/contracts";
import type { CatalogEntry, Sample, SuspectEvent, TelemetrySamples } from "@fdp/contracts";
import { MOCK_MODEL } from "@fdp/contracts/mock";
import { loadInjections } from "@fdp/ground-truth";
import { DEFAULT_PIPELINE_CONFIG, createPipeline } from "@fdp/backend/pipeline";
import type {
  DecisionBackend,
  DecisionInput,
  DecisionOutput,
  PipelineConfig,
  PipelineOutput,
  PipelinePorts,
} from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import { createMockJevHandle, MOCK_API_KEY } from "../backends/mock.ts";
import { createRulesHandle } from "../backends/rules.ts";
import { counted, newStats } from "../backends/types.ts";
import type { BackendHandle } from "../backends/types.ts";
import { loadReferenceCatalog } from "../catalog/reference.ts";
import { loadConfig } from "../config.ts";
import { AMBIENT_TOLERANCE_C, ambient } from "../replay/ambient.ts";
import type { InjectionDef } from "../replay/index.ts";
import type { BoundScenario, InjectionSpec, Scenario } from "../scenario/index.ts";
import { METROPT3_HEADER, METROPT3_LINE_TERMINATOR } from "../slices.ts";
import {
  buildPipelineConfig,
  buildPipelinePorts,
  createFakeWallClock,
  FAKE_WALL_START,
  messagePrices,
  MissingCsvError,
  runScenario,
  WALL_STEP_MS,
} from "./host.ts";
import type { HostCatalog, HostConfig, ScenarioRun } from "./host.ts";

// ---------------------------------------------------------------------------
// A synthetic compressor, written as a MetroPT-3 CSV
// ---------------------------------------------------------------------------

const SAMPLE_PERIOD_S = 10;
const CUT_IN_BAR = 8.05;
const CUT_OUT_BAR = 10.03;
const RUN_ON_S = 407;
const LOADED_RUN_S = 110;
const DECAY_BAR_PER_MIN = 0.069;
const LPS_CLOSE_BAR = 6.95;
const LPS_OPEN_BAR = 7.74;

type Mode = "loaded" | "unloaded" | "off";

interface Phase {
  readonly mode: Mode;
  readonly seconds: number;
  readonly fromBar: number;
  /** Loaded phases move linearly to this pressure; the others decay. */
  readonly toBar?: number;
}

/** One normal cycle of the first month: load to cut-out, run on, stop, decay to cut-in. */
function normalCycle(): Phase[] {
  const nonLoadedS = Math.round(((CUT_OUT_BAR - CUT_IN_BAR) / DECAY_BAR_PER_MIN) * 6) * 10;
  const afterRunOn = CUT_OUT_BAR - (DECAY_BAR_PER_MIN * RUN_ON_S) / 60;
  return [
    { mode: "loaded", seconds: LOADED_RUN_S, fromBar: CUT_IN_BAR, toBar: CUT_OUT_BAR },
    { mode: "unloaded", seconds: 410, fromBar: CUT_OUT_BAR },
    { mode: "off", seconds: nonLoadedS - 410, fromBar: afterRunOn },
  ];
}

function normalCycles(count: number): Phase[] {
  return Array.from({ length: count }, normalCycle).flat();
}

/** Demand beats supply: loaded, and line pressure falls through the switch. */
const PRESSURE_LOSS: readonly Phase[] = [
  { mode: "loaded", seconds: 240, fromBar: CUT_IN_BAR, toBar: 6.85 },
  { mode: "loaded", seconds: 300, fromBar: 6.85, toBar: 6.4 },
];

function pressureAt(phase: Phase, offsetS: number): number {
  if (phase.toBar !== undefined) {
    return phase.fromBar + ((phase.toBar - phase.fromBar) * offsetS) / phase.seconds;
  }
  return phase.fromBar - (DECAY_BAR_PER_MIN * offsetS) / 60;
}

function tagValues(
  mode: Mode,
  line: number,
  sinceCutInS: number,
  lps: boolean,
): Record<string, number | boolean> {
  const loaded = mode === "loaded";
  const towerPulse = loaded && sinceCutInS >= 10 && sinceCutInS < 70;
  return {
    discharge_pressure: loaded ? line + 0.32 : -0.012,
    line_pressure: line,
    separator_discharge_pressure: loaded ? -0.014 : line,
    dryer_purge_pressure: -0.018,
    reservoir_pressure: line - 0.002,
    oil_temperature: 56.6,
    motor_current: loaded ? 6 : mode === "unloaded" ? 3.77 : 0.038,
    intake_closed: !loaded,
    load_valve: loaded,
    dryer_tower: !towerPulse,
    regulator_contact: !loaded,
    low_pressure_switch: lps,
    purge_switch: true,
    oil_level_ok: true,
    flow_pulse: true,
  };
}

/** The CSV columns in header order, each with the register-map tag it is replayed into. */
const COLUMNS: readonly { column: string; tag: string }[] = METROPT3_HEADER.split(",")
  .slice(2)
  .map((column) => {
    const signal = SIGNALS.find((candidate) => candidate.metropt_column === column);
    if (signal === undefined) throw new Error(`no register-map signal replays ${column}`);
    return { column, tag: signal.tag };
  });

function csvTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** The phases as MetroPT-3 CSV text, one row every ten seconds from `start`. */
function syntheticCsv(phases: readonly Phase[], start: string): string {
  const startMs = Date.parse(start);
  const lines = [METROPT3_HEADER];
  let elapsedS = 0;
  let sinceCutInS = 0;
  let lps = false;
  for (const phase of phases) {
    if (phase.mode === "loaded") sinceCutInS = 0;
    for (let offsetS = 0; offsetS < phase.seconds; offsetS += SAMPLE_PERIOD_S) {
      const line = pressureAt(phase, offsetS);
      lps = lps ? line < LPS_OPEN_BAR : line <= LPS_CLOSE_BAR;
      const values = tagValues(phase.mode, line, sinceCutInS + offsetS, lps);
      const cells = COLUMNS.map(({ tag }) => {
        const value = values[tag];
        if (value === undefined) throw new Error(`the synthetic waveform has no ${tag}`);
        return typeof value === "boolean" ? (value ? "1.0" : "0.0") : value.toFixed(3);
      });
      lines.push(
        [String(lines.length - 1), csvTs(startMs + (elapsedS + offsetS) * 1000), ...cells].join(
          ",",
        ),
      );
    }
    if (phase.mode !== "loaded") sinceCutInS += phase.seconds;
    elapsedS += phase.seconds;
  }
  return lines.join(METROPT3_LINE_TERMINATOR) + METROPT3_LINE_TERMINATOR;
}

function durationS(phases: readonly Phase[]): number {
  return phases.reduce((total, phase) => total + phase.seconds, 0);
}

// ---------------------------------------------------------------------------
// Scenarios, configuration and a stub backend
// ---------------------------------------------------------------------------

const START = "2020-02-03T00:00:00.000Z";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function writeCsv(phases: readonly Phase[]): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-host-"));
  temporary.push(directory);
  const path = join(directory, "synthetic.csv");
  writeFileSync(path, syntheticCsv(phases, START), "utf8");
  return path;
}

/** A bound negative scenario over the whole synthetic file, optionally with injections. */
function boundScenario(
  phases: readonly Phase[],
  injections: readonly InjectionSpec[] = [],
): BoundScenario {
  const from = new Date(START);
  const to = new Date(from.getTime() + durationS(phases) * 1000);
  const scenario: Scenario = {
    schema: "urn:fdp:eval:scenario:v1",
    id: "synthetic_pressure_loss",
    title: "Synthetic pressure loss",
    group: "negative",
    profiles: ["core"],
    split: "dev",
    positive: false,
    source: { kind: "csv" },
    replay: { from: from.toISOString(), to: to.toISOString() },
    ground_truth: { kind: "negative" },
    expect: { tickets: "none", fault: "any", max_false_tickets: 0, pass_level: "detection" },
    warmup_min: 0,
    seed: 7,
    notes: "",
  };
  return {
    scenario,
    profile: "core",
    replay: { from, to },
    windows: [],
    excluded: [],
    benignFaultIds: new Set(),
    injections,
    source: { kind: "csv" },
  };
}

function hostConfig(csvPath: string, argv: readonly string[] = []): HostConfig {
  return loadConfig(argv, { METROPT_CSV: csvPath }, { cwd: "/tmp" });
}

const REFERENCE = loadReferenceCatalog();

/** The reference catalog as the host reads it: its entries and its conditions. */
const CATALOG: HostCatalog = { entries: REFERENCE.entries, conditions: REFERENCE.conditionTable };

/** The confidence the stub answers with; above the ticket threshold. */
const STUB_CONFIDENCE = 0.9;

/**
 * A backend that always names the first candidate retrieval offered, at a fixed confidence.
 *
 * It answers with a fixed shape rather than a fixed fault, because the decision message only
 * validates a choice that is among the candidates.
 */
function stubBackend(): DecisionBackend {
  return {
    name: "rules",
    model: "stub-1",
    decide(input: DecisionInput): Promise<DecisionOutput> {
      const first = input.candidates[0];
      if (first === undefined) throw new Error("retrieval offered no candidate");
      const rest = 1 - STUB_CONFIDENCE;
      return Promise.resolve({
        backend: "rules",
        model: "stub-1",
        choice: first.fault_id,
        probabilities: { [first.fault_id]: STUB_CONFIDENCE, none_of_these: rest },
        confidence: STUB_CONFIDENCE,
        support: Object.fromEntries(input.candidates.map((candidate) => [candidate.fault_id, 0.5])),
        severity: { level: "high", score: 2, probabilities: { "2": 1 }, confidence: 1 },
        usage: { input_tokens: 0, output_tokens: 0 },
        latency_ms: 0,
        state: {},
        state_digest: "0".repeat(64),
        raw: {},
      });
    },
  };
}

function stubHandle(): BackendHandle {
  const stats = newStats();
  return {
    name: "rules",
    model: "stub-1",
    mode: "-",
    backend: counted(stubBackend(), stats),
    stats,
    close: () => Promise.resolve(),
  };
}

/** Everything the host handed the pipeline: its ports, its configuration, every batch and every answer. */
interface Capture {
  ports?: PipelinePorts;
  config?: Partial<PipelineConfig>;
  readonly batches: TelemetrySamples[];
  readonly pushes: PipelineOutput[][];
}

function capturingFactory(capture: Capture) {
  return (ports: PipelinePorts, config: Partial<PipelineConfig>) => {
    capture.ports = ports;
    capture.config = config;
    const pipeline = createPipeline(ports, config);
    return {
      ...pipeline,
      push: async (batch: TelemetrySamples) => {
        capture.batches.push(batch);
        const outputs = await pipeline.push(batch);
        capture.pushes.push(outputs);
        return outputs;
      },
    };
  };
}

function newCapture(): Capture {
  return { batches: [], pushes: [] };
}

/** The strings no ground truth may leave behind in what the pipeline sees. */
const GROUND_TRUTH_MARKERS = ["failure_id", "injection_id", "preset_id", "gt/"];

/** The synthetic extra tag the replay writes ambient(t) into. */
const AMBIENT_TAG = "ambient_temperature";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFakeWallClock", () => {
  it("starts at a fixed instant and moves only when told", () => {
    const wall = createFakeWallClock();
    expect(wall.now().toISOString()).toBe(FAKE_WALL_START);
    expect(wall.now().toISOString()).toBe(FAKE_WALL_START);
    expect(wall.advance(5).toISOString()).toBe("2026-01-01T00:00:00.005Z");
    expect(wall.now().toISOString()).toBe("2026-01-01T00:00:00.005Z");
  });

  it("refuses a start that is no instant and a step backwards", () => {
    expect(() => createFakeWallClock("not a time")).toThrow(TypeError);
    expect(() => createFakeWallClock().advance(-1)).toThrow(TypeError);
  });
});

describe("the pipeline's configuration and ports", () => {
  const cfg = hostConfig("/unused.csv");

  it("carries the gate, the episode timings, the persistence and the rules left out", () => {
    expect(buildPipelineConfig(cfg, "rules")).toEqual({
      gate: { ticketMin: 0.85, reviewMin: 0.6 },
      decisionIntervalSimMin: 30,
      episodeClearSimMin: 120,
      persistSimMin: 1,
      rulesDisabled: ["flow_pulses_missing"],
      unitId: DEFAULT_UNIT_ID,
    });
  });

  it("runs the pipeline exactly as the backend configures it by default", () => {
    // The runtime's own parity is apps/backend's `pipelineConfig` test; both meet at the
    // pipeline's defaults for rules and llm, and at the pre-registered choice for Jev
    // (review 0.65, ticket 0.85), so a run and the service apply one rule.
    for (const backend of ["rules", "llm"] as const) {
      expect(buildPipelineConfig(cfg, backend)).toEqual(DEFAULT_PIPELINE_CONFIG);
    }
    expect(buildPipelineConfig(cfg, "jev")).toEqual({
      ...DEFAULT_PIPELINE_CONFIG,
      gate: { ticketMin: 0.85, reviewMin: 0.65 },
    });
  });

  it("hands the pipeline GATE_PERSIST_SIM_MIN from the environment", () => {
    const tuned = loadConfig([], { METROPT_CSV: "/unused.csv", GATE_PERSIST_SIM_MIN: "5" });
    expect(buildPipelineConfig(tuned, "rules").persistSimMin).toBe(5);
    const off = loadConfig([], { METROPT_CSV: "/unused.csv", GATE_PERSIST_SIM_MIN: "0" });
    expect(buildPipelineConfig(off, "jev").persistSimMin).toBe(0);
  });

  it("gates Jev with JEV_GATE_* and the other backends with GATE_*", () => {
    // The runtime's own side is apps/backend's pipelineConfig test: one rule for both hosts.
    const own = loadConfig([], {
      METROPT_CSV: "/unused.csv",
      JEV_GATE_TICKET_MIN_CONFIDENCE: "0.9",
      JEV_GATE_REVIEW_MIN_CONFIDENCE: "0.7",
    });
    expect(buildPipelineConfig(own, "jev").gate).toEqual({ ticketMin: 0.9, reviewMin: 0.7 });
    expect(buildPipelineConfig(own, "rules").gate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
    expect(buildPipelineConfig(own, "llm").gate).toEqual({ ticketMin: 0.85, reviewMin: 0.6 });
  });

  it("bills each backend at its own prices", () => {
    expect(messagePrices("jev", cfg.prices)).toEqual({
      price_input_per_mtok: 0.042,
      price_output_per_mtok: 0,
      prices_as_of: "2026-09-19",
    });
    expect(messagePrices("llm", cfg.prices)).toEqual({
      price_input_per_mtok: 5,
      price_output_per_mtok: 25,
      prices_as_of: "2026-09-19",
    });
    expect(messagePrices("rules", cfg.prices)).toEqual({
      price_input_per_mtok: 0,
      price_output_per_mtok: 0,
      prices_as_of: "2026-09-19",
    });
  });

  it("hands over the register map, the clock, the retriever and the backend, and no ground truth", () => {
    const wall = createFakeWallClock();
    const ports = buildPipelinePorts(stubHandle(), CATALOG, wall, cfg.prices);
    expect(Object.keys(ports).sort()).toEqual([
      "decision",
      "prices",
      "retriever",
      "signals",
      "wall",
    ]);
    expect(ports.signals).toBe(SIGNALS);
    expect(ports.wall).toBe(wall);

    const serialised = JSON.stringify(ports);
    for (const marker of GROUND_TRUTH_MARKERS) expect(serialised).not.toContain(marker);
  });

  it("hands the retriever the catalog's conditions, whose symptoms reach the query", async () => {
    // One synthetic cause whose text shares three words with its condition's
    // symptom sentence and two with the condition's title, and an event keyed
    // on that condition whose only rule sentence shares nothing with it.
    const base = REFERENCE.entries[0];
    if (base === undefined) throw new Error("the reference catalog declares no cause");
    const cause: CatalogEntry = {
      ...base,
      fault_id: "synthetic_widget_seal",
      name: "Widget seal",
      summary: "The sealed widget sticks.",
      remedy: "",
      checks: [],
      signal_moves: [{ signal: "oil_temperature", direction: "rises" }],
      signal_moves_text: [],
      conditions: [
        {
          condition_id: "synthetic_condition",
          title: "Synthetic condition",
          likelihood: "unknown",
          alarms: [],
        },
      ],
    };
    const event: SuspectEvent = {
      schema: "urn:fdp:schema:suspect-event:v1",
      unit_id: DEFAULT_UNIT_ID,
      wall_ts: FAKE_WALL_START,
      event_id: "66666666-6666-4666-8666-666666666666",
      sim_ts: "2020-02-03T05:00:00.000Z",
      symptom_key: "synthetic_condition",
      rule_ids: ["oil_temperature_rising"],
      machine_state: { mode: "loaded", since_sim_ts: "2020-02-03T04:50:00.000Z" },
      window: { from_sim_ts: "2020-02-03T04:00:00.000Z", to_sim_ts: "2020-02-03T05:00:00.000Z" },
      evidence: [{ metric: "oil_temperature", observation: "Something happened." }],
      observations: [
        { signal: "oil_temperature", level: "normal", trend: "flat", since: "minutes" },
      ],
      active_alarms: [],
      co_symptoms: [],
      ambient: "mild",
    };
    const textScore = async (catalog: HostCatalog): Promise<number | undefined> => {
      const ports = buildPipelinePorts(stubHandle(), catalog, createFakeWallClock(), cfg.prices);
      const candidates = await ports.retriever.retrieve(event);
      return candidates.find((candidate) => candidate.fault_id === cause.fault_id)?.retrieval.text;
    };

    const condition = {
      condition_id: "synthetic_condition",
      title: "Synthetic condition",
      symptoms: ["A sealed widget sticks."],
    };
    // Without the table the query is the title and the rule sentence: two of
    // its four lexemes are the cause's. With it, five of seven are.
    expect(await textScore({ entries: [cause], conditions: [] })).toBeCloseTo(2 / 4, 12);
    expect(await textScore({ entries: [cause], conditions: [condition] })).toBeCloseTo(5 / 7, 12);
  });
});

describe("runScenario over a synthetic pressure loss", () => {
  const phases = [...normalCycles(2), ...PRESSURE_LOSS];
  const csvPath = writeCsv(phases);
  const capture = newCapture();
  const wall = createFakeWallClock();
  const handle = stubHandle();
  let ticks = 0;
  const run: Promise<ScenarioRun> = runScenario(
    boundScenario(phases),
    handle,
    hostConfig(csvPath),
    CATALOG,
    {
      wall,
      createPipeline: capturingFactory(capture),
      elapsedMs: () => (ticks += 250),
    },
  );

  it("replays every row of the file, in batches of at most 25", async () => {
    const { stats } = await run;
    const rows = durationS(phases) / SAMPLE_PERIOD_S;
    expect(stats.samples).toBe(rows);
    expect(stats.batches).toBe(Math.ceil(rows / 25));
    expect(capture.batches).toHaveLength(stats.batches);
    expect(stats.discontinuities).toBe(1);
  });

  it("hands the pipeline valid telemetry-samples batches carrying no ground truth", async () => {
    await run;
    for (const batch of capture.batches) {
      expect(validate("telemetry-samples", batch).ok).toBe(true);
      const text = JSON.stringify(batch);
      for (const marker of GROUND_TRUTH_MARKERS) expect(text).not.toContain(marker);
    }
    const ports = JSON.stringify(capture.ports);
    for (const marker of GROUND_TRUTH_MARKERS) expect(ports).not.toContain(marker);
    expect(capture.config).toEqual(buildPipelineConfig(hostConfig(csvPath), handle.name));
  });

  it("advances the fake wall clock one millisecond per batch", async () => {
    const { stats } = await run;
    expect(wall.now().getTime() - Date.parse(FAKE_WALL_START)).toBe(stats.batches * WALL_STEP_MS);
    capture.batches.forEach((batch, index) => {
      expect(Date.parse(batch.wall_ts) - Date.parse(FAKE_WALL_START)).toBe(index * WALL_STEP_MS);
    });
  });

  it("records every output, in order, with the sim_ts of its batch's last sample", async () => {
    const { events } = await run;
    const expected = capture.pushes.flatMap((outputs, index) => {
      const batch = capture.batches[index];
      const last = batch?.samples[batch.samples.length - 1];
      return outputs.map((output) => ({ ...output, batchSimTs: last?.sim_ts }));
    });
    expect(events).toEqual(expected);
    expect(events.length).toBeGreaterThan(0);
  });

  it("drives the pipeline to a decision and a ticket", async () => {
    const { events, stats } = await run;
    const types = new Set(events.map((event) => event.type));
    expect(types).toEqual(new Set(["alarm", "suspect", "decision", "episode", "ticket"]));
    expect(stats.decisions).toBe(events.filter((event) => event.type === "decision").length);
    expect(stats.decisions).toBeGreaterThan(0);
    expect(stats.failures).toBe(0);
    expect(handle.stats.calls).toBe(stats.decisions);

    for (const event of events) {
      if (event.type !== "suspect") continue;
      expect(Date.parse(event.event.sim_ts)).toBeLessThanOrEqual(Date.parse(event.batchSimTs));
    }
  });

  it("records every alarm raise, the first per code, and every transition", async () => {
    const { events, alarms, firstAlarms, alarmTransitions } = await run;
    const transitions = events.flatMap((event) =>
      event.type === "alarm" ? [event.transition] : [],
    );
    expect(alarmTransitions).toEqual(transitions);
    expect(alarms).toEqual(
      transitions
        .filter((transition) => transition.state === "raised")
        .map((transition) => ({ code: transition.code, simTs: new Date(transition.sim_ts) })),
    );
    expect(alarms.length).toBeGreaterThan(0);
    expect(firstAlarms.map((alarm) => alarm.code)).toEqual([
      ...new Set(alarms.map((alarm) => alarm.code)),
    ]);
    for (const first of firstAlarms) {
      expect(first).toEqual(alarms.find((alarm) => alarm.code === first.code));
    }
  });

  it("reports the run's identity, seed and throughput", async () => {
    const run_ = await run;
    expect(run_.scenarioId).toBe("synthetic_pressure_loss");
    expect(run_.backend).toBe("rules");
    expect(run_.model).toBe("stub-1");
    expect(run_.mode).toBe("-");
    expect(run_.seed).toBe(7);
    expect(run_.stats.wallMs).toBe(250);
    expect(run_.stats.samplesPerS).toBe((run_.stats.samples * 1000) / 250);
  });

  it("never pushes anything after the replay ends, so open episodes stay open", async () => {
    const { events } = await run;
    const lastSimTs = capture.batches.at(-1)?.samples.at(-1)?.sim_ts;
    expect(
      events.every((event) => Date.parse(event.batchSimTs) <= Date.parse(lastSimTs ?? "")),
    ).toBe(true);
    const closed = events.filter(
      (event) =>
        event.type === "episode" && (event.action === "closed" || event.action === "aborted"),
    );
    expect(closed).toEqual([]);
  });
});

describe("runScenario, determinism and options", () => {
  const phases = [...normalCycles(2), ...PRESSURE_LOSS];
  const csvPath = writeCsv(phases);

  it("produces the same events twice, ids aside", async () => {
    const strip = (run: ScenarioRun) =>
      JSON.stringify(run.events).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<id>",
      );
    const first = await runScenario(
      boundScenario(phases),
      stubHandle(),
      hostConfig(csvPath),
      CATALOG,
    );
    const second = await runScenario(
      boundScenario(phases),
      stubHandle(),
      hostConfig(csvPath),
      CATALOG,
    );
    expect(strip(second)).toBe(strip(first));
  });

  it("lets --seed override the scenario's own", async () => {
    const run = await runScenario(
      boundScenario(normalCycles(1)),
      stubHandle(),
      hostConfig(writeCsv(normalCycles(1)), ["--seed", "42"]),
      CATALOG,
      { alarms: false },
    );
    expect(run.seed).toBe(42);
    expect(run.alarms).toEqual([]);
  });

  it("names METROPT_CSV when the full CSV is not there", async () => {
    await expect(
      runScenario(boundScenario(phases), stubHandle(), hostConfig("/no/such/file.csv"), CATALOG),
    ).rejects.toThrow(MissingCsvError);
  });
});

describe("runScenario with an injection", () => {
  const phases = normalCycles(4);
  const csvPath = writeCsv(phases);
  const definitions = loadInjections()?.injections ?? [];
  const oilCooler = definitions.find((definition) =>
    definition.transforms.some((transform) => transform.tag === "oil_temperature"),
  );

  it.skipIf(oilCooler === undefined)(
    "overlays it on the rows and leaves no trace of it in what the pipeline sees",
    async () => {
      if (oilCooler === undefined) return;
      const at = new Date(Date.parse(START) + 20 * 60_000);
      const injection: InjectionSpec = {
        injection_id: oilCooler.injection_id,
        at,
        until: new Date(at.getTime() + 60 * 60_000),
        durationMin: 60,
        fault_id: oilCooler.fault_id,
        benign: oilCooler.benign,
        params: { magnitude: 1 },
      };
      const capture = newCapture();
      await runScenario(
        boundScenario(phases, [injection]),
        stubHandle(),
        hostConfig(csvPath),
        CATALOG,
        {
          createPipeline: capturingFactory(capture),
          injectionDefs: definitions,
        },
      );

      const oil = capture.batches
        .flatMap((batch) => batch.samples)
        .map((sample) => ({
          at: Date.parse(sample.sim_ts),
          value: sample.values["oil_temperature"],
        }));
      const before = oil.filter((sample) => sample.at < at.getTime()).map((sample) => sample.value);
      const after = oil.filter((sample) => sample.at >= at.getTime()).map((sample) => sample.value);
      expect(new Set(before)).toEqual(new Set([56.6]));
      expect(after.some((value) => value !== 56.6)).toBe(true);

      for (const batch of capture.batches) {
        const text = JSON.stringify(batch);
        for (const marker of [
          ...GROUND_TRUTH_MARKERS,
          oilCooler.injection_id,
          oilCooler.fault_id,
        ]) {
          expect(text).not.toContain(marker);
        }
      }
      const ports = JSON.stringify(capture.ports);
      for (const marker of [...GROUND_TRUTH_MARKERS, oilCooler.injection_id]) {
        expect(ports).not.toContain(marker);
      }
    },
  );
});

describe("runScenario and the synthetic ambient lane", () => {
  // The simulator writes ambient(t) into every sample and the runtime always
  // receives it, so every replay the host starts carries it too — a recording
  // as much as an injected scenario.
  // The synthetic file starts on 3 February at midnight, where the model reads
  // about 5.6 °C, so a lane left at 0 °C is far outside the tolerance.
  const phases = normalCycles(2);
  const csvPath = writeCsv(phases);
  const definitions = loadInjections()?.injections ?? [];
  const awayFromAmbient = definitions.find((definition) =>
    definition.transforms.every((transform) => transform.tag !== AMBIENT_TAG),
  );

  /** Every sample the host handed the pipeline while it replayed `bound`. */
  async function replayedSamples(
    bound: BoundScenario,
    injectionDefs: readonly InjectionDef[] = [],
  ): Promise<Sample[]> {
    const capture = newCapture();
    await runScenario(bound, stubHandle(), hostConfig(csvPath), CATALOG, {
      createPipeline: capturingFactory(capture),
      injectionDefs,
      alarms: false,
    });
    return capture.batches.flatMap((batch) => batch.samples);
  }

  /** The largest distance between a sample's ambient value and the model at its instant. */
  function worstAmbientError(samples: readonly Sample[]): number {
    return Math.max(
      ...samples.map((sample) => {
        const value = sample.values[AMBIENT_TAG];
        if (typeof value !== "number") return Infinity;
        return Math.abs(value - ambient(Date.parse(sample.sim_ts)));
      }),
    );
  }

  it("fills it on a scenario without injections, a recording's replay", async () => {
    const samples = await replayedSamples(boundScenario(phases));

    expect(samples).toHaveLength(durationS(phases) / SAMPLE_PERIOD_S);
    expect(worstAmbientError(samples)).toBeLessThanOrEqual(AMBIENT_TOLERANCE_C);
  });

  it.skipIf(awayFromAmbient === undefined)(
    "fills it on a scenario with an injection that leaves the ambient tag alone",
    async () => {
      if (awayFromAmbient === undefined) return;
      const at = new Date(Date.parse(START) + 20 * 60_000);
      const injection: InjectionSpec = {
        injection_id: awayFromAmbient.injection_id,
        at,
        until: new Date(at.getTime() + 60 * 60_000),
        durationMin: 60,
        fault_id: awayFromAmbient.fault_id,
        benign: awayFromAmbient.benign,
        params: { magnitude: 1 },
      };
      const samples = await replayedSamples(boundScenario(phases, [injection]), definitions);

      expect(samples).toHaveLength(durationS(phases) / SAMPLE_PERIOD_S);
      expect(worstAmbientError(samples)).toBeLessThanOrEqual(AMBIENT_TOLERANCE_C);
    },
  );
});

describe("runScenario with the real backends", () => {
  const phases = [...normalCycles(2), ...PRESSURE_LOSS];
  const csvPath = writeCsv(phases);

  it("decides with the rules baseline", async () => {
    const wall = createFakeWallClock();
    const handle = createRulesHandle({ wall });
    const run = await runScenario(boundScenario(phases), handle, hostConfig(csvPath), CATALOG, {
      wall,
    });
    const decisions = run.events.filter((event) => event.type === "decision");
    expect(decisions.length).toBeGreaterThan(0);
    expect(handle.stats.calls).toBe(decisions.length);
    for (const decision of decisions) {
      expect(decision.decision.backend).toBe("rules");
      expect(decision.decision.latency_ms).toBe(0);
    }
  });

  it("decides with Jev through the mock server, sending no key and no ground truth", async () => {
    const wall = createFakeWallClock();
    const handle = await createMockJevHandle({ jevModel: MOCK_MODEL }, { wall });
    try {
      const run = await runScenario(boundScenario(phases), handle, hostConfig(csvPath), CATALOG, {
        wall,
      });
      const decisions = run.events.flatMap((event) =>
        event.type === "decision" ? [event.decision] : [],
      );
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.every((decision) => decision.status === "ok")).toBe(true);
      expect(
        decisions.every((decision) => decision.backend === "jev" && decision.model === MOCK_MODEL),
      ).toBe(true);
      expect(decisions.every((decision) => decision.cost.price_input_per_mtok === 0.042)).toBe(
        true,
      );

      const posted = handle.server.requests.filter((request) => request.path === "/v1/systemone");
      expect(posted).toHaveLength(decisions.length);
      expect(handle.stats).toEqual({ calls: decisions.length, failures: 0, cassetteMisses: 0 });
      for (const request of posted) {
        const text = JSON.stringify(request);
        expect(text).not.toContain(MOCK_API_KEY);
        for (const marker of GROUND_TRUTH_MARKERS)
          expect(JSON.stringify(request.body)).not.toContain(marker);
      }
    } finally {
      await handle.close();
    }
  });
});
