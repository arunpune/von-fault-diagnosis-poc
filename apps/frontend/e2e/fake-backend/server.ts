// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fake backend of the mock-mode end-to-end suite: Node `http` and `ws`, no framework, every
// REST route and every WebSocket frame of docs/api.md as the contracts settled them, typed against
// `src/api/types.ts` so the compiler catches drift between the UI's view of the contract and this
// second implementation of it. Behind the routes sits the scripted scenario of `scenario.ts`.
//
// A control API steers it from the tests; `vite preview` does not proxy it, so a test reaches it
// directly at the URL the launcher prints (`FAKE_BACKEND_URL`):
//
//   POST /__test/emit      any `ws-server-message` frame (`schema`, `unit_id` and `wall_ts` may be
//                          left out); records it carries are taken in, then it is sent as is
//   POST /__test/stream    { samples_per_s, seconds }: replay at that rate, whatever the speed
//   POST /__test/restart-ws  close every socket (1012); the client has to reconnect
//   POST /__test/reset     a fresh scenario, `?backend=rules` (or `{ backend }`) for the rules
//                          backend; every socket is closed as on a restart
//
// Run on its own with `node e2e/fake-backend/server.ts`: `PORT` (0, the default, picks a free
// port), `HOST` (127.0.0.1) and `FAKE_DECISION_BACKEND` (von | rules); it prints
// `FAKE_BACKEND_PORT=<port>` once it listens.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import { findFault, OVERLAY_CATALOG, SIGNALS } from "./data.ts";
import { SERIES_POINTS_MAX } from "./decimate.ts";
import {
  CLOSE_SERVICE_RESTART,
  createHub,
  FLUSH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./hub.ts";
import type { BackendMode } from "./pipeline.ts";
import { apiError, isRecord, ISO_PATTERN } from "./requests.ts";
import { createScenario, UNIT_ID, type Reply, type Scenario } from "./scenario.ts";
import { InvalidCursorError, type PageQuery, type SimRange } from "./store.ts";

import type { ServerFrame } from "@/api/ws-types";
import type { TicketStatusFilter } from "@/api/types";

/** Wall time between two scenario ticks. */
const TICK_INTERVAL_MS = 50;

const MAX_BODY_BYTES = 1_048_576;
const MAX_STREAM_SAMPLES_PER_S = 5000;
const MAX_STREAM_SECONDS = 600;
const TICKET_FILTERS: readonly TicketStatusFilter[] = [
  "review",
  "open",
  "resolved",
  "closed",
  "all",
];
const BACKENDS: readonly BackendMode[] = ["von", "rules"];

export interface FakeBackendOptions {
  /** 0 (the default) lets the system pick a free port. */
  readonly port?: number;
  readonly host?: string;
  readonly backend?: BackendMode;
  readonly seed?: number;
}

export interface FakeBackend {
  readonly port: number;
  /** `http://<host>:<port>`, what `FDP_BACKEND_URL` and the control API use. */
  readonly url: string;
  close(): Promise<void>;
}

/** A query parameter or a body the route refuses: HTTP 400 `bad_request`. */
class BadRequest extends Error {
  readonly parameter: string | undefined;

  constructor(message: string, parameter?: string) {
    super(message);
    this.name = "BadRequest";
    this.parameter = parameter;
  }
}

interface Request {
  readonly method: string;
  readonly url: URL;
  /** The path's captured segments, decoded. */
  readonly params: readonly string[];
  readonly body: unknown;
}

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  handle(request: Request): Reply<unknown>;
}

function ok<T>(body: T, status = 200): Reply<T> {
  return { status, body };
}

function notFound(what: string): Reply<never> {
  return { status: 404, body: apiError("not_found", what) };
}

// --- query parameters ---------------------------------------------------------------------------

function textParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function intParam(url: URL, name: string, max: number): number | undefined {
  const value = textParam(url, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequest(`${name} must be an integer from 1 to ${max}`, name);
  }
  return parsed;
}

function instantParam(url: URL, name: string): number | undefined {
  const value = textParam(url, name);
  if (value === undefined) {
    return undefined;
  }
  if (!ISO_PATTERN.test(value)) {
    throw new BadRequest(`${name} is not an iso_ts instant`, name);
  }
  return Date.parse(value);
}

function booleanParam(url: URL, name: string): boolean | undefined {
  const value = textParam(url, name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    throw new BadRequest(`${name} must be true or false`, name);
  }
  return value === "true";
}

function pageQuery(url: URL): PageQuery {
  return { limit: intParam(url, "limit", 1000), before: textParam(url, "before") };
}

function rangeQuery(url: URL): SimRange {
  return { fromMs: instantParam(url, "from"), toMs: instantParam(url, "to") };
}

function seriesTags(url: URL): readonly string[] {
  const list = textParam(url, "signals") ?? textParam(url, "tags");
  if (list === undefined) {
    return SIGNALS.map((signal) => signal.signal_id);
  }
  const tags = list.split(",").filter((tag) => tag !== "");
  const unknown = tags.filter((tag) => !SIGNALS.some((signal) => signal.signal_id === tag));
  if (unknown.length > 0) {
    throw new BadRequest(`unknown tags: ${unknown.join(", ")}`, "tags");
  }
  return tags;
}

