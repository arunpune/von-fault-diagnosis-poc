// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The state every decision backend reads
 * (docs/decision-backends.md#the-state-words-not-numbers).
 *
 * Words only. Every number already became a level, a trend or a duration in
 * `detection/buckets.ts`, and this builder only splits, filters, orders and
 * names. Nothing here computes a quantity, because the moment a model has to
 * compare two figures the answer stops being a snap judgment. The one figure
 * it reads is the motor current, against
 * detection's own running threshold, to name the machine's mode truthfully
 * when the controller requests load and the motor does not run.
 *
 * The layout is stable so every question can point into it by path — that is
 * what {@link resolveStatePath} and {@link inspectPathsFor} are for, and what
 * makes an `inspect` list testable without a model. The rules backend reads the
 * same object through `retrieval/match.ts`, so the twin and Von are fed by one
 * builder and never drift apart.
 *
 * Nothing that did not come out of the catalog or out of detection enters the
 * state: the only free text is the manual's own wording and the sentences
 * detection's rules write, which limits the prompt-injection surface to content
 * this project wrote (no real brands, no third-party manuals).
 */

import { createHash } from "node:crypto";

import { alarmByCode, parseIsoMs, SIGNALS } from "@fdp/contracts";
import type { LevelBucket, Observation, SignalMove, SuspectEvent } from "@fdp/contracts";

import { duration } from "../detection/buckets.ts";
import { VALUE_WINDOW_S } from "../detection/features.ts";
import { ROLE_COLUMNS } from "../detection/signals.ts";
import { RUNNING_CURRENT_A } from "../detection/state.ts";
import { fromContractLevel, fromContractTrend, moveTarget } from "../retrieval/match.ts";
import type { Candidate } from "../retrieval/types.ts";
import type { DecisionInput } from "./types.ts";

/**
 * What the unit is, in one sentence: the fictional CAU-7, no real brand.
 *
 * It is a constant rather than a catalog field because every decision of this
 * proof of concept is about the same machine, and a sentence the model reads on
 * every request is cheaper to keep here than to carry through retrieval.
 */
export const MACHINE_KIND =
  "oil-injected screw compressor with a twin-tower desiccant dryer, load/unload regulation";

/** How many observations reach the model. */
export const MAX_OBSERVATIONS = 12;

/** The word `controller_alarms` carries when the controller is quiet. */
export const NO_ALARMS = "none";

/** The word a bucket carries when detection could not place the signal. */
const UNKNOWN_WORD = "unknown";

/**
 * `machine.mode` when the controller holds the unit loaded but the motor is
 * not running (see {@link motorStandsUnderLoad}).
 */
export const LOADED_MOTOR_NOT_RUNNING = "load requested, motor not running";

/** The budget the state alone must fit, in the `ceil(chars / 3)` heuristic. */
export const STATE_TOKEN_BUDGET = 4000;

/** One signal or derived behaviour as the model reads it. */
export interface StateObservation {
  /** The register-map tag id or the derived behaviour id. */
  readonly signal: string;
  /** The human name of that signal, for a question that quotes it. */
  readonly label: string;
  readonly level: string;
  readonly trend: string;
  readonly since: string;
  /**
   * Over the last day, in the busy hours and in the quiet hours, in words
   * ({@link byHoursWords}); only when detection sent `by_hours`.
   */
  readonly by_hours?: string;
  /**
   * What a detection rule firing under the symptom saw on this signal, in the
   * rule's own sentence ({@link ruleSentences}); only on the row a rule measured.
   */
  readonly seen?: string;
}

/** One catalog cause as the model reads it. */
export interface StateCandidate {
  readonly id: string;
  readonly cause: string;
  readonly condition: string;
  readonly expected_signal_moves: readonly string[];
  readonly benign: boolean;
}

/** The whole state of one decision. */
export interface DecisionState {
  readonly machine: {
    readonly kind: string;
    readonly mode: string;
    readonly mode_for: string;
    readonly ambient: string;
  };
  readonly symptom: {
    readonly condition: string;
    readonly also_present: readonly string[];
    readonly for: string;
  };
  readonly observations: readonly StateObservation[];
  readonly controller_alarms: readonly string[];
  readonly candidates: readonly StateCandidate[];
}

/** Signal tag id or behaviour id to the human name a question may quote. */
export type SignalLabels = Readonly<Record<string, string>>;

/** `far_above_normal` → `far above normal`; the model never sees an underscore. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}

/** The level of one observation, in words, or `unknown` when detection had none. */
function levelWords(observation: Observation): string {
  const level = fromContractLevel(observation.level);
  return level === undefined ? UNKNOWN_WORD : words(level);
}

/** The trend of one observation, in words, or `unknown` when detection had none. */
function trendWords(observation: Observation): string {
  const trend = fromContractTrend(observation.trend);
  return trend === undefined ? UNKNOWN_WORD : words(trend);
}

/** How the unit's quiet hours are named to the model: what makes them quiet. */
export const QUIET_HOURS_WORDS = "the quiet hours, when the plant draws least air";

/** One kind of hour against the reference cycle, or undefined when it was not seen. */
function paceWords(level: LevelBucket): string | undefined {
  switch (level) {
    case "far_above":
    case "above":
      return "faster than usual";
    case "normal":
      return "as usual";
    case "below":
    case "far_below":
      return "slower than usual";
    case "unknown":
      return undefined;
  }
}

/**
 * The last day's idle decay by kind of hour, in one sentence.
 *
 * The manual tells a network leak from a plant drawing more air by whether
 * the decay keeps its pace when the plant draws least air, so the sentence
 * puts exactly that side by side and says which kind of hour was not seen.
 * "Faster" is the manual's own word for the decay (`faster` in its expected
 * movements), and "as usual" means inside the reference cycle's band. The
 * sentence holds no digit and no underscore, like every other state word.
 */
export function byHoursWords(byHours: {
  readonly quiet: LevelBucket;
  readonly busy: LevelBucket;
}): string | undefined {
  const quiet = paceWords(byHours.quiet);
  const busy = paceWords(byHours.busy);
  const faster = "faster than usual";
  if (quiet !== undefined && busy !== undefined) {
    if (quiet === faster && busy === faster) {
      return `${faster} in the busy hours and also in ${QUIET_HOURS_WORDS}`;
    }
    if (quiet === busy) return `${busy} in the busy hours and in ${QUIET_HOURS_WORDS}`;
    if (busy === faster)
      return `${faster} only in the busy hours; ${quiet} in ${QUIET_HOURS_WORDS}`;
    if (quiet === faster)
      return `${faster} only in ${QUIET_HOURS_WORDS}; ${busy} in the busy hours`;
    return `${busy} in the busy hours; ${quiet} in ${QUIET_HOURS_WORDS}`;
  }
  if (busy !== undefined) {
    const since = busy === faster ? "since it turned faster" : "yet";
    return `${busy} in the busy hours; ${QUIET_HOURS_WORDS}, not seen ${since}`;
  }
  if (quiet !== undefined) {
    const since = quiet === faster ? "since it turned faster" : "yet";
    return `${quiet} in ${QUIET_HOURS_WORDS}; the busy hours not seen ${since}`;
  }
  return undefined;
}

/** How far out of its band a signal sits, one half of its magnitude. */
function levelWeight(observation: Observation): number {
  switch (observation.level) {
    case "far_below":
    case "far_above":
      return 3;
    case "below":
    case "above":
      return 2;
    case "normal":
    case "unknown":
      return 0;
  }
}

/** How hard a signal is moving, the other half of its magnitude. */
function trendWeight(observation: Observation): number {
  switch (observation.trend) {
    case "erratic":
    case "stuck":
      return 2;
    case "rising":
    case "falling":
      return 1;
    case "flat":
    case "unknown":
      return 0;
  }
}

/** A signal the model must see even when it is behaving: a candidate named it. */
function namedByCandidates(candidates: readonly Candidate[]): ReadonlySet<string> {
  const named = new Set<string>();
  for (const candidate of candidates) {
    for (const move of candidate.signal_moves) {
      const target = moveTarget(move);
      if (target !== undefined) named.add(target);
    }
  }
  return named;
}

/**
 * Whether detection saw this signal doing anything at all.
 *
 * A row whose level and trend are both unknown says nothing about now: it is a
 * behaviour detection knows only by kind of hour over the last day. It enters
 * the state when a candidate names it, never as context on its own.
 */
function isMoving(observation: Observation): boolean {
  if (observation.level === "unknown" && observation.trend === "unknown") return false;
  return observation.level !== "normal" || observation.trend !== "flat";
}

/** One observation with what its place in the state depends on. */
interface RankedObservation {
  readonly observation: Observation;
  /** Whether a candidate's `signal_moves` name the signal. */
  readonly named: boolean;
  /** How far out of its band the signal sits plus how hard it moves. */
  readonly magnitude: number;
  /** Where detection put it in the event, the last tie-break. */
  readonly index: number;
}

/**
 * The order of the state's observations.
 *
 * Named signals first, then the rest; inside each group the larger deviation
 * first; detection's own order breaks what is left, so the same event and the
 * same candidates always give the same list.
 */
function byNamedThenMagnitude(left: RankedObservation, right: RankedObservation): number {
  if (left.named !== right.named) return left.named ? -1 : 1;
  if (left.magnitude !== right.magnitude) return right.magnitude - left.magnitude;
  return left.index - right.index;
}

/**
 * What the rules firing under the symptom saw, by the signal each one measured.
 *
 * Detection writes one `evidence` item per rule hit under the symptom, in
 * `rule_ids` order, before the one per observation that moved, so the first
 * `rule_ids.length` items are the rules' own: the metric the rule watched — a
 * signal tag or a behaviour id, the ids the observations carry — and its
 * `detail`, a sentence of words that states what was seen and
 * never what it means (`detection/rules/types.ts`). It is the one piece of
 * evidence the level and trend words cannot carry when the rule watched a
 * pattern rather than a value: a tower indication that should change over at
 * every cut-in and has not, reads normal and flat for hours, because while the
 * unit is loaded either tower is an ordinary value (signals.yaml: the towers
 * alternate while the unit delivers air). Retrieval already searches these
 * sentences (`retrieval/query.ts`); here they reach the model beside the row.
 *
 * Two rules that measured one signal give their sentences in the order they
 * fired. The observations' own evidence sentences are left out: they repeat
 * the row's level and trend in words.
 */
function ruleSentences(event: SuspectEvent): ReadonlyMap<string, string> {
  const bySignal = new Map<string, string>();
  for (const item of event.evidence.slice(0, event.rule_ids.length)) {
    const sentence = item.observation.trim();
    if (sentence === "") continue;
    const earlier = bySignal.get(item.metric);
    bySignal.set(item.metric, earlier === undefined ? sentence : `${earlier} ${sentence}`);
  }
  return bySignal;
}

/**
 * The observations the model reads.
 *
 * Every signal a candidate's expected movements name, then every other signal
 * that is doing something, each group ordered by how far the signal is off its
 * usual behaviour, capped at {@link MAX_OBSERVATIONS}. A row a firing rule
 * measured carries that rule's sentence ({@link ruleSentences}); the sentence
 * moves no row in or out and changes no order.
 *
 * The named group comes first because the cap cuts from the end. A candidate
 * that expects a signal to stay put, or a switch to hold its state, can only be
 * judged if that signal reaches the state; ordered by magnitude alone, a
 * behaving signal sorts last and a crowded event cuts exactly the observation
 * that separates two causes. An unnamed moving signal is context for the
 * severity and for "none of these", so it fills whatever room is left.
 */
function buildObservations(
  event: SuspectEvent,
  candidates: readonly Candidate[],
  labels: SignalLabels,
): StateObservation[] {
  const namedSignals = namedByCandidates(candidates);
  const seenBySignal = ruleSentences(event);
  const ordered = event.observations
    .map((observation, index): RankedObservation => ({
      observation,
      named: namedSignals.has(observation.signal),
      magnitude: levelWeight(observation) + trendWeight(observation),
      index,
    }))
    .filter(({ observation, named }) => named || isMoving(observation))
    .sort(byNamedThenMagnitude)
    .slice(0, MAX_OBSERVATIONS);

  return ordered.map(({ observation }) => {
    const byHours =
      observation.by_hours === undefined ? undefined : byHoursWords(observation.by_hours);
    const seen = seenBySignal.get(observation.signal);
    return {
      signal: observation.signal,
      label: labels[observation.signal] ?? words(observation.signal),
      level: levelWords(observation),
      trend: trendWords(observation),
      since: observation.since ?? words(UNKNOWN_WORD),
      ...(byHours === undefined ? {} : { by_hours: byHours }),
      ...(seen === undefined ? {} : { seen }),
    };
  });
}

/**
 * One expected movement in the manual's own sentence.
 *
 * `signal_moves_text[]` is what the manual generator rendered and the PDF
 * printed, so the model and a technician reading the manual see the same
 * line. Entries extracted from a PDF carry no rendered text, and those fall
 * back to a sentence built from the tag and the direction word.
 */
function movesOf(candidate: Candidate, labels: SignalLabels): string[] {
  if (candidate.signal_moves_text.length > 0) return [...candidate.signal_moves_text];
  return candidate.signal_moves.map((move) => generatedMove(move, labels));
}

/** The fallback sentence for a movement the manual never rendered. */
function generatedMove(move: SignalMove, labels: SignalLabels): string {
  const target = moveTarget(move);
  const label = target === undefined ? "the unit" : (labels[target] ?? words(target));
  const phase = move.phase === undefined || move.phase === "any" ? "" : ` while ${move.phase}`;
  return `${label} ${words(move.direction)}${phase}`;
}

/** The title of a condition, from whichever candidate lists it. */
function conditionTitle(candidates: readonly Candidate[], conditionId: string): string {
  for (const candidate of candidates) {
    for (const condition of candidate.conditions) {
      if (condition.condition_id === conditionId) return condition.title;
    }
  }
  return words(conditionId);
}

/** The condition a candidate is offered under, or the first one it explains. */
function candidateCondition(candidate: Candidate, symptomKey: string): string {
  const listed = candidate.conditions.find((condition) => condition.condition_id === symptomKey);
  return (listed ?? candidate.conditions[0]).title;
}

/** How long the two timestamps are apart, in milliseconds. */
function elapsedMs(fromIso: string, toIso: string): number {
  return parseIsoMs(toIso).getTime() - parseIsoMs(fromIso).getTime();
}

/** How long the two timestamps are apart, in duration words. */
function durationWords(fromIso: string, toIso: string): string {
  return words(duration(elapsedMs(fromIso, toIso)));
}

/**
 * The register map's tag for the motor current, looked up by its recording
 * column the way `detection/signals.ts` binds its roles, so no tag literal is
 * written here.
 */
const MOTOR_CURRENT_SIGNAL: string | undefined = SIGNALS.find(
  (signal) => signal.metropt_column === ROLE_COLUMNS.motor_current,
)?.tag;

/**
 * Whether the controller holds the unit loaded while the motor is not running.
 *
 * Detection calls a sample `loaded` from the two valve digitals alone
 * (docs/detection.md#machine-state), so a load request the motor never
 * answers is `loaded` to it. The manual says otherwise: loaded means the
 * compression element delivers air with the motor current at its loaded value
 * (the manual's "Regulation" and "Loaded run" sections), and a load request
 * with the current below 1.0 A is its no-start situation, alarm S304 ("the motor draws
 * no current, so the drive never started"). Read as `loaded`, every "while
 * loaded" expectation looks answered by a motor current that is only "far
 * below normal": the level words cannot tell a stopped motor from one that
 * sags under load, so the mode has to say it.
 *
 * Only the words change. The rules twin matches in the event's own mode
 * (`matchContextOf`), and detection's mode, rules and cycles are untouched.
 *
 * The test is detection's own running threshold, {@link RUNNING_CURRENT_A},
 * applied to the motor current the event carries: the median of the last
 * {@link VALUE_WINDOW_S} seconds. It is read only once the unit has been loaded
 * for that whole window. Right after a cut-in the window still holds the
 * samples of the off phase before it, so an event raised on the cut-in sample
 * shows a median near zero while the motor has in fact just started; with
 * the window inside the load request, a median below the threshold means the
 * motor drew no running current for at least half of the last minute of it.
 * An event without the value — every words-only fixture — keeps `loaded`.
 */
function motorStandsUnderLoad(event: SuspectEvent): boolean {
  if (event.machine_state.mode !== "loaded" || MOTOR_CURRENT_SIGNAL === undefined) return false;
  if (elapsedMs(event.machine_state.since_sim_ts, event.sim_ts) < VALUE_WINDOW_S * 1000) {
    return false;
  }
  const current = event.observations.find(
    (observation) => observation.signal === MOTOR_CURRENT_SIGNAL,
  )?.value;
  return current !== undefined && current < RUNNING_CURRENT_A;
}

/** The machine's mode in words, corrected where the motor does not answer a load request. */
function modeWords(event: SuspectEvent): string {
  return motorStandsUnderLoad(event) ? LOADED_MOTOR_NOT_RUNNING : words(event.machine_state.mode);
}

/** The active controller messages, code and title, or the single word `none`. */
function buildAlarms(event: SuspectEvent): string[] {
  if (event.active_alarms.length === 0) return [NO_ALARMS];
  return event.active_alarms.map((code) => {
    const alarm = alarmByCode(code);
    return alarm === undefined ? code : `${code} ${alarm.title}`;
  });
}

/**
 * Build the state of one decision.
 *
 * `labels` names the signals: the register map's human names for the tags and
 * the manual's behaviour descriptions for the derived ones. A signal with no
 * label falls back to its own id in words rather than dropping out, because an
 * observation the model cannot name is worse than one named awkwardly.
 */
export function buildState(input: DecisionInput, labels: SignalLabels = {}): DecisionState {
  const { event, candidates } = input;
  return {
    machine: {
      kind: MACHINE_KIND,
      mode: modeWords(event),
      mode_for: durationWords(event.machine_state.since_sim_ts, event.sim_ts),
      ambient: words(event.ambient),
    },
    symptom: {
      condition: conditionTitle(candidates, event.symptom_key),
      also_present: event.co_symptoms.map((key) => conditionTitle(candidates, key)),
      for: durationWords(event.window.from_sim_ts, event.sim_ts),
    },
    observations: buildObservations(event, candidates, labels),
    controller_alarms: buildAlarms(event),
    candidates: candidates.map((candidate) => ({
      id: candidate.fault_id,
      cause: candidate.name,
      condition: candidateCondition(candidate, event.symptom_key),
      expected_signal_moves: movesOf(candidate, labels),
      benign: candidate.benign,
    })),
  };
}

/** JSON with every object key in sorted order, so a digest is reproducible. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
}

/** The state as one canonical JSON string; the digest and the budget read it. */
export function canonicalStateJson(state: DecisionState): string {
  return JSON.stringify(canonical(state));
}

/**
 * How many tokens the state costs, as `ceil(chars / 3)`.
 *
 * A heuristic on purpose: the state's size budget is there to catch
 * a state that grew by a candidate or by a longer manual sentence, and a
 * tokenizer would tie the assertion to one provider's vocabulary.
 */
export function estimateTokens(state: DecisionState): number {
  return Math.ceil(canonicalStateJson(state).length / 3);
}

/** The sha256 of the state's canonical JSON; the decision message carries it. */
export function stateDigest(state: DecisionState): string {
  return createHash("sha256").update(canonicalStateJson(state), "utf8").digest("hex");
}

const PATH_SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d+\])*)$/;

