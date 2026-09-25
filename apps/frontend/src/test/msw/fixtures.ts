// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The JSON fixtures under src/test/fixtures, typed. They are built from the contracts' valid
// fixtures and tell one story — the 5 Jun 2020 air leak with a ticket open, a rules decision in
// review, a resolved and a closed ticket — so ids line up across files: the decision's event is
// in `events`, the ticket's history is in `decisions`, and so on.
//
// A JSON import widens every string, so each file is cast to its contract type here; the cast is
// sound because `fixtures.test.ts` validates every file against the contract schemas. Treat them
// as read-only: clone (`structuredClone`) before changing one in a test.

import alertsJson from "@/test/fixtures/alerts.json";
import catalogFaultJson from "@/test/fixtures/catalog-fault.json";
import costJson from "@/test/fixtures/cost.json";
import decisionFailedJson from "@/test/fixtures/decision-failed.json";
import decisionJson from "@/test/fixtures/decision.json";
import decisionsJson from "@/test/fixtures/decisions.json";
import eventsJson from "@/test/fixtures/events.json";
import healthJson from "@/test/fixtures/health.json";
import overlayActiveJson from "@/test/fixtures/overlay-active.json";
import overlayCatalogJson from "@/test/fixtures/overlay-catalog.json";
import overlayInjectionsJson from "@/test/fixtures/overlay-injections.json";
import overlayMarkersJson from "@/test/fixtures/overlay-markers.json";
import seriesJson from "@/test/fixtures/series.json";
import signalsJson from "@/test/fixtures/signals.json";
import simCommandResultJson from "@/test/fixtures/sim-command-result.json";
import statusJson from "@/test/fixtures/status.json";
import ticketJson from "@/test/fixtures/ticket.json";
import ticketsJson from "@/test/fixtures/tickets.json";
import wsAlarmNativeJson from "@/test/fixtures/ws-alarm-native.json";
import wsAlertSystemJson from "@/test/fixtures/ws-alert-system.json";
import wsCostUpdateJson from "@/test/fixtures/ws-cost-update.json";
import wsDecisionJson from "@/test/fixtures/ws-decision.json";
import wsEventSuspectJson from "@/test/fixtures/ws-event-suspect.json";
import wsHeartbeatJson from "@/test/fixtures/ws-heartbeat.json";
import wsHelloJson from "@/test/fixtures/ws-hello.json";
import wsOverlayCatalogJson from "@/test/fixtures/ws-overlay-catalog.json";
import wsOverlayInjectionActiveJson from "@/test/fixtures/ws-overlay-injection-active.json";
import wsOverlayInjectionJson from "@/test/fixtures/ws-overlay-injection.json";
import wsOverlayMarkerJson from "@/test/fixtures/ws-overlay-marker.json";
import wsSnapshotJson from "@/test/fixtures/ws-snapshot.json";
import wsStatusBackendJson from "@/test/fixtures/ws-status-backend.json";
import wsStatusGatewayJson from "@/test/fixtures/ws-status-gateway.json";
import wsStatusSimJson from "@/test/fixtures/ws-status-sim.json";
import wsTelemetrySamplesJson from "@/test/fixtures/ws-telemetry-samples.json";
import wsTelemetrySeriesJson from "@/test/fixtures/ws-telemetry-series.json";
import wsTicketJson from "@/test/fixtures/ws-ticket.json";
import type {
  AlertSystem,
  ApiCost,
  ApiDecisions,
  ApiEvents,
  ApiHealth,
  ApiSignals,
  ApiSimCommandResult,
  ApiStatus,
  ApiTelemetrySeries,
  ApiTickets,
  CatalogEntry,
  Decision,
  DecisionDetail,
  InjectionInterval,
  ItemList,
  OverlayCatalog,
  OverlayInjectionActive,
  OverlayMarker,
  ServerFrameType,
  TicketDetail,
} from "@/api/types";
import type { FrameOf } from "@/api/ws-types";

/** series.json, keyed by the contract schema its body follows. */
export interface SeriesFixture {
  "api-telemetry-series": ApiTelemetrySeries;
}

/** One `ws-server-message` frame per type, keyed by type. */
export type FrameFixtures = { readonly [T in ServerFrameType]: FrameOf<T> };

/** Casts a JSON import to the contract type `fixtures.test.ts` validates it against. */
function contract<T>(json: unknown): T {
  return json as T;
}

export const fixtures = {
  alerts: contract<ItemList<AlertSystem>>(alertsJson),
  catalogFault: contract<CatalogEntry>(catalogFaultJson),
  cost: contract<ApiCost>(costJson),
  decision: contract<DecisionDetail>(decisionJson),
  decisionFailed: contract<Decision>(decisionFailedJson),
  decisions: contract<ApiDecisions>(decisionsJson),
  events: contract<ApiEvents>(eventsJson),
  health: contract<ApiHealth>(healthJson),
  overlayActive: contract<OverlayInjectionActive>(overlayActiveJson),
  overlayCatalog: contract<OverlayCatalog>(overlayCatalogJson),
  overlayInjections: contract<ItemList<InjectionInterval>>(overlayInjectionsJson),
  overlayMarkers: contract<ItemList<OverlayMarker>>(overlayMarkersJson),
  series: contract<SeriesFixture>(seriesJson),
  signals: contract<ApiSignals>(signalsJson),
  simCommandResult: contract<ApiSimCommandResult>(simCommandResultJson),
  status: contract<ApiStatus>(statusJson),
  ticket: contract<TicketDetail>(ticketJson),
  tickets: contract<ApiTickets>(ticketsJson),
} as const;

export const frames: FrameFixtures = {
  hello: contract(wsHelloJson),
  snapshot: contract(wsSnapshotJson),
  heartbeat: contract(wsHeartbeatJson),
  "telemetry.samples": contract(wsTelemetrySamplesJson),
  "telemetry.series": contract(wsTelemetrySeriesJson),
  "status.sim": contract(wsStatusSimJson),
  "status.gateway": contract(wsStatusGatewayJson),
  "status.backend": contract(wsStatusBackendJson),
  "event.suspect": contract(wsEventSuspectJson),
  decision: contract(wsDecisionJson),
  ticket: contract(wsTicketJson),
  "alert.system": contract(wsAlertSystemJson),
  "alarm.native": contract(wsAlarmNativeJson),
  "overlay.catalog": contract(wsOverlayCatalogJson),
  "overlay.injection": contract(wsOverlayInjectionJson),
  "overlay.injection_active": contract(wsOverlayInjectionActiveJson),
  "overlay.marker": contract(wsOverlayMarkerJson),
  "cost.update": contract(wsCostUpdateJson),
};
