// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The two watchdogs on a fake wall clock: nothing in
// this file waits for a real second. The production timeouts (15 s and 60 s)
// are used as they are, because moving a fake clock costs nothing.

import { validate, type AlertSystem } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { sequentialIds } from "../episodes/decisions.test-helper.ts";
import {
  createHeartbeat,
  DECISION_ERROR_LIMIT,
  toSystemAlertRow,
  type Heartbeat,
  type HeartbeatRow,
} from "./index.ts";

const START = "2026-09-22T10:00:00.000Z";

/** `START` plus `seconds`, as an `iso_ts`. */
function wallAt(seconds: number): string {
  return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

interface Harness {
  readonly heartbeat: Heartbeat;
  readonly alerts: AlertSystem[];
  readonly rows: HeartbeatRow[];
  /** Move the wall clock to `START + seconds`. */
  to(seconds: number): void;
  /** Move the clock and tick once a second on the way, as the runtime does. */
  runTo(seconds: number): void;
}

function harness(): Harness {
  const wall = fixedClock(START);
  let nowS = 0;
  const alerts: AlertSystem[] = [];
  const rows: HeartbeatRow[] = [];
  const heartbeat = createHeartbeat({
    wall,
    timeouts: { telemetryS: 15, decisionS: 60 },
    sink: { alert: (message) => alerts.push(message), heartbeat: (row) => rows.push(row) },
    unitId: "cau-7",
    ids: sequentialIds(7),
  });
  const to = (seconds: number) => {
    wall.advance((seconds - nowS) * 1000);
    nowS = seconds;
  };
  return {
    heartbeat,
    alerts,
    rows,
    to,
    runTo(seconds) {
      while (nowS < seconds) {
        to(Math.min(nowS + 1, seconds));
        heartbeat.tick();
      }
    },
  };
}

/** The alert messages, reduced to what a reader of the UI would see. */
function summary(alerts: readonly AlertSystem[]) {
  return alerts.map((alert) => [alert.kind, alert.state, alert.wall_ts]);
}

function expectValid(alerts: readonly AlertSystem[]): void {
  for (const alert of alerts) {
    const result = validate("alert-system", alert);
    expect(result.ok ? [] : result.errors.map((issue) => issue.text)).toEqual([]);
  }
}

describe("telemetry_silent", () => {
  it("is raised at 16 s of silence while the simulator plays, and cleared by a sample", () => {
    const h = harness();
    h.heartbeat.noteSimState("playing");
    h.heartbeat.noteSample();

    h.runTo(15);
    expect(h.alerts).toEqual([]);
    h.runTo(16);
    expect(summary(h.alerts)).toEqual([["telemetry_silent", "raised", wallAt(16)]]);
    h.runTo(40);
    expect(h.alerts).toHaveLength(1);

    h.heartbeat.noteSample();
    expect(summary(h.alerts)).toEqual([
      ["telemetry_silent", "raised", wallAt(16)],
      ["telemetry_silent", "cleared", wallAt(40)],
    ]);
    const [raised, cleared] = h.alerts;
    expect(cleared?.alert_id).toBe(raised?.alert_id);
    expect(cleared?.since_wall_ts).toBe(wallAt(16));
    expect(raised?.details).toEqual({
      timeout_s: 15,
      last_ok_wall_ts: wallAt(0),
      message: "no telemetry sample for more than 15 s while the simulator is playing",
    });
    expectValid(h.alerts);
  });

  it("is never raised while the simulator is paused, stopped or not yet heard of", () => {
    const h = harness();
    h.runTo(120);
    h.heartbeat.noteSimState("paused");
    h.runTo(240);
    h.heartbeat.noteSimState("stopped");
    h.runTo(360);

    expect(h.alerts).toEqual([]);
    expect(h.heartbeat.snapshot().states.telemetry).toBe("unknown");
  });

  it("measures silence from the moment the replay resumed, not from before the pause", () => {
    const h = harness();
    h.heartbeat.noteSimState("playing");
    h.heartbeat.noteSample();
    h.to(5);
    h.heartbeat.noteSimState("paused");
    h.runTo(600);
    h.heartbeat.noteSimState("playing");
    h.heartbeat.noteSimState("playing");

    h.runTo(615);
    expect(h.alerts).toEqual([]);
    h.runTo(616);
    expect(summary(h.alerts)).toEqual([["telemetry_silent", "raised", wallAt(616)]]);
  });

  it("is raised when the simulator plays and no sample ever arrives", () => {
    const h = harness();
    h.heartbeat.noteSimState("playing");
    h.runTo(16);

    expect(summary(h.alerts)).toEqual([["telemetry_silent", "raised", wallAt(16)]]);
    expect(h.alerts[0]?.details).not.toHaveProperty("last_ok_wall_ts");
  });

  it("is cleared when the simulator stops playing", () => {
    const h = harness();
    h.heartbeat.noteSimState("playing");
    h.runTo(20);
    h.heartbeat.noteSimState("paused");

    expect(summary(h.alerts)).toEqual([
      ["telemetry_silent", "raised", wallAt(16)],
      ["telemetry_silent", "cleared", wallAt(20)],
    ]);
    expect(h.alerts[1]?.details.message).toBe("the simulator is paused, not playing");
    expectValid(h.alerts);
  });
});

describe("decision_api_silent", () => {
  it("is never raised before the first attempt", () => {
    const h = harness();
    h.runTo(600);

    expect(h.alerts).toEqual([]);
    expect(h.heartbeat.snapshot().states.decision_api).toBe("unknown");
  });

  it(`is raised by the ${DECISION_ERROR_LIMIT}rd consecutive error and cleared by a success`, () => {
    const h = harness();
    h.heartbeat.noteDecisionOk();
    h.to(1);
    h.heartbeat.noteDecisionError();
    h.to(2);
    h.heartbeat.noteDecisionError();
    expect(h.alerts).toEqual([]);
    h.to(3);
    h.heartbeat.noteDecisionError();

    expect(summary(h.alerts)).toEqual([["decision_api_silent", "raised", wallAt(3)]]);
    expect(h.alerts[0]?.details).toEqual({
      timeout_s: 60,
      consecutive_errors: 3,
      last_ok_wall_ts: wallAt(0),
      message: "3 decision calls in a row failed",
    });
    h.to(4);
    h.heartbeat.noteDecisionError();
    expect(h.alerts).toHaveLength(1);

    h.to(10);
    h.heartbeat.noteDecisionOk();
    expect(summary(h.alerts)).toEqual([
      ["decision_api_silent", "raised", wallAt(3)],
      ["decision_api_silent", "cleared", wallAt(10)],
    ]);
    expect(h.alerts[1]?.details).toMatchObject({ consecutive_errors: 0 });
    expectValid(h.alerts);
  });

  it("is raised by a failure streak older than 60 s with no success since", () => {
    const h = harness();
    h.heartbeat.noteDecisionError();
    h.to(30);
    h.heartbeat.noteDecisionError();

    h.runTo(60);
    expect(h.alerts).toEqual([]);
    h.runTo(61);
    expect(summary(h.alerts)).toEqual([["decision_api_silent", "raised", wallAt(61)]]);
    expect(h.alerts[0]?.details).toEqual({
      timeout_s: 60,
      consecutive_errors: 2,
      message: "decision calls have failed for more than 60 s with no success",
    });
  });

  it("starts a new streak after a success", () => {
    const h = harness();
    h.heartbeat.noteDecisionError();
    h.to(50);
    h.heartbeat.noteDecisionOk();
    h.to(70);
    h.heartbeat.noteDecisionError();

    h.runTo(130);
    expect(h.alerts).toEqual([]);
    h.runTo(131);
    expect(summary(h.alerts)).toEqual([["decision_api_silent", "raised", wallAt(131)]]);
  });
});

describe("what the watchdog reports", () => {
  it("flushes a heartbeat row per source only when it changed", () => {
    const h = harness();
    h.heartbeat.tick();
    h.heartbeat.tick();
    expect(h.rows.map((row) => [row.source, row.status])).toEqual([
      ["telemetry", "unknown"],
      ["decision_api", "unknown"],
    ]);

    h.heartbeat.noteSimState("playing");
    h.heartbeat.noteSample();
    h.heartbeat.noteDecisionError();
    h.to(1);
    h.heartbeat.tick();

    expect(h.rows.slice(2)).toEqual([
      {
        source: "telemetry",
        status: "ok",
        last_ok_wall_ts: wallAt(0),
        last_seen_wall_ts: wallAt(0),
        consecutive_errors: 0,
        detail: { timeout_s: 15, sim_state: "playing" },
      },
      {
        source: "decision_api",
        status: "ok",
        last_ok_wall_ts: null,
        last_seen_wall_ts: wallAt(0),
        consecutive_errors: 1,
        detail: { timeout_s: 60, total: 1, ok: 0, failed: 1 },
      },
    ]);
  });

  it("flushes the row of a source the moment its alert changes", () => {
    const h = harness();
    h.heartbeat.noteDecisionError();
    h.heartbeat.noteDecisionError();
    h.heartbeat.noteDecisionError();

    expect(h.rows.map((row) => [row.source, row.status, row.consecutive_errors])).toEqual([
      ["decision_api", "silent", 3],
    ]);
  });

  it("counts decisions for status-backend and lists the alerts that are up", () => {
    const h = harness();
    h.heartbeat.noteDecisionOk();
    h.to(5);
    h.heartbeat.noteDecisionError();
    h.heartbeat.noteDecisionError();
    h.heartbeat.noteDecisionError();
    h.heartbeat.noteSimState("playing");
    h.runTo(30);

    expect(h.heartbeat.snapshot()).toEqual({
      decision: {
        total: 4,
        ok: 1,
        failed: 3,
        consecutive_errors: 3,
        last_ok_wall_ts: wallAt(0),
        last_error_wall_ts: wallAt(5),
      },
      telemetry_silent: true,
      decision_api_silent: true,
      states: { telemetry: "silent", decision_api: "silent" },
    });
    expect(h.heartbeat.activeAlerts().map((alert) => alert.kind)).toEqual([
      "decision_api_silent",
      "telemetry_silent",
    ]);
  });

  it("maps an alert message onto its app.system_alerts row", () => {
    const h = harness();
    h.heartbeat.noteSimState("playing");
    h.runTo(20);
    h.heartbeat.noteSample();
    const [raised, cleared] = h.alerts;

    expect(toSystemAlertRow(raised!)).toEqual({
      alert_id: raised!.alert_id,
      unit_id: "cau-7",
      kind: "telemetry_silent",
      state: "raised",
      raised_wall_ts: wallAt(16),
      cleared_wall_ts: null,
      details: raised!.details,
    });
    expect(toSystemAlertRow(cleared!)).toMatchObject({
      alert_id: raised!.alert_id,
      state: "cleared",
      raised_wall_ts: wallAt(16),
      cleared_wall_ts: wallAt(20),
    });
  });
});
