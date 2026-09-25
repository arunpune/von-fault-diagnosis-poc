// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Every message and REST body the UI reads.
//
// The shapes are the generated types of `@fdp/contracts`, imported as types only so nothing of
// the contracts package reaches the bundle. A few are renamed to the UI's words:
// what the backend's overlay endpoint serves is an "overlay" here, never the name of the module
// it comes from. Below the re-exports sit the only shapes this file spells itself:
// the REST bodies the contracts leave without a schema and the part of the series body the
// recorder seeds from. Every other module imports its types from here, never from the package.

import type {
  ActiveFaultInjections,
  AlarmNativePayload,
  AlertSystem,
  AmbientBucket,
  ApiCost,
  ApiDecisions,
  ApiError as ApiErrorBody,
  ApiEvents,
  ApiHealth,
  ApiSignals,
  ApiSimCommandResult,
  ApiStatus,
  ApiTelemetrySeries,
  ApiTicketClose,
  ApiTickets,
  BackendTotals,
  Candidate,
  CatalogEntry,
  Channel,
  Command,
  ControlAck,
  ControlError,
  CostDay,
  CostUpdatePayload,
  Decision,
  DecisionBackend,
  Episode,
  EvidenceItem,
  ExcludedWindow,
  Failure,
  FaultInjectionEvent,
  FrameType,
  GroundTruthCatalog,
  GroundTruthFailureTableDocument,
  GroundTruthPresetDefinition,
  HealthSim,
  HeartbeatPayload,
  HeartbeatState,
  HelloPayload,
  InjectArgs,
  InjectionMenuEntry,
  InstanceParameter,
  JumpArgs,
  LedgerRow,
  LevelBucket,
  MachineMode,
  ManualReference,
  NoArgs,
  Observation,
  ReplayMarker,
  RunningInstance,
  Sample,
  SeriesEntry,
  SeriesFrameEntry,
  SeriesPoint,
  SetSpeedArgs,
  SeverityLevel,
  SignalDef,
  SignalMove,
  SimulatorState,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
  SuspectEvent,
  TelemetrySamples,
  TelemetrySeriesPayload,
  Ticket,
  TicketClosure,
  TrendBucket,
  UnlabelledEpisode,
  UsageTotals,
  WsServerMessage,
} from "@fdp/contracts";

export type {
  AlarmNativePayload,
  AlertSystem,
  AmbientBucket,
  ApiCost,
  ApiDecisions,
  ApiErrorBody,
  ApiEvents,
  ApiHealth,
  ApiSignals,
  ApiSimCommandResult,
  ApiStatus,
  ApiTelemetrySeries,
  ApiTicketClose,
  ApiTickets,
  BackendTotals,
  Candidate,
  CatalogEntry,
  Channel,
  ControlAck,
  ControlError,
  CostDay,
  Decision,
  DecisionBackend,
  Episode,
  EvidenceItem,
  ExcludedWindow,
  HealthSim,
  HeartbeatPayload,
  HeartbeatState,
  HelloPayload,
  InjectArgs,
  JumpArgs,
  LedgerRow,
  LevelBucket,
  MachineMode,
  ManualReference,
  NoArgs,
  Observation,
  RunningInstance,
  Sample,
  SeriesEntry,
  SeriesFrameEntry,
  SeriesPoint,
  SetSpeedArgs,
  SeverityLevel,
  SignalDef,
  SignalMove,
  SimulatorState,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
  SuspectEvent,
  TelemetrySamples,
  Ticket,
  TicketClosure,
  TrendBucket,
  UnlabelledEpisode,
  UsageTotals,
  WsServerMessage,
};

/** The command a simulator acknowledgement echoes (`control-ack.cmd`). */
export type SimCommandName = Command;

/** `cost.update`: the ledger row of one billed decision with the running totals. */
export type CostUpdate = CostUpdatePayload;

/** `telemetry.series`: one decimated chart frame. */
export type TelemetrySeries = TelemetrySeriesPayload;

/** The frame types of `ws-server-message`, the same names a socket subscribes to. */
export type ServerFrameType = FrameType;

// The overlay: dataset failure windows, injected faults and replay markers, as the backend's
// read-only overlay endpoint serves them (see the isolation section of docs/architecture.md).
// The UI draws them and never reads them for anything else.

/** `GET /api/overlay/catalog` and the `overlay.catalog` frame. */
export type OverlayCatalog = GroundTruthCatalog;
/** One entry of the "Jump to" menu. */
export type PresetDef = GroundTruthPresetDefinition;
/** One entry of the "Inject fault" menu. */
export type InjectionDef = InjectionMenuEntry;
/** One tunable parameter of an injection, with its default and bounds. */
export type ParamDef = InstanceParameter;
/** The dataset failure windows and the windows excluded from scoring. */
export type FailureTable = GroundTruthFailureTableDocument;
/** One dataset failure window. */
export type FailureWindow = Failure;
/** `GET /api/overlay/active` and the `overlay.injection_active` frame. */
export type OverlayInjectionActive = ActiveFaultInjections;
/** The `overlay.injection` frame: one injection instance starting or stopping. */
export type OverlayInjection = FaultInjectionEvent;
/** A replay marker (jump, reset or loop), one per `overlay.marker` frame. */
export type OverlayMarker = ReplayMarker;

// UI-internal shapes: the REST bodies without a contract schema and the part of the series body
// the recorder seeds from.

/** The body of the bounded lists: `/api/alerts/system`, `/api/overlay/{injections,markers}`. */
export interface ItemList<T> {
  items: T[];
}

/** One row of `GET /api/overlay/injections`: an injection instance and its extent in sim time. */
export interface InjectionInterval {
  unit_id: string;
  instance_id: string;
  injection_id: string;
  fault_id: string;
  start_sim_ts: string;
  /** Null while the instance has not stopped. */
  end_sim_ts: string | null;
  /** Why the instance stopped; null while it runs. */
  reason: string | null;
  params: Record<string, unknown>;
}

/** `GET /api/decisions/:id`: the decision message plus the state the backend saw, when stored. */
export type DecisionDetail = Decision & { state?: unknown };

/** `GET /api/tickets/:id`: the ticket message plus its episode's decisions, newest first. */
export type TicketDetail = Ticket & { decisions: Decision[] };

/** The `?status=` filter of `GET /api/tickets`: one ticket status, or every ticket. */
export type TicketStatusFilter = Ticket["status"] | "all";

/** The technician's verdict posted to `POST /api/tickets/:id/close`. */
export type TicketVerdict = ApiTicketClose["verdict"];

/**
 * The route segment of each simulator command (`POST /api/sim/:segment`, docs/api.md) and the
 * argument object it takes.
 */
export interface SimCommandArgs {
  play: NoArgs;
  pause: NoArgs;
  speed: SetSpeedArgs;
  jump: JumpArgs;
  inject: InjectArgs;
  clear: NoArgs;
  reset: NoArgs;
}

export type SimCommandSegment = keyof SimCommandArgs;

/**
 * The series history the recorder seeds from, as `toSeries()` in `endpoints.ts` reads it out of
 * `GET /api/telemetry/series`: the window, one contract `SeriesEntry` per tag and the instants
 * where data time jumped, where the recorder breaks its lines.
 */
export type SeriesResponse = Pick<ApiTelemetrySeries, "from" | "to" | "series" | "discontinuities">;
