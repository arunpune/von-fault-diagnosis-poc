// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Turning a scenario file into the windows the scorer counts in.
//
// A scenario file carries no failure timestamp and no fault id except as a
// reference. Everything a scorer needs — where a positive window starts and
// ends, which causes count as right, when the signature first became measurable,
// what the controller's own alarm did, which stretches are neither positive nor
// negative — is resolved here from `@fdp/ground-truth` and from the slice
// definitions, and from nowhere else. That makes this file the single
// adaptation point: if the ground-truth API moves, this file moves with it.
//
// The dependencies are parameters rather than imports of convenience, so a unit
// test can bind against a failure table it wrote itself instead of against the
// committed one. `bindScenario` with no `deps` uses the real package.

import {
  getInjection as getInjectionIn,
  loadFailureTable as loadFailureTableIn,
  loadInjections as loadInjectionsIn,
  precursorFrom as precursorFromIn,
  scoringWindows as scoringWindowsIn,
} from "@fdp/ground-truth";
import type {
  GtFailure,
  GtFailureTable,
  GtInjectionDef,
  GtInjections,
  ScoringWindow as GtScoringWindow,
} from "@fdp/ground-truth";

import { spanFrom } from "../metrics/index.ts";
import { sliceDef as sliceDefIn } from "../slices.ts";
import type { SliceDefinition } from "../slices.ts";
import { ScenarioError, applyProfile } from "./load.ts";
import type { ReplayRange } from "./load.ts";
import type { Profile, Scenario, ScenarioInjection } from "./schema.ts";

/** How long a gap in the recording keeps poisoning the features after it ends. */
export const GAP_TAIL_MIN = 30;

/** The part of `@fdp/ground-truth` the binder uses; a test passes a double instead. */
export interface GroundTruthApi {
  loadFailureTable(): GtFailureTable;
  loadInjections(): GtInjections | null;
  getInjection(id: string): GtInjectionDef | undefined;
  scoringWindows(options?: { includeSecondary?: boolean }): GtScoringWindow[];
  precursorFrom(failureId: string): Date | null;
}

/** The part of `src/slices.ts` the binder uses. */
export interface SliceApi {
  sliceDef(name: string): SliceDefinition;
}

export interface BindDeps {
  readonly gt?: GroundTruthApi;
  readonly slices?: SliceApi;
}

/** One window a positive is scored in, already clipped to the replayed range. */
export interface ScoringWindow {
  /** The failure id, or the injection id for an injected window. */
  readonly id: string;
  /**
   * Where the window's true-positive span opens — `spanFrom` of the metrics, that is
   * `min(leadFrom, onset)` when the onset is known, else `leadFrom` (the credited span) —
   * clipped to the replayed range. It is also where the window's positive time starts,
   * which the negative machine-days leave out.
   */
  readonly from: Date;
  readonly to: Date;
  /**
   * The instant the signature first becomes measurable: the precursor for a failure that has
   * one, the window start otherwise. Lead time is measured from here and it is deliberately
   * *not* clipped to the replayed range, so a scenario that starts mid-precursor still reports
   * how much warning the data gave. The true-positive span opens here unless a known data onset
   * is earlier (`from`).
   */
  readonly leadFrom: Date;
  /** Every cause a correct answer may name, the primary one first. */
  readonly accepted: readonly string[];
  /** True when the cause is normal operation rather than a defect. */
  readonly benign: boolean;
  /** When the data turns, if the table knows it. */
  readonly onset?: Date;
  /** False for F1, whose lead-in is a frozen block, so its lead time is reported as "≥". */
  readonly onsetKnown: boolean;
  /** The first `LPS` activation inside the window, when there is one. */
  readonly nativeLpsFirst?: Date;
  /**
   * True for the four MetroPT-3 headline failures the in-sample check scores; false for a
   * secondary positive (F4b) and for an injected fault.
   */
  readonly headline: boolean;
}