/**
 * Read one backticked state path, such as `candidates[1].expected_signal_moves[0]`.
 *
 * Returns `undefined` when the path does not resolve, which is exactly the
 * assertion the question tests make: every path a question names must point at
 * something the model can actually read.
 */
export function resolveStatePath(state: DecisionState, path: string): unknown {
  let current: unknown = state;
  for (const segment of path.split(".")) {
    const parsed = PATH_SEGMENT.exec(segment);
    if (parsed === null) return undefined;
    const [, key = "", indexes = ""] = parsed;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
    for (const index of indexes.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[Number(index[1])];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** What the `fault` Choice inspects. */
export const CHOICE_INSPECT_PATHS: readonly string[] = [
  "observations",
  "controller_alarms",
  "candidates",
];

/** What the `severity` Score inspects. */
export const SEVERITY_INSPECT_PATHS: readonly string[] = [
  "observations",
  "controller_alarms",
  "machine.mode",
];

/** What the `match_<fault_id>` Noul of one candidate inspects. */
export function matchInspectPaths(index: number): readonly string[] {
  return ["observations", `candidates[${index}].expected_signal_moves`];
}

/** The defining movement one Noul asks about. */
export function definingMovePath(index: number): string {
  return `candidates[${index}].expected_signal_moves[0]`;
}

/**
 * Every path the Von question set reads from this state.
 *
 * The Von backend builds the questions; this list is what makes "every
 * `inspect` path resolves" a test the state builder can run on its own.
 */
export function inspectPathsFor(state: DecisionState): readonly string[] {
  const paths = new Set<string>([...CHOICE_INSPECT_PATHS, ...SEVERITY_INSPECT_PATHS]);
  state.candidates.forEach((_candidate, index) => {
    for (const path of matchInspectPaths(index)) paths.add(path);
    paths.add(definingMovePath(index));
  });
  return [...paths];
}
