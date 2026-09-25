// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The real stack, started from this repository's own Dockerfiles.
//
// The parity test and the golden recorder both need the same three
// containers on the same scratch network — the broker, the machine and the
// gateway — so they share this helper rather than two copies of the same
// twenty calls. What it starts is not a stand-in: the images are built from
// `services/modbus/Dockerfile` and `infra/mosquitto/Dockerfile` at the
// repository root, which is what makes a disagreement between the TypeScript
// port and the Go engine a finding rather than a difference in setup.
//
// Everything is per-run and random: a network of its own, random host ports,
// image tags carrying a suffix, and an `fdp.worktree` label naming the working
// copy, so several worktrees may run their suites at the same time. Nothing is
// published on a fixed port and nothing is reused between runs.
//
// Credentials follow the stack's own: the broker is this repository's image
// with the real ACL, `gt/#` is readable by the `eval` credential only, and
// `plant/<unit>/control/cmd` is writable by `backend-ops` only. Without
// `infra/mosquitto` in the checkout the helper falls back to a stock
// `eclipse-mosquitto:2.0.22` with an anonymous configuration and empty
// passwords, exactly as `services/modbus/scripts/image-smoke.sh` documents.
//
// The passwords below are the committed PoC defaults of
// `infra/mosquitto/passwd.txt` (secrets come from the environment only, and
// these are not secrets).

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

import { REGISTER_MAP, ROOTS, assertValid, toIsoMs, topics } from "@fdp/contracts";
import type { Sample, TelemetrySamples } from "@fdp/contracts";
import { loadInjections } from "@fdp/ground-truth";
import type { MqttClient } from "mqtt";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";

import { createReplaySource, defaultAlarmRegistry } from "../../src/replay/index.ts";
import type { InjectionDef, RegisterMap } from "../../src/replay/index.ts";
import { REPO_ROOT } from "../../src/slices.ts";

// `testcontainers` and `mqtt` are loaded on demand rather than at module load:
// `test/replay/golden.test.ts` reads the golden helpers at the bottom of this
// file in the offline suite, and neither a Docker client nor an MQTT stack
// belongs in a run that starts no container.
const testcontainers = async () => import("testcontainers");
const mqtt = async () => import("mqtt");

/** The pinned broker image, used when `infra/mosquitto` is not in the checkout. */
export const MOSQUITTO_IMAGE = "eclipse-mosquitto:2.0.22";

/** The unit the register map, the topics and the ACL are written for. */
export const UNIT_ID = "cau-7";

/** The credentials the parity harness uses, with their committed defaults. */
export const CREDENTIALS = {
  /** Read-only on `plant/#` and `gt/#`. */
  evaluation: { username: "eval", password: "eval" },
  /** The only credential allowed to publish `control/cmd`. */
  backendOps: { username: "backend-ops", password: "backend-ops" },
  sim: { username: "sim", password: "sim" },
  gateway: { username: "gateway", password: "gateway" },
} as const;

/** The variable that multiplies every wall-clock bound; CI sets 3. */
export const TIMING_SLACK_ENV = "FDP_TIMING_SLACK";

/** The network aliases the containers reach each other by. */
const ALIAS = { broker: "mqtt", sim: "modbus-sim" } as const;

const BROKER_PORT = 1883;
const MODBUS_PORT = 5020;

/** Where the replayed slice is copied inside the machine's image. */
const CSV_TARGET = "/data/parity.csv";

// Neither the machine nor the gateway publishes a host port: nothing outside
// the network talks to them, and the broker is the only door the harness needs.
// It is also the only way their readiness can be waited on at all —
// testcontainers' default strategy checks a container's internal ports by
// running a shell inside it, and both images are distroless. With no exposed
// port that strategy is a no-op and `waitForProbe` below, which execs each
// binary's own `probe` subcommand, is what decides they are up.

/** How long a container may take to start, and a probe to turn healthy, before the slack. */
const STARTUP_BUDGET_MS = 120_000;
const PROBE_BUDGET_MS = 90_000;
const PROBE_INTERVAL_MS = 500;

/** How long one `exec` against the daemon may take before it counts as unanswered. */
const EXEC_BUDGET_MS = 30_000;

/** How long the tail of a container's log may take to arrive before it is reported without it. */
const LOG_TAIL_BUDGET_MS = 5_000;

/** How long stopping the three containers and their network may take. */
const STOP_BUDGET_MS = 60_000;

/** An anonymous configuration for the fallback broker; it has no credentials and no ACL. */
const ANONYMOUS_CONF = [
  "listener 1883 0.0.0.0",
  "protocol mqtt",
  "allow_anonymous true",
  "persistence false",
  "retain_available true",
  "log_dest stdout",
  "",
].join("\n");

/** `FDP_TIMING_SLACK` as a positive multiplier; 1 when it is unset or unreadable. */
export function timingSlack(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TIMING_SLACK_ENV];
  if (raw === undefined || raw === "") return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** A wall-clock budget in milliseconds, scaled by `FDP_TIMING_SLACK`. */
