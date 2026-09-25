// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the pipeline's outputs and the watchdogs' alerts go.
 *
 * Every output travels three ways, in this order:
 *
 *   1. **the database**, as `app_rw`, through the repositories of
 *      `src/persistence/` and the episode, ticket and cost repositories;
 *   2. **the broker**, through the diagnosis client (`mqtt/diag-client.ts`);
 *   3. **the WebSocket hub**, as the frame of its type.
 *
 * The rows reference one another — a decision its event and its episode, a
 * ticket its latest decision, a ledger row its decision — so the writes of one
 * push are awaited one after the other in the order the pipeline emitted them.
 * The pipeline emits a decision before the episode it opened, so the decision's
 * episode is written from the store first. Publications are not awaited: the
 * broker client keeps them in call order, and a broker that is briefly away
 * must not hold up the database.
 *
 * A failed write or publication is logged and counted, never thrown: the
 * process keeps diagnosing, `/api/health` shows the counters, and the next
 * upsert of the same episode or ticket repairs what a transient failure left
 * behind.
 */

import type { AlertSystem, Decision, SuspectEvent, Ticket } from "@fdp/contracts";

import { record as ledgerRow } from "../cost/index.ts";
import type { CostRepo } from "../cost/repo.ts";
import type { EpisodeRepo } from "../episodes/repo.ts";
import type { Episode, EpisodeStore } from "../episodes/index.ts";
import type { Heartbeat, HeartbeatRow, HeartbeatSink } from "../heartbeat/index.ts";
import type { Logger } from "../log.ts";
import type { DiagClient } from "../mqtt/diag-client.ts";
import { candidateRows } from "../persistence/index.ts";
import type {
  AlertsRepo,
  DecisionsRepo,
  EventsRepo,
  HeartbeatsRepo,
} from "../persistence/types.ts";
import type {
  PipelineAlarm,
  PipelineDecision,
  PipelineOutput,
  PipelineSuspect,
  PipelineTicket,
} from "../pipeline/types.ts";
import type { TicketRepo } from "../tickets/repo.ts";
import type { Hub } from "../ws/hub.ts";
import { createSerialQueue } from "./serial.ts";

/** The steps a sink counts failures of, for `/api/health`. */
export type SinkStep = "persist" | "publish";

/** The repositories the output sink writes. */
export interface OutputRepos {
  readonly events: Pick<EventsRepo, "insert">;
  readonly decisions: Pick<DecisionsRepo, "insert" | "insertCandidates">;
  readonly episodes: Pick<EpisodeRepo, "save">;
  readonly tickets: Pick<TicketRepo, "save" | "saveClosure">;
  readonly cost: Pick<CostRepo, "insert" | "totals">;
}

/** The publications of the output sink. */
export type OutputPublisher = Pick<
  DiagClient,
  "publishSuspect" | "publishDecision" | "publishTicket"
>;

export interface OutputSinkPorts {
  readonly repos: OutputRepos;
  readonly publisher: OutputPublisher;
  readonly hub: Pick<Hub, "broadcast">;
  /** The pipeline's episode store: the episode a decision or a ticket belongs to. */
  readonly store: Pick<EpisodeStore, "byId" | "get">;
  /** The decision watchdog, told about every answered and every failed call. */
  readonly watchdog: Pick<Heartbeat, "noteDecisionOk" | "noteDecisionError">;
  readonly logger: Logger;
  /** Called after a push that changed an episode, a ticket or the decision counters. */
  readonly onChange?: () => void;
}

/** Writes, publishes and broadcasts what one push of the pipeline emitted. */
export interface OutputSink {
  /** Handle the outputs of one push or one ticket close, in order. */
  write(outputs: readonly PipelineOutput[]): Promise<void>;
  /** Failures so far, by step. */
  failures(): Readonly<Record<SinkStep, number>>;
}

/** Failure counters and the one place that logs a failed step. */
function failureLog(logger: Logger) {
  const counts: Record<SinkStep, number> = { persist: 0, publish: 0 };
  return {
    counts,
    note(step: SinkStep, what: string, error: unknown): void {
      counts[step] += 1;
      logger.error({ err: error, step, what, failures: counts[step] }, `could not ${step} ${what}`);
    },
  };
}

/**
 * The episode each suspect event of one push fed, from the decisions it led
 * to and from the episodes it opened; an event that was only counted falls
 * back to the open episode of its symptom.
 *
 * An episode that waits for persistence is opened by an event no
 * decision names, and it can end in the push that opened it — a replay jump
 * aborts it — so its opening event is linked through the `opened` output
 * rather than through the store, which no longer holds it open.
 */
function episodeLinks(outputs: readonly PipelineOutput[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const output of outputs) {
    if (output.type === "decision") {
      links.set(output.decision.event_id, output.decision.episode_id);
    } else if (output.type === "episode" && output.action === "opened") {
      links.set(output.episode.first_event_id, output.episode.episode_id);
    }
  }
  return links;
}

