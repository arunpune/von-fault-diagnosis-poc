// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger, moduleLogger, REDACT_PATHS } from "./log.ts";

/** Collects the JSON lines a logger writes, so assertions run on real output. */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString("utf8"));
      done();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const CONFIG = { logLevel: "info", unitId: "cau-7", version: "1.0.0" } as const;

describe("createLogger", () => {
  it("writes JSON with the unit and the version on every line", () => {
    const sink = capture();
    createLogger(CONFIG, sink.stream).info({ step: "boot" }, "configuration loaded");
    const [line] = sink.lines();
    expect(line).toMatchObject({
      level: "info",
      unit_id: "cau-7",
      version: "1.0.0",
      step: "boot",
      msg: "configuration loaded",
    });
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts every path of the redaction list", () => {
    const sink = capture();
    const logger = createLogger(CONFIG, sink.stream);
    logger.info(
      {
        req: { headers: { authorization: "Bearer tk-secret" } },
        headers: { authorization: "Bearer tk-secret" },
        sdk: { apiKey: "tk-secret", api_key: "tk-secret", authorization: "tk-secret" },
        pool: { password: "app_rw-secret" },
      },
      "options",
    );
    const written = JSON.stringify(sink.lines()[0]);
    expect(written).not.toContain("tk-secret");
    expect(written).not.toContain("app_rw-secret");
    expect(written.match(/\[redacted\]/g)?.length).toBe(6);
  });

  it("keeps the documented redaction list stable", () => {
    expect([...REDACT_PATHS]).toEqual([
      "req.headers.authorization",
      "headers.authorization",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "*.authorization",
    ]);
  });

  it("honours the configured level", () => {
    const sink = capture();
    const logger = createLogger({ ...CONFIG, logLevel: "warn" }, sink.stream);
    logger.info("dropped");
    logger.warn("kept");
    expect(sink.lines().map((line) => line.msg)).toEqual(["kept"]);
  });
});

describe("moduleLogger", () => {
  it("tags a line with the module that wrote it", () => {
    const sink = capture();
    moduleLogger(createLogger(CONFIG, sink.stream), "ingest").info("pushed");
    expect(sink.lines()[0]).toMatchObject({ module: "ingest", unit_id: "cau-7" });
  });
});
