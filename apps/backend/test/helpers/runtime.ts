// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The running service under test.
 *
 * The runtime suites start `startApp` — the real composition, every
 * connection, every timer — against the containers of `containers.ts`, and
 * watch it the way its users do: over the broker as the read-only `eval`
 * credential, over `GET /ws` with Node's own `WebSocket`, over REST with
 * `fetch`, and in the database as the owning role.
 *
 * What they need beyond the containers is here:
 *
 *   * the catalog, stored the way init stores it, because
 *     retrieval reads `app.v_catalog_entries` and the chunks as `app_rw`;
 *   * an embedder: the pinned model when the environment offers its files,
 *     otherwise a deterministic bag-of-words hash — the test-only factory
 *     override of `startApp`, so no test downloads a model it was not given;
 *   * the log lines, captured, so a test can read what the service said;
 *   * the gateway's side of the wire: fixture batches published at a steady
 *     rate as the `gateway` credential.
 *
 * Everything invented below is fictional; no real manual, manufacturer or
 * product is named.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";

import { alarmByCode, EMBEDDING, type CatalogEntry, type TelemetrySamples } from "@fdp/contracts";
import type { MqttClient } from "mqtt";

import { startApp, type RunningApp } from "../../src/app.ts";
import { loadEnv, type Env } from "../../src/config/env.ts";
import { query, queryOne, withTx, type Pool, type Queryable } from "../../src/db/pool.ts";
import type { DecisionBackendFactories } from "../../src/decision/select.ts";
import { createLogger } from "../../src/log.ts";
import { loadOverlayConfig } from "../../src/overlay/index.ts";
import { VERSION } from "../../src/pipeline/index.ts";
import {
  createEmbedder,
  l2Normalize,
  modelFilePath,
  toVectorLiteral,
  type Embedder,
} from "../../src/retrieval/embedder.ts";
import type { TestStack } from "./containers.ts";
import { connectAs, disconnect, subscribeGranted } from "./mqtt.ts";
import { withSlack } from "./timing.ts";

export const UNIT = "cau-7";

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** Poll until `predicate` holds, so a test never waits longer than it must. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = withSlack(20_000),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(25);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The embedder
// ---------------------------------------------------------------------------

/** A 32-bit FNV-1a hash, so a word always lands in the same dimension. */
function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The deterministic stand-in for the model: a normalised bag of hashed words.
 * Two texts are close when they share words, which is all the vector stage
 * needs to contribute a ranking.
 */
export function createHashEmbedder(dimension: number = EMBEDDING.dimension): Embedder {
  function embedOne(text: string): Float32Array {
    const vector = new Float32Array(dimension);
    for (const word of text.toLowerCase().split(/[^a-z]+/)) {
      if (word.length < 3) continue;
      const slot = fnv1a(word) % dimension;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    return l2Normalize(vector);
  }
  return { dimension, embed: (texts) => Promise.resolve(texts.map(embedOne)) };
}

/** The pinned model when `MODEL_CACHE_DIR` holds it (or a download is allowed), else the hash. */
export async function chooseEmbedder(): Promise<{ embedder: Embedder; real: boolean }> {
  const allowDownload = process.env.EMBEDDER_ALLOW_DOWNLOAD === "true";
  const cacheDir = process.env.MODEL_CACHE_DIR ?? join(tmpdir(), "fdp-models");
  const cached = EMBEDDING.files.every((file) =>
    existsSync(modelFilePath(EMBEDDING, cacheDir, file.path)),
  );
  if (!cached && !allowDownload) return { embedder: createHashEmbedder(), real: false };
  return { embedder: await createEmbedder({ cacheDir, allowDownload }), real: true };
}

// ---------------------------------------------------------------------------
// The catalog, stored as init stores it
// ---------------------------------------------------------------------------

async function insertId(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ id: string }>(db, `${sql} RETURNING id`, params);
  if (row === undefined) throw new Error(`no id returned by: ${sql}`);
  return Number(row.id);
}

