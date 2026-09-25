// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the generic fixture harness of `schemas.test.ts` cannot see: the consistency rules that hold
// *across* the telemetry, control and status fixtures. The same files are read by the simulator's
// Go conformance tests, the gateway integration tests and the backend's diagnosis client, so a
// fixture that drifts here breaks four consumers at once.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SIGNALS } from "../src/generated/register-map.ts";
import { topics } from "../src/generated/topics.ts";
import { fixturesFor, schemaPath } from "../src/testing.ts";
import type { ValidFixture } from "../src/testing.ts";
import { parseIsoMs, toIsoMs } from "../src/time.ts";
import { validateMqtt } from "../src/validate.ts";

/** The schemas this file covers; their valid fixtures are the ones walked for timestamps. */
const SCHEMA_NAMES = [
  "telemetry-samples",
  "control-cmd",
  "control-ack",
  "status-sim",
  "status-gateway",
  "status-backend",
] as const;

interface CommonSchema {
  readonly $defs: { readonly identifier: { readonly pattern: string } };
}

/** The manual's identifier grammar, read from the contract rather than repeated here. */
const IDENTIFIER = new RegExp(
  (JSON.parse(readFileSync(schemaPath("common"), "utf8")) as CommonSchema).$defs.identifier.pattern,
);

/** The tag ids of the generated register map; empty while the map carries no signals. */
const REGISTER_TAGS: ReadonlySet<string> = new Set(SIGNALS.map((signal) => signal.tag));

if (REGISTER_TAGS.size === 0) {
  console.info(
    "telemetry.test.ts: src/generated/register-map.ts carries no signals yet, so the " +
      "assertion that every tag id exists in the register map is skipped.",
  );
}

function fixture(name: string, file: string): unknown {
  const { valid, invalid } = fixturesFor(name);
  const found = [...valid, ...invalid].find((candidate) => candidate.file === file);
  if (found === undefined) throw new Error(`missing fixture ${name}/${file}`);
  return found.data;
}

interface SampleShape {
  readonly seq?: unknown;
  readonly flags?: { readonly discontinuity?: unknown; readonly missing?: unknown };
  readonly values?: Record<string, unknown>;
  readonly alarms?: readonly unknown[];
}

/** The `samples` array of a telemetry fixture, or an empty list for anything else. */
function samplesOf(data: unknown): readonly SampleShape[] {
  const samples = (data as { samples?: unknown }).samples;
  return Array.isArray(samples) ? (samples as SampleShape[]) : [];
}

/** Every `sim_ts` string anywhere in a fixture, including the embedded status of an ack. */
function simTimestamps(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) simTimestamps(item, found);
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "sim_ts" && typeof child === "string") found.push(child);
    else simTimestamps(child, found);
  }
  return found;
}

// (a) The 25-sample batch is the shared example of a full poll batch: the simulator's tests
// build one by hand in Go, the gateway produces one and the backend ingests one. Its traits are
// pinned here.
describe("telemetry-samples/valid-batch-25.json", () => {
  const samples = samplesOf(fixture("telemetry-samples", "valid-batch-25.json"));

  it("holds 25 samples whose seq strictly increases", () => {
    expect(samples).toHaveLength(25);
    const seqs = samples.map((sample) => sample.seq);
    for (const seq of seqs) expect(typeof seq).toBe("number");
    const ascending = seqs.every(
      (seq, index) => index === 0 || (seq as number) > (seqs[index - 1] as number),
    );
    expect(ascending).toBe(true);
  });

  it("carries one discontinuity, one missing row and one alarm", () => {
    expect(samples.filter((sample) => sample.flags?.discontinuity === true)).toHaveLength(1);
    expect(samples.filter((sample) => sample.flags?.missing === true)).toHaveLength(1);
    expect(samples.flatMap((sample) => sample.alarms ?? [])).toEqual(["W102"]);
  });
});

// (b) `values` is keyed by the tag ids of the signal registry. The grammar is checked always;
// membership in the register map only once the map carries signals.
describe("telemetry-samples value keys", () => {
  const { valid, invalid } = fixturesFor("telemetry-samples");
  const all: ValidFixture[] = [...valid, ...invalid];
  const keysOf = (data: unknown): string[] =>
    samplesOf(data).flatMap((sample) => Object.keys(sample.values ?? {}));

  it.each(all)("$file uses identifier-shaped tag ids", ({ data }) => {
    const keys = keysOf(data);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !IDENTIFIER.test(key))).toEqual([]);
  });

  it.skipIf(REGISTER_TAGS.size === 0)("uses only tags the register map declares", () => {
    const strays = all
      .flatMap(({ file, data }) => keysOf(data).map((key) => ({ file, key })))
      .filter(({ key }) => !REGISTER_TAGS.has(key));
    expect(strays).toEqual([]);
  });
});

// (c) The topic decides the schema, which is how every MQTT consumer validates: the fixtures
// must pass and fail through that path too, not only through a validator named by hand.
describe("control-cmd over its topic", () => {
  const topic = topics.controlCmd();
  const { valid, invalid } = fixturesFor("control-cmd");

  it.each(valid)("accepts $file on the control topic", ({ data }) => {
    const result = validateMqtt(topic, JSON.stringify(data));
    expect(result.ok ? [] : result.errors.map((error) => error.text)).toEqual([]);
  });

  it.each(invalid)("rejects $file on the control topic", ({ data }) => {
    expect(validateMqtt(topic, JSON.stringify(data)).ok).toBe(false);
  });

  it("accepts a payload given as bytes, as an MQTT client hands it over", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify(fixture("control-cmd", "valid-play.json")),
    );
    expect(validateMqtt(topic, payload).ok).toBe(true);
  });
});

// (d) One time format across TypeScript, Go and Python. Every data timestamp in a valid
// fixture must survive `parseIsoMs` and come back byte for byte from `toIsoMs`.
describe("sim_ts round trip", () => {
  const cases = SCHEMA_NAMES.flatMap((name) =>
    fixturesFor(name).valid.flatMap(({ file, data }) =>
      simTimestamps(data).map((text) => ({ name, file, text })),
    ),
  );

  it("finds a data timestamp in the fixtures of every schema that has one", () => {
    const covered = new Set(cases.map((entry) => entry.name));
    expect([...covered].sort()).toEqual([
      "control-ack",
      "control-cmd",
      "status-sim",
      "telemetry-samples",
    ]);
  });

  it.each(cases)("$name/$file round-trips $text", ({ text }) => {
    expect(toIsoMs(parseIsoMs(text))).toBe(text);
  });
});
