// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The episode state machine, transition by
// transition: open, redecide at 30 sim minutes, close after 120 sim minutes of
// silence, abort on a discontinuity, merge by fault_id and the unique open key.
// Everything runs on the simulated clock; no test here reads the wall.

import { validate, type SuspectEvent } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { candidatesFor } from "../../test/fixtures/catalog/index.ts";
import { answered, eventAt, failed, sequentialIds } from "./decisions.test-helper.ts";
import {
  createEpisodeManager,
  createEpisodeStore,
  toEpisodeMessage,
  UnknownEpisodeError,
  type Episode,
  type EpisodeManager,
} from "./index.ts";

const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const LEAK = "dryer_purge_leak";
const OTHER_FAULT = "downstream_air_leak";

/** 11:00 on the fixture day plus `minutes`, as an `iso_ts`. */
function at(minutes: number): string {
  return new Date(Date.parse("2020-06-05T11:00:00.000Z") + minutes * 60_000).toISOString();
}

interface Harness {
  readonly manager: EpisodeManager;
  /** A fresh event on `continuous_load` (co-firing `purge_pressure_high`) at `minutes`. */
  load(minutes: number): SuspectEvent;
  /** A fresh event on `purge_pressure_high` at `minutes`. */
  purge(minutes: number): SuspectEvent;
  /** Decide `episode` on `event`; the decision ids come from their own counter. */
  decide(episode: Episode, event: SuspectEvent, choice: string, confidence: number): Episode;
}

function harness(): Harness {
  const manager = createEpisodeManager({
    store: createEpisodeStore(),
    cfg: { decisionIntervalSimMin: 30, episodeClearSimMin: 120 },
    ids: sequentialIds(1),
  });
  const eventIds = sequentialIds(2);
  const decisionIds = sequentialIds(3);
  return {
    manager,
    load: (minutes) => eventAt(SIGNATURE_A_EVENT, eventIds(), at(minutes)),
    purge: (minutes) =>
      eventAt(SIGNATURE_A_EVENT, eventIds(), at(minutes), {
        symptom_key: "purge_pressure_high",
        co_symptoms: ["continuous_load"],
        rule_ids: ["purge_pressure_high"],
      }),
    decide(episode, event, choice, confidence) {
      const { decision, gate } = answered({
        event,
        candidates: CANDIDATES,
        episodeId: episode.episode_id,
        decisionId: decisionIds(),
        choice,
        confidence,
      });
      return manager.onDecision(episode.episode_id, decision, gate).episode;
    },
  };
}

describe("open", () => {
  it("opens an episode on the first event of a key and asks for a decision", () => {
    const { manager, load } = harness();
    const event = load(0);

    const result = manager.onEvent(event, true);

    expect(result.action).toBe("open");
    expect(result.episode).toMatchObject({
      unit_id: "cau-7",
      symptom_key: "continuous_load",
      symptom_keys: ["continuous_load", "purge_pressure_high"],
      status: "open",
      opened_sim_ts: at(0),
      first_event_id: event.event_id,
      event_count: 1,
      decision_count: 0,
    });
    expect(manager.openCount()).toBe(1);
  });

  it("keeps one open episode per key however many events arrive", () => {
    const { manager, load } = harness();
    const first = manager.onEvent(load(0), true).episode;
    const second = manager.onEvent(load(5), true).episode;

    expect(second.episode_id).toBe(first.episode_id);
    expect(second.event_count).toBe(2);
    expect(second.last_event_sim_ts).toBe(at(5));
    expect(manager.store.listOpen()).toHaveLength(1);
  });
});

