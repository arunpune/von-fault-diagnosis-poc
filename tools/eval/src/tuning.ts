// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The explicit tuning list, and the guard that keeps test data out of it.
//
// Design tuning — thresholds, word semantics, phase and onset parameters,
// retrieval text, the threshold sweep — reads only this list and synthetic
// frames. It is the tuning set the dev/test split describes — the summer
// baseline, the frozen logger, F4b, the unlabelled episodes and the injected
// scenarios outside the core-10 — written down, because the `dev` profile is
// not a tuning set: it replays `metropt3_full` (every headline failure) and
// `f4_precursor_jul14` (F4's scored hours, onset included).
// `fdp-eval run --tuning` replays exactly this list, and a core-10 result or a
// smoke E2E outcome is never a tuning signal.
//
// The list was signed off on 2026-09-24, after the E3 and E4 results had been
// seen, as it stands — ten scenarios with the leak's twin, the four dev
// injections sharing `baseline-feb03` with core-10 negatives as the dev/test
// split allows — and `unlabelled_leak_may19` is a design case. Its scenario
// file carries a design target (the signature-A pair, inferred and unverified)
// that the tuning readout and the sweep report beside, never inside, their
// figures (`src/metrics/design.ts`); the failure table still keeps the
// unlabelled episodes excluded, and the pre-registered threshold selection
// leaves may19 out. The pre-registration's amendment of 2026-09-24, made
// before any Von decision on the list existed, leaves `august_oil_level_aug10`
// out of the selection the same way: it binds no labelled window, so counting
// its time as negative time would score a correct oil-level ticket as a false
// alarm. Both stay on the list, and both are reported apart.
//
// The decision for a consistent leak injection (2026-09-23) adds
// `inject_air_leak_downstream_jul05`: the dev twin of the core-10
// `inject_air_leak_downstream` — the same injection at the same time of day
// with the same expectation, on the summer day of `summer_normal_jul05`, which
// no core-10 scenario replays — so the downstream leak can be designed and
// verified without reading the test split.
//
// The guard runs before anything is replayed and rejects a core-10 scenario
// (the test split), a scenario of the held-out set (its own split, which runs
// once, in its final run: tools/eval/records/heldout-seal.md), a scenario bound
// to a headline failure (by the failure table's own `in_headline` flag, not a
// hard-coded F1–F4) and a `recording` scenario. A dev scenario that replays the
// same slice as a core-10 one is *not* rejected — the dev/test split allows the
// injected scenarios outside the core-10 on the baseline day — but it is
// reported, so nobody reads its figures without knowing the day is shared.

import { ConfigError } from "./config.ts";
import { isHeldout } from "./heldout.ts";
import type { Profile, Scenario } from "./scenario/index.ts";

/** Every tuning scenario is dev split, so each replays over the dev profile's range. */
export const TUNING_BIND_PROFILE: Profile = "dev";

/** The tuning list, the leak's twin included, in the order a tuning run replays it. */
export const TUNING_SCENARIOS: readonly string[] = [
  "summer_normal_jul05",
  "frozen_logger_jun22",
  "f4b_recurrence_jul17",
  // A design case; its design target is reported, never gated or counted.
  "unlabelled_leak_may19",
  "august_oil_level_aug10",
  "inject_dryer_tower_switching_failure",
  "inject_intake_valve_sticking",
  "inject_motor_overload",
  "inject_separator_drain_blocked",
  // The dev twin of the core-10 downstream leak, on the summer slice.
  "inject_air_leak_downstream_jul05",
];

/**
 * The tuning scenarios whose figures are reported apart and never counted when a choice is made
 * from the list (the Von thresholds pre-registration,
 * tools/eval/records/von-thresholds-preregistration.md, "Data"), each with the reason the
 * report gives.
 */
export const TUNING_REPORTED_APART: readonly {
  readonly scenario: string;
  readonly reason: string;
}[] = [
  {
    scenario: "unlabelled_leak_may19",
    reason: "its target is inferred, not verified: a design case, reported and never counted",
  },
  {
    scenario: "august_oil_level_aug10",
    reason:
      "it binds no labelled window, expects at least one ticket of any fault, and its file says reported, never gated; its time is not negative time for the sweep, so a correct oil-level ticket is not a false alarm (the pre-registration's amendment of 2026-09-24)",
  },
];

