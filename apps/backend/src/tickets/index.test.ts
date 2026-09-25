// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ticket lifecycle: review → open
// promotion, update on every later decision whatever the gate said, resolved
// by silence or a discontinuity, closed by a technician, and never written by
// a decision again once it has left the live states. Every transition is
// enumerated in one table, and every message it produces is validated against
// the `ticket` contract with the action and status the transition promises.

import { validate, type CatalogEntry, type SuspectEvent, type Ticket } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { candidatesFor, catalogEntry } from "../../test/fixtures/catalog/index.ts";
import { fixedClock } from "../clock.ts";
import { answered, eventAt, failed, sequentialIds } from "../episodes/decisions.test-helper.ts";
import { createEpisodeStore, type Episode } from "../episodes/store.ts";
import {
  createTicketManager,
  TicketClosedError,
  UnknownTicketError,
  type TicketChange,
  type TicketClosureRow,
  type TicketManager,
  type TicketOutcome,
  type TicketRecord,
  type TicketRepo,
} from "./index.ts";

const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const LEAK = "dryer_purge_leak";
const SILENCER = "purge_silencer_damaged";
const WALL_START = "2026-09-22T09:00:00.000Z";

/** 11:00 on the fixture day plus `minutes`, as an `iso_ts`. */
function at(minutes: number): string {
  return new Date(Date.parse("2020-06-05T11:00:00.000Z") + minutes * 60_000).toISOString();
}

/** A repository that remembers every write, and can be told to fail the next one. */
function recordingRepo(): TicketRepo & {
  saved: TicketRecord[];
  closures: TicketClosureRow[];
  failNext(): void;
} {
  let failing = false;
  const saved: TicketRecord[] = [];
  const closures: TicketClosureRow[] = [];
  return {
    saved,
    closures,
    failNext() {
      failing = true;
    },
    async save(ticket) {
      if (failing) {
        failing = false;
        throw new Error("connection terminated");
      }
      saved.push(ticket);
    },
    async saveClosure(closure) {
      closures.push(closure);
    },
    async load() {
      return [...saved];
    },
  };
}

interface Harness {
  readonly tickets: TicketManager;
  readonly repo: ReturnType<typeof recordingRepo>;
  readonly episode: Episode;
  readonly wall: ReturnType<typeof fixedClock>;
  /** Decide the episode at `minutes`, choosing `choice` with `confidence`. */
  decide(minutes: number, choice: string, confidence: number): Promise<TicketOutcome>;
}

function harness(): Harness {
  const store = createEpisodeStore();
  const episode = store.open({
    episode_id: "00000001-0000-4000-8000-000000000001",
    unit_id: "cau-7",
    symptom_key: "continuous_load",
    opened_sim_ts: at(0),
    first_event_id: SIGNATURE_A_EVENT.event_id,
  });
  const wall = fixedClock(WALL_START);
  const repo = recordingRepo();
  const tickets = createTicketManager({ repo, ids: sequentialIds(9), wall });
  const eventIds = sequentialIds(2);
  const decisionIds = sequentialIds(3);

  return {
    tickets,
    repo,
    episode,
    wall,
    async decide(minutes, choice, confidence) {
      wall.advance(1_000);
      const event: SuspectEvent = eventAt(SIGNATURE_A_EVENT, eventIds(), at(minutes));
      const { decision, gate } = answered({
        event,
        candidates: CANDIDATES,
        episodeId: episode.episode_id,
        decisionId: decisionIds(),
        choice,
        confidence,
      });
      const candidate: CatalogEntry | undefined = CANDIDATES.find(
        (entry) => entry.fault_id === choice,
      );
      return tickets.applyDecision(episode, decision, gate, candidate, event);
    },
  };
}

/** The outcome as a change, failing the test when nothing changed. */
function changed(outcome: TicketOutcome): TicketChange {
  if (outcome.action === "none") throw new Error("expected the ticket to change");
  return outcome;
}

/** Validate a message against the contract and return it. */
function valid(message: Ticket): Ticket {
  const result = validate("ticket", message);
  expect(result.ok ? [] : result.errors.map((issue) => issue.text)).toEqual([]);
  return message;
}

type Step = (h: Harness, previous: TicketChange | undefined) => Promise<TicketOutcome>;