export function budgetMs(base: number): number {
  return Math.round(base * timingSlack());
}

/** True when the broker is this repository's image, with the real ACL and passwords. */
export function hasBrokerConfig(): boolean {
  return existsSync(join(REPO_ROOT, "infra/mosquitto/Dockerfile"));
}

/** True when the machine's image can be built: it copies `packages/ground-truth/data`. */
export function hasGroundTruthData(): boolean {
  return existsSync(join(REPO_ROOT, "packages/ground-truth/data/injections.json"));
}

/** True when a Docker daemon answers. */
export async function dockerIsAvailable(): Promise<boolean> {
  try {
    const { getContainerRuntimeClient } = await testcontainers();
    const client = await getContainerRuntimeClient();
    await client.container.list();
    return true;
  } catch {
    return false;
  }
}

/**
 * Why this machine cannot run the parity stack, or `undefined` when it can.
 *
 * A caller skips on the sentence rather than guessing, so a run that skips says which of the
 * three reasons it was.
 */
export async function parityBlocker(): Promise<string | undefined> {
  if (!(await dockerIsAvailable())) {
    return "no Docker daemon answers; the parity test needs one to build and run the images";
  }
  if (!hasGroundTruthData()) {
    return (
      "packages/ground-truth/data/injections.json is absent, so the sim image cannot be " +
      "built (this checkout carries no injection catalog)"
    );
  }
  return undefined;
}

/** The three images one parity run is built from. */
export interface ParityImages {
  readonly sim: string;
  readonly gateway: string;
  readonly broker: string;
  /** True when `broker` is this repository's image rather than the stock one. */
  readonly brokerHasAcl: boolean;
}

/** A short random suffix, so two worktrees never name the same image. */
function suffix(): string {
  return `${process.pid.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The label every container of a run carries, so a stray one can be found later. */
function labels(): Record<string, string> {
  return { "fdp.worktree": basename(process.cwd()), "fdp.suite": "eval-parity" };
}

/**
 * Builds the sim, the gateway and the broker images once.
 *
 * The Docker build cache makes a second call cheap, but a suite still builds once in
 * `beforeAll` and starts a stack per case: the three images are what takes minutes, the three
 * containers what takes seconds.
 */
export async function buildParityImages(): Promise<ParityImages> {
  const { GenericContainer } = await testcontainers();
  const tag = suffix();
  const sim = `fdp-parity-sim:${tag}`;
  const gateway = `fdp-parity-gateway:${tag}`;

  await GenericContainer.fromDockerfile(REPO_ROOT, "services/modbus/Dockerfile")
    .withTarget("sim")
    .build(sim, { deleteOnExit: false });
  await GenericContainer.fromDockerfile(REPO_ROOT, "services/modbus/Dockerfile")
    .withTarget("gateway")
    .build(gateway, { deleteOnExit: false });

  if (!hasBrokerConfig()) {
    return { sim, gateway, broker: MOSQUITTO_IMAGE, brokerHasAcl: false };
  }
  // The broker image needs BuildKit: `infra/mosquitto/Dockerfile` copies its
  // ACL and its credential file with `--chmod`, which the legacy builder
  // refuses. The two Go images build under either.
  const broker = `fdp-parity-mqtt:${tag}`;
  await GenericContainer.fromDockerfile(REPO_ROOT, "infra/mosquitto/Dockerfile")
    .withBuildkit()
    .build(broker, { deleteOnExit: false });
  return { sim, gateway, broker, brokerHasAcl: true };
}

/** What one parity run replays, and how. */
export interface SimStackOptions {
  readonly images: ParityImages;
  /** The CSV the machine replays; copied into the image, never bind-mounted. */
  readonly csvPath: string;
  /** Simulated seconds per wall-clock second; the parity run uses 3600. */
  readonly replaySpeed?: number;
  /** Start playing at once; the parity run does not, so it can inject at the first row. */
  readonly autoplay?: boolean;
  /** Wrap at the end of the recording; the parity run stops instead. */
  readonly loop?: boolean;
}

/** A running stack: a broker reachable from the host, and the two services behind it. */
export interface SimStack {
  /** `mqtt://host:port` of the broker's mapped port. */
  readonly mqttUrl: string;
  /** True when the broker enforces the repository's ACL, so `gt/#` needs the credential. */
  readonly brokerHasAcl: boolean;
  readonly unitId: string;
  readonly broker: StartedTestContainer;
  readonly sim: StartedTestContainer;
  readonly gateway: StartedTestContainer;
  /** The last lines each container logged, for a failure message. */
  tail(): Promise<string>;
  stop(): Promise<void>;
}

/** The password a service is started with: the committed default, or empty without the ACL. */
function passwordFor(credential: { password: string }, brokerHasAcl: boolean): string {
  return brokerHasAcl ? credential.password : "";
}

/**
 * Polls a container's own `probe` subcommand until it exits 0, or the budget runs out.
 *
 * Each exec carries a deadline of its own: `StartedTestContainer.exec` waits on the daemon
 * without one, and a daemon that has stopped answering — a loaded machine running several
 * suites at once is enough — would otherwise hold this loop open past every budget above it
 * and surface as a test that "timed out" with nothing to read.
 */
