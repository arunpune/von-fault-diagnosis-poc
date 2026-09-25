// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the dashboard routes are built from.
 *
 * Interfaces only. The runtime hands the routes the real objects —
 * the ingest stage and the detector of its pipeline, the repositories of
 * `src/persistence/`, the ticket action of its pipeline — and the route tests
 * hand them fakes, so a route never knows which it is talking to and the
 * runtime wires the service without touching a route.
 *
 * Every repository is narrowed to the reads a route makes (`Pick`), so a fake
 * implements three methods instead of eight and a route cannot write through a
 * port it was given for reading. The persisted ones come from
 * `src/persistence/types.ts`, the one file that exports them. Two lists
 * have no persisted reader there — `EpisodeRepo` and `TicketRepo` only save
 * and hydrate — so their read ports are declared here: {@link TicketsReader}
 * and {@link EpisodesReader}, which `snapshot-readers.ts` implements over the
 * pipeline's own records. The catalog's read port is {@link CatalogReader},
 * implemented over `app.v_catalog_entries` by `repo-catalog.ts`.
 *
 * The health route keeps its own ports (`health.ts`): it must answer before
 * any of these exist, while the process is still connecting.
 */

import type { ApiStatus, CatalogEntry, Episode as EpisodeMessage, Ticket } from "@fdp/contracts";

import type { Env } from "../config/env.ts";
import type { Detector } from "../detection/index.ts";
import type { EpisodeStatus } from "../episodes/index.ts";
import type { Ingest } from "../ingest/index.ts";
import type {
  AlertsRepo,
  CostRepo,
  DecisionsRepo,
  EventsRepo,
  NativeAlarmsRepo,
  Page,
  PageQuery,
} from "../persistence/types.ts";
import type { TicketStatus, TicketVerdict } from "../tickets/index.ts";

/** `GET /api/tickets?status=`: one ticket status, or every ticket when absent. */
export interface TicketListQuery extends PageQuery {
  readonly status?: TicketStatus;
}

/** The tickets, as the `ticket` message of their latest state (`review` is a status). */
export interface TicketsReader {
  /** One page, newest ticket first. */
  list(query?: TicketListQuery): Promise<Page<Ticket>>;
  /** One ticket, or `undefined` when no ticket has that id. */
  get(ticketId: string): Promise<Ticket | undefined>;
}

/** `GET /api/episodes?status=`: one episode status, or every episode when absent. */
export interface EpisodeListQuery extends PageQuery {
  readonly status?: EpisodeStatus;
}

/** The episodes, in the `api-episodes` item shape. */
export interface EpisodesReader {
  /** One page, newest episode first. */
  list(query?: EpisodeListQuery): Promise<Page<EpisodeMessage>>;
}

/** The fault catalog of the active manual document, read only. */
export interface CatalogReader {
  /** Every cause of the active document, in `fault_id` order; empty before init has run. */
  faults(): Promise<readonly CatalogEntry[]>;
  /** One cause, or `undefined` when the active document has none with that id. */
  fault(faultId: string): Promise<CatalogEntry | undefined>;
  /**
   * The normal bands the manual declares per signal (`app.catalog_signals`),
   * keyed by `signal_id`; signals without a band are absent.
   */
  normalBands(): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>>;
}

/** Every repository the routes read. */
export interface ApiRepos {
  readonly events: Pick<EventsRepo, "list">;
  readonly decisions: Pick<DecisionsRepo, "list" | "get">;
  readonly episodes: EpisodesReader;
  readonly tickets: TicketsReader;
  readonly cost: Pick<CostRepo, "summary" | "ledger">;
  readonly alerts: Pick<AlertsRepo, "list">;
  readonly nativeAlarms: NativeAlarmsRepo;
  readonly catalog: CatalogReader;
}

/**
 * The live picture `GET /api/status` repeats: the retained statuses, the raised
 * alerts and the running injections. The route adds the gate thresholds.
 */
export type RuntimeStatus = Omit<ApiStatus, "gate">;

/** What the runtime reports about itself. */
export interface ApiRuntime {
  status(): RuntimeStatus | Promise<RuntimeStatus>;
}

/** The one write a technician performs. */
export interface ApiActions {
  /**
   * Close a ticket on a verdict and resolve with the `ticket` message the close
   * produced (the runtime also persists and publishes it).
   *
   * @throws UnknownTicketError when no ticket carries that id (HTTP 404).
   * @throws TicketClosedError when the ticket already has a verdict (HTTP 409).
   */
  closeTicket(ticketId: string, closure: TicketVerdict): Promise<Ticket>;
}

/** Everything the dashboard routes need. */
export interface ApiDeps {
  /**
   * The gate `GET /api/status` reports: the thresholds of the running decision backend
   * and the persistence.
   */
  readonly env: Pick<Env, "gate" | "decisionBackend">;
  readonly ingest: Pick<Ingest, "latest" | "series">;
  readonly detector: Pick<Detector, "frame">;
  readonly repos: ApiRepos;
  readonly runtime: ApiRuntime;
  readonly actions: ApiActions;
}