/** One troubleshooting chunk per cause, in init's table-chunk format. */
function troubleshootingChunk(entry: CatalogEntry): string {
  const title = entry.manual_ref.title ?? entry.name;
  return (
    `${entry.manual_ref.section} ${title} — Fault finding\n` +
    `Cause: ${entry.name} | Check: ${entry.checks.join(" ")} | Remedy: ${entry.remedy}`
  );
}

/**
 * Store `entries` as an ingested manual: document, sections, conditions,
 * causes and their links, checks, remedies, signal moves, alarms and one
 * troubleshooting chunk per cause with its vector, and the ingest run marked
 * `succeeded` last, in one transaction, as the owning role.
 */
export async function storeCatalog(
  admin: Pool,
  entries: readonly CatalogEntry[],
  embedder: Embedder,
): Promise<number> {
  const chunks = entries.map(troubleshootingChunk);
  const vectors = await embedder.embed(chunks);

  return withTx(admin, async (tx) => {
    const documentId = await insertId(
      tx,
      "INSERT INTO app.manual_documents (name, path, variant, sha256, bytes, pages) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        "Operator manual (runtime test)",
        "/manual/runtime-test.pdf",
        "clean",
        "c".repeat(64),
        4_096,
        12,
      ],
    );
    const runId = await insertId(
      tx,
      "INSERT INTO app.ingest_runs (document_id, status, embedding_model_id, embedding_revision, embedding_dimension, catalog_source) " +
        "VALUES ($1, 'running', $2, $3, $4, 'yaml')",
      [documentId, EMBEDDING.model_id, EMBEDDING.revision, EMBEDDING.dimension],
    );

    const sections = new Map<string, string>();
    for (const entry of entries) {
      if (!sections.has(entry.manual_ref.section)) {
        sections.set(entry.manual_ref.section, entry.manual_ref.title ?? entry.name);
      }
    }
    for (const [ref, title] of sections) {
      const parent = ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : null;
      await query(
        tx,
        "INSERT INTO app.catalog_sections (document_id, section_ref, title, level, parent_ref) VALUES ($1, $2, $3, $4, $5)",
        [documentId, ref, title, ref.split(".").length, parent],
      );
    }

    const conditionPks = new Map<string, number>();
    for (const entry of entries) {
      for (const condition of entry.conditions) {
        if (conditionPks.has(condition.condition_id)) continue;
        conditionPks.set(
          condition.condition_id,
          await insertId(
            tx,
            "INSERT INTO app.catalog_conditions (document_id, condition_id, title, symptoms, alarm_codes, source) " +
              "VALUES ($1, $2, $3, $4, $5, 'yaml')",
            [documentId, condition.condition_id, condition.title, [], condition.alarms],
          ),
        );
      }
    }

    for (const [index, entry] of entries.entries()) {
      const causePk = await insertId(
        tx,
        "INSERT INTO app.catalog_causes (document_id, fault_id, name, summary, subsystem, benign, remedy, parts, " +
          "maintenance, related_alarms, manual_section, manual_anchor, source) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        [
          documentId,
          entry.fault_id,
          entry.name,
          entry.summary,
          entry.subsystem,
          entry.benign,
          entry.remedy,
          entry.parts,
          entry.maintenance,
          entry.related_alarms,
          entry.manual_ref.section,
          entry.manual_ref.anchor ?? null,
          entry.source,
        ],
      );
      for (const [ordinal, condition] of entry.conditions.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_condition_causes (condition_pk, cause_pk, ordinal, likelihood, note) VALUES ($1, $2, $3, $4, $5)",
          [
            conditionPks.get(condition.condition_id),
            causePk,
            ordinal,
            condition.likelihood,
            condition.note ?? null,
          ],
        );
      }
      for (const [ordinal, instruction] of entry.checks.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_checks (cause_pk, ordinal, instruction) VALUES ($1, $2, $3)",
          [causePk, ordinal, instruction],
        );
      }
      await query(
        tx,
        "INSERT INTO app.catalog_remedies (cause_pk, ordinal, action) VALUES ($1, 0, $2)",
        [causePk, entry.remedy],
      );
      for (const [ordinal, move] of entry.signal_moves.entries()) {
        await query(
          tx,
          "INSERT INTO app.catalog_signal_moves (cause_pk, ordinal, signal_id, behaviour, direction, phase, onset, note, text) " +
            "VALUES ($1, $2, $3, $4, $5, coalesce($6, 'any'), coalesce($7, 'sustained'), $8, $9)",
          [
            causePk,
            ordinal,
            move.signal ?? null,
            move.behaviour ?? null,
            move.direction,
            move.phase ?? null,
            move.onset ?? null,
            move.note ?? null,
            move.text ?? null,
          ],
        );
      }
      const vector = vectors[index];
      if (vector === undefined) throw new Error(`no vector for ${entry.fault_id}`);
      await query(
        tx,
        "INSERT INTO app.chunks (document_id, ordinal, section_ref, section_title, kind, content, embedding, fault_id, table_kind) " +
          "VALUES ($1, $2, $3, $4, 'table', $5, $6::vector, $7, 'troubleshooting')",
        [
          documentId,
          index,
          entry.manual_ref.section,
          entry.manual_ref.title ?? entry.name,
          chunks[index],
          toVectorLiteral(vector),
          entry.fault_id,
        ],
      );
    }

    const codes = [...new Set(entries.flatMap((entry) => entry.related_alarms))].sort();
    for (const code of codes) {
      const alarm = alarmByCode(code);
      if (alarm === undefined) throw new Error(`the fixture names an unknown alarm: ${code}`);
      await query(
        tx,
        "INSERT INTO app.catalog_alarms (document_id, code, type, title) VALUES ($1, $2, $3, $4)",
        [documentId, code, alarm.type, alarm.title],
      );
    }

    await query(
      tx,
      "UPDATE app.ingest_runs SET status = 'succeeded', finished_wall_ts = now() WHERE id = $1",
      [runId],
    );
    return documentId;
  });
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface AppUnderTest {
  readonly app: RunningApp;
  readonly env: Env;
  /** `http://127.0.0.1:<port>`. */
  readonly httpUrl: string;
  /** `ws://127.0.0.1:<port>/ws`. */
  readonly wsUrl: string;
  /** Every log line the service wrote, as written. */
  readonly logs: string[];
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Variables on top of the stack's connection settings. */
  readonly env?: Readonly<Record<string, string>>;
  readonly embedder?: Embedder;
  readonly decision?: Partial<DecisionBackendFactories>;
}