async function waitForProbe(
  container: StartedTestContainer,
  binary: string,
  label: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs(PROBE_BUDGET_MS);
  let last = "";
  while (Date.now() < deadline) {
    const result = await withTimeout(
      container.exec([binary, "probe"]),
      EXEC_BUDGET_MS,
      `the ${label} probe`,
    );
    if (result.exitCode === 0) return;
    last = result.output.trim();
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  throw new Error(
    `@fdp/eval: ${label} was not healthy within ${budgetMs(PROBE_BUDGET_MS)} ms` +
      (last === "" ? "" : `; last probe output: ${last}`),
  );
}

/**
 * The last lines of a container's log, for a failure message.
 *
 * `logs()` asks the daemon to follow the container, so the stream ends only when the container
 * does: reading it to its end would never return while the stack is still up. This runs from
 * the failure path, with the stack deliberately still alive so the tail can be read, so an
 * unbounded read here does not just hang — it replaces the sentence that says what actually
 * went wrong with vitest's own "test timed out", which names nothing. The lines asked for are
 * already in the daemon's buffer, so a short settle is enough; then the stream is let go.
 */
async function tailOf(container: StartedTestContainer, label: string): Promise<string> {
  try {
    const stream = await withTimeout(
      container.logs({ tail: 25 }),
      EXEC_BUDGET_MS,
      `the ${label} log`,
    );
    const chunks: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        stream.on("data", (chunk: unknown) => chunks.push(String(chunk)));
        stream.once("end", done);
        stream.once("error", done);
        timer = setTimeout(done, budgetMs(LOG_TAIL_BUDGET_MS));
      });
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
    return `--- ${label}\n${chunks.join("")}`;
  } catch (error) {
    return `--- ${label}\n(could not be read: ${String(error)})`;
  }
}

/**
 * Starts the broker, the machine and the gateway on a network of their own.
 *
 * The machine comes up paused when `autoplay` is false, which is what lets a caller inject at
 * the first row of the recording and then play: the instance's `started_sim_ts` is the first
 * row, and the whole replay carries the overlay.
 */