interface Transition {
  readonly name: string;
  /** Steps run in order; the last one is the transition under test. */
  readonly steps: readonly Step[];
  readonly action: TicketOutcome["action"];
  /** The message's `action` and `status`, when the transition produces one. */
  readonly message?: { readonly action: Ticket["action"]; readonly status: Ticket["status"] };
}

const openTicket: Step = (h) => h.decide(0, LEAK, 0.9);
const openReview: Step = (h) => h.decide(0, LEAK, 0.7);
const resolveSilence: Step = (h, previous) =>
  h.tickets.resolve(previous!.ticket.ticket_id, "silence", at(200));
const closeCorrect: Step = (h, previous) =>
  h.tickets.close(previous!.ticket.ticket_id, { verdict: "correct" }, at(90));

/**
 * Every transition of the lifecycle, the ones that change nothing included.
 *
 * The confidences are the default gate: ≥ 0.85 `ticket`, ≥ 0.60 `review`,
 * anything lower `log`.
 */
const TRANSITIONS: readonly Transition[] = [
  {
    name: "gate ticket opens an open ticket",
    steps: [openTicket],
    action: "opened",
    message: { action: "opened", status: "open" },
  },
  {
    name: "gate review opens a review ticket",
    steps: [openReview],
    action: "opened",
    message: { action: "opened", status: "review" },
  },
  { name: "gate log opens nothing", steps: [(h) => h.decide(0, LEAK, 0.4)], action: "none" },
  {
    name: "an abstention opens nothing",
    steps: [(h) => h.decide(0, "none_of_these", 0.9)],
    action: "none",
  },
  {
    name: "a review ticket is promoted by a decision at the ticket threshold",
    steps: [openReview, (h) => h.decide(30, LEAK, 0.85)],
    action: "promoted",
    message: { action: "updated", status: "open" },
  },
  {
    name: "a review ticket below the ticket threshold is updated and stays in review",
    steps: [openReview, (h) => h.decide(30, SILENCER, 0.65)],
    action: "updated",
    message: { action: "updated", status: "review" },
  },
  {
    name: "an open ticket is updated by a later ticket-level decision",
    steps: [openTicket, (h) => h.decide(30, LEAK, 0.95)],
    action: "updated",
    message: { action: "updated", status: "open" },
  },
  {
    name: "an open ticket is updated by a later decision the gate only logged",
    steps: [openTicket, (h) => h.decide(30, SILENCER, 0.3)],
    action: "updated",
    message: { action: "updated", status: "open" },
  },
  {
    name: "an open ticket is not changed by an abstention",
    steps: [openTicket, (h) => h.decide(30, "none_of_these", 0.9)],
    action: "none",
  },
  {
    name: "silence resolves an open ticket",
    steps: [openTicket, resolveSilence],
    action: "resolved",
    message: { action: "resolved", status: "resolved" },
  },
  {
    name: "a discontinuity resolves a review ticket",
    steps: [openReview, (h, p) => h.tickets.resolve(p!.ticket.ticket_id, "discontinuity", at(40))],
    action: "resolved",
    message: { action: "resolved", status: "resolved" },
  },
  {
    name: "a technician closes an open ticket",
    steps: [openTicket, closeCorrect],
    action: "closed",
    message: { action: "closed", status: "closed" },
  },
  {
    name: "a technician closes a review ticket",
    steps: [openReview, closeCorrect],
    action: "closed",
    message: { action: "closed", status: "closed" },
  },
  {
    name: "a technician closes a resolved ticket",
    steps: [openTicket, resolveSilence, closeCorrect],
    action: "closed",
    message: { action: "closed", status: "closed" },
  },
  {
    name: "a closed ticket is not updated by a later decision",
    steps: [openTicket, closeCorrect, (h) => h.decide(120, LEAK, 0.99)],
    action: "none",
  },
  {
    name: "a resolved ticket is not updated by a later decision",
    steps: [openTicket, resolveSilence, (h) => h.decide(210, LEAK, 0.99)],
    action: "none",
  },
  {
    name: "a resolved ticket is not resolved twice",
    steps: [openTicket, resolveSilence, resolveSilence],
    action: "none",
  },
  {
    name: "a closed ticket is not resolved by silence",
    steps: [openTicket, closeCorrect, resolveSilence],
    action: "none",
  },
];

