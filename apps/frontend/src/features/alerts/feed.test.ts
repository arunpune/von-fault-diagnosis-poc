// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { Decision, SuspectEvent, Ticket } from "@/api/types";
import {
  buildFeed,
  describeArrivals,
  FEED_CAP,
  newArrivals,
  type FeedItem,
} from "@/features/alerts/feed";
import { fixtures } from "@/test/msw/fixtures";

const events = fixtures.events.items;
const decisions = fixtures.decisions.items;
const tickets = fixtures.tickets.items;

const ANSWERED_DECISION_ID = "6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60";
const FAILED_DECISION_ID = "7e2a9c05-4d18-4b73-9e60-3a4b5c6d7e80";
const REVIEW_DECISION_ID = "0e5f7a21-9c34-4b6d-81a7-2f3e4d5c6b70";
const OPEN_TICKET_ID = "2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60";

function byKey(items: readonly FeedItem[], key: string): FeedItem {
  const item = items.find((candidate) => candidate.key === key);
  if (item === undefined) {
    throw new Error(`no feed item ${key}`);
  }
  return item;
}

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error("the fixture list is empty");
  }
  return item;
}

function decisionFixture(id: string): Decision {
  const decision = decisions.find((candidate) => candidate.decision_id === id);
  if (decision === undefined) {
    throw new Error(`no decision ${id} in decisions.json`);
  }
  return structuredClone(decision);
}

/** A suspect event like the fixture's, `minutes` after 2020-06-01 00:00 UTC. */
function eventAt(minutes: number): SuspectEvent {
  const simTs = new Date(Date.UTC(2020, 5, 1) + minutes * 60_000).toISOString();
  return { ...structuredClone(first(events)), event_id: `event-${minutes}`, sim_ts: simTs };
}

describe("buildFeed", () => {
  it("merges the three caches newest first, the outcome above what caused it", () => {
    const feed = buildFeed(events, decisions, tickets);

    expect(feed.map((item) => `${item.kind} ${item.sim_ts}`)).toEqual([
      "ticket 2020-07-18T13:22:00.000Z",
      "decision_failed 2020-06-05T10:11:12.000Z",
      "suspect 2020-06-05T10:11:12.000Z",
      "ticket 2020-06-05T09:41:12.000Z",
      "decision 2020-06-05T09:41:12.000Z",
      "suspect 2020-06-05T09:41:12.000Z",
      "ticket 2020-05-30T01:11:12.000Z",
      "ticket 2020-05-22T04:15:00.000Z",
      "decision 2020-05-22T04:15:00.000Z",
      "suspect 2020-05-22T04:15:00.000Z",
    ]);
  });

  it("titles a decision with the chosen cause and gives its confidence, gate word and time", () => {
    const item = byKey(buildFeed([], decisions, []), `decision-${ANSWERED_DECISION_ID}`);

    expect(item).toEqual({
      key: `decision-${ANSWERED_DECISION_ID}`,
      kind: "decision",
      sim_ts: "2020-06-05T09:41:12.000Z",
      severity: "high",
      title: "Dryer purge valve not seating",
      meta: ["91 %", "Ticket", "2020-06-05 09:41:12"],
      ref: { kind: "decision", id: ANSWERED_DECISION_ID },
    });
    expect(byKey(buildFeed([], decisions, []), `decision-${REVIEW_DECISION_ID}`).meta).toEqual([
      "65 %",
      "Review",
      "2020-05-22 04:15:00",
    ]);
  });

  it("lists a failed decision with its error kind and no severity", () => {
    const item = byKey(buildFeed([], decisions, []), `decision-${FAILED_DECISION_ID}`);

    expect(item.kind).toBe("decision_failed");
    expect(item.title).toBe("Decision failed: timeout");
    expect(item.severity).toBeUndefined();
    expect(item.meta).toEqual(["Logged", "2020-06-05 10:11:12"]);
    expect(item.ref).toEqual({ kind: "decision", id: FAILED_DECISION_ID });
  });

  it("words a failure kind with underscores as plain words", () => {
    const decision = decisionFixture(FAILED_DECISION_ID);
    decision.error = { kind: "rate_limit", status: 429, message: "Too many requests." };

    expect(first(buildFeed([], [decision], [])).title).toBe("Decision failed: rate limit");
  });

  it('titles "none of these" as no matching fault and tells an abstention from a log line', () => {
    const abstained = decisionFixture(ANSWERED_DECISION_ID);
    abstained.choice = "none_of_these";
    abstained.confidence = 0.72;
    abstained.gate = { ...abstained.gate, outcome: "log", abstained: true };
    const unsure = decisionFixture(REVIEW_DECISION_ID);
    unsure.choice = "none_of_these";
    unsure.confidence = 0.41;
    unsure.gate = { ...unsure.gate, outcome: "log", abstained: false };

    const feed = buildFeed([], [abstained, unsure], []);

    expect(byKey(feed, `decision-${ANSWERED_DECISION_ID}`)).toMatchObject({
      title: "No matching fault",
      meta: ["72 %", "Abstained", "2020-06-05 09:41:12"],
    });
    expect(byKey(feed, `decision-${REVIEW_DECISION_ID}`)).toMatchObject({
      title: "No matching fault",
      meta: ["41 %", "Logged", "2020-05-22 04:15:00"],
    });
  });

  it("calls none of these at or above the review threshold an abstention without the flag", () => {
    const decision = decisionFixture(ANSWERED_DECISION_ID);
    decision.choice = "none_of_these";
    decision.confidence = decision.gate.review_min_confidence;
    decision.gate = { ...decision.gate, outcome: "log", abstained: false };

    expect(first(buildFeed([], [decision], [])).meta[1]).toBe("Abstained");
  });

  it("titles a suspect event with its symptom and links it to the decision that answered it", () => {
    const feed = buildFeed(events, decisions, []);

    expect(byKey(feed, "suspect-3d4a1f02-5c6b-4e71-9a83-0b1c2d3e4f50")).toEqual({
      key: "suspect-3d4a1f02-5c6b-4e71-9a83-0b1c2d3e4f50",
      kind: "suspect",
      sim_ts: "2020-06-05T09:41:12.000Z",
      title: "Suspect: Continuous load",
      meta: ["Machine loaded", "2020-06-05 09:41:12"],
      ref: { kind: "decision", id: ANSWERED_DECISION_ID },
    });
    expect(byKey(feed, "suspect-9b2e7c41-8d05-4a6f-b312-7e5d90a4c618").title).toBe(
      "Suspect: Frequent cycling",
    );
  });

  it("gives a suspect event no link while no decision has answered it", () => {
    const [item] = buildFeed(events.slice(0, 1), [], []);

    expect(item?.ref).toBeNull();
  });

  it("titles a ticket change with its short id and action, and gives its status", () => {
    const feed = buildFeed([], [], tickets);

    expect(byKey(feed, `ticket-${OPEN_TICKET_ID}`)).toEqual({
      key: `ticket-${OPEN_TICKET_ID}`,
      kind: "ticket",
      sim_ts: "2020-06-05T09:41:12.000Z",
      severity: "high",
      title: "Ticket #8d7e60 opened",
      meta: ["91 %", "Open", "2020-06-05 09:41:12"],
      ref: { kind: "ticket", id: OPEN_TICKET_ID },
    });
    expect(byKey(feed, "ticket-6d0e4b92-8a13-4f57-b2c6-9e1a3d5f7b28")).toMatchObject({
      title: "Ticket #5f7b28 closed",
      meta: ["94 %", "Closed as correct", "2020-05-30 01:11:12"],
    });
    expect(byKey(feed, "ticket-8f3b6d27-0a41-4e59-9c83-5b6a7c8d9e01").meta[1]).toBe("In review");
    expect(byKey(feed, "ticket-e13c9b40-7d28-4a65-b091-2c3d4e5f6a70").title).toBe(
      "Ticket #5f6a70 resolved",
    );
  });

  it("titles an updated ticket as updated", () => {
    const ticket: Ticket = { ...structuredClone(first(tickets)), action: "updated" };

    expect(first(buildFeed([], [], [ticket])).title).toBe("Ticket #5f6a70 updated");
  });

  it(`keeps the newest ${FEED_CAP} items`, () => {
    const many = Array.from({ length: FEED_CAP + 100 }, (_, index) => eventAt(index));

    const feed = buildFeed(many, [], []);

    expect(feed).toHaveLength(FEED_CAP);
    expect(first(feed).key).toBe(`suspect-event-${FEED_CAP + 99}`);
    expect(feed.at(-1)?.key).toBe("suspect-event-100");
  });

  it("puts an instant that does not parse below every real one", () => {
    const broken = { ...eventAt(0), event_id: "broken", sim_ts: "not a time" };

    const feed = buildFeed([broken, eventAt(5)], [], []);

    expect(feed.map((item) => item.key)).toEqual(["suspect-event-5", "suspect-broken"]);
  });

  it("orders items of the same instant and kind by key", () => {
    const a = { ...eventAt(0), event_id: "a" };
    const b = { ...eventAt(0), event_id: "b" };

    expect(buildFeed([b, a], [], []).map((item) => item.key)).toEqual(["suspect-a", "suspect-b"]);
  });

  it("is pure: equal inputs give equal feeds and the inputs stay untouched", () => {
    const frozen = [
      Object.freeze([...events]),
      Object.freeze([...decisions]),
      Object.freeze([...tickets]),
    ] as const;

    expect(buildFeed(...frozen)).toEqual(buildFeed(...frozen));
    expect(frozen[0]).toEqual(events);
  });
});