export async function startSimStack(options: SimStackOptions): Promise<SimStack> {
  const { images } = options;
  const { GenericContainer, Network } = await testcontainers();
  const network: StartedNetwork = await withTimeout(
    new Network().start(),
    STARTUP_BUDGET_MS,
    "a network of its own",
  );
  const started: { broker?: StartedTestContainer; sim?: StartedTestContainer } = {};

  // Tearing down is bounded too: a daemon that has stopped answering must end
  // the run with a message rather than hold the suite open to its own timeout.
  const quietly = async (what: string, action: () => Promise<unknown>): Promise<void> => {
    await withTimeout(action(), STOP_BUDGET_MS, `stopping ${what}`).catch(() => undefined);
  };

  const stopAll = async (): Promise<void> => {
    if (started.sim !== undefined) await quietly("the machine", () => started.sim!.stop());
    if (started.broker !== undefined) await quietly("the broker", () => started.broker!.stop());
    await quietly("the network", () => network.stop());
  };

  try {
    let brokerContainer = new GenericContainer(images.broker)
      .withNetwork(network)
      .withNetworkAliases(ALIAS.broker)
      .withExposedPorts(BROKER_PORT)
      .withLabels(labels())
      // The default strategy — the mapped port accepts a connection — is the
      // right one here: `infra/mosquitto/mosquitto.conf` asks for the error,
      // warning and notice log types only, so the broker's own "running" line
      // is never printed and no log message could be waited on.
      .withStartupTimeout(budgetMs(STARTUP_BUDGET_MS));

    if (images.brokerHasAcl) {
      brokerContainer = brokerContainer.withEnvironment({
        MQTT_SIM_PASSWORD: CREDENTIALS.sim.password,
        MQTT_GATEWAY_PASSWORD: CREDENTIALS.gateway.password,
        MQTT_EVAL_PASSWORD: CREDENTIALS.evaluation.password,
        MQTT_BACKEND_OPS_PASSWORD: CREDENTIALS.backendOps.password,
      });
    } else {
      brokerContainer = brokerContainer.withCopyContentToContainer([
        { content: ANONYMOUS_CONF, target: "/mosquitto/config/mosquitto.conf", mode: 0o644 },
      ]);
    }
    // A broker whose published port does not carry traffic is no broker at all,
    // and the daemon hands one out often enough on a machine that has churned
    // through a few hundred containers: the forward accepts the connection and
    // delivers nothing, so the harness waits out its whole connect budget while
    // the broker's own log never mentions it, and every failure downstream is
    // reported against whatever test happened to be running. The door is opened
    // once here, before the rest of the stack is built on it, and a broker that
    // will not answer is replaced by one on a different port.
    let broker: StartedTestContainer | undefined;
    for (let attempt = 1; broker === undefined; attempt += 1) {
      const candidate = await withTimeout(brokerContainer.start(), STARTUP_BUDGET_MS, "the broker");
      started.broker = candidate;
      const url = `mqtt://${candidate.getHost()}:${candidate.getMappedPort(BROKER_PORT)}`;
      try {
        const probe = await connectClient(
          url,
          "fdp-parity-probe",
          images.brokerHasAcl ? CREDENTIALS.evaluation : undefined,
          BROKER_PROBE_BUDGET_MS,
        );
        await endClient(probe);
        broker = candidate;
      } catch (error) {
        if (attempt >= BROKER_ATTEMPTS) {
          throw new Error(
            `@fdp/eval: ${attempt} brokers in a row never answered on the port the daemon ` +
              `published for them, last ${url}`,
            { cause: error },
          );
        }
        started.broker = undefined;
        await quietly("a broker that never answered", () => candidate.stop());
      }
    }

    const simContainer = new GenericContainer(images.sim)
      .withNetwork(network)
      .withNetworkAliases(ALIAS.sim)
      .withLabels(labels())
      .withCommand(["run"])
      .withCopyFilesToContainer([{ source: options.csvPath, target: CSV_TARGET, mode: 0o444 }])
      .withEnvironment({
        METROPT_CSV: CSV_TARGET,
        REPLAY_SPEED: String(options.replaySpeed ?? 3600),
        SIM_AUTOPLAY: String(options.autoplay ?? false),
        SIM_LOOP: String(options.loop ?? false),
        GT_DIR: "/gt",
        UNIT_ID: UNIT_ID,
        MQTT_URL: `mqtt://${ALIAS.broker}:${BROKER_PORT}`,
        MQTT_SIM_PASSWORD: passwordFor(CREDENTIALS.sim, images.brokerHasAcl),
      })
      .withStartupTimeout(budgetMs(STARTUP_BUDGET_MS));
    const sim = await withTimeout(simContainer.start(), STARTUP_BUDGET_MS, "the machine");
    started.sim = sim;
    await waitForProbe(sim, "/modbus-sim", "the machine");

    const gatewayContainer = new GenericContainer(images.gateway)
      .withNetwork(network)
      .withLabels(labels())
      .withCommand(["run"])
      .withEnvironment({
        MODBUS_ADDR: `${ALIAS.sim}:${MODBUS_PORT}`,
        UNIT_ID: UNIT_ID,
        MQTT_URL: `mqtt://${ALIAS.broker}:${BROKER_PORT}`,
        MQTT_GATEWAY_PASSWORD: passwordFor(CREDENTIALS.gateway, images.brokerHasAcl),
      })
      .withStartupTimeout(budgetMs(STARTUP_BUDGET_MS));
    const gateway = await withTimeout(gatewayContainer.start(), STARTUP_BUDGET_MS, "the gateway");
    await waitForProbe(gateway, "/gateway", "the gateway");

    return {
      mqttUrl: `mqtt://${broker.getHost()}:${broker.getMappedPort(BROKER_PORT)}`,
      brokerHasAcl: images.brokerHasAcl,
      unitId: UNIT_ID,
      broker,
      sim,
      gateway,
      tail: async () =>
        [
          await tailOf(broker, "broker"),
          await tailOf(sim, "modbus-sim"),
          await tailOf(gateway, "gateway"),
        ].join("\n"),
      stop: async () => {
        await quietly("the gateway", () => gateway.stop());
        await stopAll();
      },
    };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// One recorded run of the stack.
//
// The sequence is the parity test's: subscribe, inject while the machine
// is still paused on the first row, play, and collect what the gateway
// publishes until the machine reports `stopped` and the wire has gone quiet.
// Only the harness ever reads `gt/#`; the samples it compares are exactly what
// a backend would receive.
// ---------------------------------------------------------------------------

/** What an `inject` command asks for (the contracts' `control-cmd`). */
export interface InjectRequest {
  readonly injection_id: string;
  readonly params: { readonly magnitude: number; readonly duration_sim_min: number };
}

/** What one recorded run produced. */
export interface ParityRun {
  /** Every sample the gateway published, flattened in arrival order. */
  readonly samples: Sample[];
  /** How many `telemetry-samples` batches carried them. */
  readonly batches: number;
  /** The instant the injection started at, from `gt/<unit>/injection`. */
  readonly startedSimTsMs?: number;
  /** The instance the simulator created, from the same message. */
  readonly instanceId?: string;
  /** The `status-sim` document the run ended on. */
  readonly finalState: string;
}

/** How long one command may take to be acknowledged. */
const ACK_BUDGET_MS = 30_000;

/** How long a whole replay may take, before the slack. */
const REPLAY_BUDGET_MS = 180_000;

/**
 * How long one MQTT round trip may take: a SUBACK, a QoS 1 PUBACK, a CONNACK or a DISCONNECT.
 *
 * Every one of them is a callback the broker has to answer, and `reconnectPeriod: 0` means a
 * connection that dies takes the answer with it: mqtt.js then never calls back and the await
 * holds the suite open to vitest's own deadline, which reports a bare "test timed out" naming
 * nothing. These are bounded so that a broker that stops answering ends the run with a sentence.
 */
const MQTT_BUDGET_MS = 30_000;

/** How long one attempt at the first connection may take, how long they may take together. */
const CONNECT_ATTEMPT_MS = 10_000;
const CONNECT_BUDGET_MS = 90_000;
const CONNECT_RETRY_MS = 500;

/** How long a freshly started broker has to answer, and how many are tried before giving up. */
const BROKER_PROBE_BUDGET_MS = 20_000;
const BROKER_ATTEMPTS = 3;

/** An envelope with the three fields every message carries. */
function envelope(unitId: string, schema: string): Record<string, unknown> {
  return { schema, unit_id: unitId, wall_ts: toIsoMs(new Date()) };
}

/** A promise that rejects when the budget runs out, with a sentence naming what was awaited. */
function withTimeout<T>(promise: Promise<T>, budget: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`@fdp/eval: ${what} did not arrive within ${budgetMs(budget)} ms`)),
      budgetMs(budget),
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Records one replay of the stack, with an optional injection started at the first row.
 *
 * The machine is paused when this is called (`autoplay: false`), so the `inject` command
 * lands on the first row of the recording and the instance's `started_sim_ts` is that row's
 * timestamp — which is what the TypeScript replay is then run with.
 */
export async function recordParityRun(
  stack: SimStack,
  injection?: InjectRequest,
): Promise<ParityRun> {
  const { unitId } = stack;
  const credential = stack.brokerHasAcl ? CREDENTIALS.evaluation : undefined;
  const publisher = stack.brokerHasAcl ? CREDENTIALS.backendOps : undefined;

  const reader = await connectClient(stack.mqttUrl, "fdp-parity-reader", credential);
  const writer = await connectClient(stack.mqttUrl, "fdp-parity-writer", publisher);

  const samples: Sample[] = [];
  let batches = 0;
  let finalState = "unknown";
  let playSent = false;
  let lastSeq = 0;
  let headSeq: number | undefined;
  let startedSimTsMs: number | undefined;
  let instanceId: string | undefined;

  const acks = new Map<string, Record<string, unknown>>();
  const waiters: (() => void)[] = [];
  const notify = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  // A recorder whose connection has died will never see the message it is
  // waiting for, so waiting out the budget only delays the same failure and
  // hides its cause. `reconnectPeriod: 0` makes a close final: note it and wake
  // every waiter, so the next check reports the lost connection by name.
  let lost: string | undefined;
  const watchConnection = (client: MqttClient, role: string): void => {
    client.on("close", () => {
      lost ??= `the ${role}'s connection to the broker closed`;
      notify();
    });
    client.on("error", (error: Error) => {
      lost ??= `the ${role}'s connection to the broker failed: ${error.message}`;
      notify();
    });
  };
  watchConnection(reader, "reader");
  watchConnection(writer, "writer");

  reader.on("message", (topic: string, payload: Buffer) => {
    const document = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (topic === topics.telemetrySamples(unitId)) {
      const batch = document as unknown as TelemetrySamples;
      batches += 1;
      samples.push(...batch.samples);
      lastSeq = Math.max(lastSeq, ...batch.samples.map((sample) => sample.seq));
    } else if (topic === topics.statusSim(unitId)) {
      finalState = String(document["state"]);
      headSeq = Number(document["head_seq"]);
    } else if (topic === topics.controlAck(unitId)) {
      acks.set(String(document["cmd_id"]), document);
    } else if (topic === topics.gtInjection(unitId) && document["event"] === "start") {
      startedSimTsMs = Date.parse(String(document["sim_ts"]));
      instanceId = String(document["instance_id"]);
    }
    notify();
  });

  await subscribe(reader, [
    topics.telemetrySamples(unitId),
    topics.statusSim(unitId),
    topics.controlAck(unitId),
    `${ROOTS.gt}/#`,
  ]);

  /** Waits until `ready` holds, or the budget runs out. */
  const until = (ready: () => boolean, what: string, budget: number): Promise<void> =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (ready()) {
            resolve();
            return;
          }
          if (lost !== undefined) {
            reject(new Error(`@fdp/eval: waiting for ${what}, but ${lost}`));
            return;
          }
          waiters.push(check);
        };
        check();
      }),
      budget,
      what,
    );

  /** Publishes one command and waits for the acknowledgement that carries its id. */
  const command = async (
    cmd: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const cmdId = randomUUID();
    const message = {
      ...envelope(unitId, "urn:fdp:schema:control-cmd:v1"),
      cmd_id: cmdId,
      cmd,
      args,
    };
    assertValid("control-cmd", message);
    await publish(writer, topics.controlCmd(unitId), message);
    await until(() => acks.has(cmdId), `the acknowledgement of ${cmd}`, ACK_BUDGET_MS);
    const ack = acks.get(cmdId) ?? {};
    if (ack["ok"] !== true) {
      throw new Error(`@fdp/eval: the simulator refused ${cmd}: ${JSON.stringify(ack["error"])}`);
    }
    return ack;
  };

  try {
    if (injection !== undefined) {
      await command("inject", { injection_id: injection.injection_id, params: injection.params });
      await until(
        () => startedSimTsMs !== undefined,
        `the gt/${unitId}/injection start message`,
        ACK_BUDGET_MS,
      );
    }

    await command("play", {});
    playSent = true;
    await until(
      () => playSent && finalState === "stopped",
      "the end of the replay (status/sim stopped)",
      REPLAY_BUDGET_MS,
    );
    // The machine has run out of rows; the gateway still has a poll cycle or
    // two of ring to drain. `head_seq` of the last `status/sim` is the newest
    // sample the machine wrote, and the gateway was synced to an idle machine
    // before `play`, so the recorder holds the whole replay exactly when it has
    // seen that sequence number. Ending instead on a quiet wire loses the tail
    // whenever a loaded daemon pauses the gateway for longer than the window,
    // and a short recording is not a parity failure that says so: it surfaces
    // as `port.length` differing from `run.samples.length`, which reads like a
    // defect in the port.
    try {
      await until(
        () => headSeq !== undefined && lastSeq >= headSeq,
        "the gateway to publish every sample the machine wrote",
        REPLAY_BUDGET_MS,
      );
    } catch (error) {
      throw new Error(
        `@fdp/eval: the gateway published ${samples.length} samples, up to seq ${lastSeq} of ` +
          `the ${headSeq ?? "unknown number of"} the machine wrote`,
        { cause: error },
      );
    }

    return { samples, batches, startedSimTsMs, instanceId, finalState };
  } finally {
    await endClient(reader);
    await endClient(writer);
  }
}

