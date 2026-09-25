// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The live picture: the retained statuses the
// runtime keeps and forwards, `GET /api/status` without its gate, and the
// WebSocket `snapshot` frame, each checked against its contract.

import {
  validate,
  type ActiveFaultInjections,
  type AlertSystem,
  type Decision,
  type GroundTruthCatalog,
  type StatusBackend,
  type StatusGateway,
  type StatusSim,
} from "@fdp/contracts";
import { fixturesFor } from "@fdp/contracts/testing";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { createCatalogRetriever, createPipeline } from "../pipeline/index.ts";
import type { PipelineOutput } from "../pipeline/types.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import { longLoadedRuns, scenarioBatches } from "../../test/fixtures/synthetic/index.ts";
import { confidentBackend, recordingHub, recordingWatchdog } from "./fakes.test-helper.ts";
import {
  createStatusTracker,
  runtimeStatus,
  SNAPSHOT_DECISIONS,
  wsSnapshot,
  type RuntimeViewSources,
} from "./status.ts";

function fixture<T>(schema: string, file: string): T {
  const found = fixturesFor(schema).valid.find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`no ${schema} fixture ${file}`);
  return structuredClone(found.data) as T;
}

const SIM = fixture<StatusSim>("status-sim", "valid-playing.json");
const PAUSED = fixture<StatusSim>("status-sim", "valid-paused.json");
const GATEWAY = fixture<StatusGateway>("status-gateway", "valid-connected.json");
const BACKEND = fixture<StatusBackend>("status-backend", "valid-jev.json");
const ALERT = fixture<AlertSystem>("alert-system", "valid-raised.json");
const CATALOG = fixture<GroundTruthCatalog>("gt-catalog", "valid-full.json");
const ACTIVE = fixture<ActiveFaultInjections>("gt-injection-active", "valid-one-running.json");

const GATE = { ticket_min_confidence: 0.85, review_min_confidence: 0.6 };

describe("createStatusTracker", () => {
  it("keeps the latest status of each publisher and forwards it", () => {
    const hub = recordingHub();
    const watchdog = recordingWatchdog();
    const tracker = createStatusTracker({ watchdog, hub });
    expect(tracker.sim()).toBeNull();
    expect(tracker.healthSim()).toBeNull();

    tracker.onSim(SIM);
    tracker.onGateway(GATEWAY);
    tracker.onSim(PAUSED);

    expect(tracker.sim()).toEqual(PAUSED);
    expect(tracker.gateway()).toEqual(GATEWAY);
    expect(hub.frames.map((frame) => frame.type)).toEqual([
      "status.sim",
      "status.gateway",
      "status.sim",
    ]);
  });

  it("tells the telemetry watchdog whether the replay is playing", () => {
    const watchdog = recordingWatchdog();
    const tracker = createStatusTracker({ watchdog, hub: recordingHub() });

    tracker.onSim(SIM);
    tracker.onSim(PAUSED);

    expect(watchdog.simStates).toEqual([SIM.state, PAUSED.state]);
  });

  it("repeats the three replay values the health route reports", () => {
    const tracker = createStatusTracker({ watchdog: recordingWatchdog(), hub: recordingHub() });
    tracker.onSim(SIM);

    expect(tracker.healthSim()).toEqual({ state: SIM.state, speed: SIM.speed, sim_ts: SIM.sim_ts });
  });
});

/** A pipeline that opened a ticket, and the decisions it took on the way. */
async function busyPipeline() {
  const pipeline = createPipeline({
    wall: fixedClock("2026-09-22T08:00:00.000Z"),
    retriever: createCatalogRetriever(FIXTURE_CATALOG),
    decision: confidentBackend(),
  });
  const outputs: PipelineOutput[] = [];
  for (const batch of scenarioBatches(longLoadedRuns(20))) {
    outputs.push(...(await pipeline.push(batch)));
    if (outputs.some((output) => output.type === "ticket")) break;
  }
  const decisions: Decision[] = outputs.flatMap((output) =>
    output.type === "decision" ? [output.decision] : [],
  );
  return { pipeline, decisions };
}

async function sources(overrides: Partial<RuntimeViewSources> = {}): Promise<RuntimeViewSources> {
  const { pipeline, decisions } = await busyPipeline();
  const tracker = createStatusTracker({ watchdog: recordingWatchdog(), hub: recordingHub() });
  tracker.onSim(SIM);
  tracker.onGateway(GATEWAY);
  return {
    tracker,
    backend: () => BACKEND,
    alerts: () => [ALERT],
    overlay: { catalog: () => CATALOG, active: () => ACTIVE },
    pipeline,
    decisions: {
      list: (query = {}) =>
        Promise.resolve({
          items: decisions.slice(0, query.limit ?? decisions.length),
          next_cursor: null,
        }),
    },
    ...overrides,
  };
}

describe("runtimeStatus", () => {
  it("is api-status once the route adds the gate", async () => {
    const body = { ...runtimeStatus(await sources()), gate: GATE };

    expect(validate("api-status", body).ok).toBe(true);
    expect(body).toMatchObject({
      sim: SIM,
      gateway: GATEWAY,
      backend: BACKEND,
      alerts_active: [ALERT],
      injections_active: ACTIVE.active,
    });
  });

  it("reports nulls and empty lists before anything has arrived", async () => {
    const quiet = await sources({
      tracker: createStatusTracker({ watchdog: recordingWatchdog(), hub: recordingHub() }),
      alerts: () => [],
      overlay: { catalog: () => null, active: () => null },
    });
    const body = { ...runtimeStatus(quiet), gate: GATE };

    expect(validate("api-status", body).ok).toBe(true);
    expect(body).toMatchObject({ sim: null, gateway: null, injections_active: [] });
  });
});

describe("wsSnapshot", () => {
  it("is a valid snapshot frame with the open work and the overlay", async () => {
    const view = await sources();
    const payload = await wsSnapshot(view);
    const frame = {
      schema: "urn:fdp:schema:ws-server-message:v1",
      unit_id: "cau-7",
      wall_ts: "2026-09-22T08:00:00.000Z",
      type: "snapshot",
      payload,
    };

    const result = validate("ws-server-message", frame);
    expect(result.ok ? [] : result.errors.map((issue) => issue.text)).toEqual([]);
    expect(payload.status).toEqual({ sim: SIM, gateway: GATEWAY, backend: BACKEND });
    expect(payload.latest_sample).toEqual(view.pipeline.ingest.latest());
    expect(payload.episodes.length).toBeGreaterThan(0);
    expect(payload.episodes.every((episode) => episode.status === "open")).toBe(true);
    expect(payload.tickets.map((ticket) => ticket.status)).toEqual(["open"]);
    expect(payload.system_alerts).toEqual([ALERT]);
    expect(payload.overlay).toEqual({ catalog: CATALOG, active: ACTIVE });
  });

  it("asks for at most the frame's cap of recent decisions", async () => {
    const limits: (number | undefined)[] = [];
    const view = await sources({
      decisions: {
        list: (query = {}) => {
          limits.push(query.limit);
          return Promise.resolve({ items: [], next_cursor: null });
        },
      },
    });

    await wsSnapshot(view);
    expect(limits).toEqual([SNAPSHOT_DECISIONS]);
  });

  it("lists the open episodes newest first", async () => {
    const payload = await wsSnapshot(await sources());
    const opened = payload.episodes.map((episode) => episode.opened_sim_ts);
    expect(opened).toEqual([...opened].sort().reverse());
  });
});
