// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles for the runtime's unit tests.
 *
 * Three kinds:
 *
 *   * a decision backend that always answers with confidence 0.9 on the first
 *     candidate, so a synthetic scenario the rules twin only logs opens a
 *     ticket and the sinks see every kind of output;
 *   * recorders for the hub, the broker publications and the watchdog, which
 *     keep what they were handed in order;
 *   * {@link fakeDiagnosisDb}, the diagnosis tables in memory with their
 *     foreign keys — a decision needs its event and its episode, a ticket its
 *     episode and its latest decision, a ledger row its decision — so a sink
 *     that writes out of order fails here exactly as it would in PostgreSQL.
 */

import type {
  AlertSystem,
  ApiCost,
  Decision,
  Sample,
  StatusBackend,
  SuspectEvent,
  Ticket,
} from "@fdp/contracts";

import type { CostLedgerRow } from "../cost/index.ts";
import { computeCost } from "../cost/index.ts";
import type { DecisionBackend } from "../decision/types.ts";
import type { Episode } from "../episodes/index.ts";
import type { HeartbeatRow } from "../heartbeat/index.ts";
import { createRulesBackend } from "../pipeline/index.ts";
import type { DecisionCandidateRow } from "../persistence/types.ts";
import type { TicketClosureRow, TicketRecord } from "../tickets/index.ts";
import type { BroadcastType, FramePayload } from "../ws/hub.ts";
import type { OutputRepos, WatchdogSinkPorts } from "./sinks.ts";

/** The confidence the stub backend answers with: above the 0.85 ticket gate. */
export const CONFIDENT = 0.9;

/** The rules twin, overruled: its answer, with 0.9 on the first candidate. */
export function confidentBackend(): DecisionBackend {
  const twin = createRulesBackend();
  return {
    name: twin.name,
    model: twin.model,
    async decide(input) {
      const answer = await twin.decide(input);
      const [first] = input.candidates;
      if (first === undefined) return answer;
      const others = Object.keys(answer.probabilities).length - 1;
      const probabilities = Object.fromEntries(
        Object.keys(answer.probabilities).map((id) => [
          id,
          id === first.fault_id ? CONFIDENT : (1 - CONFIDENT) / Math.max(1, others),
        ]),
      );
      return { ...answer, choice: first.fault_id, confidence: CONFIDENT, probabilities };
    },
  };
}

/** One frame the hub was asked to send. */
export interface RecordedFrame {
  readonly type: BroadcastType;
  readonly payload: unknown;
}

export interface RecordingHub {
  readonly frames: RecordedFrame[];
  readonly samples: Sample[];
  broadcast<T extends BroadcastType>(type: T, payload: FramePayload<T>): void;
  pushSamples(samples: readonly Sample[]): void;
}

export function recordingHub(): RecordingHub {
  const frames: RecordedFrame[] = [];
  const samples: Sample[] = [];
  return {
    frames,
    samples,
    broadcast(type, payload) {
      frames.push({ type, payload });
    },
    pushSamples(batch) {
      samples.push(...batch);
    },
  };
}

/** One message the broker client was asked to publish. */
export interface RecordedPublication {
  readonly kind: "suspect" | "decision" | "ticket" | "alert" | "status";
  readonly payload: unknown;
}

export interface RecordingPublisher {
  readonly published: RecordedPublication[];
  /** Make the next publication fail, the way a closed connection does. */
  failNext(): void;
  publishSuspect(event: SuspectEvent): Promise<void>;
  publishDecision(decision: Decision): Promise<void>;
  publishTicket(ticket: Ticket): Promise<void>;
  publishSystemAlert(alert: AlertSystem): Promise<void>;
  publishStatus(status: StatusBackend): Promise<void>;
}

export function recordingPublisher(): RecordingPublisher {
  const published: RecordedPublication[] = [];
  let failing = false;
  function record(kind: RecordedPublication["kind"], payload: unknown): Promise<void> {
    if (failing) {
      failing = false;
      return Promise.reject(new Error("the broker connection is closed"));
    }
    published.push({ kind, payload });
    return Promise.resolve();
  }
  return {
    published,
    failNext() {
      failing = true;
    },
    publishSuspect: (event) => record("suspect", event),
    publishDecision: (decision) => record("decision", decision),
    publishTicket: (ticket) => record("ticket", ticket),
    publishSystemAlert: (alert) => record("alert", alert),
    publishStatus: (status) => record("status", status),
  };
}

/** How often each watchdog note was taken. */
export interface RecordingWatchdog {
  readonly notes: { sample: number; ok: number; error: number; tick: number };
  readonly simStates: string[];
  noteSample(): void;
  noteDecisionOk(): void;
  noteDecisionError(): void;
  noteSimState(state: string): void;
  tick(): void;
}