describe("the ticket lifecycle", () => {
  it.each(TRANSITIONS)("$name", async (transition) => {
    const h = harness();
    let previous: TicketChange | undefined;
    let last: TicketOutcome | undefined;
    for (const step of transition.steps) {
      last = await step(h, previous);
      if (last.action !== "none") previous = last;
    }

    expect(last?.action).toBe(transition.action);
    if (transition.message === undefined) {
      expect(last?.message).toBeNull();
      return;
    }
    const message = valid(changed(last!).message);
    expect({ action: message.action, status: message.status }).toEqual(transition.message);
    expect(message.status).toBe(changed(last!).ticket.status);
  });

  it("validates every message a long episode produces", async () => {
    const h = harness();
    const messages: Ticket[] = [];
    const collect = (outcome: TicketOutcome) => {
      if (outcome.message !== null) messages.push(outcome.message);
      return outcome;
    };

    collect(await h.decide(0, LEAK, 0.7));
    collect(await h.decide(30, LEAK, 0.7));
    collect(await h.decide(60, LEAK, 0.9));
    collect(await h.decide(90, SILENCER, 0.5));
    collect(await h.decide(120, "none_of_these", 0.9));
    const ticketId = messages[0]!.ticket_id;
    collect(await h.tickets.resolve(ticketId, "silence", at(250)));
    collect(
      await h.tickets.close(ticketId, { verdict: "wrong", note: "seal", closed_by: "t1" }, at(300)),
    );

    expect(messages.map((message) => [message.action, message.status])).toEqual([
      ["opened", "review"],
      ["updated", "review"],
      ["updated", "open"],
      ["updated", "open"],
      ["resolved", "resolved"],
      ["closed", "closed"],
    ]);
    for (const message of messages) valid(message);
    expect(messages.map((message) => message.update_count)).toEqual([0, 1, 2, 3, 3, 3]);
    expect(new Set(messages.map((message) => message.ticket_id)).size).toBe(1);
  });
});