function ticketFilter(url: URL): TicketStatusFilter {
  const value = textParam(url, "status") ?? "all";
  const filter = TICKET_FILTERS.find((candidate) => candidate === value);
  if (filter === undefined) {
    throw new BadRequest(`status must be one of ${TICKET_FILTERS.join(", ")}`, "status");
  }
  return filter;
}

function backendOf(request: Request): BackendMode {
  const fromBody = isRecord(request.body) ? request.body.backend : undefined;
  const value = textParam(request.url, "backend") ?? fromBody ?? "von";
  const backend = BACKENDS.find((candidate) => candidate === value);
  if (backend === undefined) {
    throw new BadRequest(`backend must be one of ${BACKENDS.join(", ")}`, "backend");
  }
  return backend;
}

// --- the server ---------------------------------------------------------------------------------

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new BadRequest("the body is larger than 1 MB");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest("the body is not JSON");
  }
}

function send(response: ServerResponse, reply: Reply<unknown>): void {
  const text = JSON.stringify(reply.body);
  response.writeHead(reply.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

/** A frame for `/__test/emit`: the envelope is completed, the rest is the caller's. */
function frameOf(body: unknown, wallIso: string): ServerFrame {
  if (!isRecord(body) || typeof body.type !== "string" || !isRecord(body.payload)) {
    throw new BadRequest("the body must be a frame { type, payload }");
  }
  // The control API exists to send what the scenario would not, including frames a test builds
  // to probe the UI's default branches, so the payload is passed on unchecked.
  return {
    schema: "urn:fdp:schema:ws-server-message:v1",
    unit_id: UNIT_ID,
    wall_ts: wallIso,
    ...body,
  } as ServerFrame;
}

export async function startFakeBackend(options: FakeBackendOptions = {}): Promise<FakeBackend> {
  const host = options.host ?? "127.0.0.1";
  const wall = (): number => Date.now();
  const hub = createHub({ unitId: UNIT_ID, wall, source: () => scenario });

  function newScenario(backend: BackendMode): Scenario {
    return createScenario({
      backend,
      seed: options.seed,
      wall,
      sink: {
        frame: (type, payload) => hub.frame(type, payload),
        samples: (samples) => hub.pushSamples(samples),
      },
    });
  }

  let scenario = newScenario(options.backend ?? "von");

  const routes: readonly Route[] = [
    { method: "GET", pattern: /^\/api\/health$/, handle: () => ok(scenario.health()) },
    { method: "GET", pattern: /^\/api\/status$/, handle: () => ok(scenario.status()) },
    { method: "GET", pattern: /^\/api\/signals$/, handle: () => ok({ signals: SIGNALS }) },
    {
      method: "GET",
      pattern: /^\/api\/(?:telemetry\/series|series)$/,
      handle: ({ url }) => {
        const range = rangeQuery(url);
        if (range.fromMs === undefined || range.toMs === undefined) {
          throw new BadRequest(
            "from and to are required",
            range.fromMs === undefined ? "from" : "to",
          );
        }
        if (range.fromMs > range.toMs) {
          throw new BadRequest("from is after to", "from");
        }
        return ok(
          scenario.series({
            tags: seriesTags(url),
            fromMs: range.fromMs,
            toMs: range.toMs,
            points: intParam(url, "points", SERIES_POINTS_MAX) ?? SERIES_POINTS_MAX,
          }),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/events(?:\/suspect)?$/,
      handle: ({ url }) => ok(scenario.records.events(pageQuery(url))),
    },
    {
      method: "GET",
      pattern: /^\/api\/decisions$/,
      handle: ({ url }) =>
        ok(
          scenario.records.decisions({
            ...pageQuery(url),
            episodeId: textParam(url, "episode_id"),
          }),
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/decisions\/([^/]+)$/,
      handle: ({ params: [id = ""] }) => {
        const decision = scenario.records.decision(id);
        return decision === undefined ? notFound(`no decision with id ${id}`) : ok(decision);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/tickets$/,
      handle: ({ url }) => ok(scenario.records.tickets(ticketFilter(url), pageQuery(url))),
    },
    {
      method: "GET",
      pattern: /^\/api\/tickets\/([^/]+)$/,
      handle: ({ params: [id = ""] }) => {
        const ticket = scenario.records.ticketDetail(id);
        return ticket === undefined ? notFound(`no ticket with id ${id}`) : ok(ticket);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/tickets\/([^/]+)\/close$/,
      handle: ({ params: [id = ""], body }) => scenario.closeTicket(id, body),
    },
    { method: "GET", pattern: /^\/api\/cost$/, handle: () => ok(scenario.records.cost()) },
    {
      method: "GET",
      pattern: /^\/api\/alerts\/system$/,
      handle: ({ url }) => ok({ items: scenario.records.alerts(booleanParam(url, "active")) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/catalog\/faults\/([^/]+)$/,
      handle: ({ params: [id = ""] }) => {
        const entry = findFault(id);
        return entry === undefined ? notFound(`no catalog entry for ${id}`) : ok(entry);
      },
    },
    { method: "GET", pattern: /^\/api\/overlay\/catalog$/, handle: () => ok(OVERLAY_CATALOG) },
    {
      method: "GET",
      pattern: /^\/api\/overlay\/active$/,
      handle: () => ok(scenario.overlayActive()),
    },
    {
      method: "GET",
      pattern: /^\/api\/overlay\/injections$/,
      handle: ({ url }) => ok({ items: scenario.records.intervals(rangeQuery(url)) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/overlay\/markers$/,
      handle: ({ url }) => ok({ items: scenario.records.markers(rangeQuery(url)) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/sim\/([^/]+)$/,
      handle: ({ params: [segment = ""], body }) => scenario.command(segment, body),
    },
    {
      method: "POST",
      pattern: /^\/__test\/emit$/,
      handle: ({ body }) => {
        const frame = frameOf(body, new Date(wall()).toISOString());
        scenario.ingest(frame);
        return ok({ receivers: hub.send(frame) }, 202);
      },
    },
    {
      method: "POST",
      pattern: /^\/__test\/stream$/,
      handle: ({ body }) => {
        const rate = isRecord(body) ? body.samples_per_s : undefined;
        const seconds = isRecord(body) ? body.seconds : undefined;
        if (typeof rate !== "number" || rate <= 0 || rate > MAX_STREAM_SAMPLES_PER_S) {
          throw new BadRequest(
            `samples_per_s must be above 0 and at most ${MAX_STREAM_SAMPLES_PER_S}`,
          );
        }
        if (typeof seconds !== "number" || seconds <= 0 || seconds > MAX_STREAM_SECONDS) {
          throw new BadRequest(`seconds must be above 0 and at most ${MAX_STREAM_SECONDS}`);
        }
        scenario.stream(rate, seconds);
        return ok(
          { samples_per_s: rate, until_wall_ts: new Date(wall() + seconds * 1000).toISOString() },
          202,
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/__test\/restart-ws$/,
      handle: () =>
        ok({ closed: hub.closeAll(CLOSE_SERVICE_RESTART, "restart requested by a test") }),
    },
    {
      method: "POST",
      pattern: /^\/__test\/reset$/,
      handle: (request) => {
        const backend = backendOf(request);
        hub.flush();
        scenario = newScenario(backend);
        return ok({
          backend,
          closed: hub.closeAll(CLOSE_SERVICE_RESTART, "the fake backend was reset"),
        });
      },
    },
  ];

  function route(method: string, path: string): { route: Route; params: string[] } | undefined {
    for (const candidate of routes) {
      const match = candidate.method === method ? candidate.pattern.exec(path) : null;
      if (match !== null) {
        return { route: candidate, params: match.slice(1).map((part) => decodeURIComponent(part)) };
      }
    }
    return undefined;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://fake-backend");
    try {
      const found = route(method, url.pathname);
      if (found === undefined) {
        send(response, notFound(`no route for ${method} ${url.pathname}`));
        return;
      }
      const body = method === "POST" ? await readBody(request) : undefined;
      send(response, found.route.handle({ method, url, params: found.params, body }));
    } catch (error) {
      if (error instanceof BadRequest) {
        const details = error.parameter === undefined ? undefined : { parameter: error.parameter };
        send(response, { status: 400, body: apiError("bad_request", error.message, details) });
      } else if (error instanceof InvalidCursorError) {
        send(response, {
          status: 400,
          body: apiError("bad_cursor", error.message, { parameter: "before" }),
        });
      } else {
        console.error("fake backend: request failed", error);
        send(response, {
          status: 500,
          body: apiError("internal_error", "the request failed on the server"),
        });
      }
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://fake-backend").pathname;
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => hub.attach(ws));
  });

  const timers = [
    setInterval(() => scenario.tick(), TICK_INTERVAL_MS),
    setInterval(() => hub.flush(), FLUSH_INTERVAL_MS),
    setInterval(() => hub.heartbeat(), HEARTBEAT_INTERVAL_MS),
  ];

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    url: `http://${host}:${port}`,
    async close() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      hub.closeAll(1001, "the fake backend is stopping");
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

async function main(): Promise<void> {
  const requested = process.env.FAKE_DECISION_BACKEND ?? "von";
  const backend = BACKENDS.find((candidate) => candidate === requested);
  if (backend === undefined) {
    throw new Error(`FAKE_DECISION_BACKEND must be one of ${BACKENDS.join(", ")}`);
  }
  const fake = await startFakeBackend({
    port: Number(process.env.PORT ?? 0),
    host: process.env.HOST ?? "127.0.0.1",
    backend,
  });
  process.stdout.write(`FAKE_BACKEND_PORT=${fake.port}\n`);
  const stop = (): void => {
    void fake.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.main) {
  await main();
}