/** Why a stretch of the replay counts neither as a positive nor as a negative. */
export type ExclusionReason = GtFailureTable["excluded_windows"][number]["reason"] | "gap";

/** One excluded stretch, clipped to the replayed range. */
export interface ExcludedWindow {
  readonly from: Date;
  readonly to: Date;
  readonly reason: ExclusionReason;
}

/** One injection instance with everything the replay and the scorer need resolved. */
export interface InjectionSpec {
  readonly injection_id: string;
  readonly at: Date;
  readonly until: Date;
  readonly durationMin: number;
  readonly fault_id: string;
  readonly benign: boolean;
  readonly params: Readonly<Record<string, number>>;
}

/** Where the rows come from, resolved against the slice definitions. */
export type BoundSource =
  | { readonly kind: "slice"; readonly name: string; readonly definition: SliceDefinition }
  | { readonly kind: "csv" };

/** A scenario with its ground truth resolved, which is what the runner and the scorer consume. */
export interface BoundScenario {
  readonly scenario: Scenario;
  readonly profile: Profile;
  readonly replay: ReplayRange;
  readonly windows: readonly ScoringWindow[];
  readonly excluded: readonly ExcludedWindow[];
  readonly benignFaultIds: ReadonlySet<string>;
  readonly injections: readonly InjectionSpec[];
  readonly source: BoundSource;
}

const MINUTE_MS = 60_000;

const DEFAULT_GT: GroundTruthApi = {
  loadFailureTable: loadFailureTableIn,
  loadInjections: loadInjectionsIn,
  getInjection: getInjectionIn,
  scoringWindows: scoringWindowsIn,
  precursorFrom: precursorFromIn,
};

const DEFAULT_SLICES: SliceApi = { sliceDef: sliceDefIn };

