// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `summarise` over hand-made event logs.
//
// Every log here is written out message by message, in the order the pipeline
// emits them (suspect → decision → episode → ticket), and every contract
// message is validated against its schema first, so the fixtures cannot drift
// into shapes the pipeline would never produce. The causes and ids are
// fictional.

import { validate } from "@fdp/contracts";
import type { Decision, Ticket } from "@fdp/contracts";
import type {
  Episode,
  PipelineOutput,
  SuspectEventMessage,
  TicketClosureRow,
  TicketRecord as TicketRow,
} from "@fdp/backend/pipeline";
import { describe, expect, it } from "vitest";

import type { CatalogEntry } from "../catalog/types.ts";
import { benignCauses, summarise } from "./recorder.ts";

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

const UNIT = "cau-7";
const WALL = "2026-01-01T00:00:00.000Z";

/** A deterministic UUID from a small number, so a failing assertion names its fixture. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function minutes(n: number): string {
  return new Date(Date.parse("2020-02-03T00:00:00.000Z") + n * 60_000).toISOString();
}

interface DecisionFields {
  readonly id: number;
  readonly episode: number;
  readonly at: number;
  readonly choice: string;
  readonly confidence: number;
  readonly outcome: "ticket" | "review" | "log";
  readonly abstained?: boolean;
  readonly backend?: "rules" | "jev";
  readonly inputTokens?: number;
}

function decisionMessage(fields: DecisionFields): Decision {
  const backend = fields.backend ?? "rules";
  const named = fields.choice !== "none_of_these";
  const message: Decision = {
    schema: "urn:fdp:schema:decision:v1",
    unit_id: UNIT,
    wall_ts: WALL,
    decision_id: uuid(fields.id),
    episode_id: uuid(fields.episode),
    event_id: uuid(1000 + fields.id),
    sim_ts: minutes(fields.at),
    backend,
    model: backend === "rules" ? "rules-v1" : "jev-1.13.0",
    status: "ok",
    choice: fields.choice,
    probabilities: named
      ? { [fields.choice]: fields.confidence, none_of_these: 1 - fields.confidence }
      : { none_of_these: 1 },
    confidence: fields.confidence,
    support: {},
    candidates: [],
    severity: { level: "medium", score: 1, probabilities: { "1": 1 }, confidence: 1 },
    gate: {
      outcome: fields.outcome,
      abstained: fields.abstained ?? false,
      reason: "fixture",
      ticket_min_confidence: 0.85,
      review_min_confidence: 0.6,
    },
    usage: { input_tokens: fields.inputTokens ?? 0, output_tokens: 0 },
    cost: { usd: 0, price_input_per_mtok: 0, price_output_per_mtok: 0, prices_as_of: "2026-09-19" },
    latency_ms: 0,
    state_digest: "0".repeat(64),
    error: null,
  };
  return checked("decision", message);
}

function failedDecision(id: number, episode: number, at: number): Decision {
  return checked("decision", {
    ...decisionMessage({ id, episode, at, choice: "none_of_these", confidence: 0, outcome: "log" }),
    backend: "jev",
    model: "jev-1.13.0",
    status: "failed",
    probabilities: { none_of_these: 1 },
    severity: { level: "low", score: 0, probabilities: { "0": 1 }, confidence: 0 },
    error: { kind: "timeout", message: "no answer" },
  });
}

interface TicketFields {
  readonly id: number;
  readonly episode: number;
  readonly action: Ticket["action"];
  readonly status: Ticket["status"];
  readonly fault: string;
  readonly decision: number;
  readonly opened: number;
  readonly updated?: number;
  readonly resolved?: number;
  readonly closeReason?: Ticket["close_reason"];
  readonly closure?: Ticket["closure"];
}

function ticketMessage(fields: TicketFields): Ticket {
  const message: Ticket = {
    schema: "urn:fdp:schema:ticket:v1",
    unit_id: UNIT,
    wall_ts: WALL,
    ticket_id: uuid(fields.id),
    episode_id: uuid(fields.episode),
    action: fields.action,
    status: fields.status,
    fault_id: fields.fault,
    condition_id: "frequent_cycling",
    title: "A fictional cause — a fictional condition",
    cause: "A fictional description.",
    checks: ["Look at the unit."],
    remedy: "Repair the unit.",
    manual_ref: { section: "8.3" },
    evidence: [{ metric: "load_cycle_rate", observation: "The unit loads often." }],
    confidence: 0.7,
    probabilities: { [fields.fault]: 0.7, none_of_these: 0.3 },
    severity: "medium",
    backend: "rules",
    model: "rules-v1",
    latest_decision_id: uuid(fields.decision),
    opened_sim_ts: minutes(fields.opened),
    updated_sim_ts: minutes(fields.updated ?? fields.opened),
    resolved_sim_ts: fields.resolved === undefined ? null : minutes(fields.resolved),
    close_reason: fields.closeReason ?? null,
    update_count: fields.updated === undefined ? 0 : 1,
    closure: fields.closure ?? null,
  };
  return checked("ticket", message);
}

function checked<T>(schema: "decision" | "ticket", message: T): T {
  const result = validate(schema, message);
  if (!result.ok) {
    throw new Error(
      `fixture is not a valid ${schema}: ${result.errors.map((e) => e.text).join("; ")}`,
    );
  }
  return message;
}

/** The `app.tickets` row behind a message; the recorder reads the message, never the row. */
function rowOf(ticket: Ticket): TicketRow {
  return {
    ticket_id: ticket.ticket_id,
    episode_id: ticket.episode_id,
    unit_id: ticket.unit_id,
    status: ticket.status,
    fault_id: ticket.fault_id,
    condition_id: ticket.condition_id,
    title: ticket.title,
    cause: ticket.cause,
    remedy: ticket.remedy,
    checks: ticket.checks,
    manual_ref: ticket.manual_ref,
    evidence: ticket.evidence,
    confidence: ticket.confidence,
    probabilities: ticket.probabilities,
    severity: ticket.severity,
    backend: ticket.backend,
    model: ticket.model,
    rationale: ticket.rationale ?? null,
    latest_decision_id: ticket.latest_decision_id,
    opened_sim_ts: ticket.opened_sim_ts,
    updated_sim_ts: ticket.updated_sim_ts,
    resolved_sim_ts: ticket.resolved_sim_ts,
    close_reason: ticket.close_reason,
    opened_wall_ts: ticket.wall_ts,
    updated_wall_ts: ticket.wall_ts,
    resolved_wall_ts: ticket.resolved_sim_ts === null ? null : ticket.wall_ts,
    update_count: ticket.update_count,
    closure: ticket.closure === null ? null : { ...ticket.closure },
  };
}

