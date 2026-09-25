// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The episodes the backend is holding open, in memory.
 *
 * An episode is the run of suspect events and decisions about one symptom on
 * one unit. The pipeline reads and writes it here and never touches the
 * database: `episodes/repo.ts` persists the same rows write-through, and
 * {@link EpisodeStore.hydrate} puts them back after a restart, so a backend
 * that comes up again does not open a second episode for a symptom it was
 * already watching.
 *
 * Keys are `(unit_id, symptom_key)` and at most one episode per key is open,
 * which is the invariant `episodes_one_open` enforces in the database.
 * This store enforces it too, up front and with a
 * readable error, because by the time the unique index refuses the INSERT the
 * pipeline has already decided.
 *
 * One field is not a column of `app.episodes`: {@link Episode.fault_id} is the
 * fault the episode's ticket names, read back from `app.tickets` when the
 * store is hydrated. It is what the merge rule compares, and keeping it
 * on the episode means that rule is one pass over the open episodes rather
 * than a query per decision.
 */

/** Where an episode stands (`app.episodes.status`). */
export type EpisodeStatus = "open" | "closed" | "aborted";

/** Why an episode ended (`app.episodes.close_reason`). */
export type EpisodeCloseReason = "silence" | "discontinuity" | "manual";

/** The `(unit_id, symptom_key)` pair an episode is keyed by. */
export interface EpisodeKey {
  readonly unit_id: string;
  readonly symptom_key: string;
}

/**
 * One episode, as the store holds it.
 *
 * Every field but `fault_id` is a column of `app.episodes`; the timestamps are
 * `iso_ts` strings on the simulated clock, never wall time.
 */
export interface Episode {
  readonly episode_id: string;
  readonly unit_id: string;
  /** The symptom the episode was opened on; half of its key. */
  readonly symptom_key: string;
  /** Every symptom seen on this episode, the key's own included, in order. */
  readonly symptom_keys: readonly string[];
  readonly status: EpisodeStatus;
  /** The episode whose ticket this one's decisions update, or `null`. */
  readonly merged_into: string | null;
  readonly opened_sim_ts: string;
  readonly last_event_sim_ts: string;
  readonly last_decision_sim_ts: string | null;
  readonly closed_sim_ts: string | null;
  readonly close_reason: EpisodeCloseReason | null;
  readonly first_event_id: string;
  readonly ticket_id: string | null;
  readonly closed_by_technician: boolean;
  readonly event_count: number;
  readonly decision_count: number;
  /** The fault the episode's ticket names; `null` while it owns no ticket. */
  readonly fault_id: string | null;
}

/** What {@link EpisodeStore.open} needs; everything else starts at its zero. */
export interface OpenEpisode {
  readonly episode_id: string;
  readonly unit_id: string;
  readonly symptom_key: string;
  readonly opened_sim_ts: string;
  readonly first_event_id: string;
  /** Symptoms firing beside the key at the opening event. */
  readonly co_symptoms?: readonly string[];
}

/** The fields {@link EpisodeStore.update} may change. */
export type EpisodePatch = Partial<Omit<Episode, "episode_id" | "unit_id" | "symptom_key">>;

/** The in-memory episodes of one process. */
export interface EpisodeStore {
  /** The open episode of a key, or `undefined` when none is open. */
  get(key: EpisodeKey): Episode | undefined;
  /** Start an episode; throws when the key already has an open one. */
  open(input: OpenEpisode): Episode;
  /** Apply a patch; throws when no episode carries that id. */
  update(episodeId: string, patch: EpisodePatch): Episode;
  /** Every episode the store holds, oldest first. */
  list(): readonly Episode[];
  /** The open episodes only, in the order they opened; what the clock and the merge rule scan. */
  listOpen(): readonly Episode[];
  byId(episodeId: string): Episode | undefined;
  /** Replace everything with `rows`, as read back from the database. */
  hydrate(rows: readonly Episode[]): void;
}

/** Thrown when a second episode would be opened on a key that has one. */
export class EpisodeConflictError extends Error {
  readonly key: EpisodeKey;

  constructor(key: EpisodeKey, openEpisodeId: string) {
    super(
      `episode ${openEpisodeId} is already open on ${key.unit_id}/${key.symptom_key}; ` +
        "one open episode per (unit_id, symptom_key)",
    );
    this.name = "EpisodeConflictError";
    this.key = key;
  }
}

/** Thrown when an episode id names nothing this store holds. */
export class UnknownEpisodeError extends Error {
  readonly episodeId: string;

  constructor(episodeId: string) {
    super(`no episode with id ${episodeId} is in the store`);
    this.name = "UnknownEpisodeError";
    this.episodeId = episodeId;
  }
}

/** The map key of `(unit_id, symptom_key)`; neither part carries a slash. */
function keyOf(key: EpisodeKey): string {
  return `${key.unit_id}/${key.symptom_key}`;
}

/** An episode as it looks the moment it opens. */
function fresh(input: OpenEpisode): Episode {
  const co = input.co_symptoms ?? [];
  const symptomKeys = [input.symptom_key, ...co.filter((entry) => entry !== input.symptom_key)];
  return {
    episode_id: input.episode_id,
    unit_id: input.unit_id,
    symptom_key: input.symptom_key,
    symptom_keys: [...new Set(symptomKeys)],
    status: "open",
    merged_into: null,
    opened_sim_ts: input.opened_sim_ts,
    last_event_sim_ts: input.opened_sim_ts,
    last_decision_sim_ts: null,
    closed_sim_ts: null,
    close_reason: null,
    first_event_id: input.first_event_id,
    ticket_id: null,
    closed_by_technician: false,
    event_count: 1,
    decision_count: 0,
    fault_id: null,
  };
}

/**
 * A store over two maps: every episode by id, and the open one of each key.
 *
 * The second map is an index, not a second copy — it holds ids — so an episode
 * that closes is removed from it and the key is free again, which is exactly
 * what the partial unique index does in the database.
 */
export function createEpisodeStore(rows: readonly Episode[] = []): EpisodeStore {
  const byId = new Map<string, Episode>();
  const openByKey = new Map<string, string>();

  function put(episode: Episode): Episode {
    const key = keyOf(episode);
    const openId = openByKey.get(key);
    if (episode.status === "open" && openId !== undefined && openId !== episode.episode_id) {
      throw new EpisodeConflictError(episode, openId);
    }
    byId.set(episode.episode_id, episode);
    if (episode.status === "open") openByKey.set(key, episode.episode_id);
    else if (openId === episode.episode_id) openByKey.delete(key);
    return episode;
  }

  const store: EpisodeStore = {
    get(key) {
      const id = openByKey.get(keyOf(key));
      return id === undefined ? undefined : byId.get(id);
    },

    open(input) {
      const open = store.get(input);
      if (open !== undefined) throw new EpisodeConflictError(input, open.episode_id);
      return put(fresh(input));
    },

    update(episodeId, patch) {
      const current = byId.get(episodeId);
      if (current === undefined) throw new UnknownEpisodeError(episodeId);
      return put({ ...current, ...patch });
    },

    list() {
      return [...byId.values()];
    },

    listOpen() {
      const open: Episode[] = [];
      for (const id of openByKey.values()) {
        const episode = byId.get(id);
        if (episode !== undefined) open.push(episode);
      }
      return open;
    },

    byId(episodeId) {
      return byId.get(episodeId);
    },

    hydrate(next) {
      byId.clear();
      openByKey.clear();
      for (const episode of next) put(episode);
    },
  };

  if (rows.length > 0) store.hydrate(rows);
  return store;
}