function laterOf(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function earlierOf(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

/** The overlap of `[from, to)` with the replayed range, or `undefined` when it is empty. */
function clip(range: ReplayRange, from: Date, to: Date): ReplayRange | undefined {
  const start = laterOf(from, range.from);
  const end = earlierOf(to, range.to);
  return start.getTime() < end.getTime() ? { from: start, to: end } : undefined;
}

function optionalDate(value: string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : new Date(value);
}

/**
 * The slice a scenario replays, checked against the range it asks for.
 *
 * The definitions carry the segments a slice is cut from, so a replay range that reaches
 * past them would silently run out of rows on a machine that has cut the fixtures. Catching
 * it here turns that into a named error in `fdp-eval validate`, in any checkout, with no
 * dataset present.
 */
function bindSource(
  scenario: Scenario,
  range: ReplayRange,
  path: string,
  slices: SliceApi,
): BoundSource {
  if (scenario.source.kind === "csv") return { kind: "csv" };

  const { name } = scenario.source;
  let definition: SliceDefinition;
  try {
    definition = slices.sliceDef(name);
  } catch (error) {
    throw new ScenarioError("source", path, String(error));
  }

  const covered = definition.segments.some(
    (segment) =>
      new Date(segment.from).getTime() <= range.from.getTime() &&
      new Date(segment.to).getTime() >= range.to.getTime(),
  );
  if (!covered) {
    const segments = definition.segments.map((s) => `${s.from} → ${s.to}`).join(", ");
    throw new ScenarioError(
      "source",
      path,
      `slice '${name}' does not cover ${range.from.toISOString()} → ${range.to.toISOString()} (segments: ${segments})`,
    );
  }
  return { kind: "slice", name, definition };
}

/** How long one instance runs: its own `duration_sim_min`, else the definition's default. */
function durationOf(
  scheduled: ScenarioInjection,
  definition: GtInjectionDef,
  path: string,
): number {
  const override = scheduled.params?.["duration_sim_min"];
  if (override === undefined) return definition.default_duration_sim_min;
  if (!Number.isInteger(override) || override < 1) {
    throw new ScenarioError(
      "injection",
      path,
      `injection '${scheduled.injection_id}' has duration_sim_min ${override}, which is not a positive whole number of minutes`,
    );
  }
  return override;
}

/** Every declared parameter of an instance must exist in the definition and sit in its bounds. */
function checkParams(scheduled: ScenarioInjection, definition: GtInjectionDef, path: string): void {
  for (const [name, value] of Object.entries(scheduled.params ?? {})) {
    if (name === "duration_sim_min") continue;
    const declared = definition.params.find((candidate) => candidate.name === name);
    if (declared === undefined) {
      const known = definition.params.map((candidate) => candidate.name).join(", ");
      throw new ScenarioError(
        "injection",
        path,
        `injection '${scheduled.injection_id}' has no parameter '${name}' (declared: ${known || "none"})`,
      );
    }
    if (value < declared.min || value > declared.max) {
      throw new ScenarioError(
        "injection",
        path,
        `injection '${scheduled.injection_id}' parameter '${name}' is ${value}, outside [${declared.min}, ${declared.max}]`,
      );
    }
  }
}

function bindInjections(
  scenario: Scenario,
  range: ReplayRange,
  path: string,
  gt: GroundTruthApi,
): InjectionSpec[] {
  const scheduled = scenario.injections ?? [];
  if (scheduled.length === 0) return [];
  if (gt.loadInjections() === null) {
    throw new ScenarioError(
      "injection",
      path,
      "schedules injections but packages/ground-truth/data/injections.json is absent",
    );
  }

  return scheduled.map((entry) => {
    const definition = gt.getInjection(entry.injection_id);
    if (definition === undefined) {
      throw new ScenarioError(
        "injection",
        path,
        `no injection definition named '${entry.injection_id}' in @fdp/ground-truth`,
      );
    }
    checkParams(entry, definition, path);

    const at = new Date(entry.at);
    if (at.getTime() < range.from.getTime() || at.getTime() >= range.to.getTime()) {
      throw new ScenarioError(
        "injection",
        path,
        `injection '${entry.injection_id}' starts at ${entry.at}, outside the replayed range`,
      );
    }
    const durationMin = durationOf(entry, definition, path);
    return {
      injection_id: entry.injection_id,
      at,
      until: new Date(at.getTime() + durationMin * MINUTE_MS),
      durationMin,
      fault_id: definition.fault_id,
      benign: definition.benign,
      params: { ...entry.params },
    };
  });
}

/**
 * One failure's scoring window before it is clipped to what was replayed.
 *
 * The scenario binder clips it to a scenario's range and stack mode (`src/stack/score.ts`) to
 * the segments a stack replayed, so both score a failure through this one function and cannot
 * disagree about where its span opens.
 *
 * `leadFrom` is the precursor when the failure has one, else the labelled start. The window
 * opens at `spanFrom`, the credited span: `leadFrom`, or the data onset when the onset is known
 * and earlier — F3 at 09:48:30 instead of 10:00, F2 at 23:14:56 instead of 23:30 — never later
 * than the labelled start. The precursor is where the signature starts, so it is also where the
 * window starts: `f4_precursor_jul14` is exactly the stretch between F4's `precursor_from` and
 * the acute window, and it would otherwise bind to nothing. The labels themselves are read,
 * never changed.
 *
 * @param failure the failure table's row.
 * @param scoring the ground truth's scoring window of that failure.
 * @param precursor the failure's `precursor_from`, or `null`.
 */
export function failureScoringWindow(
  failure: GtFailure,
  scoring: GtScoringWindow,
  precursor: Date | null,
): ScoringWindow {
  const leadFrom = precursor ?? scoring.from;
  const onset = optionalDate(failure.data_onset);
  const opens = spanFrom({ id: failure.id, leadFrom, onset, onsetKnown: failure.onset_known });
  return {
    id: failure.id,
    from: earlierOf(opens, scoring.from),
    to: scoring.to,
    leadFrom,
    accepted: [...scoring.accepted_fault_ids],
    benign: false,
    onset,
    onsetKnown: failure.onset_known,
    nativeLpsFirst: optionalDate(failure.native_alarm_first),
    headline: failure.in_headline,
  };
}

function bindFailureWindow(
  failureId: string,
  range: ReplayRange,
  path: string,
  gt: GroundTruthApi,
): ScoringWindow {
  const table = gt.loadFailureTable();
  const failure = table.failures.find((candidate) => candidate.id === failureId);
  if (failure === undefined) {
    const known = table.failures.map((candidate) => candidate.id).join(", ");
    throw new ScenarioError(
      "ground_truth",
      path,
      `no failure named '${failureId}' in the failure table (known: ${known})`,
    );
  }

  const window = gt
    .scoringWindows({ includeSecondary: true })
    .find((candidate) => candidate.failure_id === failureId);
  if (window === undefined) {
    throw new ScenarioError("ground_truth", path, `failure '${failureId}' has no scoring window`);
  }

  const unclipped = failureScoringWindow(failure, window, gt.precursorFrom(failureId));
  const clipped = clip(range, unclipped.from, unclipped.to);
  if (clipped === undefined) {
    throw new ScenarioError(
      "ground_truth",
      path,
      `failure '${failureId}' (${window.from.toISOString()} → ${window.to.toISOString()}) does not overlap the replayed range`,
    );
  }

  return { ...unclipped, from: clipped.from, to: clipped.to };
}

/**
 * Every headline failure the replayed range covers.
 *
 * This is what the MetroPT-3 check of `metropt3_full` is scored against: one window per
 * headline failure (F4b is a secondary positive and stays out), each clipped the same way a
 * single-failure scenario would be.
 */
function recordingWindows(range: ReplayRange, path: string, gt: GroundTruthApi): ScoringWindow[] {
  const windows = gt
    .scoringWindows()
    .filter(
      (window) =>
        window.from.getTime() < range.to.getTime() && window.to.getTime() > range.from.getTime(),
    )
    .map((window) => bindFailureWindow(window.failure_id, range, path, gt));
  if (windows.length === 0) {
    throw new ScenarioError(
      "ground_truth",
      path,
      "no headline failure overlaps the replayed range",
    );
  }
  return windows;
}

function injectionWindows(
  injections: readonly InjectionSpec[],
  range: ReplayRange,
): ScoringWindow[] {
  const windows: ScoringWindow[] = [];
  for (const injection of injections) {
    const clipped = clip(range, injection.at, injection.until);
    if (clipped === undefined) continue;
    windows.push({
      id: injection.injection_id,
      from: clipped.from,
      to: clipped.to,
      leadFrom: injection.at,
      accepted: [injection.fault_id],
      benign: injection.benign,
      onset: injection.at,
      onsetKnown: true,
      // `headline` marks the four MetroPT-3 failures the in-sample check scores; an
      // injected fault is scored by precision and recall, never by that check.
      headline: false,
    });
  }
  return windows;
}

/**
 * The stretches of the replayed range that count neither as a positive nor as a negative.
 *
 * Two sources. The failure table's `excluded_windows` are the repairs, the frozen blocks, the
 * unlabelled episodes, F4b and the depot depressurisations. The gaps are the recording's own:
 * the failure table keeps them out of `excluded_windows` because the replay derives
 * them from the `discontinuity` flag in the stream, but the ones longer than an hour are known
 * in advance and are attached here — with their 30-minute tail — so that `fdp-eval validate`
 * reports them before a single row has been read.
 */
function excludedWindows(range: ReplayRange, gt: GroundTruthApi): ExcludedWindow[] {
  const table = gt.loadFailureTable();
  const found: ExcludedWindow[] = [];

  for (const window of table.excluded_windows) {
    const clipped = clip(range, new Date(window.from), new Date(window.to));
    if (clipped !== undefined) {
      found.push({ from: clipped.from, to: clipped.to, reason: window.reason });
    }
  }
  for (const gap of table.gaps_over_1h) {
    const end = new Date(new Date(gap.end).getTime() + GAP_TAIL_MIN * MINUTE_MS);
    const clipped = clip(range, new Date(gap.start), end);
    if (clipped !== undefined) {
      found.push({ from: clipped.from, to: clipped.to, reason: "gap" });
    }
  }
  return found.sort((left, right) => left.from.getTime() - right.from.getTime());
}

/** Every cause the injection catalog marks as normal operation rather than a defect. */
function benignFaultIds(gt: GroundTruthApi): Set<string> {
  const catalog = gt.loadInjections();
  const ids = new Set<string>();
  for (const injection of catalog?.injections ?? []) {
    if (injection.benign) ids.add(injection.fault_id);
  }
  return ids;
}

/** Every cause id the ground-truth data names: failures, their accepted causes, hints, injections. */
function groundTruthCauses(gt: GroundTruthApi): Set<string> {
  const table = gt.loadFailureTable();
  const causes = new Set<string>();
  for (const failure of table.failures) {
    causes.add(failure.fault_id);
    for (const accepted of failure.accepted_fault_ids) causes.add(accepted);
  }
  for (const episode of table.unlabelled_episodes) causes.add(episode.fault_id_hint);
  for (const injection of gt.loadInjections()?.injections ?? []) causes.add(injection.fault_id);
  return causes;
}

/**
 * A design target's references must resolve: every cause it names is one the ground-truth data
 * names, and the replayed range holds an unlabelled episode for it to apply to. The episodes
 * themselves come from the failure table, never from the scenario file.
 */
function checkDesignTarget(
  scenario: Scenario,
  excluded: readonly ExcludedWindow[],
  path: string,
  gt: GroundTruthApi,
): void {
  const target = scenario.design_target;
  if (target === undefined) return;
  const causes = groundTruthCauses(gt);
  const unknown = target.accepted.filter((faultId) => !causes.has(faultId));
  if (unknown.length > 0) {
    throw new ScenarioError(
      "ground_truth",
      path,
      `design_target names ${unknown.join(", ")}, which the ground-truth data does not name`,
    );
  }
  if (!excluded.some((window) => window.reason === "unlabelled_positive")) {
    throw new ScenarioError(
      "ground_truth",
      path,
      "design_target applies to the unlabelled episodes of the replayed range, and it holds none",
    );
  }
}

/**
 * Resolves one scenario against ground truth for one profile.
 *
 * @param path what to name in an error; the file the scenario was read from.
 * @throws ScenarioError when a slice, an injection id or a failure id does not resolve, when
 * the ground truth and the replayed range do not overlap, or when a design target names a cause
 * ground truth does not or has no unlabelled episode to apply to.
 */
export function bindScenario(
  scenario: Scenario,
  options: { profile?: Profile; path?: string; deps?: BindDeps } = {},
): BoundScenario {
  const profile = options.profile ?? "core";
  const path = options.path ?? `${scenario.id}.json`;
  const gt = options.deps?.gt ?? DEFAULT_GT;
  const slices = options.deps?.slices ?? DEFAULT_SLICES;

  const replay = applyProfile(scenario, profile);
  const source = bindSource(scenario, replay, path, slices);
  const injections = bindInjections(scenario, replay, path, gt);

  let windows: ScoringWindow[];
  switch (scenario.ground_truth.kind) {
    case "failure":
      windows = [bindFailureWindow(scenario.ground_truth.failure_id, replay, path, gt)];
      break;
    case "recording":
      windows = recordingWindows(replay, path, gt);
      break;
    case "injection":
      windows = injectionWindows(injections, replay);
      if (windows.length === 0) {
        throw new ScenarioError(
          "ground_truth",
          path,
          "no scheduled injection overlaps the replayed range",
        );
      }
      break;
    default:
      windows = [];
      break;
  }

  const excluded = excludedWindows(replay, gt);
  checkDesignTarget(scenario, excluded, path, gt);

  return {
    scenario,
    profile,
    replay,
    windows,
    excluded,
    benignFaultIds: benignFaultIds(gt),
    injections,
    source,
  };
}
