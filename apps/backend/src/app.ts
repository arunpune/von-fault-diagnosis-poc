// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The composition root.
 *
 * Two functions, one inside the other:
 *
 *   * {@link createApp} builds the HTTP host — Fastify with `GET /api/health`,
 *     and the dashboard routes, the overlay routes and `GET /ws` when it is
 *     handed what they read. It opens no connection, so a test can drive the
 *     real routes with `fastify.inject` against ports of its own;
 *   * {@link startApp} is the running service: it opens every connection in
 *     the order listed below, builds the pipeline and its sinks, hands them to
 *     {@link createApp}, listens, and returns the one handle that shuts it all
 *     down again within ten seconds.
 *
 * Start-up, one log line per step, failing fast with a named cause:
 *
 *   1. the environment (the caller: `src/index.ts` or a test);
 *   2. the diagnosis pool, and the migration it must be at — "run init first"
 *      when it is not;
 *   3. the signal roles of the register map;
 *   4. the embedder, offline from `MODEL_CACHE_DIR`;
 *   5. the retriever, the decision backend, the open work read back from the
 *      database, and the pipeline over them;
 *   6. the overlay (its own pool and broker credential), then the diagnosis
 *      broker client and its subscriptions;
 *   7. the HTTP server, the retained `status/backend`, and the one-second
 *      timer of the heartbeat, the aggregate writes and the retention.
 *
 * Shutdown is the same road back: timers, the queued telemetry and the open
 * minute of aggregates, the WebSocket clients (1001), the broker clients, the
 * pools.
 */

import { EMBEDDING, SIGNALS } from "@fdp/contracts";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { HealthPorts, LinkName, LinkProbe } from "./api/health.ts";
import { apiRoutes, API_PREFIX, type ApiDeps, type ApiPorts } from "./api/index.ts";
import { createCatalogRepo } from "./api/repo-catalog.ts";
import { createSnapshotReaders } from "./api/snapshot-readers.ts";
import { systemClock, type WallClock } from "./clock.ts";
import { ConfigError, decisionModel, gateThresholds, type Env } from "./config/env.ts";
import type { Secret } from "./config/secret.ts";
import { pricesFor, summaryPrices } from "./cost/index.ts";
import { createCostRepo } from "./cost/repo.ts";
import { createAppPool } from "./db/app.ts";
import { assertMigrated, REQUIRED_MIGRATION, type Pool } from "./db/pool.ts";
import { createVonBackend } from "./decision/von/index.ts";
import { createAnthropicProvider, createLlmBackend } from "./decision/llm/index.ts";
import { selectBackend, type DecisionBackendFactories } from "./decision/select.ts";
import type { DecisionBackend } from "./decision/types.ts";
import { resolveRoles } from "./detection/index.ts";
import { createEpisodeRepo } from "./episodes/repo.ts";
import { createHeartbeat } from "./heartbeat/index.ts";
import { newId } from "./ids.ts";
import { createTelemetryRepo } from "./ingest/repo.ts";
import { createLogger, type Logger } from "./log.ts";
import { createDiagClient, type DiagClient } from "./mqtt/diag-client.ts";
import { createOverlay, type OverlayConfig, type OverlayHub } from "./overlay/index.ts";
import { createPersistence } from "./persistence/index.ts";
import { createPipeline, createRulesBackend, VERSION } from "./pipeline/index.ts";
import type { Pipeline, PipelineConfig } from "./pipeline/types.ts";
import { createCachedCatalogLoader } from "./retrieval/catalog.ts";
import { createEmbedder, type Embedder } from "./retrieval/embedder.ts";
import { createPgRetriever } from "./retrieval/index.ts";
import { hydrate } from "./runtime/hydrate.ts";
import { createOutputSink, createWatchdogSink } from "./runtime/sinks.ts";
import {
  createStatusTracker,
  runtimeStatus,
  wsSnapshot,
  type RuntimeViewSources,
} from "./runtime/status.ts";
import { createTelemetryRuntime } from "./runtime/telemetry.ts";
import { createStatusPublisher } from "./status.ts";
import { createTicketRepo } from "./tickets/repo.ts";
import { createHub, wsRoutes, type Hub } from "./ws/index.ts";

/** How long a shutdown may take before it gives up on what is still open. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Bodies larger than this are refused before a route sees them. */
export const BODY_LIMIT_BYTES = 1_048_576;