/** A writable stream that keeps every line pino writes to it. */
function lineCollector(lines: string[]): Writable {
  let partial = "";
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      partial += chunk.toString();
      const complete = partial.split("\n");
      partial = complete.pop() ?? "";
      lines.push(...complete.filter((line) => line !== ""));
      callback();
    },
  });
}

/**
 * `startApp` against the test stack, listening on a free port, with the
 * overlay on its own credentials and the log captured.
 */
export async function startAppOn(
  stack: TestStack,
  options: StartOptions = {},
): Promise<AppUnderTest> {
  const env = loadEnv({
    PORT: "0",
    LOG_LEVEL: "info",
    UNIT_ID: UNIT,
    DATABASE_URL_APP: stack.pg.urlFor("app_rw"),
    MQTT_URL: stack.mqtt.url,
    MQTT_BACKEND_DIAG_PASSWORD: stack.mqtt.credentials["backend-diag"],
    ...options.env,
  });
  const overlayConfig = loadOverlayConfig({
    UNIT_ID: UNIT,
    DATABASE_URL_GT: stack.pg.urlFor("gt_rw"),
    MQTT_URL: stack.mqtt.url,
    MQTT_BACKEND_OPS_PASSWORD: stack.mqtt.credentials["backend-ops"],
  });
  const logs: string[] = [];
  const logger = createLogger(
    { logLevel: env.logLevel, unitId: env.unitId, version: VERSION },
    lineCollector(logs),
  );
  const embedder = options.embedder ?? createHashEmbedder();

  const app = await startApp(env, {
    logger,
    overlayConfig,
    factories: { embedder: () => Promise.resolve(embedder), decision: options.decision },
  });
  const address = app.fastify.server.address();
  if (address === null || typeof address === "string") {
    await app.stop();
    throw new Error("the service is not listening on a TCP port");
  }
  return {
    app,
    env,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    logs,
    stop: () => app.stop(),
  };
}

