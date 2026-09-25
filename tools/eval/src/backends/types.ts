// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a run holds on to for each decision backend it compares.
//
// The backends themselves are the pipeline's: `createRulesBackend` and
// `createJevBackend` from `@fdp/backend/pipeline`, never a copy. A handle adds
// what the harness needs around one: the mode the report prints beside the
// column (`mock` columns are "not informative"), a `close()` for the local
// server a mode may have started, and the counters the report quotes — calls
// and failed calls, and the cassette hits and misses or the live queue's
// retries and waits of the modes that have them.
//
// Two small pieces every handle module shares live here too: the wrapper that
// counts calls, and the signal names the backends quote in the state they
// build.

import { SIGNALS } from "@fdp/contracts";
import type { DecisionBackend, WallClock } from "@fdp/backend/pipeline";

import type { BackendName } from "../config.ts";
import type { RateLimitStats } from "./ratelimit.ts";

/** How a backend is reached; `-` for the rules backend, which reaches nothing. */
export type BackendMode = "live" | "cassette" | "mock" | "-";

/** The counters of one handle, read by the report. */
export interface BackendStats {
  /** `decide()` calls, answered or not. */
  readonly calls: number;
  /** Calls that threw, which the pipeline turned into failed decisions. */
  readonly failures: number;
  /** Requests a cassette server had no recording for; 0 in every other mode. */
  readonly cassetteMisses: number;
  /** Requests a cassette server answered from a recording; cassette mode only. */
  readonly cassetteHits?: number;
  /** The digest of every missed request, in arrival order; cassette mode only. */
  readonly cassetteMissDigests?: readonly string[];
  /**
   * Hits past the last answer their cassette recorded, answered with it again: decisions that
   * need not be the ones the recording run made at that point. Cassette mode only.
   */
  readonly cassetteReused?: number;
  /** `--resample`: the rotation of recorded answers the cassette server serves; cassette mode only. */
  readonly cassetteResample?: number;
  /**
   * The most recorded answers any cassette hit so far held: how many resamples the recording can
   * give the requests this run made. Cassette mode only.
   */
  readonly cassetteAnswersMax?: number;
  /** The live queue's calls, retries and waits; live mode only (`ratelimit.ts`). */
  readonly rateLimit?: RateLimitStats;
}

/** One backend of a run, with its mode, its counters and its teardown. */
export interface BackendHandle {
  readonly name: BackendName;
  readonly model: string;
  readonly mode: BackendMode;
  /** The pipeline's own backend, wrapped only to count calls. */
  readonly backend: DecisionBackend;
  /** A live view: the numbers move as the run decides. */
  readonly stats: BackendStats;
  /** Stops whatever the handle started; safe to call twice. */
  close(): Promise<void>;
}

/** What building a handle needs beyond the configuration. */
export interface HandleDeps {
  /**
   * The wall clock the mock and cassette backends stamp latencies with: the run's fake clock,
   * so a replayed latency is a function of the replay and not of the machine it ran on. A live
   * answer's latency reads the process clock instead (`jev.ts`, `llm.ts`).
   */
  readonly wall: WallClock;
}

/**
 * The register map's human name of every signal, by tag id.
 *
 * Both backends quote them in the state they build (`buildState`), and a signal without a
 * label would be quoted by its id in words. The evaluation passes the names the register map
 * itself carries, so the state reads as the manual does.
 */
export const SIGNAL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SIGNALS.map((signal) => [signal.tag, signal.name])),
);

/**
 * Whether a backend was asked for decisions and every one of them failed: it answered nothing,
 * so its column says nothing about the model and its gate has nothing to score.
 */
export function allDecisionsFailed(stats: Pick<BackendStats, "calls" | "failures">): boolean {
  return stats.calls > 0 && stats.failures >= stats.calls;
}

/** A wall clock as the milliseconds function the backend factories take. */
export function millisecondsOf(wall: WallClock): () => number {
  return () => wall.now().getTime();
}

/** The mutable side of `BackendStats`, kept by the handle module that owns it. */
export interface StatsCounter {
  calls: number;
  failures: number;
  cassetteMisses: number;
}

/** A fresh set of counters at zero. */
export function newStats(): StatsCounter {
  return { calls: 0, failures: 0, cassetteMisses: 0 };
}

/**
 * The live view of a live handle: its own counters and a copy of its queue's, read each time.
 *
 * Getters rather than fields, so the view moves as the run decides and a spread of it (which is
 * how the run records a handle when it ends) takes the numbers of that moment.
 */
export function liveStats(
  counter: Readonly<StatsCounter>,
  limiter: { readonly stats: RateLimitStats },
): BackendStats {
  return {
    get calls() {
      return counter.calls;
    },
    get failures() {
      return counter.failures;
    },
    get cassetteMisses() {
      return counter.cassetteMisses;
    },
    get rateLimit(): RateLimitStats {
      const { calls, retries, waitedMs } = limiter.stats;
      return { calls, retries, waitedMs };
    },
  };
}

/**
 * The same backend, counting every call and every call that threw into `stats`.
 *
 * The error is rethrown untouched: the pipeline is what turns a `DecisionError` into the failed
 * form of the decision message, and anything else must still reject the push that met it.
 */
export function counted(backend: DecisionBackend, stats: StatsCounter): DecisionBackend {
  return {
    name: backend.name,
    model: backend.model,
    async decide(input, options) {
      stats.calls += 1;
      try {
        return await backend.decide(input, options);
      } catch (error) {
        stats.failures += 1;
        throw error;
      }
    },
  };
}