describe("newArrivals", () => {
  it("returns the items the previous feed did not show, or showed in an older state", () => {
    const before = buildFeed(events, decisions.slice(1), tickets);
    const reviewTicket = first(tickets.filter((ticket) => ticket.status === "review"));
    const promoted: Ticket = {
      ...structuredClone(reviewTicket),
      action: "updated",
      status: "open",
      updated_sim_ts: "2020-05-22T05:15:00.000Z",
    };
    const others = tickets.filter((ticket) => ticket.ticket_id !== reviewTicket.ticket_id);
    const after = buildFeed(events, decisions, [...others, promoted]);

    expect(newArrivals(after, before).map((item) => item.key)).toEqual([
      `decision-${FAILED_DECISION_ID}`,
      "ticket-8f3b6d27-0a41-4e59-9c83-5b6a7c8d9e01",
    ]);
    expect(newArrivals(after, after)).toEqual([]);
  });
});

describe("describeArrivals", () => {
  it("announces decisions and tickets, oldest first, and leaves suspect events out", () => {
    const arrivals = buildFeed(events.slice(1, 2), decisions.slice(1, 2), tickets.slice(1, 2));

    expect(arrivals.map((item) => item.kind)).toEqual(["ticket", "decision", "suspect"]);
    expect(describeArrivals(arrivals)).toBe(
      "Decision: Dryer purge valve not seating, 91 %, Ticket. Ticket #8d7e60 opened.",
    );
  });

  it("announces a failed decision by its title", () => {
    expect(describeArrivals(buildFeed([], decisions.slice(0, 1), []))).toBe(
      "Decision failed: timeout.",
    );
  });

  it("has nothing to say about suspect events alone", () => {
    expect(describeArrivals(buildFeed(events, [], []))).toBeNull();
    expect(describeArrivals([])).toBeNull();
  });
});
