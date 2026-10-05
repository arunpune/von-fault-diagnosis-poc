// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fake {@link ApiDeps} for the route tests and for the HTTP/WS integration
 * test.
 *
 * The records are the contracts' own valid fixtures, so a route that answers
 * with them answers something the user interface can parse; every repository
 * records the query it was asked, so a test can prove the route read the
 * query string the way it says. The ingest stage and the detector are the real
 * ones, fed the 25-sample telemetry fixture, so `/series` and
 * `/telemetry/latest` exercise the real decimation and the real machine state.
 * The ticket and episode lists are the real snapshot readers over fixture
 * records, and `closeTicket` behaves as the ticket manager does: 404 for an
 * unknown id, 409 for a second verdict.
 *
 * The file is named `*.test-helper.ts` so Vitest does not collect it as a
 * suite of its own.
 */

import type {
  AlertSystem,
  ApiCost,
  ApiStatus,
  CatalogEntry,
  Decision,
  SuspectEvent,
  TelemetrySamples,
  Ticket,
} from "@fdp/contracts";
import { fixturesFor } from "@fdp/contracts/testing";
import Fastify, { type FastifyInstance } from "fastify";

import { fixedClock } from "../clock.ts";
import { createDetector } from "../detection/index.ts";
import type { Episode } from "../episodes/index.ts";
import { createIngest } from "../ingest/index.ts";
import { decodeCursor } from "../persistence/cursor.ts";
import type {
  AlertListQuery,
  DecisionListQuery,
  EventListQuery,
  NativeAlarm,
  NativeAlarmRange,
} from "../persistence/types.ts";
import { TicketClosedError, UnknownTicketError, type TicketVerdict } from "../tickets/index.ts";
import type { ApiDeps, RuntimeStatus } from "./deps.ts";
import { API_PREFIX, apiRoutes, type ApiPorts } from "./index.ts";
import { createSnapshotReaders } from "./snapshot-readers.ts";

/** The wall instant every fake stamps. */
export const WALL_TS = "2026-09-22T10:00:00.000Z";

/** A deep copy of one valid fixture of the contracts package. */
export function contract<T>(schema: string, file: string): T {
  const found = fixturesFor(schema).valid.find((fixture) => fixture.file === file);
  if (found === undefined) throw new Error(`no valid fixture ${schema}/${file}`);
  return structuredClone(found.data) as T;
}

/** The 25-sample batch the fake ingest and detector were fed. */
export const TELEMETRY = contract<TelemetrySamples>("telemetry-samples", "valid-batch-25.json");

/** Four tickets, one per status, each of its own episode. */
function fixtureTickets(): Record<Ticket["status"], Ticket> {
  const closed = contract<Ticket>("ticket", "valid-closed-correct.json");
  return {
    open: contract<Ticket>("ticket", "valid-opened.json"),
    review: contract<Ticket>("ticket", "valid-opened-review.json"),
    resolved: contract<Ticket>("ticket", "valid-resolved-silence.json"),
    closed: {
      ...closed,
      ticket_id: "9d1e2f30-4a5b-4c6d-8e7f-a0b1c2d3e4f5",
      episode_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      opened_sim_ts: "2020-04-02T08:00:00.000Z",
    },
  };
}

/** One backend episode record, with every column at a plausible value. */
export function episodeRecord(
  episodeId: string,
  status: Episode["status"],
  openedSimTs: string,
  ticketId: string | null = null,
): Episode {
  return {
    episode_id: episodeId,
    unit_id: "cau-7",
    symptom_key: "continuous_load",
    symptom_keys: ["continuous_load"],
    status,
    merged_into: null,
    opened_sim_ts: openedSimTs,
    last_event_sim_ts: openedSimTs,
    last_decision_sim_ts: openedSimTs,
    closed_sim_ts: status === "open" ? null : openedSimTs,
    close_reason: status === "open" ? null : status === "aborted" ? "discontinuity" : "silence",
    first_event_id: "3d4a1f02-5c6b-4e71-9a83-0b1c2d3e4f50",
    ticket_id: ticketId,
    closed_by_technician: false,
    event_count: 1,
    decision_count: 1,
    fault_id: null,
  };
}

