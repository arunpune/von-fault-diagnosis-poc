// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The plumbing both mock servers share: Node `http` only, no framework and no runtime dependency
// beyond the package's own Ajv.
//
// Two rules hold for every server built on this module:
//
//   * request bodies and credential header values never reach a log line. They are kept in
//     memory for assertions (`MockServer.requests`) with the credential values replaced, and
//     the optional `log` sink only ever sees `<method> <path> -> <status>`;
//   * nothing is random. Ids, token counts and answers are functions of the request and of
//     the request counter, so a Compose run and a unit test see the same bytes.

import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Header values the mocks replace before they record a request. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);

/** What a recorded credential header value reads as. The real value is never kept. */
export const REDACTED = "[redacted]";

/** Bodies larger than this are refused; a mock is never asked to buffer megabytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** One request as a test sees it afterwards. Credential header values are already gone. */
export interface RecordedRequest {
  /** Wall-clock arrival time, ISO-8601 with milliseconds. */
  readonly wallTs: string;
  readonly method: string;
  /** Path with its query string, as the client sent it. */
  readonly path: string;
  /** Lower-cased header names; the values of `CREDENTIAL_HEADERS` read `[redacted]`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON body, or the raw text when the body is not JSON, or `null` when empty. */
  readonly body: unknown;
}

/** Sink for the one-line, body-free request log. */
export type LogLine = (line: string) => void;

/** The shape every mock server exposes; each server adds its own scripting on top. */
export interface MockServer {
  /** Base URL with no trailing slash, for example `http://127.0.0.1:53124`. */
  readonly url: string;
  readonly port: number;
  /** Every request the server received, oldest first, including the ones it refused. */
  readonly requests: readonly RecordedRequest[];
  /** Drops the recorded requests, the scripted policy and the queued failures. */
  reset(): void;
  /** Stops listening and resolves once every connection is closed. */
  close(): Promise<void>;
}

/** A failure `failNext` queued: the status to answer with and its optional `retry-after`. */
export interface QueuedFailure {
  readonly status: number;
  readonly retryAfterS?: number;
}

/** The queue behind `failNext`: one entry is consumed per request, oldest first. */
export class FailureQueue {
  #queue: QueuedFailure[] = [];

  /** Queues `times` answers with `status`; they are served before anything else. */
  push(status: number, times: number, retryAfterS?: number): void {
    if (!Number.isInteger(times) || times < 1) {
      throw new RangeError(`failNext: \`times\` must be a positive integer, got ${String(times)}`);
    }
    for (let i = 0; i < times; i += 1) this.#queue.push({ status, retryAfterS });
  }

  /** Removes and returns the next queued failure, or `undefined` when none is queued. */
  take(): QueuedFailure | undefined {
    return this.#queue.shift();
  }

  clear(): void {
    this.#queue = [];
  }
}

/** Copies the headers with the credential values replaced by `REDACTED`. */
export function redactHeaders(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : value;
    out[name] = CREDENTIAL_HEADERS.has(name) ? REDACTED : text;
  }
  return out;
}

/** Thrown by `readBody` when the client sends more than `MAX_BODY_BYTES`. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Reads the whole request body as UTF-8 text. */
export async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The parsed body, or the raw text when it is not JSON, or `null` when it is empty. */
export function parseBody(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** `true` when `text` parses as JSON; the mocks answer 422 when it does not. */
export function isJson(text: string): boolean {
  if (text.trim() === "") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Writes a JSON body with its content length and no cache. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
}

/** Writes a plain-text body, used by `GET /healthz`. */
export function sendText(response: ServerResponse, status: number, text: string): void {
  const payload = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

/** Resolves after `ms`; `latencyMs` uses it to make a slow upstream reproducible. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The bearer token of an `Authorization` header, or `undefined` when there is none. */
export function bearerToken(message: IncomingMessage): string | undefined {
  const header = message.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+(\S+)$/.exec(header.trim());
  return match?.[1];
}

/** The path without its query string. */
export function pathOf(message: IncomingMessage): string {
  const raw = message.url ?? "/";
  const index = raw.indexOf("?");
  return index === -1 ? raw : raw.slice(0, index);
}

/** A listening server together with the address it actually bound to. */
export interface ListeningServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
}

/**
 * Starts `listener` on `host`:`port`. Port `0` binds a free port, which is what every test
 * uses so that parallel workers never collide.
 */
export async function listen(
  listener: RequestListener,
  host: string,
  port: number,
): Promise<ListeningServer> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const authority = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { server, url: `http://${authority}:${String(address.port)}`, port: address.port };
}

/** Stops a server and waits for its connections to end. */
export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && error.message !== "Server is not running.") reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}
