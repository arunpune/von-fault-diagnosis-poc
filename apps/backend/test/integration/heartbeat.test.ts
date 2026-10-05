// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The two watchdogs on a real broker.
 *
 * The whole service runs against the test stack with the timeouts cut to one
 * and two seconds (no test waits out the production 15 s and 60 s), and
 * the decision backend is Von against the contracts' mock with the SDK's
 * retries off, so a scripted failure is exactly one failed call.
 *
 *   * `telemetry_silent`: the simulator's retained status says `playing`, the
 *     gateway stops publishing, and within three seconds (stretched by
 *     `FDP_TIMING_SLACK`) the service raises the alert on
 *     `plant/cau-7/alerts/system` and in `app.system_alerts`; the next batch
 *     clears it.
 *   * `decision_api_silent`: the mock answers the next three calls with 529;
 *     the third failure in a row raises the alert, and the next answered call
 *     clears it.
 *
 * The telemetry is synthetic (the first-month cycle, then long loaded runs
 * that make detection ask for decisions), so this suite needs no dataset.
 */

import {
  isValid,
  type AlertSystem,
  type Decision,
  type StatusSim,
  type TelemetrySamples,
} from "@fdp/contracts";
import { startMockTypeSafe, type MockTypeSafe } from "@fdp/contracts/mock";
import { fixturesFor } from "@fdp/contracts/testing";
import type { MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret } from "../../src/config/secret.ts";
import { createPool, queryOne, type Pool } from "../../src/db/pool.ts";
import { createVonBackend } from "../../src/decision/von/index.ts";
import { FIXTURE_CATALOG, FIXTURE_LABELS } from "../fixtures/catalog/index.ts";
import { BASELINE_CYCLE, cycles, longLoadedRuns, runBatches } from "../fixtures/synthetic/index.ts";
import { startStack, type TestStack } from "../helpers/containers.ts";
import { connectAs, disconnect, publishJson } from "../helpers/mqtt.ts";
import {
  createHashEmbedder,
  gatewayPublisher,
  observeBroker,
  startAppOn,
  storeCatalog,
  UNIT,
  waitForBatches,
  waitUntil,
  type AppUnderTest,
  type BrokerObserver,
  type GatewayPublisher,
} from "../helpers/runtime.ts";
import { withSlack } from "../helpers/timing.ts";

const MOCK_KEY = "mock-key-heartbeat";
const ALERTS = `plant/${UNIT}/alerts/system`;
const DECISIONS = `plant/${UNIT}/decisions`;
const STATUS_SIM = `plant/${UNIT}/status/sim`;

/** The bound the watchdog must meet: raised within three seconds of the last sample. */
const RAISE_WITHIN_MS = 3_000;

function statusSim(state: StatusSim["state"]): StatusSim {
  const found = fixturesFor("status-sim").valid.find(
    (fixture) => fixture.file === "valid-playing.json",
  );
  if (found === undefined) throw new Error("no status-sim fixture");
  const message = structuredClone(found.data) as StatusSim;
  return { ...message, state, wall_ts: new Date().toISOString() };
}

let stack: TestStack;
let admin: Pool;
let mock: MockTypeSafe;
let service: AppUnderTest;
let observer: BrokerObserver;
let gateway: GatewayPublisher;
let simulator: MqttClient;

/**
 * One continuous replay, cut in four: ordinary cycles before the silence, two
 * batches that end it, the rest of the ordinary cycles, then the long loaded
 * runs that make detection ask for decisions.
 */
let beforeSilence: TelemetrySamples[];
let afterSilence: TelemetrySamples[];
let quietRest: TelemetrySamples[];
let busy: TelemetrySamples[];

beforeAll(async () => {
  stack = await startStack({ migrate: true });
  admin = createPool(stack.pg.adminUrl, { applicationName: "fdp-heartbeat-admin" });
  const embedder = createHashEmbedder();
  await storeCatalog(admin, FIXTURE_CATALOG, embedder);
  mock = await startMockTypeSafe({ port: 0, apiKey: MOCK_KEY });

  const quiet = runBatches(cycles(BASELINE_CYCLE, 6));
  const all = runBatches([...cycles(BASELINE_CYCLE, 6), ...longLoadedRuns(20).phases]);
  const half = Math.floor(quiet.length / 2);
  beforeSilence = all.slice(0, half);
  afterSilence = all.slice(half, half + 2);
  quietRest = all.slice(half + 2, quiet.length);
  busy = all.slice(quiet.length);

  observer = await observeBroker(stack, `plant/${UNIT}/#`);
  service = await startAppOn(stack, {
    embedder,
    env: {
      DECISION_BACKEND: "von",
      TYPESAFE_API_KEY: MOCK_KEY,
      TYPESAFE_BASE_URL: mock.url,
      HEARTBEAT_TELEMETRY_TIMEOUT_S: "1",
      HEARTBEAT_DECISION_TIMEOUT_S: "2",
    },
    decision: {
      von: (env) =>
        createVonBackend({
          apiKey: env.typesafeApiKey ?? new Secret(""),
          baseURL: env.typesafeBaseUrl,
          model: env.vonModel,
          maxRetries: 0,
          labels: FIXTURE_LABELS,
        }),
    },
  });
  gateway = await gatewayPublisher(stack);
  simulator = await connectAs(stack.mqtt, "sim");
}, 240_000);