/** The free-form counters of `GET /api/health` (the runtime's queue among them). */
export async function healthCounters(target: AppUnderTest): Promise<Record<string, number>> {
  const response = await fetch(`${target.httpUrl}/api/health`);
  const body = (await response.json()) as { counters: Record<string, number> };
  return body.counters;
}

/** Wait until the service has handled at least `count` batches and nothing is queued. */
export async function waitForBatches(target: AppUnderTest, count: number): Promise<void> {
  await waitUntil(async () => {
    const counters = await healthCounters(target);
    return (counters.telemetry_batches ?? 0) >= count && counters.telemetry_queued === 0;
  }, `${count} telemetry batches handled`);
}

// ---------------------------------------------------------------------------
// Watching the broker
// ---------------------------------------------------------------------------

export interface ObservedMessage {
  readonly topic: string;
  /** The parsed JSON payload. */
  readonly payload: unknown;
  /** The payload as it came off the wire. */
  readonly raw: string;
}

export interface BrokerObserver {
  readonly messages: ObservedMessage[];
  /** The messages on one topic, parsed, in arrival order. */
  on<T = unknown>(topic: string): T[];
  close(): Promise<void>;
}

/** Subscribe `filter` as the read-only `eval` credential and keep everything that arrives. */
export async function observeBroker(stack: TestStack, filter: string): Promise<BrokerObserver> {
  const client: MqttClient = await connectAs(stack.mqtt, "eval");
  const messages: ObservedMessage[] = [];
  client.on("message", (topic, payload) => {
    const raw = payload.toString("utf8");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // Keep the text: a non-JSON payload is still something the test may assert on.
    }
    messages.push({ topic, payload: parsed, raw });
  });
  const granted = await subscribeGranted(client, filter);
  if (granted !== 1) throw new Error(`the eval credential could not subscribe ${filter}`);
  return {
    messages,
    on: <T>(topic: string) =>
      messages.filter((message) => message.topic === topic).map((message) => message.payload as T),
    close: () => disconnect(client),
  };
}

// ---------------------------------------------------------------------------
// The gateway's side of the wire
// ---------------------------------------------------------------------------

/** Publishes fixture batches as the `gateway` credential. */
export interface GatewayPublisher {
  /**
   * Publish `batches` in order at about `perSecond` batches a second; stop
   * early, after the batch that makes `until` hold. Resolves with how many
   * were published.
   */
  publish(
    batches: readonly TelemetrySamples[],
    options?: { perSecond?: number; until?: () => boolean },
  ): Promise<number>;
  close(): Promise<void>;
}

export async function gatewayPublisher(stack: TestStack): Promise<GatewayPublisher> {
  const client = await connectAs(stack.mqtt, "gateway");
  const topic = `plant/${UNIT}/telemetry/samples`;
  return {
    async publish(batches, options = {}) {
      const pause = 1_000 / (options.perSecond ?? 200);
      let count = 0;
      for (const batch of batches) {
        await client.publishAsync(topic, JSON.stringify(batch), { qos: 1 });
        count += 1;
        if (options.until?.() === true) break;
        await sleep(pause);
      }
      return count;
    },
    close: () => disconnect(client),
  };
}

// ---------------------------------------------------------------------------
// The browser's side of the wire
// ---------------------------------------------------------------------------

export interface WsFrame {
  readonly type: string;
  readonly payload: unknown;
}

export interface WsClient {
  readonly frames: WsFrame[];
  /** The raw text of every frame, for the secret-leak scan. */
  readonly raw: string[];
  close(): Promise<void>;
}

/** Open `GET /ws` with Node's WebSocket and keep every frame. */
export async function openSocket(url: string): Promise<WsClient> {
  const socket = new WebSocket(url);
  const frames: WsFrame[] = [];
  const raw: string[] = [];
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    raw.push(text);
    frames.push(JSON.parse(text) as WsFrame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error(`cannot open ${url}`));
    });
  });
  return {
    frames,
    raw,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.addEventListener("close", () => {
          resolve();
        });
        socket.close();
      }),
  };
}
