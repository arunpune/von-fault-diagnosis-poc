// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The event log keeps every output and drops what no file may carry: a
// decision backend's state and its raw provider bodies.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validate } from "@fdp/contracts";
import type { Decision } from "@fdp/contracts";
import type { AlarmTransition, DecisionOutput } from "@fdp/backend/pipeline";
import { afterAll, describe, expect, it } from "vitest";

import type { TimedOutput } from "../runner/host.ts";
import { eventLogName, loggedEvent, renderEventLog, writeEventLog } from "./events.ts";

const STATE_MARKER = "state-that-must-stay-in-the-process";
const RAW_MARKER = "raw-body-that-must-stay-in-the-process";
const DIGEST = "a".repeat(64);

function decisionMessage(): Decision {
  const message: Decision = {
    schema: "urn:fdp:schema:decision:v1",
    unit_id: "cau-7",
    wall_ts: "2026-01-01T00:00:00.000Z",
    decision_id: "00000000-0000-4000-8000-000000000001",
    episode_id: "00000000-0000-4000-8000-000000000002",
    event_id: "00000000-0000-4000-8000-000000000003",
    sim_ts: "2020-02-03T02:30:00.000Z",
    backend: "von",
    model: "von-1.13.0",
    status: "ok",
    choice: "oil_cooler_fouled",
    probabilities: { oil_cooler_fouled: 0.9, none_of_these: 0.1 },
    confidence: 0.9,
    support: {},
    candidates: [],
    severity: { level: "medium", score: 1, probabilities: { "1": 1 }, confidence: 1 },
    gate: {
      outcome: "ticket",
      abstained: false,
      reason: "fixture",
      ticket_min_confidence: 0.85,
      review_min_confidence: 0.6,
    },
    usage: { input_tokens: 1480, output_tokens: 0 },
    cost: { usd: 0, price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: "2026-09-19" },
    latency_ms: 0,
    state_digest: DIGEST,
    error: null,
  };
  const result = validate("decision", message);
  if (!result.ok) throw new Error(result.errors.map((issue) => issue.text).join("; "));
  return message;
}

function backendOutput(): DecisionOutput {
  return {
    backend: "von",
    model: "von-1.13.0",
    choice: "oil_cooler_fouled",
    probabilities: { oil_cooler_fouled: 0.9, none_of_these: 0.1 },
    confidence: 0.9,
    support: { oil_cooler_fouled: 0.8 },
    severity: { level: "medium", score: 1, probabilities: { "1": 1 }, confidence: 1 },
    usage: { input_tokens: 1480, output_tokens: 0 },
    latency_ms: 0,
    request_id: "req-1",
    state: { note: STATE_MARKER },
    state_digest: DIGEST,
    raw: { request: { body: RAW_MARKER }, response: { body: RAW_MARKER } },
  };
}

const DECISION: TimedOutput = {
  type: "decision",
  decision: decisionMessage(),
  output: backendOutput(),
  gate: null,
  batchSimTs: "2020-02-03T02:30:00.000Z",
};

const TRANSITION: AlarmTransition = {
  code: "W104",
  state: "raised",
  sim_ts: "2020-02-03T02:40:00.000Z",
  seq: 961,
};

const ALARM: TimedOutput = {
  type: "alarm",
  transition: TRANSITION,
  batchSimTs: "2020-02-03T02:40:00.000Z",
};

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("the event log", () => {
  it("names one file per scenario and backend", () => {
    expect(eventLogName("f3_air_leak_jun05", "rules")).toBe("f3_air_leak_jun05.rules.jsonl");
  });

  it("drops a decision's state and raw bodies and keeps its digest", () => {
    const logged = loggedEvent(DECISION);
    expect(logged.type).toBe("decision");
    if (logged.type !== "decision") return;
    expect(logged.output).not.toHaveProperty("state");
    expect(logged.output).not.toHaveProperty("raw");
    expect(logged.output?.state_digest).toBe(DIGEST);
    expect(logged.output?.request_id).toBe("req-1");
    expect(logged.output?.support).toEqual({ oil_cooler_fouled: 0.8 });
    if (DECISION.type === "decision") expect(logged.decision).toBe(DECISION.decision);
  });

  it("passes every other output through unchanged", () => {
    expect(loggedEvent(ALARM)).toBe(ALARM);
  });

  it("keeps a failed decision's missing output as null", () => {
    if (DECISION.type !== "decision") throw new Error("fixture");
    const failed: TimedOutput = { ...DECISION, output: null };
    const logged = loggedEvent(failed);
    expect(logged.type === "decision" ? logged.output : "absent").toBeNull();
  });

  it("writes one JSON object per line with nothing of the state or the bodies in it", () => {
    const directory = mkdtempSync(join(tmpdir(), "fdp-eval-events-"));
    directories.push(directory);
    const path = join(directory, eventLogName("inject_oil_cooler_fouling", "von"));
    writeEventLog(path, [DECISION, ALARM]);

    const text = readFileSync(path, "utf8");
    expect(text).toBe(renderEventLog([DECISION, ALARM]));
    expect(text).not.toContain(STATE_MARKER);
    expect(text).not.toContain(RAW_MARKER);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      "decision",
      "alarm",
    ]);
  });

  it("writes an empty file for a run that produced nothing", () => {
    expect(renderEventLog([])).toBe("");
  });
});
