// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A mock backend for the component tests: one msw handler for every REST route the UI calls,
// answering from the fixtures and behaving like the real routes where a test would notice —
// tickets filter by status, an unknown id is a 404 `api-error`, a close validates its verdict
// and answers the closed ticket, a simulator command echoes its effect in the acknowledgement.
// A test that needs another answer overrides one route with `server.use`.

import { http, HttpResponse, type JsonBodyType } from "msw";

import type {
  ApiSimCommandResult,
  ApiTicketClose,
  Decision,
  DecisionDetail,
  SimCommandName,
  SimCommandSegment,
  StatusSim,
  Ticket,
  TicketDetail,
  TicketStatusFilter,
} from "@/api/types";
import { fixtures } from "@/test/msw/fixtures";

/** An `api-error` answer, as the backend's error handler writes it. */
export function apiError(status: number, code: string, message: string): Response {
  return HttpResponse.json({ error: { code, message } }, { status });
}

function json(body: JsonBodyType, status = 200): Response {
  return HttpResponse.json(body, { status });
}

const TICKET_FILTERS: readonly TicketStatusFilter[] = [
  "review",
  "open",
  "resolved",
  "closed",
  "all",
];

function isTicketFilter(value: string): value is TicketStatusFilter {
  return TICKET_FILTERS.some((filter) => filter === value);
}

function findDecision(decisionId: string): DecisionDetail | undefined {
  if (fixtures.decision.decision_id === decisionId) {
    return fixtures.decision;
  }
  const candidates: readonly Decision[] = [fixtures.decisionFailed, ...fixtures.decisions.items];
  return candidates.find((decision) => decision.decision_id === decisionId);
}

function episodeDecisions(episodeId: string): Decision[] {
  return fixtures.decisions.items.filter((decision) => decision.episode_id === episodeId);
}

function findTicket(ticketId: string): Ticket | undefined {
  return fixtures.tickets.items.find((item) => item.ticket_id === ticketId);
}

function findTicketDetail(ticketId: string): TicketDetail | undefined {
  if (fixtures.ticket.ticket_id === ticketId) {
    return fixtures.ticket;
  }
  const ticket = findTicket(ticketId);
  return ticket === undefined
    ? undefined
    : { ...ticket, decisions: episodeDecisions(ticket.episode_id) };
}

function isCloseBody(body: unknown): body is ApiTicketClose {
  return (
    typeof body === "object" &&
    body !== null &&
    "verdict" in body &&
    (body.verdict === "correct" || body.verdict === "wrong")
  );
}

function closedTicket(ticket: Ticket, body: ApiTicketClose): Ticket {
  const wallTs = "2026-09-19T10:05:00.000Z";
  return {
    ...ticket,
    wall_ts: wallTs,
    action: "closed",
    status: "closed",
    close_reason: "technician",
    resolved_sim_ts: ticket.resolved_sim_ts ?? ticket.updated_sim_ts,
    closure: { ...body, wall_ts: wallTs },
  };
}

/** The command each route segment publishes. */
const SIM_COMMANDS: Readonly<Record<SimCommandSegment, SimCommandName>> = {
  play: "play",
  pause: "pause",
  speed: "set_speed",
  jump: "jump",
  inject: "inject",
  clear: "clear_injections",
  reset: "reset",
};

function isSimSegment(value: string): value is SimCommandSegment {
  return Object.hasOwn(SIM_COMMANDS, value);
}