function episodeRecord(id: number, action: "opened" | "merged" | "closed" | "aborted"): Episode {
  return {
    episode_id: uuid(id),
    unit_id: UNIT,
    symptom_key: "frequent_cycling",
    symptom_keys: ["frequent_cycling"],
    status: action === "closed" ? "closed" : action === "aborted" ? "aborted" : "open",
    merged_into: null,
    opened_sim_ts: minutes(0),
    last_event_sim_ts: minutes(0),
    last_decision_sim_ts: minutes(0),
    closed_sim_ts: null,
    close_reason: null,
    first_event_id: uuid(1000 + id),
    ticket_id: null,
    closed_by_technician: false,
    event_count: 1,
    decision_count: 1,
    fault_id: null,
  };
}

const suspect = (id = 9999, at = 0): PipelineOutput => ({
  type: "suspect",
  event: {
    event_id: uuid(id),
    sim_ts: minutes(at),
    symptom_key: "continuous_load",
  } as SuspectEventMessage,
});
const decided = (decision: Decision): PipelineOutput => ({
  type: "decision",
  decision,
  output: null,
  gate: { outcome: decision.gate.outcome, abstained: decision.gate.abstained, reason: "fixture" },
});
const episode = (
  id: number,
  action: "opened" | "merged" | "closed" | "aborted",
): PipelineOutput => ({
  type: "episode",
  episode: episodeRecord(id, action),
  action,
});
const ticketed = (ticket: Ticket, closure: TicketClosureRow | null = null): PipelineOutput => ({
  type: "ticket",
  ticket,
  record: rowOf(ticket),
  closure,
});
const alarm = (code: string, at: number): PipelineOutput => ({
  type: "alarm",
  transition: { code, state: "raised", sim_ts: minutes(at), seq: at + 1 },
});