/**
 * Connects one MQTT client, with a credential when the broker enforces its ACL.
 *
 * `reconnectPeriod: 0` is what lets the recorder treat a `close` as final, but it also means a
 * first attempt that goes nowhere is never retried. The broker the harness talks to is reached
 * through a host port the daemon has just published, and on a machine running several container
 * suites at once that forward is not always carrying traffic by the time the container is
 * healthy: the SYN is answered by nobody, no CONNACK arrives, and mqtt.js gives up for good
 * while the broker's own log shows no connection at all. So the first connection — and only the
 * first — is retried until the budget runs out, each attempt with a client of its own.
 */
async function connectClient(
  url: string,
  clientPrefix: string,
  credential?: { username: string; password: string },
  budget: number = CONNECT_BUDGET_MS,
): Promise<MqttClient> {
  const { connect } = await mqtt();
  const giveUpAt = Date.now() + budgetMs(budget);
  for (let attempt = 1; ; attempt += 1) {
    const client = connect(url, {
      clientId: `${clientPrefix}-${suffix()}`,
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: budgetMs(CONNECT_ATTEMPT_MS),
      ...(credential ?? {}),
    });
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          client.once("connect", () => resolve());
          client.once("error", reject);
        }),
        CONNECT_ATTEMPT_MS,
        `a connection to ${url}`,
      );
      return client;
    } catch (error) {
      await endClient(client);
      if (Date.now() >= giveUpAt) {
        throw new Error(
          `@fdp/eval: ${clientPrefix} could not connect to ${url} in ${attempt} attempts over ` +
            `${budgetMs(budget)} ms`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

async function subscribe(client: MqttClient, filters: string[]): Promise<void> {
  for (const filter of filters) {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        client.subscribe(filter, { qos: 1 }, (error, granted) => {
          if (error) {
            reject(error);
            return;
          }
          const refused = (granted ?? []).some((entry) => entry.qos > 2);
          if (refused) {
            reject(new Error(`@fdp/eval: the broker refused the subscription to ${filter}`));
            return;
          }
          resolve();
        });
      }),
      MQTT_BUDGET_MS,
      `the acknowledgement of the subscription to ${filter}`,
    );
  }
}