/** The register map's human name of every signal, which the decision state quotes. */
const SIGNAL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SIGNALS.map((signal) => [signal.tag, signal.name])),
);

export interface AppDeps {
  readonly clock?: WallClock;
  /** The root logger; `createApp` builds one from the environment when none is given. */
  readonly logger?: Logger;
  /** One probe per connection this process actually holds open (see `api/health.ts`). */
  readonly links?: Partial<Record<LinkName, LinkProbe>>;
  readonly heartbeats?: HealthPorts["heartbeats"];
  readonly sim?: HealthPorts["sim"];
  readonly counters?: HealthPorts["counters"];
  /** What the dashboard routes read; without it only the health route is served. */
  readonly dashboard?: ApiDeps;
  /** The overlay's two route plugins, when this process runs the overlay. */
  readonly overlay?: ApiPorts["overlay"];
  /** The WebSocket hub `GET /ws` hands its sockets to; no `/ws` without one. */
  readonly hub?: Pick<Hub, "attach" | "closeAll">;
}

export interface App {
  readonly fastify: FastifyInstance;
  readonly logger: Logger;
  /** Listen on the configured port; resolves with the address the server bound to. */
  start(): Promise<string>;
  /** Close the server and everything registered with it, within {@link SHUTDOWN_TIMEOUT_MS}. */
  stop(): Promise<void>;
}