function stringArg(args: unknown, name: string): string | undefined {
  if (typeof args !== "object" || args === null || !(name in args)) {
    return undefined;
  }
  const value: unknown = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** The simulator status after a command, as the acknowledgement would carry it. */
function statusAfter(status: StatusSim, segment: SimCommandSegment, args: unknown): StatusSim {
  switch (segment) {
    case "play":
      return { ...status, state: "playing" };
    case "pause":
      return { ...status, state: "paused" };
    case "speed": {
      const speed = (args as { speed?: unknown } | null)?.speed;
      return typeof speed === "number" ? { ...status, speed } : status;
    }
    default:
      return status;
  }
}

/** Why the simulator would refuse the command, or null when it applies it. */
function refusal(segment: SimCommandSegment, args: unknown) {
  const catalog = fixtures.overlayCatalog;
  if (segment === "jump") {
    const presetId = stringArg(args, "preset_id");
    if (presetId !== undefined && !catalog.presets.presets.some((p) => p.preset_id === presetId)) {
      return { code: "unknown_preset" as const, message: `no preset ${presetId}` };
    }
  }
  if (segment === "inject") {
    const injectionId = stringArg(args, "injection_id");
    if (!catalog.injections.some((injection) => injection.injection_id === injectionId)) {
      return { code: "unknown_injection" as const, message: `no injection ${String(injectionId)}` };
    }
  }
  return null;
}

function simResult(segment: SimCommandSegment, args: unknown): ApiSimCommandResult {
  const result = structuredClone(fixtures.simCommandResult);
  if (result.ack === null) {
    return result;
  }
  const error = refusal(segment, args);
  result.ack = {
    ...result.ack,
    cmd: SIM_COMMANDS[segment],
    ok: error === null,
    error,
    status: statusAfter(result.ack.status, segment, args),
  };
  return result;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

export const handlers = [
  http.get("/api/health", () => json(fixtures.health)),
  http.get("/api/status", () => json(fixtures.status)),
  http.get("/api/signals", () => json(fixtures.signals)),
  http.get("/api/telemetry/series", () => json(fixtures.series["api-telemetry-series"])),
  http.get("/api/events/suspect", () => json(fixtures.events)),

  http.get("/api/decisions", ({ request }) => {
    const episodeId = new URL(request.url).searchParams.get("episode_id");
    if (episodeId === null) {
      return json(fixtures.decisions);
    }
    return json({ items: episodeDecisions(episodeId), next_cursor: null });
  }),
  http.get("/api/decisions/:id", ({ params }) => {
    const decision = findDecision(String(params.id));
    return decision === undefined
      ? apiError(404, "not_found", `no decision with id ${String(params.id)}`)
      : json(decision);
  }),

  http.get("/api/tickets", ({ request }) => {
    const status = new URL(request.url).searchParams.get("status") ?? "all";
    if (!isTicketFilter(status)) {
      return apiError(400, "bad_request", `status is not one of ${TICKET_FILTERS.join(", ")}`);
    }
    const items = fixtures.tickets.items.filter(
      (ticket) => status === "all" || ticket.status === status,
    );
    return json({ items, next_cursor: null });
  }),
  http.get("/api/tickets/:id", ({ params }) => {
    const ticket = findTicketDetail(String(params.id));
    return ticket === undefined
      ? apiError(404, "not_found", `no ticket with id ${String(params.id)}`)
      : json(ticket);
  }),
  http.post("/api/tickets/:id/close", async ({ params, request }) => {
    const body = await readJsonBody(request);
    if (!isCloseBody(body)) {
      return apiError(400, "bad_request", "the body is not an api-ticket-close");
    }
    const ticket = findTicket(String(params.id));
    if (ticket === undefined) {
      return apiError(404, "not_found", `no ticket with id ${String(params.id)}`);
    }
    if (ticket.closure !== null) {
      return apiError(409, "conflict", "the ticket already has a verdict");
    }
    return json(closedTicket(ticket, body));
  }),

  http.get("/api/cost", () => json(fixtures.cost)),
  http.get("/api/alerts/system", ({ request }) => {
    const active = new URL(request.url).searchParams.get("active");
    const items = fixtures.alerts.items.filter(
      (alert) => active === null || (alert.state === "raised") === (active === "true"),
    );
    return json({ items });
  }),
  http.get("/api/catalog/faults/:faultId", ({ params }) =>
    fixtures.catalogFault.fault_id === params.faultId
      ? json(fixtures.catalogFault)
      : apiError(404, "not_found", `no cause with fault_id ${String(params.faultId)}`),
  ),

  http.get("/api/overlay/catalog", () => json(fixtures.overlayCatalog)),
  http.get("/api/overlay/active", () => json(fixtures.overlayActive)),
  http.get("/api/overlay/injections", () => json(fixtures.overlayInjections)),
  http.get("/api/overlay/markers", () => json(fixtures.overlayMarkers)),

  http.post("/api/sim/:cmd", async ({ params, request }) => {
    const segment = String(params.cmd);
    if (!isSimSegment(segment)) {
      return apiError(404, "not_found", `no route POST /api/sim/${segment}`);
    }
    const body = await readJsonBody(request);
    const args = typeof body === "object" && body !== null && "args" in body ? body.args : {};
    return json(simResult(segment, args), 202);
  }),
];
