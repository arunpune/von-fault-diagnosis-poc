// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-anthropic-mock`: the flags it accepts, and the process itself — it is spawned on port 0,
// prints the URL it bound to as its first line, serves the scripted reply behind the queued
// failures and stops on SIGTERM. `tools/init`'s integration test drives the same entry point from
// Python, so a broken flag is caught here first.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { AnthropicMessagesRequest } from "./anthropic-mock.ts";
import { parseArgs, parseFailure, readReplies, replyPolicy } from "./anthropic-cli.ts";
import { UsageError } from "./cli.ts";

const CLI = fileURLToPath(new URL("./anthropic-cli.ts", import.meta.url));

const REQUEST: AnthropicMessagesRequest = {
  model: "claude-opus-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "Which cause fits?" }],
};

function files(contents: Record<string, string>): (path: string) => string {
  return (path) => {
    const text = contents[path];
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    return text;
  };
}

describe("parseArgs", () => {
  it("defaults to a loopback bind with the mock's own reply", () => {
    expect(parseArgs([])).toEqual({
      port: 8090,
      host: "127.0.0.1",
      apiKey: undefined,
      latencyMs: 0,
      replies: [],
      failures: [],
      quiet: false,
    });
  });

  it("reads every documented flag, and --fail-next more than once", () => {
    const read = files({ "reply.json": '{"json": {"fault_id": "oil_filter_clogged"}}' });
    expect(
      parseArgs(
        [
          "--port",
          "0",
          "--host",
          "0.0.0.0",
          "--api-key",
          "test",
          "--latency-ms",
          "5",
          "--reply",
          "reply.json",
          "--fail-next",
          "529",
          "--fail-next",
          "429:3:0.01",
          "--quiet",
        ],
        read,
      ),
    ).toEqual({
      port: 0,
      host: "0.0.0.0",
      apiKey: "test",
      latencyMs: 5,
      replies: [{ json: { fault_id: "oil_filter_clogged" } }],
      failures: [
        { status: 529, times: 1 },
        { status: 429, times: 3, retryAfterS: 0.01 },
      ],
      quiet: true,
    });
  });

  it("refuses an unknown flag, a missing value and a value that is not a number", () => {
    expect(() => parseArgs(["--nonsense"])).toThrow(/unknown option --nonsense/u);
    expect(() => parseArgs(["--reply"])).toThrow(/--reply needs a value/u);
    expect(() => parseArgs(["--port", "eight"])).toThrow(/non-negative integer/u);
    expect(() => parseArgs(["--latency-ms", "-1"])).toThrow(/non-negative integer/u);
  });

  it("treats --help as a usage request", () => {
    expect(() => parseArgs(["--help"])).toThrow(UsageError);
    expect(() => parseArgs(["-h"])).toThrow(/^$/u);
  });
});

describe("parseFailure", () => {
  it("defaults to one failure without retry-after", () => {
    expect(parseFailure("401")).toEqual({ status: 401, times: 1 });
    expect(parseFailure("529:2")).toEqual({ status: 529, times: 2 });
  });

  it("refuses a status failNext cannot serve and a malformed count or delay", () => {
    expect(() => parseFailure("418")).toThrow(/status of 400, 401, 422, 429, 500, 529/u);
    expect(() => parseFailure("429:0")).toThrow(/at least 1/u);
    expect(() => parseFailure("429:two")).toThrow(/non-negative integer/u);
    expect(() => parseFailure("429:1:-1")).toThrow(/non-negative number/u);
    expect(() => parseFailure("429:1:1:1")).toThrow(/<status>/u);
  });
});