/** Resolve with `work`, or with `"timeout"` once `ms` have passed. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The HTTP host: health always, the dashboard, the overlay and `/ws` when handed their ports. */
export function createApp(env: Env, deps: AppDeps = {}): App {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createLogger({ logLevel: env.logLevel, unitId: env.unitId, version: VERSION });

  // pino's `Logger` carries more than Fastify's `FastifyBaseLogger` asks for;
  // naming the narrower type keeps the instance at Fastify's default generics,
  // which is what every plugin signature in this package is written against.
  const fastify: FastifyInstance = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const health: HealthPorts = {
    clock,
    version: VERSION,
    backend: { name: env.decisionBackend, model: decisionModel(env) },
    links: deps.links ?? {},
    heartbeats: deps.heartbeats,
    sim: deps.sim,
    counters: deps.counters,
  };

  // `register` is deferred until the instance is first used, so these are not
  // floating promises: `listen` and `inject` both await the plugin tree.
  void fastify.register(
    apiRoutes({
      startedAt: clock.now(),
      health,
      dashboard: deps.dashboard,
      overlay: deps.overlay,
      crossOrigin: env.nodeEnv !== "production",
    }),
    { prefix: API_PREFIX },
  );
  if (deps.hub !== undefined) void fastify.register(wsRoutes(deps.hub));

  return {
    fastify,
    logger,

    async start(): Promise<string> {
      const address = await fastify.listen({ port: env.port, host: "0.0.0.0" });
      logger.info({ address, decision_backend: env.decisionBackend }, "http server listening");
      return address;
    },

    async stop(): Promise<void> {
      if ((await within(fastify.close(), SHUTDOWN_TIMEOUT_MS)) === "timeout") {
        logger.warn({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, "http server did not close in time");
      }
    },
  };
}

/** Factories a test may swap; production builds the real ones from the environment. */
export interface AppFactories {
  /** The query embedder; by default the pinned model, read offline from `MODEL_CACHE_DIR`. */
  readonly embedder?: (env: Env) => Promise<Embedder>;
  /** Decision backend factories that replace the defaults one by one (`decision/select.ts`). */
  readonly decision?: Partial<DecisionBackendFactories>;
}

export interface StartOptions {
  /** The root logger; built from the environment when none is given. */
  readonly logger?: Logger;
  readonly clock?: WallClock;
  /** The overlay's configuration; `overlay/config.ts` reads the process environment by default. */
  readonly overlayConfig?: OverlayConfig;
  readonly factories?: AppFactories;
}

/** The running service. */
export interface RunningApp {
  /** Where the HTTP server listens, `http://host:port`. */
  readonly address: string;
  readonly fastify: FastifyInstance;
  readonly logger: Logger;
  /** The diagnosis broker client, for the isolation tests. */
  readonly diag: DiagClient;
  readonly pipeline: Pipeline;
  /** Shut everything down in reverse start-up order, within {@link SHUTDOWN_TIMEOUT_MS}. */
  stop(): Promise<void>;
}

/** Something start-up opened and a failed start-up has to close again. */
type Closer = () => Promise<void>;

/** A key the configuration already required; its absence here is a composition bug. */
function requireKey(key: Secret | null, variable: string): Secret {
  if (key === null) throw new ConfigError([`${variable} is not set`]);
  return key;
}

/** The three answer engines, built from the environment. */
function defaultBackendFactories(clock: WallClock, logger: Logger): DecisionBackendFactories {
  const now = (): number => clock.now().getTime();
  const decisionLogger = logger.child({ module: "decision" });
  return {
    rules: () => createRulesBackend({ labels: SIGNAL_LABELS, now }),
    von: (env) =>
      createVonBackend({
        apiKey: requireKey(env.typesafeApiKey, "TYPESAFE_API_KEY"),
        baseURL: env.typesafeBaseUrl,
        model: env.vonModel,
        labels: SIGNAL_LABELS,
        wall: now,
        warn: (fields, message) => {
          decisionLogger.warn(fields, message);
        },
      }),
    llm: (env) =>
      createLlmBackend(
        createAnthropicProvider({
          apiKey: requireKey(env.llmApiKey, "LLM_API_KEY"),
          model: env.llmModel,
          ...(env.llmBaseUrl === null ? {} : { baseURL: env.llmBaseUrl }),
        }),
        clock,
        { labels: SIGNAL_LABELS },
      ),
  };
}

/** The query embedder: offline unless `EMBEDDER_ALLOW_DOWNLOAD` says otherwise. */
function loadEmbedder(env: Env): Promise<Embedder> {
  return createEmbedder({ cacheDir: env.modelCacheDir, allowDownload: env.embedderAllowDownload });
}

/**
 * The tunables of the pipeline, from the environment.
 *
 * The gate gets the thresholds of the backend the service runs: Von's own
 * `VON_GATE_*` pair (default review 0.65, ticket 0.85), or `GATE_*` for the rules
 * and llm backends.
 *
 * Exported so a test can hold the running service, the pipeline's own
 * defaults and `tools/eval` to one configuration.
 */
export function pipelineConfig(env: Env): PipelineConfig {
  const thresholds = gateThresholds(env.gate, env.decisionBackend);
  return {
    gate: {
      ticketMin: thresholds.ticketMinConfidence,
      reviewMin: thresholds.reviewMinConfidence,
    },
    decisionIntervalSimMin: env.decisionIntervalSimMin,
    episodeClearSimMin: env.episodeClearSimMin,
    persistSimMin: env.gate.persistSimMin,
    rulesDisabled: env.rulesDisabled,
    unitId: env.unitId,
  };
}

/** The overlay recorder's frames, sent through the hub as the `overlay.*` frames. */
function overlayFrames(hub: Pick<Hub, "broadcast">): OverlayHub {
  return {
    publish(frame) {
      switch (frame.type) {
        case "overlay.catalog":
          hub.broadcast(frame.type, frame.payload);
          break;
        case "overlay.injection":
          hub.broadcast(frame.type, frame.payload);
          break;
        case "overlay.injection_active":
          hub.broadcast(frame.type, frame.payload);
          break;
        case "overlay.marker":
          hub.broadcast(frame.type, frame.payload);
          break;
      }
    },
  };
}

/** One round trip, so a pool that has lost its server reports `down` rather than `ok`. */
async function probe(pool: Pool): Promise<boolean> {
  await pool.query("SELECT 1");
  return true;
}

/** Close what start-up opened, newest first; a failure to close is logged, not thrown. */
async function closeAll(closers: readonly Closer[], logger: Logger): Promise<void> {
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch (error: unknown) {
      logger.warn({ err: error }, "a connection did not close cleanly");
    }
  }
}

/** Open the diagnosis pool and refuse a database init has not prepared. */
async function openDatabase(env: Env, logger: Logger, closers: Closer[]): Promise<Pool> {
  const pool = createAppPool(env, logger);
  closers.push(() => pool.end());
  const migration = await assertMigrated(pool);
  logger.info({ migration, required: REQUIRED_MIGRATION }, "database reachable and migrated");
  return pool;
}

/**
 * Start the service and resolve once it listens.
 *
 * On any start-up failure, everything opened so far is closed again before the
 * error is rethrown, so the caller only has to report it.
 *
 * @throws MigrationStateError when the database is not at `REQUIRED_MIGRATION`
 * ("run init first"), `EmbedderError` when the model files are missing or
 * corrupt, `ConfigError`, `OverlayConfigError`, `OpsCredentialError` or
 * `DiagCredentialError` for an unusable configuration, and whatever a refused
 * connection throws.
 */
