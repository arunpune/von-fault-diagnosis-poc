// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The three helpers the rest of the harness builds on: the dataset clock
// (`src/time.ts`), the generated identifiers (`src/ids.ts`) and the redacting
// logger (`src/log.ts`).
//
// Each of them exists because of a rule rather than for convenience, and that
// is what is asserted here: the dataset is read as UTC (docs/dataset.md) and a
// timestamp that names no instant is refused rather than rolled over; run and
// instance ids are derived, so two runs of a profile line up; and no value
// under a key-shaped name ever reaches the log stream, because secrets come
// from the environment only and are never printed.

import { describe, expect, it } from "vitest";

import { INSTANCE_ID_PATTERN, RUN_ID_PATTERN, createInstanceIds, runId } from "../src/ids.ts";
import { REDACTED, type LogFields, createLogger, redact } from "../src/log.ts";
import { formatCsvTs, minutesBetween, parseCsvTs, toIsoMs } from "../src/time.ts";

/** A stream that keeps what the logger wrote instead of printing it. */
function captureStream(): { lines: string[]; write(chunk: string): void } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

describe("parseCsvTs", () => {
  it("reads the dataset clock as UTC", () => {
    expect(parseCsvTs("2020-02-01 00:00:00")).toBe(Date.UTC(2020, 1, 1, 0, 0, 0));
    expect(parseCsvTs("2020-06-05 09:49:07")).toBe(Date.UTC(2020, 5, 5, 9, 49, 7));
  });

  it("round-trips through formatCsvTs", () => {
    const text = "2020-07-15 14:25:30";
    expect(formatCsvTs(parseCsvTs(text))).toBe(text);
  });

  it("refuses anything that is not the fixed-width shape", () => {
    expect(() => parseCsvTs("2020-02-01T00:00:00Z")).toThrow(TypeError);
    expect(() => parseCsvTs("2020-02-01 00:00")).toThrow(TypeError);
    expect(() => parseCsvTs(" 2020-02-01 00:00:00")).toThrow(TypeError);
  });

  it("refuses a date that names no instant instead of rolling it over", () => {
    expect(() => parseCsvTs("2020-02-30 00:00:00")).toThrow(RangeError);
    expect(() => parseCsvTs("2020-13-01 00:00:00")).toThrow(RangeError);
  });
});

describe("minutesBetween", () => {
  it("measures epoch milliseconds, Dates and iso_ts strings alike", () => {
    const from = parseCsvTs("2020-06-05 09:00:00");
    const to = parseCsvTs("2020-06-05 09:49:30");

    expect(minutesBetween(from, to)).toBeCloseTo(49.5, 9);
    expect(minutesBetween(new Date(from), new Date(to))).toBeCloseTo(49.5, 9);
    expect(minutesBetween(toIsoMs(new Date(from)), toIsoMs(new Date(to)))).toBeCloseTo(49.5, 9);
  });

  it("is negative when the second instant is earlier", () => {
    expect(minutesBetween("2020-06-05T10:00:00.000Z", "2020-06-05T09:00:00.000Z")).toBe(-60);
  });
});

describe("runId", () => {
  it("names a run after its UTC start and its profile", () => {
    expect(runId("core", new Date("2020-06-05T09:49:07.123Z"))).toBe("20200605-094907-core");
    expect(runId("smoke", new Date("2026-01-02T03:04:05.000Z"))).toMatch(RUN_ID_PATTERN);
  });

  it("refuses a profile that would not be a directory name", () => {
    const startedAt = new Date("2026-01-02T03:04:05.000Z");
    expect(() => runId("", startedAt)).toThrow(TypeError);
    expect(() => runId("Core", startedAt)).toThrow(TypeError);
    expect(() => runId("core/full", startedAt)).toThrow(TypeError);
  });
});