async function publish(
  client: MqttClient,
  topic: string,
  message: Record<string, unknown>,
): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(message), { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    MQTT_BUDGET_MS,
    `the acknowledgement of the message published to ${topic}`,
  );
}

async function endClient(client: MqttClient): Promise<void> {
  // A client that will not close must not hold the run open either; the socket
  // is torn down with the process in any case.
  await withTimeout(
    new Promise<void>((resolve) => {
      client.end(true, {}, () => resolve());
    }),
    MQTT_BUDGET_MS,
    "the close of an MQTT client",
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The golden recordings, and the comparison both suites score with.
//
// A golden file is one recorded run of the real stack, kept beside the cut
// slices in `data/fixtures/metropt3/golden/`, which version control ignores —
// it holds sample values derived from MetroPT-3, and no such row is committed
// to this repository. `scripts/refresh-parity-golden.ts` writes them, the
// Docker parity test is the authority, and `test/replay/golden.test.ts` is the
// fast unit test that reads them when they are there.
//
// Each file records what produced it: the sim image digest and the SHA-256 of
// `injections.json`, so a recording made before a change to either is
// recognisable as stale rather than silently scored against.
// ---------------------------------------------------------------------------

/** The schema identifier a golden recording carries. */
export const GOLDEN_SCHEMA = "urn:fdp:eval:parity-golden:v1";

/** Where the recordings live, beside the slices they are cut from; gitignored. */
export const GOLDEN_DIR = join(REPO_ROOT, "data/fixtures/metropt3/golden");

/** The variable that turns an absent recording from a skip into a failure. */
export const REQUIRE_GOLDEN_ENV = "FDP_REQUIRE_GOLDEN";

/** What produced one recording. */
export interface GoldenProvenance {
  /** When the recording was made, for a human reading the file. */
  readonly recorded_at: string;
  /** The image id of the `sim` target the run was recorded from. */
  readonly sim_image_digest: string;
  /** SHA-256 of `packages/ground-truth/data/injections.json` at that moment. */
  readonly injections_sha256: string;
  /**
   * Which alarm registry the port would compare the recording against, and its digest.
   *
   * A recording is only comparable message for message while the registry behind it is the
   * one the simulator's image was generated from, so the digest travels with the samples.
   */
  readonly alarm_registry: { readonly source: string; readonly sha256: string };
  /** The slice that was replayed, and the SHA-256 the definitions record for it. */
  readonly slice: string;
  readonly slice_sha256: string;
  readonly replay_speed: number;
  readonly unit_id: string;
}

/** One recorded run: its provenance, its injection and every sample it produced. */
export interface ParityGolden {
  readonly schema: typeof GOLDEN_SCHEMA;
  readonly recorded: GoldenProvenance;
  /** The injection the run was recorded with, or `null` for the clean run. */
  readonly injection: (InjectRequest & { readonly started_sim_ts: string }) | null;
  readonly samples: readonly Sample[];
}

/** Where the recording called `name` would be. */
export function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

/** True when an absent recording must fail rather than skip. */
export function goldenRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REQUIRE_GOLDEN_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

/** The recording called `name`, or `undefined` when it has not been made on this machine. */
export function readGolden(name: string): ParityGolden | undefined {
  const path = goldenPath(name);
  if (!existsSync(path)) return undefined;
  const document = JSON.parse(readFileSync(path, "utf8")) as ParityGolden;
  if (document.schema !== GOLDEN_SCHEMA) {
    throw new Error(`@fdp/eval: ${path} carries schema ${String(document.schema)}`);
  }
  return document;
}

/** Writes one recording, creating the directory when it is the first. */
export function writeGolden(name: string, document: ParityGolden): string {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const path = goldenPath(name);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

/**
 * The image id of a locally built image, for the provenance block of a recording.
 *
 * A locally built image has no registry digest, so what is recorded is the content id the
 * daemon gave it — which is exactly as good for the question the block answers: was this
 * recording made from the image the checkout builds today?
 */
export function imageDigest(image: string): string {
  try {
    return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** SHA-256 of the injection catalog the recording was made against. */
export function injectionsSha256(): string {
  const path = join(REPO_ROOT, "packages/ground-truth/data/injections.json");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Which alarm registry the port would evaluate, and its digest.
 *
 * `source: "none"` means the checkout carries neither `manual/spec` nor the provisional
 * fixture, in which case the replay stamps empty lists and a recording of it says so.
 */
export function alarmRegistryProvenance(): { source: string; sha256: string } {
  const registry = defaultAlarmRegistry();
  if (registry === undefined) return { source: "none", sha256: "" };
  return { source: registry.source, sha256: registry.sha256 };
}

/** The rounding slack every tolerance carries, far below any register step. */
const FLOAT_SLACK = 1e-9;

/** How far two readings of one tag may sit apart before they are a difference. */
export interface Tolerances {
  /** Tags compared with a tolerance instead of exactly, in the tag's own unit. */
  readonly within: Readonly<Record<string, number>>;
  /** Tags left out of the comparison entirely, such as a noisy one. */
  readonly ignore?: readonly string[];
  /**
   * Whether the `alarms` list is compared.
   *
   * It is, by default, and that is a real comparison on both sides: the simulator sets
   * `alarm_bits` from `regmap.Alarms` and the port compiles the same three documents, so the
   * two lists must be identical sample for sample.
   *
   * `"ignore"` belongs to one kind of run only: the one that deliberately replays a
   * *different* signal on the two sides. The parity test's noise comparison drops
   * the `noise` transform from the port's copy of the injection, so `motor_current` differs
   * by construction — and so may any message written over it. Comparing alarms there would
   * assert that two different currents cross a threshold on the same sample, which is not
   * the parity question.
   */
  readonly alarms?: "equal" | "ignore";
}

/**
 * Compares the samples of the simulator with the samples of the port.
 *
 * Everything the two must agree on exactly — `seq`, `sim_ts`, the flags and every tag without
 * a tolerance — is compared by identity; the tags of `within` are compared by distance. The
 * result is a list of sentences rather than a boolean, because a parity failure that says
 * only "false" costs an afternoon.
 */
export function compareSamples(
  expected: readonly Sample[],
  actual: readonly Sample[],
  tolerances: Tolerances,
): string[] {
  const problems: string[] = [];
  if (expected.length !== actual.length) {
    problems.push(`the simulator published ${expected.length} samples, the port ${actual.length}`);
  }
  const ignored = new Set(tolerances.ignore ?? []);

  const count = Math.min(expected.length, actual.length);
  for (let index = 0; index < count && problems.length < 20; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left === undefined || right === undefined) continue;
    const where = `sample ${index} (seq ${left.seq})`;

    if (left.seq !== right.seq) problems.push(`${where}: seq ${left.seq} != ${right.seq}`);
    if (left.sim_ts !== right.sim_ts) {
      problems.push(`${where}: sim_ts ${left.sim_ts} != ${right.sim_ts}`);
    }
    if (JSON.stringify(left.flags) !== JSON.stringify(right.flags)) {
      problems.push(
        `${where}: flags ${JSON.stringify(left.flags)} != ${JSON.stringify(right.flags)}`,
      );
    }
    if (
      (tolerances.alarms ?? "equal") === "equal" &&
      JSON.stringify(left.alarms) !== JSON.stringify(right.alarms)
    ) {
      problems.push(
        `${where}: alarms ${JSON.stringify(left.alarms)} != ${JSON.stringify(right.alarms)}`,
      );
    }
    for (const [tag, value] of Object.entries(left.values)) {
      if (ignored.has(tag)) continue;
      const mine = right.values[tag];
      const tolerance = tolerances.within[tag];
      if (tolerance === undefined || typeof value !== "number" || typeof mine !== "number") {
        if (value !== mine) problems.push(`${where}: ${tag} ${String(value)} != ${String(mine)}`);
        continue;
      }
      // A tolerance of "one register step" is compared with a hair of slack:
      // two values a step apart differ by 0.010000000000005 once they have
      // been through a scale-and-round, and that is the tolerance holding, not
      // failing.
      const distance = Math.abs(value - mine);
      if (distance > tolerance + FLOAT_SLACK) {
        problems.push(
          `${where}: ${tag} ${value} != ${mine}, ${distance.toPrecision(3)} apart ` +
            `(allowed ${tolerance})`,
        );
      }
    }
  }
  return problems;
}

/** `seq` runs from 1 without a hole, which is what "no sample was lost" means. */
export function seqIsContiguousFromOne(samples: readonly Sample[]): string | undefined {
  for (let index = 0; index < samples.length; index += 1) {
    const seq = samples[index]?.seq;
    if (seq !== index + 1) {
      return `sample ${index} carries seq ${String(seq)}, expected ${index + 1}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The other side of the comparison: the TypeScript replay over the same rows.
//
// Both suites need the port run with exactly the settings the simulator ran
// with — the same slice, the same injection, started at the instant `gt/#`
// reported — so the call lives here and neither suite can drift from the
// other. The wall clock is fixed, because `wall_ts` is the one field of the
// envelope the comparison never looks at and a real clock would make a run
// unreproducible for no gain.
// ---------------------------------------------------------------------------

/** What the port replays, and with which injection. */
export interface PortRunOptions {
  /** The same CSV the machine was given. */
  readonly csvPath: string;
  /** The injection to start, at the instant the simulator started its own. */
  readonly injection?: {
    readonly injection_id: string;
    readonly atSimTsMs: number;
    readonly params: { readonly magnitude: number; readonly duration_sim_min: number };
  };
  /**
   * Primitives to drop from the definitions before the run.
   *
   * The parity test's noise comparison needs one noiseless side: two independent
   * draws of deviation `σm` differ with deviation `σm√2`, so measuring the simulator's noise
   * means replaying the port without its own.
   */
  readonly dropOps?: readonly string[];
}

/** The wall clock every batch of a port run is stamped from; a fixed instant. */
const FAKE_WALL = new Date(Date.UTC(2026, 8, 20, 12, 0, 0));

/** The injection catalog, with the named primitives filtered out of every definition. */
export function catalogWithout(
  defs: readonly InjectionDef[],
  dropOps: readonly string[],
): InjectionDef[] {
  if (dropOps.length === 0) return [...defs];
  return defs.map((def) => {
    const kept = def.transforms.filter((entry) => !dropOps.includes(entry.op));
    if (kept.length === 0 || kept.length === def.transforms.length) return def;
    return { ...def, transforms: kept as InjectionDef["transforms"] };
  });
}

/**
 * Replays the slice through `src/replay/`, with the synthetic ambient lane filled and the
 * injection applied, and returns the samples the harness would have handed the pipeline.
 */
export async function replayPort(options: PortRunOptions): Promise<Sample[]> {
  const defs = catalogWithout(loadInjections()?.injections ?? [], options.dropOps ?? []);
  const source = createReplaySource({
    source: options.csvPath,
    map: REGISTER_MAP as RegisterMap,
    wall: () => FAKE_WALL,
    ambient: true,
    injectionDefs: defs,
    injections:
      options.injection === undefined
        ? []
        : [
            {
              injection_id: options.injection.injection_id,
              atSimTsMs: options.injection.atSimTsMs,
              params: { ...options.injection.params },
            },
          ],
  });

  const samples: Sample[] = [];
  for await (const batch of source) samples.push(...batch.samples);
  return samples;
}