const NONE = new Set<string>();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tickets", () => {
  it("promotes a review ticket to ticket level when a later decision opens it", () => {
    const summary = summarise(
      [
        suspect(),
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.7,
            outcome: "review",
          }),
        ),
        episode(10, "opened"),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "review",
            fault: "fault_a",
            decision: 1,
            opened: 5,
          }),
        ),
        suspect(),
        decided(
          decisionMessage({
            id: 2,
            episode: 10,
            at: 35,
            choice: "fault_b",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "updated",
            status: "open",
            fault: "fault_b",
            decision: 2,
            opened: 5,
            updated: 35,
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets).toEqual([
      {
        ticketId: uuid(20),
        episodeId: uuid(10),
        openedSimTs: new Date(minutes(5)),
        faultAtOpen: "fault_a",
        faultLatest: "fault_b",
        maxLevel: "ticket",
      },
    ]);
    expect(summary.openAtEnd).toEqual([uuid(20)]);
  });

  it("keeps a ticket that never left review at review level", () => {
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.7,
            outcome: "review",
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "review",
            fault: "fault_a",
            decision: 1,
            opened: 5,
          }),
        ),
        decided(
          decisionMessage({
            id: 2,
            episode: 10,
            at: 35,
            choice: "fault_a",
            confidence: 0.65,
            outcome: "review",
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "updated",
            status: "review",
            fault: "fault_a",
            decision: 2,
            opened: 5,
            updated: 35,
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets.map((ticket) => ticket.maxLevel)).toEqual(["review"]);
  });

  it("reads the level from the gate outcome as well as the status", () => {
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        // A resolved message carries no live status; the decision behind it says ticket.
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "resolved",
            status: "resolved",
            fault: "fault_a",
            decision: 1,
            opened: 5,
            resolved: 50,
            closeReason: "silence",
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets[0]?.maxLevel).toBe("ticket");
  });

  it("scores one ticket for a merged episode, whose decisions update its target's ticket", () => {
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        episode(10, "opened"),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "open",
            fault: "fault_a",
            decision: 1,
            opened: 5,
          }),
        ),
        decided(
          decisionMessage({
            id: 2,
            episode: 11,
            at: 12,
            choice: "fault_a",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        episode(11, "opened"),
        episode(11, "merged"),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "updated",
            status: "open",
            fault: "fault_a",
            decision: 2,
            opened: 5,
            updated: 12,
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets).toHaveLength(1);
    expect(summary.tickets[0]?.episodeId).toBe(uuid(10));
    expect(summary.episodes).toEqual({ opened: 2, merged: 1, closed: 0, aborted: 0 });
    expect(summary.decisions.map((decision) => decision.episodeId)).toEqual([uuid(10), uuid(11)]);
  });

  it("closes a ticket whose episode was aborted by a discontinuity", () => {
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.7,
            outcome: "review",
          }),
        ),
        episode(10, "opened"),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "review",
            fault: "fault_a",
            decision: 1,
            opened: 5,
          }),
        ),
        episode(10, "aborted"),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "resolved",
            status: "resolved",
            fault: "fault_a",
            decision: 1,
            opened: 5,
            resolved: 44,
            closeReason: "discontinuity",
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets[0]?.closedSimTs).toEqual(new Date(minutes(44)));
    expect(summary.tickets[0]?.maxLevel).toBe("review");
    expect(summary.openAtEnd).toEqual([]);
    expect(summary.episodes).toEqual({ opened: 1, merged: 0, closed: 0, aborted: 1 });
  });

  it("dates a technician's close from the closure row when the machine never resolved it", () => {
    const closure = { verdict: "correct" as const, closed_by: "tech-1", wall_ts: WALL };
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 5,
            choice: "fault_a",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "open",
            fault: "fault_a",
            decision: 1,
            opened: 5,
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "closed",
            status: "closed",
            fault: "fault_a",
            decision: 1,
            opened: 5,
            closeReason: "technician",
            closure,
          }),
          {
            ticket_id: uuid(20),
            verdict: "correct",
            note: null,
            closed_by: "tech-1",
            sim_ts: minutes(61),
            wall_ts: WALL,
          },
        ),
      ],
      NONE,
    );
    expect(summary.tickets[0]?.closedSimTs).toEqual(new Date(minutes(61)));
    expect(summary.tickets[0]?.maxLevel).toBe("ticket");
    expect(summary.openAtEnd).toEqual([]);
  });

  it("lists the tickets in the order they were opened", () => {
    const summary = summarise(
      [
        decided(
          decisionMessage({
            id: 1,
            episode: 10,
            at: 50,
            choice: "fault_a",
            confidence: 0.9,
            outcome: "ticket",
          }),
        ),
        // The later-numbered ticket opened first: the order is sim time, not arrival.
        ticketed(
          ticketMessage({
            id: 21,
            episode: 11,
            action: "opened",
            status: "open",
            fault: "fault_b",
            decision: 1,
            opened: 50,
          }),
        ),
        ticketed(
          ticketMessage({
            id: 20,
            episode: 10,
            action: "opened",
            status: "open",
            fault: "fault_a",
            decision: 1,
            opened: 20,
          }),
        ),
      ],
      NONE,
    );
    expect(summary.tickets.map((ticket) => ticket.ticketId)).toEqual([uuid(20), uuid(21)]);
  });
});