function fixtureEpisodes(tickets: Record<Ticket["status"], Ticket>): Episode[] {
  const { open, review, resolved } = tickets;
  return [
    episodeRecord(open.episode_id, "open", open.opened_sim_ts, open.ticket_id),
    episodeRecord(review.episode_id, "open", review.opened_sim_ts, review.ticket_id),
    episodeRecord(resolved.episode_id, "closed", resolved.opened_sim_ts, resolved.ticket_id),
    episodeRecord("c0ffee00-1111-4222-8333-944455556666", "aborted", "2020-03-01T00:00:00.000Z"),
  ];
}

/** The live status the fake runtime reports: the running fixture without its gate. */
export function runtimeStatus(): RuntimeStatus {
  const status = contract<ApiStatus>("api-status", "valid-running.json");
  return {
    sim: status.sim,
    gateway: status.gateway,
    backend: status.backend,
    alerts_active: status.alerts_active,
    injections_active: status.injections_active,
  };
}

/** The decisions of the fixture episode, newest first. */
function fixtureDecisions(): Decision[] {
  return [
    contract<Decision>("decision", "valid-failed.json"),
    contract<Decision>("decision", "valid-von-ticket.json"),
  ];
}

/** Two native alarm transitions of one code. */
export const NATIVE_ALARMS: readonly NativeAlarm[] = [
  { code: "W101", state: "raised", sim_ts: "2020-06-05T09:50:00.000Z", wall_ts: WALL_TS, seq: 7 },
  { code: "W101", state: "cleared", sim_ts: "2020-06-05T10:05:00.000Z", wall_ts: WALL_TS, seq: 98 },
];

/** The state `GET /api/decisions/:id` adds. */
export const DECISION_STATE = { machine: { mode: "loaded" }, candidates: [] };

/** What the fake repositories were asked, in call order. */
export interface FakeCalls {
  readonly events: EventListQuery[];
  readonly decisions: DecisionListQuery[];
  readonly nativeAlarms: NativeAlarmRange[];
  readonly ledger: (number | undefined)[];
  readonly alerts: AlertListQuery[];
  readonly closes: { ticketId: string; closure: TicketVerdict }[];
}

export interface FakeApi {
  readonly deps: ApiDeps;
  readonly calls: FakeCalls;
  /** The tickets the fake holds; `closeTicket` replaces an entry. */
  readonly tickets: Ticket[];
  readonly episodes: Episode[];
  readonly catalog: CatalogEntry[];
}

/** A `before` token is checked the way the persisted repositories check it. */
function checkCursor(before: string | undefined): void {
  if (before !== undefined) decodeCursor(before);
}

/** The ticket message a technician's verdict produces. */
function closedTicket(ticket: Ticket, closure: TicketVerdict): Ticket {
  return {
    ...ticket,
    wall_ts: WALL_TS,
    action: "closed",
    status: "closed",
    close_reason: "technician",
    resolved_sim_ts: ticket.resolved_sim_ts ?? ticket.updated_sim_ts,
    closure: { ...closure, wall_ts: WALL_TS },
  };
}

