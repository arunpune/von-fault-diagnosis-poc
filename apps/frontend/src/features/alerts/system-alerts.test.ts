// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AlertSystem } from "@/api/types";
import { raisedAlerts, systemAlertDetail, systemAlertTitle } from "@/features/alerts/system-alerts";
import { fmtWall } from "@/lib/time";
import { fixtures } from "@/test/msw/fixtures";

function telemetryAlert(): AlertSystem {
  const [alert] = fixtures.alerts.items;
  if (alert === undefined) {
    throw new Error("alerts.json holds a raised alert");
  }
  return structuredClone(alert);
}

function decisionApiAlert(details: AlertSystem["details"]): AlertSystem {
  return {
    ...telemetryAlert(),
    alert_id: "a4d1c9e2-0b3f-4a57-8c61-2d3e4f5a6b7c",
    kind: "decision_api_silent",
    since_wall_ts: "2026-06-05T12:03:11.000Z",
    details,
  };
}

describe("systemAlertTitle", () => {
  it("says for how long telemetry has been silent", () => {
    expect(systemAlertTitle(telemetryAlert())).toBe("Telemetry silent for 90 s while playing");
  });

  it("drops the duration when the watchdog gives none", () => {
    const alert = { ...telemetryAlert(), details: {} };

    expect(systemAlertTitle(alert)).toBe("Telemetry silent while playing");
  });

  it("says since when the decision API fails and how many calls failed", () => {
    const since = fmtWall("2026-06-05T12:03:11.000Z");

    expect(systemAlertTitle(decisionApiAlert({ consecutive_errors: 3 }))).toBe(
      `Decision API failing since ${since} (3 errors)`,
    );
    expect(systemAlertTitle(decisionApiAlert({ consecutive_errors: 1 }))).toBe(
      `Decision API failing since ${since} (1 error)`,
    );
    expect(systemAlertTitle(decisionApiAlert({}))).toBe(`Decision API failing since ${since}`);
  });

  it("reads a kind a newer contract adds as its message, or as its own words", () => {
    const alert = { ...telemetryAlert(), kind: "broker_silent" as AlertSystem["kind"] };

    expect(systemAlertTitle(alert)).toBe("No telemetry sample arrived for 90 s.");
    expect(systemAlertTitle({ ...alert, details: {} })).toBe("Broker silent");
  });
});

describe("systemAlertDetail", () => {
  it("is the watchdog's own sentence, unless the headline already is it", () => {
    expect(systemAlertDetail(telemetryAlert())).toBe("No telemetry sample arrived for 90 s.");
    expect(systemAlertDetail(decisionApiAlert({}))).toBeNull();

    const unknown = { ...telemetryAlert(), kind: "broker_silent" as AlertSystem["kind"] };
    expect(systemAlertDetail(unknown)).toBeNull();
  });
});

describe("raisedAlerts", () => {
  it("keeps the raised alerts in their order and drops the cleared ones", () => {
    const raised = telemetryAlert();
    const cleared: AlertSystem = { ...decisionApiAlert({}), state: "cleared" };
    const other = decisionApiAlert({ consecutive_errors: 2 });

    expect(raisedAlerts([raised, cleared, other])).toEqual([raised, other]);
  });
});