describe("decisions and counters", () => {
  const benign = new Set(["high_demand"]);
  const summary = summarise(
    [
      alarm("W101", 1),
      suspect(),
      decided(
        decisionMessage({
          id: 1,
          episode: 10,
          at: 5,
          choice: "high_demand",
          confidence: 0.7,
          outcome: "review",
          backend: "jev",
          inputTokens: 1480,
        }),
      ),
      suspect(),
      decided(
        decisionMessage({
          id: 2,
          episode: 10,
          at: 35,
          choice: "none_of_these",
          confidence: 0.8,
          outcome: "log",
          abstained: true,
          backend: "jev",
          inputTokens: 1500,
        }),
      ),
      suspect(),
      decided(failedDecision(3, 10, 65)),
      episode(10, "opened"),
      episode(10, "closed"),
    ],
    benign,
  );

  it("keeps every answered decision with what the scorer reads", () => {
    expect(summary.decisions).toEqual([
      {
        decisionId: uuid(1),
        episodeId: uuid(10),
        simTs: new Date(minutes(5)),
        choice: "high_demand",
        confidence: 0.7,
        gate: "review",
        abstained: false,
        usage: { input_tokens: 1480, output_tokens: 0 },
        backend: "jev",
        benignChoice: true,
      },
      {
        decisionId: uuid(2),
        episodeId: uuid(10),
        simTs: new Date(minutes(35)),
        choice: "none_of_these",
        confidence: 0.8,
        gate: "log",
        abstained: true,
        usage: { input_tokens: 1500, output_tokens: 0 },
        backend: "jev",
        benignChoice: false,
      },
    ]);
  });

  it("keeps how long each decision's evidence had held, when the pipeline says", () => {
    const message = decisionMessage({
      id: 4,
      episode: 11,
      at: 95,
      choice: "high_demand",
      confidence: 0.9,
      outcome: "ticket",
      backend: "jev",
      inputTokens: 1480,
    });
    const withFigure: PipelineOutput = {
      type: "decision",
      decision: message,
      output: null,
      gate: { outcome: "ticket", abstained: false, reason: "fixture" },
      persistedSimMin: 1.5,
    };
    expect(summarise([withFigure], NONE).decisions[0]?.persistedSimMin).toBe(1.5);
    // A host that builds outputs without it (or an older pipeline) records no figure at all.
    expect(summarise([decided(message)], NONE).decisions[0]).not.toHaveProperty("persistedSimMin");
  });

  it("counts the failed calls, the suspects and the episode transitions apart", () => {
    expect(summary.failedDecisions).toBe(1);
    expect(summary.failureReasons).toEqual({ "timeout: no answer": 1 });
    expect(summary.suspects).toBe(3);
    expect(summary.episodes).toEqual({ opened: 1, merged: 0, closed: 1, aborted: 0 });
    expect(summary.tickets).toEqual([]);
    expect(summary.openAtEnd).toEqual([]);
  });

  it("keeps every suspect event with its instant and symptom, for detection level", () => {
    const events = summarise([suspect(1, 5), suspect(2, 35)], NONE).suspectEvents;
    expect(events).toEqual([
      { eventId: uuid(1), simTs: new Date(minutes(5)), symptomKey: "continuous_load" },
      { eventId: uuid(2), simTs: new Date(minutes(35)), symptomKey: "continuous_load" },
    ]);
  });

  it("summarises an empty log to nothing", () => {
    expect(summarise([], NONE)).toEqual({
      tickets: [],
      decisions: [],
      failedDecisions: 0,
      failureReasons: {},
      suspects: 0,
      suspectEvents: [],
      episodes: { opened: 0, merged: 0, closed: 0, aborted: 0 },
      openAtEnd: [],
    });
  });
});

describe("benignCauses", () => {
  const entry = (faultId: string, benign: boolean): CatalogEntry =>
    ({ fault_id: faultId, benign }) as CatalogEntry;

  it("takes the catalog's benign flags and adds the caller's", () => {
    const causes = benignCauses(
      [entry("high_demand", true), entry("fault_a", false), entry("cold_day", true)],
      ["sensor_fault"],
    );
    expect([...causes].sort()).toEqual(["cold_day", "high_demand", "sensor_fault"]);
  });
});