afterAll(async () => {
  await gateway?.close();
  if (simulator !== undefined) await disconnect(simulator);
  await service?.stop();
  await observer?.close();
  await mock?.close();
  await admin?.end();
  await stack?.stop();
});

function alertsOf(kind: AlertSystem["kind"]): AlertSystem[] {
  return observer.on<AlertSystem>(ALERTS).filter((alert) => alert.kind === kind);
}

async function storedAlert(
  alertId: string,
): Promise<{ state: string; cleared_wall_ts: Date | null } | undefined> {
  return queryOne(
    admin,
    "SELECT state, cleared_wall_ts FROM app.system_alerts WHERE alert_id = $1",
    [alertId],
  );
}

async function heartbeatStates(): Promise<Record<string, string>> {
  const response = await fetch(`${service.httpUrl}/api/health`);
  return ((await response.json()) as { heartbeats: Record<string, string> }).heartbeats;
}

describe("the telemetry watchdog", () => {
  it("raises telemetry_silent within seconds of the last sample and clears it on the next", async () => {
    await publishJson(simulator, STATUS_SIM, statusSim("playing"), { retain: true });
    await gateway.publish(beforeSilence);
    await waitForBatches(service, beforeSilence.length);
    const stoppedAt = Date.now();

    await waitUntil(
      () => alertsOf("telemetry_silent").some((alert) => alert.state === "raised"),
      "telemetry_silent raised on the broker",
      withSlack(RAISE_WITHIN_MS),
    );
    expect(Date.now() - stoppedAt).toBeLessThanOrEqual(withSlack(RAISE_WITHIN_MS));
    const raised = alertsOf("telemetry_silent").find((alert) => alert.state === "raised");
    if (raised === undefined) throw new Error("no raised alert");
    expect(isValid("alert-system", raised)).toBe(true);
    expect(raised.details.timeout_s).toBe(1);
    await waitUntil(
      async () => (await storedAlert(raised.alert_id))?.state === "raised",
      "the raised alert in app.system_alerts",
    );
    expect((await heartbeatStates()).telemetry).toBe("silent");

    await gateway.publish(afterSilence);
    await waitUntil(
      () =>
        alertsOf("telemetry_silent").some(
          (alert) => alert.alert_id === raised.alert_id && alert.state === "cleared",
        ),
      "telemetry_silent cleared on the broker",
    );
    await waitUntil(
      async () => (await storedAlert(raised.alert_id))?.state === "cleared",
      "the cleared alert in app.system_alerts",
    );
    expect((await storedAlert(raised.alert_id))?.cleared_wall_ts).not.toBeNull();
    expect((await heartbeatStates()).telemetry).toBe("ok");

    // The replay pauses: silence is no longer a fault, whatever comes next.
    await publishJson(simulator, STATUS_SIM, statusSim("paused"), { retain: true });
  }, 60_000);
});

describe("the decision watchdog", () => {
  it("raises decision_api_silent after three failed calls and clears it on the next answer", async () => {
    await publishJson(simulator, STATUS_SIM, statusSim("paused"), { retain: true });
    mock.failNext(529, 3);
    const decisions = (): Decision[] => observer.on<Decision>(DECISIONS);
    const answered = (): boolean => decisions().some((decision) => decision.status === "ok");

    // The rest of the ordinary cycles, then the long runs until a call is answered.
    const published = await gateway.publish([...quietRest, ...busy], { until: answered });
    await waitUntil(answered, "an answered decision after the failures");
    await waitForBatches(service, beforeSilence.length + afterSilence.length + published);

    const failed = decisions().filter((decision) => decision.status === "failed");
    expect(failed.slice(0, 3).map((decision) => decision.error?.kind)).toEqual([
      "overloaded",
      "overloaded",
      "overloaded",
    ]);
    await waitUntil(
      () => alertsOf("decision_api_silent").some((alert) => alert.state === "cleared"),
      "decision_api_silent cleared on the broker",
    );
    const [raised, cleared] = alertsOf("decision_api_silent");
    expect(raised).toMatchObject({ state: "raised" });
    expect(raised?.details.consecutive_errors).toBeGreaterThanOrEqual(3);
    expect(cleared).toMatchObject({ state: "cleared", alert_id: raised?.alert_id });
    await waitUntil(
      async () => (await storedAlert(raised?.alert_id ?? ""))?.state === "cleared",
      "the cleared decision alert in app.system_alerts",
    );
    expect((await heartbeatStates()).decision_api).toBe("ok");
    // One request per decision: with maxRetries 0 the SDK retried nothing.
    const calls = (): number =>
      mock.requests.filter((request) => request.path.startsWith("/v1/systemone")).length;
    await waitUntil(() => decisions().length === calls(), "one request per decision");
    expect(calls()).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
