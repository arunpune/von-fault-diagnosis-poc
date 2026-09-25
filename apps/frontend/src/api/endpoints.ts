// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One typed function per REST route the UI calls (docs/api.md). Views never build a URL: they call
// these, usually through the hooks of `queries.ts` and `mutations.ts`. Each function takes an
// optional `signal` so a query the cache no longer needs is cancelled on the wire.

import { ApiError, CLIENT_ERROR_CODES, fetchJson } from "@/api/client";
import type {
  AlertSystem,
  ApiCost,
  ApiDecisions,
  ApiEvents,
  ApiHealth,
  ApiSignals,
  ApiSimCommandResult,
  ApiStatus,
  ApiTicketClose,
  ApiTickets,
  CatalogEntry,
  DecisionDetail,
  InjectionInterval,
  ItemList,
  OverlayCatalog,
  OverlayInjectionActive,
  OverlayMarker,
  SeriesEntry,
  SeriesPoint,
  SeriesResponse,
  SimCommandArgs,
  SimCommandSegment,
  Ticket,
  TicketDetail,
  TicketStatusFilter,
} from "@/api/types";

export interface RequestOptions {
  signal?: AbortSignal;
}

/** Paging of the list routes: newest first, `before` is the previous page's `next_cursor`. */
export interface PageQuery {
  limit?: number;
  before?: string;
}

/** A window of sim time; either bound may be an ISO instant or epoch milliseconds. */
export interface SimRange {
  from?: string | number;
  to?: string | number;
}

export interface SeriesQuery {
  /** Tag ids of the signal registry; every tag when absent. */
  tags?: readonly string[];
  from: string | number;
  to: string | number;
  /** At most this many points per tag; the backend's own cap is 2 000. */
  points?: number;
}

/** The ApiError code of a simulator command the proxy gave up waiting for (HTTP 504). */
export const SIM_TIMEOUT_CODE = "sim_timeout";

/** The series route. The backend also answers its alias `/api/series`; the UI never asks it. */
const SERIES_PATH = "/api/telemetry/series";

type QueryValue = string | number | boolean | readonly string[] | undefined;

/** An ISO instant as the backend's `iso_ts` parameters expect it (millisecond precision, Z). */
function isoInstant(value: string | number): string {
  return typeof value === "number" ? new Date(value).toISOString() : value;
}

function withQuery(path: string, query: Readonly<Record<string, QueryValue>>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    params.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function getHealth(options: RequestOptions = {}): Promise<ApiHealth> {
  // 503 carries the same body with `status: degraded`; the caller reads which link is down.
  return fetchJson<ApiHealth>("/api/health", { signal: options.signal, acceptStatuses: [503] });
}

export function getStatus(options: RequestOptions = {}): Promise<ApiStatus> {
  return fetchJson<ApiStatus>("/api/status", options);
}

export function getSignals(options: RequestOptions = {}): Promise<ApiSignals> {
  return fetchJson<ApiSignals>("/api/signals", options);
}

// The series body is checked before the recorder reads it, because its points go straight into
// typed arrays. It has one spelling, the contract's `api-telemetry-series`:
// `from`/`to` for the window and `tag`, `kind`, `unit`, `points` per track.

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeriesPoint(value: unknown): value is SeriesPoint {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    (typeof value[1] === "number" || value[1] === null)
  );
}

function malformedSeries(reason: string): ApiError {
  return new ApiError(200, CLIENT_ERROR_CODES.badResponse, `The series answer ${reason}`);
}

function toTrack(value: unknown): SeriesEntry {
  if (!isRecord(value)) {
    throw malformedSeries("holds a track that is not an object");
  }
  const { tag, kind, unit, points } = value;
  if (typeof tag !== "string") {
    throw malformedSeries("holds a track without a tag");
  }
  if (kind !== "analog" && kind !== "digital") {
    throw malformedSeries(`gives ${tag} no kind`);
  }
  if (typeof unit !== "string") {
    throw malformedSeries(`gives ${tag} no unit`);
  }
  if (!Array.isArray(points) || !points.every(isSeriesPoint)) {
    throw malformedSeries(`holds malformed points for ${tag}`);
  }
  return { tag, kind, unit, points };
}

/** Reads the series body; throws `ApiError` for anything the contract does not describe. */
export function toSeries(body: unknown): SeriesResponse {
  if (!isRecord(body)) {
    throw malformedSeries("is not an object");
  }
  const { from, to, series, discontinuities } = body;
  if (typeof from !== "string" || typeof to !== "string") {
    throw malformedSeries("names no window");
  }
  if (!Array.isArray(series)) {
    throw malformedSeries("holds no series");
  }
  if (
    !Array.isArray(discontinuities) ||
    !discontinuities.every((instant) => typeof instant === "string")
  ) {
    throw malformedSeries("lists no discontinuities");
  }
  return { from, to, series: series.map(toTrack), discontinuities };
}

