// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The two watchdogs of the backend.
 *
 * | alert | raised when | cleared when |
 * | --- | --- | --- |
 * | `telemetry_silent` | the simulator says `playing` and no sample arrived for more than `HEARTBEAT_TELEMETRY_TIMEOUT_S` | the next sample arrives, or the simulator stops playing |
 * | `decision_api_silent` | three decision calls in a row failed, or the current failure streak began more than `HEARTBEAT_DECISION_TIMEOUT_S` ago with no success since | the next call succeeds |
 *
 * Both run on wall time, never on the simulated clock: a paused replay is not
 * a silent one, and a decision service that has been failing for a minute has
 * been failing for a minute whatever the replay speed. The clock is a port, so
 * a test moves it by hand and never waits.
 *
 * Silence is measured from the later of the last sample and the moment the
 * simulator started playing. A replay that was paused for an hour has an
 * hour-old last sample; raising the alert the instant it resumes would report
 * the pause, not a fault. The decision watchdog is never raised before the
 * first call, because a backend that has not been asked has not failed.
 *
 * The module owns no timer and no connection. The runtime calls
 * {@link Heartbeat.tick} once a second and hands every alert and every
 * heartbeat row to the {@link HeartbeatSink}, which publishes the
 * `alert-system` message, writes `app.system_alerts` and `app.heartbeats` and
 * forwards the WebSocket frame. An alert is emitted the
 * moment its state changes; a heartbeat row is emitted when its content
 * changed, at most once per call, so `app.heartbeats` is written about once a
 * second while telemetry flows rather than once per sample.
 */

import { assertValid, toIsoMs } from "@fdp/contracts";
import type { AlertSystem, HeartbeatState, SimulatorState } from "@fdp/contracts";

import type { WallClock } from "../clock.ts";

/** The schema id every alert message repeats. */
export const ALERT_SYSTEM_SCHEMA = "urn:fdp:schema:alert-system:v1";

/** Consecutive failed decision calls that raise `decision_api_silent`. */
export const DECISION_ERROR_LIMIT = 3;

/** Which watchdog an alert comes from (`app.system_alerts.kind`). */
export type AlertKind = AlertSystem["kind"];

/** The two watched sources (`app.heartbeats.source`). */
export type HeartbeatSource = "telemetry" | "decision_api";

/** `HEARTBEAT_TELEMETRY_TIMEOUT_S` and `HEARTBEAT_DECISION_TIMEOUT_S`, in seconds. */
export interface HeartbeatTimeouts {
  readonly telemetryS: number;
  readonly decisionS: number;
}

/** One row of `app.heartbeats`, as the watchdog last saw its source. */
export interface HeartbeatRow {
  readonly source: HeartbeatSource;
  readonly status: HeartbeatState;
  readonly last_ok_wall_ts: string | null;
  readonly last_seen_wall_ts: string | null;
  readonly consecutive_errors: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** One row of `app.system_alerts`, as it stands after an alert message. */
export interface SystemAlertRow {
  readonly alert_id: string;
  readonly unit_id: string;
  readonly kind: AlertKind;
  readonly state: AlertSystem["state"];
  readonly raised_wall_ts: string;
  readonly cleared_wall_ts: string | null;
  readonly details: AlertSystem["details"];
}

/**
 * Where the watchdog's output goes; the runtime's implementation publishes and
 * persists, and it owns the error handling of those writes.
 */
export interface HeartbeatSink {
  /** A validated `alert-system` message: an alert was raised or cleared. */
  alert(message: AlertSystem): void;
  /** The current row of one source changed. */
  heartbeat(row: HeartbeatRow): void;
}

/** The decision counters of `status-backend.decision`. */
export interface DecisionCounters {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly consecutive_errors: number;
  readonly last_ok_wall_ts: string | null;
  readonly last_error_wall_ts: string | null;
}

/** What the status publisher and the health route read. */
export interface HeartbeatSnapshot {
  readonly decision: DecisionCounters;
  readonly telemetry_silent: boolean;
  readonly decision_api_silent: boolean;
  /** `api-health.heartbeats`: `unknown` until the source has been seen once. */
  readonly states: { readonly telemetry: HeartbeatState; readonly decision_api: HeartbeatState };
}

/** What {@link createHeartbeat} is composed of. */
export interface HeartbeatPorts {
  readonly wall: WallClock;
  readonly timeouts: HeartbeatTimeouts;
  readonly sink: HeartbeatSink;
  /** The unit every alert names (`UNIT_ID`). */
  readonly unitId: string;
  /** A fresh `alert_id`; `ids.ts` `newId` in the runtime, a counter in tests. */
  readonly ids: () => string;
}

/** The watchdogs of one backend process. */
export interface Heartbeat {
  /** A telemetry sample arrived; clears `telemetry_silent`. */
  noteSample(): void;
  /** The latest `status-sim.state`; leaving `playing` clears `telemetry_silent`. */
  noteSimState(state: SimulatorState): void;
  /** A decision call answered; clears `decision_api_silent`. */
  noteDecisionOk(): void;
  /** A decision call failed; the third in a row raises `decision_api_silent`. */
  noteDecisionError(): void;
  /** Evaluate the timeouts and flush changed heartbeat rows; the runtime calls it every second. */
  tick(): void;
  snapshot(): HeartbeatSnapshot;
  /** The alerts raised right now, as their raising messages; for `GET /api/status`. */
  activeAlerts(): readonly AlertSystem[];
}

/** The row an `alert-system` message leaves in `app.system_alerts`. */
export function toSystemAlertRow(message: AlertSystem): SystemAlertRow {
  return {
    alert_id: message.alert_id,
    unit_id: message.unit_id,
    kind: message.kind,
    state: message.state,
    raised_wall_ts: message.since_wall_ts,
    cleared_wall_ts: message.state === "cleared" ? message.wall_ts : null,
    details: message.details,
  };
}

/** The ISO form of an epoch-millisecond instant, or `null`. */
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : toIsoMs(new Date(ms));
}