export async function startApp(env: Env, options: StartOptions = {}): Promise<RunningApp> {
  const logger =
    options.logger ??
    createLogger({ logLevel: env.logLevel, unitId: env.unitId, version: VERSION });
  const closers: Closer[] = [];
  try {
    return await compose(env, options, logger, closers);
  } catch (error: unknown) {
    await closeAll(closers, logger);
    throw error;
  }
}

async function compose(
  env: Env,
  options: StartOptions,
  logger: Logger,
  closers: Closer[],
): Promise<RunningApp> {
  const clock = options.clock ?? systemClock;

  const appPool = await openDatabase(env, logger, closers);

  resolveRoles(SIGNALS);
  logger.info({ signals: SIGNALS.length }, "signal roles resolved from the register map");

  const embedder = await (options.factories?.embedder ?? loadEmbedder)(env);
  logger.info(
    { model: EMBEDDING.model_id, dimension: embedder.dimension },
    "query embedder loaded",
  );

  const catalogLoader = createCachedCatalogLoader({ db: appPool });
  const retriever = createPgRetriever({ pool: appPool, embedder, catalogLoader });
  const decision: DecisionBackend = selectBackend(env, {
    ...defaultBackendFactories(clock, logger),
    ...options.factories?.decision,
  });
  logger.info({ backend: decision.name, model: decision.model }, "decision backend selected");

  const episodeRepo = createEpisodeRepo(appPool);
  const ticketRepo = createTicketRepo(appPool);
  const hydrated = await hydrate({
    episodes: episodeRepo,
    tickets: ticketRepo,
    unitId: env.unitId,
  });
  logger.info(
    { episodes_open: hydrated.store.listOpen().length, tickets: hydrated.tickets.length },
    "open work read back",
  );
  const pipeline = createPipeline(
    {
      wall: clock,
      retriever,
      decision,
      store: hydrated.store,
      tickets: hydrated.tickets,
      prices: pricesFor(env, decision.name),
      telemetry: {
        repo: createTelemetryRepo(appPool),
        retentionSimDays: env.telemetryRetentionSimDays,
      },
    },
    pipelineConfig(env),
  );

  const persistence = createPersistence(appPool, { unitId: env.unitId });
  const costRepo = createCostRepo(appPool, summaryPrices(env));

  // The hub's snapshot and the status route read `view`, which is complete
  // before the first socket or request can arrive.
  const hub = createHub({
    wall: clock,
    info: {
      serverVersion: VERSION,
      decisionBackend: decision.name,
      model: decision.model,
      unitId: env.unitId,
    },
    telemetryIntervalMs: env.wsTelemetryIntervalMs,
    snapshot: () => wsSnapshot(view),
    logger: logger.child({ module: "ws" }),
  });
  closers.push(async () => {
    hub.closeAll();
  });

  const overlay = await createOverlay({
    logger,
    wall: clock,
    config: options.overlayConfig,
    hub: overlayFrames(hub),
  });
  closers.push(() => overlay.stop());
  await overlay.start();
  logger.info({ unit_id: overlay.config.unitId }, "overlay recorder subscribed");

  const diag = await createDiagClient(env, { logger });
  closers.push(() => diag.close());
  logger.info({ client_id: diag.client.clientId }, "diagnosis broker client connected");

  const watchdogSink = createWatchdogSink({
    repos: { alerts: persistence.alerts, heartbeats: persistence.heartbeats },
    publisher: diag,
    hub,
    logger,
    onChange: () => {
      status.notify();
    },
  });
  closers.push(() => watchdogSink.settled());
  const heartbeat = createHeartbeat({
    wall: clock,
    timeouts: {
      telemetryS: env.heartbeatTelemetryTimeoutS,
      decisionS: env.heartbeatDecisionTimeoutS,
    },
    sink: watchdogSink,
    unitId: env.unitId,
    ids: newId,
  });
  const status = createStatusPublisher({
    publish: (message) => {
      hub.broadcast("status.backend", message);
      diag.publishStatus(message).catch((error: unknown) => {
        logger.error({ err: error }, "could not publish the backend status");
      });
    },
    wall: clock,
    info: { unitId: env.unitId, backend: decision.name, model: decision.model, version: VERSION },
    sources: {
      heartbeat: () => heartbeat.snapshot(),
      episodesOpen: () => hydrated.store.listOpen().length,
      ticketsOpen: () =>
        pipeline
          .snapshot()
          .tickets.filter((ticket) => ticket.status === "review" || ticket.status === "open")
          .length,
    },
  });
  closers.push(async () => {
    status.stop();
  });

  const tracker = createStatusTracker({ watchdog: heartbeat, hub });
  const sink = createOutputSink({
    repos: {
      events: persistence.events,
      decisions: persistence.decisions,
      episodes: episodeRepo,
      tickets: ticketRepo,
      cost: costRepo,
    },
    publisher: diag,
    hub,
    store: hydrated.store,
    watchdog: heartbeat,
    logger,
    onChange: () => {
      status.notify();
    },
  });
  const telemetry = createTelemetryRuntime({ pipeline, sink, hub, watchdog: heartbeat, logger });
  closers.push(() => telemetry.stop());

  const view: RuntimeViewSources = {
    tracker,
    backend: () => status.current(),
    alerts: () => heartbeat.activeAlerts(),
    overlay: { catalog: () => overlay.recorder.catalog(), active: () => overlay.recorder.active() },
    pipeline,
    decisions: persistence.decisions,
  };

  await diag.subscribe({
    telemetry: (batch) => telemetry.onBatch(batch),
    statusSim: (message) => {
      tracker.onSim(message);
    },
    statusGateway: (message) => {
      tracker.onGateway(message);
    },
  });
  logger.info(
    { telemetry: diag.topics.telemetry, status: diag.topics.status },
    "diagnosis client subscribed",
  );

  const readers = createSnapshotReaders(() => pipeline.snapshot());
  const dashboard: ApiDeps = {
    env: { gate: env.gate, decisionBackend: env.decisionBackend },
    ingest: pipeline.ingest,
    detector: pipeline.detector,
    repos: {
      events: persistence.events,
      decisions: persistence.decisions,
      episodes: readers.episodes,
      tickets: readers.tickets,
      cost: costRepo,
      alerts: persistence.alerts,
      nativeAlarms: persistence.nativeAlarms,
      catalog: createCatalogRepo({ db: appPool, loader: catalogLoader }),
    },
    runtime: { status: () => runtimeStatus(view) },
    actions: { closeTicket: (ticketId, verdict) => telemetry.closeTicket(ticketId, verdict) },
  };

  const http = createApp(env, {
    clock,
    logger,
    links: {
      "db.app": () => probe(appPool),
      "db.gt": () => overlay.databaseReachable(),
      "mqtt.diag": () => diag.connected(),
      "mqtt.ops": () => overlay.reachable(),
    },
    heartbeats: () => heartbeat.snapshot().states,
    sim: () => tracker.healthSim(),
    counters: () => {
      const flow = telemetry.counters();
      const sockets = hub.counters();
      const outputs = sink.failures();
      const alerts = watchdogSink.failures();
      const drops = Object.values(diag.drops());
      return {
        telemetry_batches: flow.batches,
        telemetry_samples: flow.samples,
        telemetry_failed: flow.failed,
        telemetry_queued: flow.queued,
        telemetry_storage_errors: flow.storageErrors,
        mqtt_invalid: drops.reduce((sum, drop) => sum + drop.invalid, 0),
        mqtt_handler_failures: drops.reduce((sum, drop) => sum + drop.failed, 0),
        sink_persist_failures: outputs.persist + alerts.persist,
        sink_publish_failures: outputs.publish + alerts.publish,
        ws_clients: sockets.clients,
        ws_telemetry_dropped: sockets.telemetryDropped,
        ws_slow_closed: sockets.slowClosed,
        ws_invalid_frames: sockets.invalidFrames,
      };
    },
    dashboard,
    overlay: { read: overlay.readPorts, sim: overlay.simPorts },
    hub,
  });
  closers.push(() => http.stop());
  const address = await http.start();

  status.start();
  telemetry.start();
  logger.info({ address }, "backend started");

  async function shutdown(): Promise<void> {
    status.stop();
    await telemetry.stop();
    await http.stop();
    await Promise.allSettled([diag.close(), overlay.stop()]);
    await watchdogSink.settled();
    await appPool.end();
  }

  return {
    address,
    fastify: http.fastify,
    logger,
    diag,
    pipeline,

    async stop(): Promise<void> {
      logger.info("shutting down");
      if ((await within(shutdown(), SHUTDOWN_TIMEOUT_MS)) === "timeout") {
        logger.warn({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, "shutdown did not finish in time");
      }
    },
  };
}