/** The output sink of the running service. */
export function createOutputSink(ports: OutputSinkPorts): OutputSink {
  const { repos, publisher, hub, store, watchdog } = ports;
  const logger = ports.logger.child({ module: "sinks" });
  const failures = failureLog(logger);

  /** Run one database write; a failure is logged and counted. */
  async function persist(what: string, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error: unknown) {
      failures.note("persist", what, error);
    }
  }

  /** Hand one message to the broker without waiting for its acknowledgement. */
  function publish(what: string, send: () => Promise<void>): void {
    send().catch((error: unknown) => {
      failures.note("publish", what, error);
    });
  }

  async function saveEpisode(episode: Episode | undefined): Promise<void> {
    if (episode === undefined) return;
    await persist(`episode ${episode.episode_id}`, () => repos.episodes.save(episode));
  }

  async function onSuspect(output: PipelineSuspect, links: Map<string, string>): Promise<void> {
    const event: SuspectEvent = output.event;
    const episodeId =
      links.get(event.event_id) ??
      store.get({ unit_id: event.unit_id, symptom_key: event.symptom_key })?.episode_id;
    await persist(`suspect event ${event.event_id}`, () => repos.events.insert(event, episodeId));
    publish(`suspect event ${event.event_id}`, () => publisher.publishSuspect(event));
    hub.broadcast("event.suspect", event);
  }

  async function onDecision(output: PipelineDecision): Promise<void> {
    const { decision } = output;
    if (decision.status === "ok") watchdog.noteDecisionOk();
    else watchdog.noteDecisionError();

    // The row references its episode, which the pipeline announces only after
    // the decision; the store already holds it.
    await saveEpisode(store.byId(decision.episode_id));
    await persist(`decision ${decision.decision_id}`, async () => {
      await repos.decisions.insert(
        decision,
        output.output?.state,
        output.output?.raw.request,
        output.output?.raw.response,
      );
      await repos.decisions.insertCandidates(
        decision.decision_id,
        candidateRows(decision, { support: output.output?.support }),
      );
    });
    publish(`decision ${decision.decision_id}`, () => publisher.publishDecision(decision));
    hub.broadcast("decision", decision);
    await bill(decision);
  }

  /** The ledger row of an answered decision and the `cost.update` frame after it. */
  async function bill(decision: Decision): Promise<void> {
    const row = ledgerRow(decision);
    if (row === null) return;
    await persist(`cost of ${decision.decision_id}`, async () => {
      const costUsd = await repos.cost.insert(row);
      if (costUsd === null) return;
      const totals = await repos.cost.totals();
      hub.broadcast("cost.update", {
        decision_id: decision.decision_id,
        cost_usd: costUsd,
        total_usd: totals.usd,
        calls: totals.calls,
        backend: decision.backend,
      });
    });
  }

  async function onTicket(output: PipelineTicket): Promise<void> {
    const ticket: Ticket = output.ticket;
    await persist(`ticket ${ticket.ticket_id}`, async () => {
      await repos.tickets.save(output.record);
      if (output.closure !== null) await repos.tickets.saveClosure(output.closure);
    });
    // The episode now names its ticket, or its technician closure.
    await saveEpisode(store.byId(ticket.episode_id));
    publish(`ticket ${ticket.ticket_id}`, () => publisher.publishTicket(ticket));
    hub.broadcast("ticket", ticket);
  }

  function onAlarm(output: PipelineAlarm): void {
    // The row itself is ingest's to write, with its folded minutes.
    const { code, state, sim_ts } = output.transition;
    hub.broadcast("alarm.native", { code, active: state === "raised", sim_ts });
  }

  return {
    async write(outputs) {
      const links = episodeLinks(outputs);
      let changed = false;
      for (const output of outputs) {
        switch (output.type) {
          case "suspect":
            await onSuspect(output, links);
            break;
          case "decision":
            await onDecision(output);
            changed = true;
            break;
          case "episode":
            await saveEpisode(output.episode);
            changed = true;
            break;
          case "ticket":
            await onTicket(output);
            changed = true;
            break;
          case "alarm":
            onAlarm(output);
            break;
        }
      }
      if (changed) ports.onChange?.();
    },

    failures: () => ({ ...failures.counts }),
  };
}

export interface WatchdogSinkPorts {
  readonly repos: {
    readonly alerts: Pick<AlertsRepo, "upsert">;
    readonly heartbeats: Pick<HeartbeatsRepo, "update">;
  };
  readonly publisher: Pick<DiagClient, "publishSystemAlert">;
  readonly hub: Pick<Hub, "broadcast">;
  readonly logger: Logger;
  /** Called after every alert, so the backend status is republished. */
  readonly onChange?: () => void;
}

/** The heartbeat's sink, with a way to wait for its writes. */
export interface WatchdogSink extends HeartbeatSink {
  /** Resolves once every write queued so far has settled. */
  settled(): Promise<void>;
  failures(): Readonly<Record<SinkStep, number>>;
}

/**
 * The sink of the two watchdogs.
 *
 * The heartbeat calls it synchronously from its timer and from the sample and
 * decision paths; the writes queue behind one another, so a clear can never
 * land in `app.system_alerts` before the raise it clears.
 */
export function createWatchdogSink(ports: WatchdogSinkPorts): WatchdogSink {
  const { repos, publisher, hub } = ports;
  const logger = ports.logger.child({ module: "watchdog-sink" });
  const failures = failureLog(logger);
  const queue = createSerialQueue();

  function persist(what: string, write: () => Promise<unknown>): void {
    void queue.run(async () => {
      try {
        await write();
      } catch (error: unknown) {
        failures.note("persist", what, error);
      }
    });
  }

  return {
    alert(message: AlertSystem): void {
      logger.warn(
        { alert_id: message.alert_id, kind: message.kind, state: message.state },
        `system alert ${message.kind} ${message.state}`,
      );
      persist(`alert ${message.alert_id}`, () => repos.alerts.upsert(message));
      publisher.publishSystemAlert(message).catch((error: unknown) => {
        failures.note("publish", `alert ${message.alert_id}`, error);
      });
      hub.broadcast("alert.system", message);
      ports.onChange?.();
    },

    heartbeat(row: HeartbeatRow): void {
      persist(`heartbeat ${row.source}`, () => repos.heartbeats.update(row));
    },

    settled: () => queue.idle(),
    failures: () => ({ ...failures.counts }),
  };
}