describe("redecide", () => {
  it("re-decides a firing key 30 sim minutes after the last decision, not before", () => {
    const { manager, load, decide } = harness();
    const opening = load(0);
    const episode = manager.onEvent(opening, true).episode;
    decide(episode, opening, LEAK, 0.9);

    expect(manager.onEvent(load(10), true).action).toBe("skip");
    expect(manager.onEvent(load(29.99), true).action).toBe("skip");
    expect(manager.onEvent(load(30), true).action).toBe("redecide");
  });

  it("does not re-decide a key that is not firing", () => {
    const { manager, load, decide } = harness();
    const opening = load(0);
    decide(manager.onEvent(opening, true).episode, opening, LEAK, 0.9);

    expect(manager.onEvent(load(45), false).action).toBe("skip");
  });

  it("decides an episode that has never been decided on its next event", () => {
    const { manager, load } = harness();
    manager.onEvent(load(0), true);

    expect(manager.onEvent(load(1), true).action).toBe("redecide");
  });

  it("counts a failed call as a decision, so the key waits for the next interval", () => {
    const { manager, load } = harness();
    const opening = load(0);
    const episode = manager.onEvent(opening, true).episode;
    const decision = failed({
      event: opening,
      candidates: CANDIDATES,
      episodeId: episode.episode_id,
      decisionId: "00000003-0000-4000-8000-0000000000ff",
    });

    const result = manager.onDecision(episode.episode_id, decision, {
      outcome: "log",
      abstained: false,
      reason: "failed",
    });

    expect(result.actions).toEqual(["record"]);
    expect(result.episode).toMatchObject({ decision_count: 1, last_decision_sim_ts: at(0) });
    expect(manager.onEvent(load(10), true).action).toBe("skip");
    expect(manager.onEvent(load(30), true).action).toBe("redecide");
  });

  it("refuses a decision on an episode it does not hold", () => {
    const { manager, load } = harness();
    const { decision, gate } = answered({
      event: load(0),
      candidates: CANDIDATES,
      episodeId: "00000001-0000-4000-8000-00000000ffff",
      decisionId: "00000003-0000-4000-8000-0000000000ff",
      choice: LEAK,
      confidence: 0.9,
    });

    expect(() => manager.onDecision(decision.episode_id, decision, gate)).toThrow(
      UnknownEpisodeError,
    );
  });
});

describe("close", () => {
  it("closes an episode after 120 sim minutes of silence and frees its key", () => {
    const { manager, load } = harness();
    const episode = manager.onEvent(load(0), true).episode;

    expect(manager.onTick(at(119), [])).toEqual([]);
    const ended = manager.onTick(at(120), []);

    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("silence");
    expect(ended[0]?.episode).toMatchObject({
      episode_id: episode.episode_id,
      status: "closed",
      close_reason: "silence",
      closed_sim_ts: at(120),
    });
    expect(manager.openCount()).toBe(0);

    const next = manager.onEvent(load(121), true);
    expect(next.action).toBe("open");
    expect(next.episode.episode_id).not.toBe(episode.episode_id);
  });

  it("measures silence from the last tick the key was firing", () => {
    const { manager, load } = harness();
    manager.onEvent(load(0), true);

    expect(manager.onTick(at(60), ["continuous_load"])).toEqual([]);
    expect(manager.onTick(at(179), [])).toEqual([]);
    expect(manager.onTick(at(180), []).map((end) => end.reason)).toEqual(["silence"]);
  });

  it("never closes a key that keeps firing", () => {
    const { manager, load } = harness();
    manager.onEvent(load(0), true);

    for (let minutes = 0; minutes <= 600; minutes += 10) {
      expect(manager.onTick(at(minutes), ["continuous_load"])).toEqual([]);
    }
    expect(manager.openCount()).toBe(1);
  });
});

