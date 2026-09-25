// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The in-memory episode store: one open episode per
// (unit_id, symptom_key), the invariant `episodes_one_open` enforces in the
// database, held up front so the pipeline never decides on a key twice.

import { describe, expect, it } from "vitest";

import {
  createEpisodeStore,
  EpisodeConflictError,
  UnknownEpisodeError,
  type OpenEpisode,
} from "./store.ts";

const OPENING: OpenEpisode = {
  episode_id: "00000001-0000-4000-8000-000000000001",
  unit_id: "cau-7",
  symptom_key: "continuous_load",
  opened_sim_ts: "2020-06-05T11:00:00.000Z",
  first_event_id: "11111111-1111-4111-8111-111111111111",
  co_symptoms: ["purge_pressure_high", "continuous_load"],
};

describe("createEpisodeStore", () => {
  it("opens an episode at its zero, the key's own symptom first", () => {
    const store = createEpisodeStore();
    const episode = store.open(OPENING);

    expect(episode).toEqual({
      episode_id: OPENING.episode_id,
      unit_id: "cau-7",
      symptom_key: "continuous_load",
      symptom_keys: ["continuous_load", "purge_pressure_high"],
      status: "open",
      merged_into: null,
      opened_sim_ts: OPENING.opened_sim_ts,
      last_event_sim_ts: OPENING.opened_sim_ts,
      last_decision_sim_ts: null,
      closed_sim_ts: null,
      close_reason: null,
      first_event_id: OPENING.first_event_id,
      ticket_id: null,
      closed_by_technician: false,
      event_count: 1,
      decision_count: 0,
      fault_id: null,
    });
    expect(store.get({ unit_id: "cau-7", symptom_key: "continuous_load" })).toBe(episode);
    expect(store.byId(OPENING.episode_id)).toBe(episode);
  });

  it("refuses a second open episode on the same key", () => {
    const store = createEpisodeStore();
    store.open(OPENING);

    expect(() =>
      store.open({ ...OPENING, episode_id: "00000001-0000-4000-8000-000000000002" }),
    ).toThrow(EpisodeConflictError);
  });

  it("keeps keys apart by unit and by symptom", () => {
    const store = createEpisodeStore();
    store.open(OPENING);
    store.open({
      ...OPENING,
      episode_id: "00000001-0000-4000-8000-000000000002",
      unit_id: "cau-9",
    });
    store.open({
      ...OPENING,
      episode_id: "00000001-0000-4000-8000-000000000003",
      symptom_key: "purge_pressure_high",
    });

    expect(store.listOpen()).toHaveLength(3);
  });

  it("frees the key when the episode closes, and keeps the closed one", () => {
    const store = createEpisodeStore();
    store.open(OPENING);
    store.update(OPENING.episode_id, { status: "closed", close_reason: "silence" });

    expect(store.get(OPENING)).toBeUndefined();
    expect(store.listOpen()).toEqual([]);
    const reopened = store.open({ ...OPENING, episode_id: "00000001-0000-4000-8000-000000000002" });
    expect(store.list().map((episode) => episode.episode_id)).toEqual([
      OPENING.episode_id,
      reopened.episode_id,
    ]);
  });

  it("refuses an update that would re-open a key another episode holds", () => {
    const store = createEpisodeStore();
    store.open(OPENING);
    store.update(OPENING.episode_id, { status: "closed" });
    store.open({ ...OPENING, episode_id: "00000001-0000-4000-8000-000000000002" });

    expect(() => store.update(OPENING.episode_id, { status: "open" })).toThrow(
      EpisodeConflictError,
    );
  });

  it("refuses to update an episode it does not hold", () => {
    const store = createEpisodeStore();
    expect(() => store.update("00000001-0000-4000-8000-00000000ffff", {})).toThrow(
      UnknownEpisodeError,
    );
  });

  it("hydrates from rows and refuses rows that break the open-key rule", () => {
    const source = createEpisodeStore();
    source.open(OPENING);
    source.update(OPENING.episode_id, { status: "aborted", close_reason: "discontinuity" });
    source.open({ ...OPENING, episode_id: "00000001-0000-4000-8000-000000000002" });

    const rebuilt = createEpisodeStore(source.list());
    expect(rebuilt.list()).toEqual(source.list());
    expect(rebuilt.get(OPENING)?.episode_id).toBe("00000001-0000-4000-8000-000000000002");

    const twoOpen = [
      source.byId("00000001-0000-4000-8000-000000000002")!,
      { ...source.byId(OPENING.episode_id)!, status: "open" as const },
    ];
    expect(() => createEpisodeStore(twoOpen)).toThrow(EpisodeConflictError);
  });
});
