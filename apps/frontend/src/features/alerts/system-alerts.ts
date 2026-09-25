// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The backend's own alarms in words: a watchdog raised when telemetry or the decision API falls
// silent becomes a banner above the feed, worded from its kind and details — "Telemetry silent
// for 90 s while playing", "Decision API failing since <wall time> (3 errors)". A kind a newer
// contract adds reads as its own message.

import type { AlertSystem } from "@/api/types";
import { fmtNumber, humanize } from "@/lib/format";
import { fmtWall } from "@/lib/time";

/** The raised alerts of a list, in the order given; a cleared one needs no banner. */
export function raisedAlerts(alerts: readonly AlertSystem[]): AlertSystem[] {
  return alerts.filter((alert) => alert.state === "raised");
}

function telemetrySilent(alert: AlertSystem): string {
  const { timeout_s: timeout } = alert.details;
  return timeout === undefined
    ? "Telemetry silent while playing"
    : `Telemetry silent for ${fmtNumber(timeout, 0)} s while playing`;
}

function decisionApiSilent(alert: AlertSystem): string {
  const { consecutive_errors: errors } = alert.details;
  const since = `Decision API failing since ${fmtWall(alert.since_wall_ts)}`;
  if (errors === undefined) {
    return since;
  }
  return `${since} (${fmtNumber(errors, 0)} ${errors === 1 ? "error" : "errors"})`;
}

/** The banner's headline. */
export function systemAlertTitle(alert: AlertSystem): string {
  const kind: string = alert.kind;
  switch (kind) {
    case "telemetry_silent":
      return telemetrySilent(alert);
    case "decision_api_silent":
      return decisionApiSilent(alert);
    default:
      return alert.details.message ?? humanize(kind);
  }
}

/** The watchdog's own sentence, shown under the headline when it says something more. */
export function systemAlertDetail(alert: AlertSystem): string | null {
  const { message } = alert.details;
  return message === undefined || message === systemAlertTitle(alert) ? null : message;
}
