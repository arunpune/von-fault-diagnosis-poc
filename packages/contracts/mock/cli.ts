#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-typesafe-mock`, the command the `mock` package script and the Compose CI image run. It
// starts the mock TypeSafe server, prints the URL it bound to and keeps running until it is
// signalled.
//
// The answer policy comes from `--answer-policy`, or from `MOCK_ANSWER_POLICY` when the flag is
// absent; compose.ci.yaml sets the environment variable to `best-overlap` so that the stack's
// decision is a function of the request alone.

import { resolve } from "node:path";
import process from "node:process";

import { ANSWER_POLICY_NAMES, type AnswerPolicyName } from "./answers.ts";
import { answerPolicyFromEnv, startMockTypeSafe } from "./typesafe-mock.ts";

const USAGE = `Usage: fdp-typesafe-mock [options]

  --port <n>            Port to listen on; 0 picks a free one. Default 8089.
  --host <address>      Address to bind. Default 127.0.0.1 (a container uses 0.0.0.0).
  --api-key <key>       The only accepted bearer token. Default: any non-empty token.
  --latency-ms <n>      Delay before each API answer. Default 0.
  --answer-policy <p>   ${ANSWER_POLICY_NAMES.join(" | ")}. Default: $MOCK_ANSWER_POLICY or default.
  --quiet               Do not log one line per request.
  -h, --help            Print this message.
`;

/** The settings `parseArgs` resolves out of the command line and the environment. */
export interface CliOptions {
  readonly port: number;
  readonly host: string;
  readonly apiKey?: string;
  readonly latencyMs: number;
  readonly answerPolicy: AnswerPolicyName;
  readonly quiet: boolean;
}

/** A bad or missing flag value. `--help` throws one with an empty message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}

function requireInteger(flag: string, value: string | undefined): number {
  const text = requireValue(flag, value);
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} needs a non-negative integer, got ${text}`);
  }
  return parsed;
}

/** Parses the command line over the environment defaults; exported so a test can drive it. */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): CliOptions {
  const fromEnv = answerPolicyFromEnv(env.MOCK_ANSWER_POLICY);
  if ("error" in fromEnv) throw new UsageError(`MOCK_ANSWER_POLICY: ${fromEnv.error}`);

  let port = 8089;
  let host = "127.0.0.1";
  let apiKey: string | undefined;
  let latencyMs = 0;
  let answerPolicy = fromEnv.policy;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const next = (): string | undefined => {
      index += 1;
      return argv[index];
    };
    switch (flag) {
      case "--port":
        port = requireInteger(flag, next());
        break;
      case "--host":
        host = requireValue(flag, next());
        break;
      case "--api-key":
        apiKey = requireValue(flag, next());
        break;
      case "--latency-ms":
        latencyMs = requireInteger(flag, next());
        break;
      case "--answer-policy": {
        const chosen = answerPolicyFromEnv(requireValue(flag, next()));
        if ("error" in chosen) throw new UsageError(`--answer-policy: ${chosen.error}`);
        answerPolicy = chosen.policy;
        break;
      }
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
  return { port, host, apiKey, latencyMs, answerPolicy, quiet };
}

async function run(options: CliOptions): Promise<void> {
  const mock = await startMockTypeSafe({
    port: options.port,
    host: options.host,
    apiKey: options.apiKey,
    latencyMs: options.latencyMs,
    answerPolicy: options.answerPolicy,
    log: options.quiet
      ? undefined
      : (line: string): void => {
          process.stdout.write(`${line}\n`);
        },
  });

  process.stdout.write(
    `fdp-typesafe-mock listening on ${mock.url} (answers: ${options.answerPolicy})\n`,
  );

  const stop = (): void => {
    void mock.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function parseOrExit(): CliOptions {
  try {
    return parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message === "") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    process.stderr.write(`fdp-typesafe-mock: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

// `mock/cli.test.ts` imports `parseArgs`, so the server starts only when this file is the
// process entry point and not when the module is merely loaded.
const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === import.meta.filename) await run(parseOrExit());
