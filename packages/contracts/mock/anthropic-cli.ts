#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-anthropic-mock`, the command the `mock-anthropic` package script runs. It starts the mock
// Anthropic Messages server, prints the URL it bound to as its first line and keeps running until
// it is signalled.
//
// A test in another language cannot reach `script()` or `failNext()` across the process
// boundary — `tools/init`'s integration test drives this command from Python — so the command
// line carries both: `--reply` names a JSON file with the scripted reply (or a sequence of
// them), and every `--fail-next` queues failures ahead of it. One process is one scenario.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import {
  startMockAnthropic,
  type AnthropicFailStatus,
  type MessagePolicy,
  type MockStopReason,
  type ScriptedMessage,
} from "./anthropic-mock.ts";
import { UsageError } from "./cli.ts";

const FAIL_STATUSES: readonly AnthropicFailStatus[] = [400, 401, 422, 429, 500, 529];
const STOP_REASONS: readonly MockStopReason[] = ["end_turn", "refusal", "max_tokens"];

const USAGE = `Usage: fdp-anthropic-mock [options]

  --port <n>            Port to listen on; 0 picks a free one. Default 8090.
  --host <address>      Address to bind. Default 127.0.0.1.
  --api-key <key>       The only accepted key. Default: any non-empty key.
  --latency-ms <n>      Delay before each answer. Default 0.
  --reply <file>        JSON file holding one scripted reply, or an array of them answered in
                        order with the last one repeating. Default: the text {} and end_turn.
  --fail-next <spec>    <status>[:<times>[:<retry-after-s>]], status one of
                        ${FAIL_STATUSES.join(" ")}; served before any answer. Repeatable.
  --quiet               Do not log one line per request.
  -h, --help            Print this message.
`;

/** One `--fail-next`: the status, how many answers it replaces and its `retry-after`. */
export interface FailureSpec {
  readonly status: AnthropicFailStatus;
  readonly times: number;
  readonly retryAfterS?: number;
}

/** The settings `parseArgs` resolves out of the command line. */
export interface AnthropicCliOptions {
  readonly port: number;
  readonly host: string;
  readonly apiKey?: string;
  readonly latencyMs: number;
  /** Empty when no `--reply` was given, which keeps the mock's default reply. */
  readonly replies: readonly ScriptedMessage[];
  readonly failures: readonly FailureSpec[];
  readonly quiet: boolean;
}

/** Reads a `--reply` file; a test swaps it for an in-memory map. */
export type ReadText = (path: string) => string;

const readUtf8: ReadText = (path) => readFileSync(path, "utf8");

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}

function nonNegativeInteger(flag: string, text: string): number {
  const parsed = Number(text);
  if (text === "" || !Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} needs a non-negative integer, got ${text}`);
  }
  return parsed;
}

function isFailStatus(value: number): value is AnthropicFailStatus {
  return (FAIL_STATUSES as readonly number[]).includes(value);
}

/** Parses `<status>[:<times>[:<retry-after-s>]]`, for example `429:3:0.01`. */
export function parseFailure(spec: string): FailureSpec {
  const [statusText = "", timesText, retryText, ...rest] = spec.split(":");
  const status = Number(statusText);
  if (rest.length > 0 || !isFailStatus(status)) {
    throw new UsageError(
      `--fail-next needs <status>[:<times>[:<retry-after-s>]] with a status of ` +
        `${FAIL_STATUSES.join(", ")}, got ${spec}`,
    );
  }
  const times = timesText === undefined ? 1 : nonNegativeInteger("--fail-next times", timesText);
  if (times < 1) throw new UsageError(`--fail-next times must be at least 1, got ${spec}`);
  if (retryText === undefined) return { status, times };
  const retryAfterS = Number(retryText);
  if (retryText === "" || !Number.isFinite(retryAfterS) || retryAfterS < 0) {
    throw new UsageError(`--fail-next retry-after must be a non-negative number, got ${spec}`);
  }
  return { status, times, retryAfterS };
}

function scriptedMessage(value: unknown, file: string): ScriptedMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`--reply ${file}: every reply must be a JSON object`);
  }
  const stopReason = (value as { stopReason?: unknown }).stopReason;
  if (stopReason !== undefined && !(STOP_REASONS as readonly unknown[]).includes(stopReason)) {
    throw new UsageError(
      `--reply ${file}: stopReason must be one of ${STOP_REASONS.join(", ")}, got ${String(stopReason)}`,
    );
  }
  return value as ScriptedMessage;
}

/** Reads a `--reply` file: one scripted reply, or a non-empty array of them. */
export function readReplies(file: string, readText: ReadText = readUtf8): ScriptedMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(file)) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`--reply ${file}: ${reason}`);
  }
  const replies = Array.isArray(parsed) ? parsed : [parsed];
  if (replies.length === 0) throw new UsageError(`--reply ${file}: the array is empty`);
  return replies.map((reply) => scriptedMessage(reply, file));
}

/** Parses the command line; exported so a test can drive it without a process. */
export function parseArgs(
  argv: readonly string[],
  readText: ReadText = readUtf8,
): AnthropicCliOptions {
  let port = 8090;
  let host = "127.0.0.1";
  let apiKey: string | undefined;
  let latencyMs = 0;
  let replies: ScriptedMessage[] = [];
  const failures: FailureSpec[] = [];
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const next = (): string => {
      index += 1;
      return requireValue(flag, argv[index]);
    };
    switch (flag) {
      case "--port":
        port = nonNegativeInteger(flag, next());
        break;
      case "--host":
        host = next();
        break;
      case "--api-key":
        apiKey = next();
        break;
      case "--latency-ms":
        latencyMs = nonNegativeInteger(flag, next());
        break;
      case "--reply":
        replies = readReplies(next(), readText);
        break;
      case "--fail-next":
        failures.push(parseFailure(next()));
        break;
      case "--quiet":
        quiet = true;
        break;
      case "-h":
      case "--help":
        throw new UsageError("");
      default:
        throw new UsageError(`unknown option ${flag}`);
    }
  }
  return { port, host, apiKey, latencyMs, replies, failures, quiet };
}

/** The policy for `--reply`: the n-th answer gets the n-th reply, the last one repeating. */
export function replyPolicy(replies: readonly ScriptedMessage[]): MessagePolicy | undefined {
  const last = replies.at(-1);
  if (last === undefined) return undefined;
  return (_request, index) => replies[index] ?? last;
}

async function run(options: AnthropicCliOptions): Promise<void> {
  const mock = await startMockAnthropic({
    port: options.port,
    host: options.host,
    apiKey: options.apiKey,
    latencyMs: options.latencyMs,
    reply: replyPolicy(options.replies),
    log: options.quiet
      ? undefined
      : (line: string): void => {
          process.stdout.write(`${line}\n`);
        },
  });
  for (const failure of options.failures) {
    mock.failNext(failure.status, failure.times, failure.retryAfterS);
  }

  process.stdout.write(`fdp-anthropic-mock listening on ${mock.url}\n`);

  const stop = (): void => {
    void mock.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function parseOrExit(): AnthropicCliOptions {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message === "") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    process.stderr.write(`fdp-anthropic-mock: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

// `mock/anthropic-cli.test.ts` imports `parseArgs`, so the server starts only when this file is
// the process entry point and not when the module is merely loaded.
const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === import.meta.filename) await run(parseOrExit());