describe("readReplies", () => {
  it("accepts one reply or a sequence of them", () => {
    const read = files({
      "one.json": '{"stopReason": "refusal"}',
      "many.json": '[{"text": "{}"}, {"stopReason": "max_tokens"}]',
    });
    expect(readReplies("one.json", read)).toEqual([{ stopReason: "refusal" }]);
    expect(readReplies("many.json", read)).toEqual([{ text: "{}" }, { stopReason: "max_tokens" }]);
  });

  it("names the file when it cannot use it", () => {
    const read = files({
      "prose.json": "not json",
      "empty.json": "[]",
      "scalar.json": "[1]",
      "stop.json": '{"stopReason": "tool_use"}',
    });
    expect(() => readReplies("missing.json", read)).toThrow(/--reply missing\.json: ENOENT/u);
    expect(() => readReplies("prose.json", read)).toThrow(/--reply prose\.json:/u);
    expect(() => readReplies("empty.json", read)).toThrow(/the array is empty/u);
    expect(() => readReplies("scalar.json", read)).toThrow(/must be a JSON object/u);
    expect(() => readReplies("stop.json", read)).toThrow(/stopReason must be one of/u);
  });
});

describe("replyPolicy", () => {
  it("answers the n-th request with the n-th reply and repeats the last one", () => {
    const policy = replyPolicy([{ text: "first" }, { text: "second" }]);
    expect(policy?.(REQUEST, 0)).toEqual({ text: "first" });
    expect(policy?.(REQUEST, 1)).toEqual({ text: "second" });
    expect(policy?.(REQUEST, 5)).toEqual({ text: "second" });
  });

  it("leaves the mock's default in place without a reply", () => {
    expect(replyPolicy([])).toBeUndefined();
  });
});

/** Collects stdout lines; `url` resolves with the first one, which must announce the URL. */
function watch(child: ChildProcessByStdio<null, Readable, Readable>): {
  url: Promise<string>;
  lines: string[];
} {
  const lines: string[] = [];
  const url = new Promise<string>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`the mock printed no URL; stdout was ${JSON.stringify(buffered)}`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const complete = buffered.split("\n");
      buffered = complete.pop() ?? "";
      for (const line of complete) {
        lines.push(line);
        if (lines.length === 1) {
          clearTimeout(timer);
          const match = /^fdp-anthropic-mock listening on (http:\/\/\S+)$/u.exec(line);
          if (match?.[1] === undefined) reject(new Error(`unexpected first line ${line}`));
          else resolve(match[1]);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { url, lines };
}

/** Resolves once `lines` holds `count` lines: a log line trails the response it describes. */
async function linesArrive(lines: readonly string[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (lines.length < count) {
    if (Date.now() > deadline) throw new Error(`only ${String(lines.length)} lines arrived`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the process", () => {
  const directory = mkdtempSync(join(tmpdir(), "fdp-anthropic-cli-"));
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("prints the URL first, fails as queued, then answers the scripted reply", async () => {
    const reply = join(directory, "reply.json");
    writeFileSync(reply, JSON.stringify({ json: { fault_id: "oil_filter_clogged" } }));
    const child = spawn(
      process.execPath,
      [CLI, "--port", "0", "--api-key", "test", "--reply", reply, "--fail-next", "529:1:0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const { url, lines } = watch(child);
    try {
      const base = await url;
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const send = (): Promise<Response> =>
        fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "test" },
          body: JSON.stringify(REQUEST),
        });

      const overloaded = await send();
      expect(overloaded.status).toBe(529);
      expect(overloaded.headers.get("retry-after")).toBe("0");
      const answered = await send();
      expect(answered.status).toBe(200);
      const message = (await answered.json()) as { content: { text: string }[] };
      expect(JSON.parse(message.content[0]?.text ?? "null")).toEqual({
        fault_id: "oil_filter_clogged",
      });
      await linesArrive(lines, 3);
      expect(lines.slice(1)).toEqual(["POST /v1/messages -> 529", "POST /v1/messages -> 200"]);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  }, 30_000);

  it("exits with code 2 and prints usage on a bad --fail-next", async () => {
    const child = spawn(process.execPath, [CLI, "--fail-next", "418"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const code = await exited;
    expect(code).toBe(2);
    expect(stderr).toContain("--fail-next needs <status>");
    expect(stderr).toContain("Usage: fdp-anthropic-mock");
  }, 30_000);
});