/** The ids of `TUNING_REPORTED_APART`, in its order. */
export const TUNING_REPORTED_ONLY: readonly string[] = TUNING_REPORTED_APART.map(
  (entry) => entry.scenario,
);

/** One id the guard refuses, and why. */
export interface TuningRejection {
  readonly id: string;
  readonly reason: string;
}

/** A tuning scenario whose slice a core-10 scenario also replays: reported, never rejected. */
export interface SharedSlice {
  readonly scenario: string;
  readonly slice: string;
  /** The core-10 scenarios on that slice, sorted. */
  readonly core10: readonly string[];
}

/** What a tuning run replayed, and the slices it shares with the core-10. */
export interface TuningReport {
  readonly scenarios: readonly string[];
  readonly sharedSlices: readonly SharedSlice[];
}

/** Why a scenario may not be tuned on, or `undefined` when it may. */
function rejectionOf(
  scenario: Scenario,
  headlineFailureIds: ReadonlySet<string>,
): string | undefined {
  if (isHeldout(scenario)) return "a held-out scenario (it runs once, in its final run)";
  if (scenario.split === "test") return "a core-10 scenario (the test split)";
  const truth = scenario.ground_truth;
  if (truth.kind === "failure" && headlineFailureIds.has(truth.failure_id)) {
    return `bound to the headline failure ${truth.failure_id}`;
  }
  if (truth.kind === "recording") return "a recording that replays every headline failure";
  return undefined;
}

/**
 * Every id of `ids` the guard refuses, in list order.
 *
 * @param scenarios every scenario file.
 * @param headlineFailureIds the failures the failure table marks `in_headline`.
 */
export function tuningRejections(
  ids: readonly string[],
  scenarios: readonly Scenario[],
  headlineFailureIds: ReadonlySet<string>,
): TuningRejection[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return ids.flatMap((id) => {
    const scenario = byId.get(id);
    const reason =
      scenario === undefined
        ? "no scenario of that name"
        : rejectionOf(scenario, headlineFailureIds);
    return reason === undefined ? [] : [{ id, reason }];
  });
}

/**
 * The scenarios a tuning run replays, in list order, once the guard has passed every one.
 *
 * @throws ConfigError on `--tuning` naming every id the guard refuses and why, so the run
 * exits 1 before anything is replayed.
 */
export function selectTuning(
  scenarios: readonly Scenario[],
  headlineFailureIds: ReadonlySet<string>,
  ids: readonly string[] = TUNING_SCENARIOS,
): Scenario[] {
  const rejected = tuningRejections(ids, scenarios, headlineFailureIds);
  if (rejected.length > 0) {
    const named = rejected.map((entry) => `${entry.id} (${entry.reason})`).join("; ");
    throw new ConfigError("--tuning", `the tuning list may not hold ${named}`);
  }
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Every tuning scenario whose source slice a core-10 scenario also replays, in list order.
 *
 * @param tuning the scenarios the tuning run replays.
 * @param scenarios every scenario file; the core-10 is its test split.
 */
export function sharedSlices(
  tuning: readonly Scenario[],
  scenarios: readonly Scenario[],
): SharedSlice[] {
  const coreBySlice = new Map<string, string[]>();
  for (const scenario of scenarios) {
    if (scenario.split !== "test" || scenario.source.kind !== "slice") continue;
    const onSlice = coreBySlice.get(scenario.source.name) ?? [];
    coreBySlice.set(scenario.source.name, [...onSlice, scenario.id]);
  }
  return tuning.flatMap((scenario) => {
    if (scenario.source.kind !== "slice") return [];
    const core10 = coreBySlice.get(scenario.source.name) ?? [];
    if (core10.length === 0) return [];
    return [{ scenario: scenario.id, slice: scenario.source.name, core10: [...core10].sort() }];
  });
}