/** `GET /api/telemetry/series`: the downsampled history of some tags over a window of sim time. */
export async function getSeries(
  query: SeriesQuery,
  options: RequestOptions = {},
): Promise<SeriesResponse> {
  const params = {
    tags: query.tags,
    from: isoInstant(query.from),
    to: isoInstant(query.to),
    points: query.points,
  };
  return toSeries(await fetchJson<unknown>(withQuery(SERIES_PATH, params), options));
}

export function getEvents(page: PageQuery = {}, options: RequestOptions = {}): Promise<ApiEvents> {
  return fetchJson<ApiEvents>(withQuery("/api/events/suspect", { ...page }), options);
}

export interface DecisionsQuery extends PageQuery {
  /** Only the decisions of one episode: a ticket's history. */
  episodeId?: string;
}

export function getDecisions(
  query: DecisionsQuery = {},
  options: RequestOptions = {},
): Promise<ApiDecisions> {
  const params = { limit: query.limit, before: query.before, episode_id: query.episodeId };
  return fetchJson<ApiDecisions>(withQuery("/api/decisions", params), options);
}

export function getDecision(id: string, options: RequestOptions = {}): Promise<DecisionDetail> {
  return fetchJson<DecisionDetail>(`/api/decisions/${segment(id)}`, options);
}

/** `GET /api/tickets?status=…`; the Review tab is `status=review`. */
export function getTickets(
  status: TicketStatusFilter,
  page: PageQuery = {},
  options: RequestOptions = {},
): Promise<ApiTickets> {
  return fetchJson<ApiTickets>(withQuery("/api/tickets", { status, ...page }), options);
}

export function getTicket(id: string, options: RequestOptions = {}): Promise<TicketDetail> {
  return fetchJson<TicketDetail>(`/api/tickets/${segment(id)}`, options);
}

/** `POST /api/tickets/:id/close` with the technician's `verdict`. */
export function closeTicket(
  id: string,
  body: ApiTicketClose,
  options: RequestOptions = {},
): Promise<Ticket> {
  return fetchJson<Ticket>(`/api/tickets/${segment(id)}/close`, {
    method: "POST",
    body,
    signal: options.signal,
  });
}

export function getCost(options: RequestOptions = {}): Promise<ApiCost> {
  return fetchJson<ApiCost>("/api/cost", options);
}

/** The system alerts raised right now, for the banners after a reconnect. */
export function getActiveAlerts(options: RequestOptions = {}): Promise<ItemList<AlertSystem>> {
  return fetchJson<ItemList<AlertSystem>>("/api/alerts/system?active=true", options);
}

export function getCatalogFault(
  faultId: string,
  options: RequestOptions = {},
): Promise<CatalogEntry> {
  return fetchJson<CatalogEntry>(`/api/catalog/faults/${segment(faultId)}`, options);
}

/** The preset and injection menus and the dataset failure windows; 404 until the sim sent one. */
export function getOverlayCatalog(options: RequestOptions = {}): Promise<OverlayCatalog> {
  return fetchJson<OverlayCatalog>("/api/overlay/catalog", options);
}

export function getOverlayActive(options: RequestOptions = {}): Promise<OverlayInjectionActive> {
  return fetchJson<OverlayInjectionActive>("/api/overlay/active", options);
}

function rangeQuery(range: SimRange): Record<string, QueryValue> {
  return {
    from: range.from === undefined ? undefined : isoInstant(range.from),
    to: range.to === undefined ? undefined : isoInstant(range.to),
  };
}

export function getOverlayInjections(
  range: SimRange = {},
  options: RequestOptions = {},
): Promise<ItemList<InjectionInterval>> {
  return fetchJson<ItemList<InjectionInterval>>(
    withQuery("/api/overlay/injections", rangeQuery(range)),
    options,
  );
}

export function getOverlayMarkers(
  range: SimRange = {},
  options: RequestOptions = {},
): Promise<ItemList<OverlayMarker>> {
  return fetchJson<ItemList<OverlayMarker>>(
    withQuery("/api/overlay/markers", rangeQuery(range)),
    options,
  );
}

/**
 * `POST /api/sim/:segment` with `{ args }`. The 202 answer carries the simulator's `ack` when it
 * arrived within the backend's wait and `null` when it did not; a proxy that gives up first
 * answers 504, which becomes an `ApiError` with code `sim_timeout`.
 */
export async function simCommand<S extends SimCommandSegment>(
  cmd: S,
  args: SimCommandArgs[S],
  options: RequestOptions = {},
): Promise<ApiSimCommandResult> {
  try {
    return await fetchJson<ApiSimCommandResult>(`/api/sim/${segment(cmd)}`, {
      method: "POST",
      body: { args },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 504) {
      throw new ApiError(
        504,
        SIM_TIMEOUT_CODE,
        "The simulator did not answer in time",
        error.details,
      );
    }
    throw error;
  }
}