describe("abort", () => {
  it("aborts every open episode on a discontinuity and leaves closed ones alone", () => {
    const { manager, load, purge } = harness();
    const early = manager.onEvent(load(0), true).episode;
    manager.onTick(at(120), []);
    const loadEpisode = manager.onEvent(load(130), true).episode;
    const purgeEpisode = manager.onEvent(purge(131), true).episode;

    const ended = manager.onDiscontinuity(at(140));

    expect(ended.map((end) => [end.episode.episode_id, end.reason])).toEqual([
      [loadEpisode.episode_id, "discontinuity"],
      [purgeEpisode.episode_id, "discontinuity"],
    ]);
    for (const end of ended) {
      expect(end.episode).toMatchObject({
        status: "aborted",
        close_reason: "discontinuity",
        closed_sim_ts: at(140),
      });
    }
    expect(manager.store.byId(early.episode_id)?.status).toBe("closed");
    expect(manager.openCount()).toBe(0);
  });
});

describe("merge", () => {
  /** An episode on `purge_pressure_high` that owns an open ticket naming the leak. */
  function withTicketOwner(h: Harness): Episode {
    const opening = h.purge(0);
    const owner = h.manager.onEvent(opening, true).episode;
    h.decide(owner, opening, LEAK, 0.9);
    return h.manager.noteTicket(owner.episode_id, "00000009-0000-4000-8000-000000000001", LEAK);
  }

  function decideOn(h: Harness, episode: Episode, event: SuspectEvent, choice: string, c: number) {
    const { decision, gate } = answered({
      event,
      candidates: CANDIDATES,
      episodeId: episode.episode_id,
      decisionId: `00000004-0000-4000-8000-${episode.decision_count.toString().padStart(12, "0")}`,
      choice,
      confidence: c,
    });
    return h.manager.onDecision(episode.episode_id, decision, gate);
  }

  it("links a new episode whose first ticket-worthy decision names the owner's fault", () => {
    const h = harness();
    const owner = withTicketOwner(h);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;

    const result = decideOn(h, follower, opening, LEAK, 0.7);

    expect(result.actions).toEqual(["merge", "record"]);
    expect(result.episode.merged_into).toBe(owner.episode_id);
    expect(result.episode.status).toBe("open");
    expect(result.target.episode_id).toBe(owner.episode_id);
  });

  it("routes every later decision of the merged episode to the owner's ticket", () => {
    const h = harness();
    const owner = withTicketOwner(h);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;
    decideOn(h, follower, opening, LEAK, 0.9);

    const later = h.load(32);
    const again = decideOn(h, h.manager.store.byId(follower.episode_id)!, later, OTHER_FAULT, 0.4);

    expect(again.actions).toEqual(["record"]);
    expect(again.target.episode_id).toBe(owner.episode_id);
  });

  it("does not merge on another fault, on an abstention, below the review gate or when failed", () => {
    const h = harness();
    withTicketOwner(h);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;

    for (const [choice, confidence] of [
      [OTHER_FAULT, 0.9],
      ["none_of_these", 0.9],
      [LEAK, 0.5],
    ] as const) {
      const episode = h.manager.store.byId(follower.episode_id)!;
      const result = decideOn(h, episode, opening, choice, confidence);
      expect(result.actions).toEqual(["record"]);
      expect(result.target.episode_id).toBe(follower.episode_id);
    }

    const decision = failed({
      event: opening,
      candidates: CANDIDATES,
      episodeId: follower.episode_id,
      decisionId: "00000005-0000-4000-8000-000000000001",
    });
    const gate = { outcome: "log", abstained: false, reason: "failed" } as const;
    expect(h.manager.onDecision(follower.episode_id, decision, gate).actions).toEqual(["record"]);

    // The first decision that could open a ticket is still the one that merges.
    const merged = decideOn(h, h.manager.store.byId(follower.episode_id)!, opening, LEAK, 0.9);
    expect(merged.actions).toEqual(["merge", "record"]);
  });

  it("does not merge an episode that owns a ticket of its own", () => {
    const h = harness();
    withTicketOwner(h);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;
    h.manager.noteTicket(follower.episode_id, "00000009-0000-4000-8000-000000000002", OTHER_FAULT);

    const result = decideOn(h, h.manager.store.byId(follower.episode_id)!, opening, LEAK, 0.9);

    expect(result.actions).toEqual(["record"]);
    expect(result.episode.merged_into).toBeNull();
  });

  it("does not merge into a ticket a technician has closed", () => {
    const h = harness();
    const owner = withTicketOwner(h);
    h.manager.noteTechnicianClosure(owner.episode_id);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;

    expect(decideOn(h, follower, opening, LEAK, 0.9).actions).toEqual(["record"]);
  });

  it("gives a merged episode its own ticket back once the owner has ended", () => {
    const h = harness();
    const owner = withTicketOwner(h);
    const opening = h.load(2);
    const follower = h.manager.onEvent(opening, true).episode;
    decideOn(h, follower, opening, LEAK, 0.9);

    const ended = h.manager.onTick(at(125), ["continuous_load"]);
    expect(ended.map((end) => end.episode.episode_id)).toEqual([owner.episode_id]);

    const later = h.load(130);
    const result = decideOn(h, h.manager.store.byId(follower.episode_id)!, later, LEAK, 0.9);
    expect(result.episode.merged_into).toBe(owner.episode_id);
    expect(result.target.episode_id).toBe(follower.episode_id);
  });
});