describe("createInstanceIds", () => {
  it("counts from one, zero-padded", () => {
    const next = createInstanceIds("a1b2");
    expect(next()).toBe("inj-a1b2-000001");
    expect(next()).toBe("inj-a1b2-000002");
    expect(next()).toMatch(INSTANCE_ID_PATTERN);
  });

  it("gives two counters with the same boot id the same sequence", () => {
    const first = createInstanceIds("boot");
    const second = createInstanceIds("boot");
    expect([first(), first()]).toEqual([second(), second()]);
  });

  it("refuses a boot id that is not lowercase alphanumeric", () => {
    expect(() => createInstanceIds("")).toThrow(TypeError);
    expect(() => createInstanceIds("BOOT")).toThrow(TypeError);
    expect(() => createInstanceIds("boot-1")).toThrow(TypeError);
  });
});

describe("redact", () => {
  it("masks every value under a secret-shaped key, however deep", () => {
    const masked = redact({
      TYPESAFE_API_KEY: "sk-real",
      nested: { token: "t", Authorization: "Bearer x", password: "p", model: "jev-1.13.0" },
      list: [{ api_key: "k" }, { profile: "core" }],
    });

    expect(masked).toEqual({
      TYPESAFE_API_KEY: REDACTED,
      nested: { token: REDACTED, Authorization: REDACTED, password: REDACTED, model: "jev-1.13.0" },
      list: [{ api_key: REDACTED }, { profile: "core" }],
    });
  });

  it("leaves values that are not objects alone and survives a cycle", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(7)).toBe(7);
    expect(redact(null)).toBe(null);

    const cyclic: Record<string, unknown> = { profile: "core" };
    cyclic["self"] = cyclic;
    expect(redact(cyclic)).toEqual({ profile: "core", self: "[elided]" });
  });
});

describe("createLogger", () => {
  it("writes one text line per call and hides debug by default", () => {
    const stream = captureStream();
    const log = createLogger({ env: {}, stream });

    log.debug("not printed");
    log.info("scenario finished", { scenario: "f3_air_leak_jun05", tickets: 1 });
    log.warn("cassette miss", { digest: "abc" });

    expect(log.level).toBe("info");
    expect(stream.lines).toEqual([
      'info scenario finished scenario="f3_air_leak_jun05" tickets=1\n',
      'warn cassette miss digest="abc"\n',
    ]);
  });

  it("prints debug when EVAL_LOG_LEVEL asks for it", () => {
    const stream = captureStream();
    const log = createLogger({ env: { EVAL_LOG_LEVEL: "debug" }, stream });

    log.debug("pushing batch", { seq: 1 });

    expect(log.level).toBe("debug");
    expect(stream.lines).toEqual(["debug pushing batch seq=1\n"]);
  });

  it("falls back to the default level and says so on an unreadable one", () => {
    const stream = captureStream();
    const log = createLogger({ env: { EVAL_LOG_LEVEL: "trace" }, stream });

    expect(log.level).toBe("info");
    expect(stream.lines[0]).toContain("EVAL_LOG_LEVEL is not a level");
  });

  it("writes JSON lines under EVAL_LOG_JSON=1 and redacts the fields", () => {
    const stream = captureStream();
    const log = createLogger({ env: { EVAL_LOG_JSON: "1" }, stream });

    const fields: LogFields = { backend: "jev", TYPESAFE_API_KEY: "sk-real" };
    log.info("backend selected", fields);

    expect(stream.lines).toHaveLength(1);
    expect(JSON.parse(stream.lines[0] ?? "")).toEqual({
      level: "info",
      msg: "backend selected",
      backend: "jev",
      TYPESAFE_API_KEY: REDACTED,
    });
  });

  it("never writes a secret in text mode either", () => {
    const stream = captureStream();
    const log = createLogger({ env: {}, stream });

    log.warn("live mode", { config: { apiKey: "sk-real", baseUrl: "https://example.invalid" } });

    expect(stream.lines.join("")).not.toContain("sk-real");
    expect(stream.lines.join("")).toContain(REDACTED);
  });
});