/** A complete set of fake dependencies over the contracts' fixtures. */
export function fakeApiDeps(): FakeApi {
  const calls: FakeCalls = {
    events: [],
    decisions: [],
    nativeAlarms: [],
    ledger: [],
    alerts: [],
    closes: [],
  };
  const byStatus = fixtureTickets();
  const tickets = Object.values(byStatus);
  const episodes = fixtureEpisodes(byStatus);
  const decisions = fixtureDecisions();
  const catalog = [
    contract<CatalogEntry>("catalog-entry", "valid-benign-high-ambient.json"),
    contract<CatalogEntry>("catalog-entry", "valid-downstream-air-leak.json"),
  ];
  const alerts = [
    contract<AlertSystem>("alert-system", "valid-raised.json"),
    contract<AlertSystem>("alert-system", "valid-cleared.json"),
  ];

  const wall = fixedClock(WALL_TS);
  const ingest = createIngest({ unitId: "cau-7", wall });
  const detector = createDetector({ wall });
  ingest.push(TELEMETRY);
  for (const sample of TELEMETRY.samples) detector.push(sample);

  const readers = createSnapshotReaders(() => ({ tickets, episodes }));

  const deps: ApiDeps = {
    env: {
      gate: {
        ticketMinConfidence: 0.85,
        reviewMinConfidence: 0.6,
        persistSimMin: 1,
        von: { ticketMinConfidence: 0.85, reviewMinConfidence: 0.6 },
      },
      decisionBackend: "von",
    },
    ingest,
    detector,
    runtime: { status: runtimeStatus },
    repos: {
      events: {
        async list(query = {}) {
          calls.events.push(query);
          checkCursor(query.before);
          return {
            items: [contract<SuspectEvent>("suspect-event", "valid-continuous-load.json")],
            next_cursor: null,
          };
        },
      },
      decisions: {
        async list(query = {}) {
          calls.decisions.push(query);
          checkCursor(query.before);
          const items = decisions.filter(
            (decision) =>
              query.episode_id === undefined || decision.episode_id === query.episode_id,
          );
          return { items, next_cursor: null };
        },
        async get(decisionId, options = {}) {
          const found = decisions.find((decision) => decision.decision_id === decisionId);
          if (found === undefined) return undefined;
          return options.withState === true ? { ...found, state: DECISION_STATE } : found;
        },
      },
      episodes: readers.episodes,
      tickets: readers.tickets,
      cost: {
        async summary() {
          return contract<ApiCost>("api-cost", "valid-von-and-llm.json");
        },
        async ledger(limit) {
          calls.ledger.push(limit);
          return { items: [] };
        },
      },
      alerts: {
        async list(query = {}) {
          calls.alerts.push(query);
          return alerts.filter(
            (alert) => query.active === undefined || (alert.state === "raised") === query.active,
          );
        },
      },
      nativeAlarms: {
        async list(range) {
          calls.nativeAlarms.push(range);
          return NATIVE_ALARMS.filter((row) => row.sim_ts >= range.from && row.sim_ts <= range.to);
        },
      },
      catalog: {
        async faults() {
          return catalog;
        },
        async fault(faultId) {
          return catalog.find((entry) => entry.fault_id === faultId);
        },
        async normalBands() {
          return new Map([["line_pressure", { loaded: [8.4, 9.8], unloaded: [8.2, 9.8] }]]);
        },
      },
    },
    actions: {
      async closeTicket(ticketId, closure) {
        calls.closes.push({ ticketId, closure });
        const index = tickets.findIndex((ticket) => ticket.ticket_id === ticketId);
        const ticket = tickets[index];
        if (ticket === undefined) throw new UnknownTicketError(ticketId);
        if (ticket.status === "closed") throw new TicketClosedError(ticketId);
        const closed = closedTicket(ticket, closure);
        tickets[index] = closed;
        return closed;
      },
    },
  };

  return { deps, calls, tickets, episodes, catalog };
}

/** A Fastify instance with the REST surface under `/api`, ready for `inject`. */
export async function apiServer(
  deps: ApiDeps | undefined,
  options: Pick<ApiPorts, "crossOrigin"> = {},
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  await fastify.register(
    apiRoutes({
      health: {
        clock: fixedClock(WALL_TS),
        version: "1.0.0",
        backend: { name: "rules", model: "rules-v1" },
        links: {},
      },
      startedAt: new Date(WALL_TS),
      dashboard: deps,
      crossOrigin: options.crossOrigin,
    }),
    { prefix: API_PREFIX },
  );
  await fastify.ready();
  return fastify;
}