describe("persistence before the ticket", () => {
  const PERSIST = 2;

  /** The rule hits detection reports for `symptomKey`, its run begun at `sinceMinutes`. */
  function firing(symptomKey: string, sinceMinutes: number) {
    return [{ symptom_key: symptomKey, since_sim_ts: at(sinceMinutes) }];
  }

  function persisting(persistSimMin = PERSIST): Harness {
    const base = harness();
    const manager = createEpisodeManager({
      store: createEpisodeStore(),
      cfg: { decisionIntervalSimMin: 30, episodeClearSimMin: 120, persistSimMin },
      ids: sequentialIds(1),
    });
    return { ...base, manager, decide: harnessDecide(manager) };
  }

  /** `Harness.decide` over another manager. */
  function harnessDecide(manager: EpisodeManager): Harness["decide"] {
    const decisionIds = sequentialIds(3);
    return (episode, event, choice, confidence) => {
      const { decision, gate } = answered({
        event,
        candidates: CANDIDATES,
        episodeId: episode.episode_id,
        decisionId: decisionIds(),
        choice,
        confidence,
      });
      return manager.onDecision(episode.episode_id, decision, gate).episode;
    };
  }

  it("decides at once when GATE_PERSIST_SIM_MIN is 0 or absent", () => {
    for (const h of [harness(), persisting(0)]) {
      const episode = h.manager.onEvent(h.purge(0), true).episode;
      expect(h.manager.mayDecide(episode, at(0))).toBe(true);
    }
  });

  it("holds a ticketless episode until its key's evidence has lasted GATE_PERSIST_SIM_MIN", () => {
    const h = persisting();
    const episode = h.manager.onEvent(h.purge(0), true).episode;
    h.manager.observeEvidence(firing("purge_pressure_high", 0));

    expect(h.manager.mayDecide(episode, at(0))).toBe(false);
    expect(h.manager.mayDecide(episode, at(PERSIST - 1 / 60_000))).toBe(false);
    // The boundary: exactly N sim minutes of evidence is enough.
    expect(h.manager.mayDecide(episode, at(PERSIST))).toBe(true);
    expect(h.manager.persistedSimMin("purge_pressure_high", at(PERSIST))).toBe(PERSIST);
  });

  it("never lets a key that stopped firing count the time it was quiet", () => {
    const h = persisting();
    const episode = h.manager.onEvent(h.purge(0), true).episode;
    h.manager.observeEvidence(firing("purge_pressure_high", 0));
    h.manager.observeEvidence([]);

    expect(h.manager.mayDecide(episode, at(60))).toBe(false);

    // A new run starts from zero, however long the episode has been open.
    h.manager.observeEvidence(firing("purge_pressure_high", 60));
    expect(h.manager.mayDecide(episode, at(61))).toBe(false);
    expect(h.manager.mayDecide(episode, at(62))).toBe(true);
  });

  it("times the episode's own key, not a co-symptom's", () => {
    const h = persisting();
    const episode = h.manager.onEvent(h.load(10), true).episode;
    h.manager.observeEvidence([
      ...firing("purge_pressure_high", 0),
      ...firing("continuous_load", 10),
    ]);

    expect(h.manager.mayDecide(episode, at(11))).toBe(false);
    expect(h.manager.mayDecide(episode, at(12))).toBe(true);
  });

  it("keeps deciding an episode that owns a ticket, persisted or not", () => {
    const h = persisting();
    const opening = h.purge(0);
    const owner = h.manager.onEvent(opening, true).episode;
    h.decide(owner, opening, LEAK, 0.9);
    const ticketed = h.manager.noteTicket(
      owner.episode_id,
      "00000009-0000-4000-8000-00000000000a",
      LEAK,
    );

    // Not firing at all: the ticket exists, and the decision can only update it.
    expect(h.manager.mayDecide(ticketed, at(40))).toBe(true);

    // A closed ticket records the decision only; nothing new is created either way.
    const closed = h.manager.noteTechnicianClosure(owner.episode_id);
    expect(h.manager.mayDecide(closed, at(41))).toBe(true);
  });

  it("decides a merged episode as its owner's ticket's, and on its own evidence once the owner has ended", () => {
    const h = persisting();
    const opening = h.purge(0);
    const owner = h.manager.onEvent(opening, true).episode;
    h.decide(owner, opening, LEAK, 0.9);
    h.manager.noteTicket(owner.episode_id, "00000009-0000-4000-8000-00000000000b", LEAK);

    const follow = h.load(2);
    const follower = h.manager.onEvent(follow, true).episode;
    // Its evidence has not persisted, so it is not decided yet: no merge can happen on a blip.
    h.manager.observeEvidence(firing("continuous_load", 2));
    expect(h.manager.mayDecide(follower, at(3))).toBe(false);
    expect(h.manager.mayDecide(follower, at(4))).toBe(true);

    const merged = h.decide(follower, follow, LEAK, 0.9);
    expect(merged.merged_into).toBe(owner.episode_id);
    h.manager.observeEvidence([]);
    // Routed to the owner's live ticket: decided without waiting.
    expect(h.manager.mayDecide(merged, at(40))).toBe(true);

    // The owner ends; the follower would drive a ticket of its own again, so it waits.
    h.manager.onTick(at(125), ["continuous_load"]);
    const alone = h.manager.store.byId(follower.episode_id)!;
    expect(h.manager.mayDecide(alone, at(125))).toBe(false);
  });

  it("forgets the evidence at a discontinuity", () => {
    const h = persisting();
    h.manager.onEvent(h.purge(0), true);
    h.manager.observeEvidence(firing("purge_pressure_high", 0));
    expect(h.manager.persistedSimMin("purge_pressure_high", at(1))).toBe(1);

    h.manager.onDiscontinuity(at(1));
    expect(h.manager.persistedSimMin("purge_pressure_high", at(5))).toBe(0);
    const reopened = h.manager.onEvent(h.purge(6), true).episode;
    expect(h.manager.mayDecide(reopened, at(6))).toBe(false);
  });
});

describe("toEpisodeMessage", () => {
  it("projects an episode onto the api-episodes definition", () => {
    const { manager, load, decide } = harness();
    const opening = load(0);
    const episode = decide(manager.onEvent(opening, true).episode, opening, LEAK, 0.9);
    const ended = manager.onTick(at(200), [])[0]?.episode ?? episode;

    for (const shown of [episode, ended]) {
      const page = { items: [toEpisodeMessage(shown)], next_cursor: null };
      expect(validate("api-episodes", page)).toMatchObject({ ok: true });
    }
    expect(toEpisodeMessage(ended)).not.toHaveProperty("merged_into");
  });
});
