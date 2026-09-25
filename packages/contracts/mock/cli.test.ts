// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-typesafe-mock`: the flags it accepts, and the process itself — it is spawned on port 0,
// prints the URL it bound to, answers `/healthz` and stops on SIGTERM. The Compose CI image runs
// the same entry point, so a broken flag is caught here and not in a stack that will not come up.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "./cli.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("parseArgs", () => {
  it("defaults to the Compose port and a loopback bind", () => {
    expect(parseArgs([])).toEqual({
      port: 8089,
      host: "127.0.0.1",
      apiKey: undefined,
      latencyMs: 0,
      answerPolicy: "default",
      quiet: false,
    });
  });

  it("reads every documented flag", () => {
    expect(
      parseArgs([
        "--port",
        "0",
        "--host",
        "0.0.0.0",
        "--api-key",
        "test",
        "--latency-ms",
        "50",
        "--answer-policy",
        "best-overlap",
        "--quiet",
      ]),
    ).toEqual({
      port: 0,
      host: "0.0.0.0",
      apiKey: "test",
      latencyMs: 50,
      answerPolicy: "best-overlap",
      quiet: true,
    });
  });

  it("takes the answer policy from the flag, then from MOCK_ANSWER_POLICY", () => {
    expect(parseArgs([], { MOCK_ANSWER_POLICY: "best-overlap" }).answerPolicy).toBe("best-overlap");
    expect(parseArgs(["--answer-policy", "confident-first"]).answerPolicy).toBe("confident-first");
    expect(
      parseArgs(["--answer-policy", "default"], { MOCK_ANSWER_POLICY: "best-overlap" })
        .answerPolicy,
    ).toBe("default");
    expect(() => parseArgs([], { MOCK_ANSWER_POLICY: "guessing" })).toThrow(
      /MOCK_ANSWER_POLICY: unknown answer policy guessing/u,
    );
    expect(() => parseArgs(["--answer-policy", "guessing"])).toThrow(/unknown answer policy/u);
  });

  it("refuses an unknown flag, a missing value and a value that is not a number", () => {
    expect(() => parseArgs(["--nonsense"])).toThrow(/unknown option --nonsense/u);
    expect(() => parseArgs(["--port"])).toThrow(/--port needs a value/u);
    expect(() => parseArgs(["--port", "eight"])).toThrow(/non-negative integer/u);
    expect(() => parseArgs(["--latency-ms", "-1"])).toThrow(/non-negative integer/u);
  });

  it("treats --help as a usage request", () => {
    expect(() => parseArgs(["--help"])).toThrow(UsageError);
    try {
      parseArgs(["-h"]);
    } catch (error) {
      expect((error as UsageError).message).toBe("");
    }
  });
});

/** Resolves with the first stdout line that announces the listening URL. */
function urlOf(child: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`the mock printed no URL; stdout was ${JSON.stringify(buffered)}`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const match = /listening on (http:\/\/\S+)/u.exec(buffered);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("the process", () => {
  it("binds a free port, prints the URL and answers /healthz", async () => {
    const child = spawn(process.execPath, [CLI, "--port", "0", "--quiet"], {
      env: { ...process.env, MOCK_ANSWER_POLICY: "best-overlap" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await urlOf(child);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");
    } finally {
      child.kill("SIGTERM");
    }
  }, 30_000);

  it("exits with code 2 and prints usage on an unknown flag", async () => {
    const child = spawn(process.execPath, [CLI, "--nope"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(2);
    expect(stderr).toContain("unknown option --nope");
    expect(stderr).toContain("Usage: fdp-typesafe-mock");
  }, 30_000);
});
