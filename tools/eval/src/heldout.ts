// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The held-out set, and what keeps it out of every run but its one final run
// (tools/eval/records/heldout-seal.md).
//
// Every figure before it keeps its in-sample label, and the held-out set was
// authored blind, sealed, and runs once, after the Jev thresholds are fixed
// under the pre-registration. The set has its own split and its own profile,
// both `heldout`, and its own slices, whose names begin with `heldout-`. The
// guards live where the thing they guard is decided, and this module holds only
// the names they share:
//
//   - the loader (`scenario/load.ts`): split `heldout` if and only if profiles
//     `["heldout"]`, a held-out scenario replays a held-out slice, and nothing
//     else replays one, so no other profile can ever select one;
//   - the tuning guard (`tuning.ts`): a held-out id is refused;
//   - the run (`config.ts`, `runner/run.ts`): `--profile heldout` is refused
//     without `--final-heldout`, the final run is refused once its record is
//     committed, and `--scenario` naming a held-out id under another profile is
//     refused by name; since the Jev thresholds pre-registration's amendment of
//     2026-09-24 the final run is also refused unless it runs with exactly the
//     triple (GATE_PERSIST_SIM_MIN and Jev's pair) the pre-registered sweep
//     chose, read from its committed record (`choice.ts`,
//     tools/eval/records/jev-thresholds-choice.md);
//   - the live plan (`backends/select.ts`): a held-out run is never planned by a
//     mock replay unless it goes on to run;
//   - the sweep (`commands/sweep.ts`, `metrics/sweep.ts`): a held-out run is
//     never re-gated, whatever flag is given.
//
// Nothing here reads a scenario's rows or replays anything; a test of these
// guards never runs a held-out scenario either.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Profile, Scenario, Split } from "./scenario/schema.ts";
import { REPO_ROOT } from "./slices.ts";

/** The profile of the held-out set: it selects the held-out scenarios and nothing else. */
export const HELDOUT_PROFILE: Profile = "heldout";

/** The split of the held-out set, beside `dev` and `test`. */
export const HELDOUT_SPLIT: Split = "heldout";

/** Every held-out slice, and no other, begins with this. */
export const HELDOUT_SLICE_PREFIX = "heldout-";

/** The flag the one final run gives, and no other run may. */
export const FINAL_HELDOUT_FLAG = "--final-heldout";

/** Where the selection rule, the one-run rule and the seal are written down. */
export const HELDOUT_SEAL_FILE = "tools/eval/records/heldout-seal.md";

/**
 * The record the operator commits right after the final run, whatever its outcome. Once it
 * exists the harness refuses every further held-out run; a second run is a separate decision,
 * recorded in that file.
 */
export const FINAL_RUN_RECORD_FILE = "tools/eval/records/heldout-final-run.md";

/** True for a scenario of the held-out set. */
export function isHeldout(scenario: Pick<Scenario, "split">): boolean {
  return scenario.split === HELDOUT_SPLIT;
}

/** True for a slice only the held-out set may replay. */
export function isHeldoutSlice(name: string): boolean {
  return name.startsWith(HELDOUT_SLICE_PREFIX);
}

/** The absolute path of the final run's record, whether or not it exists. */
export function finalRunRecordPath(root: string = REPO_ROOT): string {
  return join(root, FINAL_RUN_RECORD_FILE);
}

/** True once the final run's record is in the checkout: the set has had its one run. */
export function finalRunRecorded(path: string = finalRunRecordPath()): boolean {
  return existsSync(path);
}