/**
 * The two watchdogs over one wall clock.
 *
 * `since_wall_ts` of an alert is the instant the watchdog raised it, and the
 * cleared message repeats it as the contract asks; `details.last_ok_wall_ts`
 * carries the last sample or the last successful call, which is when the
 * source actually went quiet.
 */
export function createHeartbeat(ports: HeartbeatPorts): Heartbeat {
  const { wall, timeouts, sink, unitId, ids } = ports;

  let simState: SimulatorState | null = null;
  let playingSinceMs: number | null = null;
  let lastSampleMs: number | null = null;

  let total = 0;
  let ok = 0;
  let failed = 0;
  let consecutiveErrors = 0;
  let lastOkMs: number | null = null;
  let lastErrorMs: number | null = null;
  let streakStartMs: number | null = null;

  /** The raising message of every alert that is up; the clear repeats its id and instant. */
  const raised = new Map<AlertKind, AlertSystem>();
  const lastRows = new Map<HeartbeatSource, string>();

  const nowMs = (): number => wall.now().getTime();

  function alertMessage(
    kind: AlertKind,
    state: AlertSystem["state"],
    alertId: string,
    sinceWallTs: string,
    details: AlertSystem["details"],
  ): AlertSystem {
    return assertValid("alert-system", {
      schema: ALERT_SYSTEM_SCHEMA,
      unit_id: unitId,
      wall_ts: toIsoMs(wall.now()),
      alert_id: alertId,
      kind,
      state,
      since_wall_ts: sinceWallTs,
      details,
    });
  }

  function raise(kind: AlertKind, details: AlertSystem["details"]): void {
    if (raised.has(kind)) return;
    const message = alertMessage(kind, "raised", ids(), toIsoMs(wall.now()), details);
    raised.set(kind, message);
    sink.alert(message);
  }

  function clear(kind: AlertKind, details: AlertSystem["details"]): void {
    const current = raised.get(kind);
    if (current === undefined) return;
    raised.delete(kind);
    sink.alert(alertMessage(kind, "cleared", current.alert_id, current.since_wall_ts, details));
  }

  function telemetryRow(): HeartbeatRow {
    const lastSample = isoOrNull(lastSampleMs);
    return {
      source: "telemetry",
      status: raised.has("telemetry_silent") ? "silent" : lastSampleMs === null ? "unknown" : "ok",
      last_ok_wall_ts: lastSample,
      last_seen_wall_ts: lastSample,
      consecutive_errors: 0,
      detail: {
        timeout_s: timeouts.telemetryS,
        ...(simState === null ? {} : { sim_state: simState }),
      },
    };
  }

  function decisionRow(): HeartbeatRow {
    const lastSeenMs = Math.max(lastOkMs ?? -Infinity, lastErrorMs ?? -Infinity);
    return {
      source: "decision_api",
      status: raised.has("decision_api_silent") ? "silent" : total === 0 ? "unknown" : "ok",
      last_ok_wall_ts: isoOrNull(lastOkMs),
      last_seen_wall_ts: total === 0 ? null : toIsoMs(new Date(lastSeenMs)),
      consecutive_errors: consecutiveErrors,
      detail: { timeout_s: timeouts.decisionS, total, ok, failed },
    };
  }

  /** Emit a source's row when it differs from the last one emitted. */
  function flushRow(row: HeartbeatRow): void {
    const serialized = JSON.stringify(row);
    if (lastRows.get(row.source) === serialized) return;
    lastRows.set(row.source, serialized);
    sink.heartbeat(row);
  }

  function telemetryDetails(message: string): AlertSystem["details"] {
    const lastSample = isoOrNull(lastSampleMs);
    return {
      timeout_s: timeouts.telemetryS,
      ...(lastSample === null ? {} : { last_ok_wall_ts: lastSample }),
      message,
    };
  }

  function decisionDetails(message: string): AlertSystem["details"] {
    const lastOk = isoOrNull(lastOkMs);
    return {
      timeout_s: timeouts.decisionS,
      consecutive_errors: consecutiveErrors,
      ...(lastOk === null ? {} : { last_ok_wall_ts: lastOk }),
      message,
    };
  }

  /** Whether the replay has been playing without a sample for longer than the timeout. */
  function telemetryOverdue(now: number): boolean {
    if (simState !== "playing" || playingSinceMs === null) return false;
    const quietSince = Math.max(playingSinceMs, lastSampleMs ?? -Infinity);
    return now - quietSince > timeouts.telemetryS * 1000;
  }

  /** Whether the current failure streak began longer ago than the timeout. */
  function decisionStreakOverdue(now: number): boolean {
    return streakStartMs !== null && now - streakStartMs > timeouts.decisionS * 1000;
  }

  const heartbeat: Heartbeat = {
    noteSample() {
      lastSampleMs = nowMs();
      if (raised.has("telemetry_silent")) {
        clear("telemetry_silent", telemetryDetails("telemetry samples are arriving again"));
        flushRow(telemetryRow());
      }
    },

    noteSimState(state) {
      if (state === "playing" && simState !== "playing") playingSinceMs = nowMs();
      simState = state;
      if (state !== "playing" && raised.has("telemetry_silent")) {
        clear("telemetry_silent", telemetryDetails(`the simulator is ${state}, not playing`));
        flushRow(telemetryRow());
      }
    },

    noteDecisionOk() {
      const now = nowMs();
      total += 1;
      ok += 1;
      consecutiveErrors = 0;
      streakStartMs = null;
      lastOkMs = now;
      if (raised.has("decision_api_silent")) {
        clear("decision_api_silent", decisionDetails("a decision call succeeded"));
        flushRow(decisionRow());
      }
    },

    noteDecisionError() {
      const now = nowMs();
      total += 1;
      failed += 1;
      consecutiveErrors += 1;
      lastErrorMs = now;
      streakStartMs ??= now;
      if (consecutiveErrors >= DECISION_ERROR_LIMIT) {
        raise(
          "decision_api_silent",
          decisionDetails(`${consecutiveErrors} decision calls in a row failed`),
        );
        flushRow(decisionRow());
      }
    },

    tick() {
      const now = nowMs();
      if (telemetryOverdue(now)) {
        raise(
          "telemetry_silent",
          telemetryDetails(
            `no telemetry sample for more than ${timeouts.telemetryS} s while the simulator is playing`,
          ),
        );
      }
      if (decisionStreakOverdue(now)) {
        raise(
          "decision_api_silent",
          decisionDetails(
            `decision calls have failed for more than ${timeouts.decisionS} s with no success`,
          ),
        );
      }
      flushRow(telemetryRow());
      flushRow(decisionRow());
    },

    snapshot() {
      return {
        decision: {
          total,
          ok,
          failed,
          consecutive_errors: consecutiveErrors,
          last_ok_wall_ts: isoOrNull(lastOkMs),
          last_error_wall_ts: isoOrNull(lastErrorMs),
        },
        telemetry_silent: raised.has("telemetry_silent"),
        decision_api_silent: raised.has("decision_api_silent"),
        states: { telemetry: telemetryRow().status, decision_api: decisionRow().status },
      };
    },

    activeAlerts() {
      return [...raised.values()];
    },
  };

  return heartbeat;
}