export function recordingWatchdog(): RecordingWatchdog {
  const notes = { sample: 0, ok: 0, error: 0, tick: 0 };
  const simStates: string[] = [];
  return {
    notes,
    simStates,
    noteSample: () => {
      notes.sample += 1;
    },
    noteDecisionOk: () => {
      notes.ok += 1;
    },
    noteDecisionError: () => {
      notes.error += 1;
    },
    noteSimState: (state) => {
      simStates.push(state);
    },
    tick: () => {
      notes.tick += 1;
    },
  };
}

/** The diagnosis tables in memory, with the foreign keys of the `app` schema. */
export interface FakeDiagnosisDb {
  readonly repos: OutputRepos;
  readonly watchdogRepos: WatchdogSinkPorts["repos"];
  readonly events: Map<string, { event: SuspectEvent; episodeId: string | undefined }>;
  readonly episodes: Map<string, Episode>;
  readonly decisions: Map<string, Decision>;
  readonly candidates: Map<string, readonly DecisionCandidateRow[]>;
  readonly tickets: Map<string, TicketRecord>;
  readonly closures: TicketClosureRow[];
  readonly ledger: CostLedgerRow[];
  readonly alerts: AlertSystem[];
  readonly heartbeats: HeartbeatRow[];
  /** Make every write after this call throw, the way a lost pool does. */
  failWrites(): void;
}

export function fakeDiagnosisDb(): FakeDiagnosisDb {
  const events = new Map<string, { event: SuspectEvent; episodeId: string | undefined }>();
  const episodes = new Map<string, Episode>();
  const decisions = new Map<string, Decision>();
  const candidates = new Map<string, readonly DecisionCandidateRow[]>();
  const tickets = new Map<string, TicketRecord>();
  const closures: TicketClosureRow[] = [];
  const ledger: CostLedgerRow[] = [];
  const alerts: AlertSystem[] = [];
  const heartbeats: HeartbeatRow[] = [];
  let failing = false;

  async function write(check: () => void): Promise<void> {
    if (failing) throw new Error("the pool is gone");
    check();
  }

  function ensure(condition: boolean, what: string): void {
    if (!condition) throw new Error(`foreign key violated: ${what}`);
  }

  function totals(): ApiCost["totals"] {
    return {
      usd: ledger.reduce((sum, row) => sum + computeCost(row, row), 0),
      calls: ledger.length,
      input_tokens: ledger.reduce((sum, row) => sum + row.input_tokens, 0),
      output_tokens: ledger.reduce((sum, row) => sum + row.output_tokens, 0),
    };
  }

  const repos: OutputRepos = {
    events: {
      async insert(event, episodeId) {
        await write(() => undefined);
        if (events.has(event.event_id)) return false;
        events.set(event.event_id, { event, episodeId });
        return true;
      },
    },
    episodes: {
      save: (episode) =>
        write(() => {
          ensure(events.has(episode.first_event_id), `episode ${episode.episode_id} → event`);
          if (episode.merged_into !== null) {
            ensure(episodes.has(episode.merged_into), `episode ${episode.episode_id} → target`);
          }
          episodes.set(episode.episode_id, episode);
        }),
    },
    decisions: {
      async insert(message) {
        await write(() => {
          ensure(events.has(message.event_id), `decision ${message.decision_id} → event`);
          ensure(episodes.has(message.episode_id), `decision ${message.decision_id} → episode`);
        });
        if (decisions.has(message.decision_id)) return false;
        decisions.set(message.decision_id, message);
        return true;
      },
      async insertCandidates(decisionId, rows) {
        await write(() => {
          ensure(decisions.has(decisionId), `candidates → decision ${decisionId}`);
        });
        candidates.set(decisionId, rows);
        return rows.length;
      },
    },
    tickets: {
      save: (record) =>
        write(() => {
          ensure(episodes.has(record.episode_id), `ticket ${record.ticket_id} → episode`);
          ensure(decisions.has(record.latest_decision_id), `ticket ${record.ticket_id} → decision`);
          tickets.set(record.ticket_id, record);
        }),
      saveClosure: (closure) =>
        write(() => {
          ensure(tickets.has(closure.ticket_id), `closure → ticket ${closure.ticket_id}`);
          closures.push(closure);
        }),
    },
    cost: {
      async insert(row) {
        await write(() => {
          ensure(decisions.has(row.decision_id), `ledger → decision ${row.decision_id}`);
        });
        if (ledger.some((existing) => existing.decision_id === row.decision_id)) return null;
        ledger.push(row);
        return computeCost(row, row);
      },
      totals: () => Promise.resolve(totals()),
    },
  };

  const watchdogRepos: WatchdogSinkPorts["repos"] = {
    alerts: {
      upsert: (alert) =>
        write(() => {
          alerts.push(alert);
        }),
    },
    heartbeats: {
      update: (row) =>
        write(() => {
          heartbeats.push(row);
        }),
    },
  };

  return {
    repos,
    watchdogRepos,
    events,
    episodes,
    decisions,
    candidates,
    tickets,
    closures,
    ledger,
    alerts,
    heartbeats,
    failWrites() {
      failing = true;
    },
  };
}