describe("what a transition writes", () => {
  it("opens a ticket from the chosen candidate, stamped on both clocks", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));

    expect(opened.ticket).toMatchObject({
      ticket_id: "00000009-0000-4000-8000-000000000001",
      episode_id: h.episode.episode_id,
      unit_id: "cau-7",
      status: "open",
      fault_id: LEAK,
      condition_id: "continuous_load",
      title: "Dryer purge valve not seating — Compressor stays loaded and does not reach cut-out",
      cause: catalogEntry(LEAK).summary,
      remedy: catalogEntry(LEAK).remedy,
      checks: catalogEntry(LEAK).checks,
      manual_ref: catalogEntry(LEAK).manual_ref,
      confidence: 0.9,
      severity: "high",
      backend: "rules",
      model: "rules-v1",
      opened_sim_ts: at(0),
      updated_sim_ts: at(0),
      resolved_sim_ts: null,
      close_reason: null,
      opened_wall_ts: "2026-09-22T09:00:01.000Z",
      update_count: 0,
      closure: null,
    });
    expect(opened.message.wall_ts).toBe("2026-09-22T09:00:01.000Z");
    expect(h.repo.saved).toEqual([opened.ticket]);
  });

  it("updates the text, the decision and the counter in place and keeps the opening", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));
    const updated = changed(await h.decide(30, SILENCER, 0.6));

    expect(updated.ticket).toMatchObject({
      ticket_id: opened.ticket.ticket_id,
      status: "open",
      fault_id: SILENCER,
      title: "Purge silencer damaged — Compressor stays loaded and does not reach cut-out",
      confidence: 0.6,
      opened_sim_ts: at(0),
      opened_wall_ts: opened.ticket.opened_wall_ts,
      updated_sim_ts: at(30),
      update_count: 1,
    });
    expect(updated.ticket.latest_decision_id).not.toBe(opened.ticket.latest_decision_id);
  });

  it("records a technician's verdict as a closure row and in the message", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));
    h.wall.advance(60_000);
    const closed = await h.tickets.close(
      opened.ticket.ticket_id,
      { verdict: "correct", note: "purge valve seat worn", closed_by: "technician-2" },
      at(95),
    );

    expect(closed.ticket).toMatchObject({
      status: "closed",
      close_reason: "technician",
      resolved_sim_ts: at(95),
      resolved_wall_ts: "2026-09-22T09:01:01.000Z",
    });
    expect(closed.message.closure).toEqual({
      verdict: "correct",
      note: "purge valve seat worn",
      closed_by: "technician-2",
      wall_ts: "2026-09-22T09:01:01.000Z",
    });
    expect(closed.closure).toEqual({
      ticket_id: opened.ticket.ticket_id,
      verdict: "correct",
      note: "purge valve seat worn",
      closed_by: "technician-2",
      sim_ts: at(95),
      wall_ts: "2026-09-22T09:01:01.000Z",
    });
    expect(h.repo.closures).toEqual([closed.closure]);
  });

  it("keeps the moment the machine resolved a ticket when a technician closes it later", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));
    const resolved = changed(await h.tickets.resolve(opened.ticket.ticket_id, "silence", at(200)));
    const closed = await h.tickets.close(opened.ticket.ticket_id, { verdict: "wrong" }, at(400));

    expect(resolved.ticket.close_reason).toBe("silence");
    expect(closed.ticket.resolved_sim_ts).toBe(at(200));
    expect(closed.ticket.close_reason).toBe("technician");
    expect(closed.closure?.sim_ts).toBe(at(400));
    expect(closed.message.closure).toEqual({ verdict: "wrong", wall_ts: closed.message.wall_ts });
  });

  it("refuses a second verdict and an unknown ticket", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));
    await h.tickets.close(opened.ticket.ticket_id, { verdict: "correct" }, at(10));

    await expect(
      h.tickets.close(opened.ticket.ticket_id, { verdict: "wrong" }, at(20)),
    ).rejects.toBeInstanceOf(TicketClosedError);
    const unknown = "00000009-0000-4000-8000-0000000000ff";
    await expect(h.tickets.close(unknown, { verdict: "correct" }, at(20))).rejects.toBeInstanceOf(
      UnknownTicketError,
    );
    await expect(h.tickets.resolve(unknown, "silence", at(20))).rejects.toBeInstanceOf(
      UnknownTicketError,
    );
  });

  it("changes nothing for a failed call", async () => {
    const h = harness();
    const event = eventAt(SIGNATURE_A_EVENT, "22222222-0000-4000-8000-000000000009", at(0));
    const decision = failed({
      event,
      candidates: CANDIDATES,
      episodeId: h.episode.episode_id,
      decisionId: "00000003-0000-4000-8000-0000000000ff",
    });
    const gate = { outcome: "log", abstained: false, reason: "failed" } as const;

    const outcome = await h.tickets.applyDecision(h.episode, decision, gate, undefined, event);

    expect(outcome).toEqual({ action: "none", ticket: null, message: null, closure: null });
    expect(h.repo.saved).toEqual([]);
  });

  it("refuses a decision naming a fault without the entry to render it from", async () => {
    const h = harness();
    const { decision, gate } = answered({
      event: SIGNATURE_A_EVENT,
      candidates: CANDIDATES,
      episodeId: h.episode.episode_id,
      decisionId: "00000003-0000-4000-8000-0000000000ff",
      choice: LEAK,
      confidence: 0.9,
    });

    await expect(
      h.tickets.applyDecision(h.episode, decision, gate, undefined, SIGNATURE_A_EVENT),
    ).rejects.toThrow(/no catalog entry was passed/);
  });

  it("leaves the manager as it was when the write fails", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.9));
    h.repo.failNext();

    await expect(h.decide(30, SILENCER, 0.9)).rejects.toThrow(/connection terminated/);

    expect(h.tickets.byId(opened.ticket.ticket_id)).toEqual(opened.ticket);
  });

  it("counts review and open tickets as open, hydrates and finds tickets by episode", async () => {
    const h = harness();
    const opened = changed(await h.decide(0, LEAK, 0.7));
    expect(h.tickets.openCount()).toBe(1);
    expect(h.tickets.byEpisode(h.episode.episode_id)).toEqual(opened.ticket);

    const rebuilt = createTicketManager({ ids: sequentialIds(10), wall: h.wall });
    rebuilt.hydrate(await h.repo.load("cau-7"));
    expect(rebuilt.list()).toEqual([opened.ticket]);
    await rebuilt.resolve(opened.ticket.ticket_id, "silence", at(200));
    expect(rebuilt.openCount()).toBe(0);
  });
});
