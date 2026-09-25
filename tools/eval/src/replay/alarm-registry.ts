// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The manual's controller registry, resolved into the table the CTRL-7 port
// evaluates.
//
// Three documents make one registry: `alarms.yaml` carries the messages and
// their triggers, `settings.yaml` the defaults every `{setting: id}` threshold
// and delay resolves against, and `signals.yaml` the tags, the derived
// quantities and the machine states the triggers are written over. What comes
// out is the manual's grammar with every reference resolved — a leaf still
// names the signal the manual named, and its threshold is a number in that
// signal's own unit.
//
// Two rules shape the whole module.
//
// The first is that unknown grammar is an error, never a silently skipped
// message: a trigger state nobody implements, an operator outside the six, a
// threshold that is neither `{value, unit}` nor `{setting, offset?}`, a
// composite with both branches, a message without a bit — each throws an
// `AlarmRegistryError` naming the message code and the field. A controller
// that quietly drops a shutdown message is worse than one that refuses to
// start. The messages that are *declared* unevaluable (`evaluation: none`,
// `trigger.kind: external | counter`) are a different thing: they are listed
// under `unevaluable`, carry no bit and never activate, because the replay has
// nothing to evaluate them on.
//
// The second is that this file resolves and does not evaluate. The reading of
// a resolved leaf — which comparison, which reset band, which dwell — belongs
// to `alarms.ts`, which mirrors the Go evaluator of
// `services/modbus/internal/ctrl7` message for message. Here a
// `time_in_state` leaf is still `continuous_load_time > 10 min`; there it
// becomes the state-duration rule the simulator runs.
//
// No ground truth is read here, and none could be: alarms are machine
// behaviour, and the three documents are the machine's own description of it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "../slices.ts";
import type { MachineState } from "./types.ts";

/** Where the manual's registry lives. */
export const MANUAL_SPEC_DIR = "manual/spec";

/** The five-message stand-in a worktree without `manual/spec` falls back to. */
export const PROVISIONAL_SPEC_DIR = "tools/eval/fixtures/alarms-provisional";

/** The three documents a registry is built from, in the order the digest folds them. */
export const SPEC_FILES = ["alarms.yaml", "settings.yaml", "signals.yaml"] as const;

/** Set to `off` to stamp every sample with an empty alarm list. */
export const ALARMS_ENV = "EVAL_ALARMS";

/** The trigger-state guard; `running` is the union of loaded and unloaded. */
export const TRIGGER_STATES = ["any", "loaded", "unloaded", "off", "running"] as const;
export type TriggerState = (typeof TRIGGER_STATES)[number];

/** The comparisons a leaf may carry. The manual's own grammar uses `gt`, `lt` and `eq`. */
export const LEAF_OPS = ["gt", "lt", "ge", "le", "eq", "ne"] as const;
export type LeafOp = (typeof LEAF_OPS)[number];

/** How a message releases its bit once the condition stops holding. */
export const RESET_MODES = ["auto", "auto_hysteresis", "manual", "manual_service"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** The message types of the manual's `alarms.yaml`. */
export const ALARM_TYPES = ["warning", "shutdown_warning", "shutdown", "service"] as const;
export type AlarmType = (typeof ALARM_TYPES)[number];

/** The six derived quantities `signals.yaml` may declare. */
export const DERIVED_KINDS = [
  "abs_delta",
  "delta",
  "time_in_state",
  "events_per_window",
  "seconds_since_change",
  "time_in_states_total",
] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

/** The trigger kinds; only `signal` is evaluated. */
export const TRIGGER_KINDS = ["signal", "external", "counter"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Which registry a table was loaded from. */
export type AlarmRegistrySource = "manual" | "provisional";

/** How many seconds one duration unit holds; the only conversion the grammar needs. */
const SECONDS_PER: Readonly<Record<string, number>> = { s: 1, min: 60, h: 3600 };

/** The highest bit the `alarm_bits` register can carry. */
export const MAX_ALARM_BIT = 31;

/** The states `running` stands for when `signals.yaml` declares no alias. */
export const DEFAULT_RUNNING_STATES: readonly MachineState[] = ["unloaded", "loaded"];

/** Thrown for anything the grammar does not allow, naming the message and the field. */
export class AlarmRegistryError extends Error {
  constructor(message: string) {
    super(`@fdp/eval: ${message}`);
    this.name = "AlarmRegistryError";
  }
}

/** One comparison: `signal op threshold`, with the threshold in the signal's own unit. */
export interface Leaf {
  /** A `signals.yaml` tag id or a derived quantity id; never a column or a lane. */
  readonly signal: string;
  readonly op: LeafOp;
  /** Resolved from `{value, unit}` or `{setting, offset?}`, converted into `unit`. */
  readonly threshold: number;
  /** The unit `threshold` is expressed in: the signal's, or the derived quantity's. */
  readonly unit: string;
}

/** Every branch holds. */
export interface AllCondition {
  readonly all: readonly Leaf[];
}

/** At least one branch holds. */
export interface AnyCondition {
  readonly any: readonly Leaf[];
}

/** A leaf, or one level of `all` / `any` over leaves. */
export type Condition = Leaf | AllCondition | AnyCondition;

/** True for the `all` shape, which narrows a `Condition` without a cast. */
export function isAllCondition(condition: Condition): condition is AllCondition {
  return Object.hasOwn(condition, "all");
}

/** True for the `any` shape. */
export function isAnyCondition(condition: Condition): condition is AnyCondition {
  return Object.hasOwn(condition, "any");
}

/** The leaves of a condition, whichever shape it carries. */
export function conditionLeaves(condition: Condition): readonly Leaf[] {
  if (isAllCondition(condition)) return condition.all;
  if (isAnyCondition(condition)) return condition.any;
  return [condition];
}

/** How a message releases its bit; `hysteresis` is present for `auto_hysteresis` only. */
export interface ResolvedReset {
  readonly mode: ResetMode;
  /** The reset band, in the unit of the leaf it widens. */
  readonly hysteresis?: number;
}

/** One `evaluation: sim` message with its trigger resolved. */
export interface ResolvedAlarm {
  readonly code: string;
  /** The `alarm_bits` index, 0…31, unique across the registry. */
  readonly bit: number;
  readonly type: AlarmType;
  /** What the panel shows on line 2; carried so a report can name the message. */
  readonly title: string;
  readonly state: TriggerState;
  /** Seconds after an `off` → running transition during which the message is masked. */
  readonly exclude_start_s: number;
  readonly condition: Condition;
  /** How long the condition must hold before the bit is set, in seconds. */
  readonly for_s: number;
  readonly reset: ResolvedReset;
}

/** A message the simulator never evaluates, and why. */
export interface UnevaluableAlarm {
  readonly code: string;
  readonly type: AlarmType;
  readonly kind: TriggerKind;
  /** `sim` or `none`, as `alarms.yaml` declares it. */
  readonly evaluation: string;
  /** One sentence a report can print beside the code. */
  readonly reason: string;
}

/** What the registry needs of one `signals.yaml` entry. */
export interface SignalDeclaration {
  readonly id: string;
  readonly group: "analog" | "digital" | "extra";
  readonly unit: string;
}

/** What the registry needs of one `settings.yaml` entry. */
export interface SettingDeclaration {
  readonly id: string;
  readonly unit: string;
  readonly default: number;
}

/** One entry of the `derived:` block of `signals.yaml`. */
export interface DerivedDeclaration {
  readonly id: string;
  readonly kind: DerivedKind;
  readonly unit: string;
  /** `abs_delta` / `delta`: exactly two analog tags, subtracted in this order. */
  readonly inputs?: readonly string[];
  /** `time_in_state`: the state the timer runs in. */
  readonly state?: MachineState;
  /** `time_in_states_total`: the states the total accumulates in. */
  readonly states?: readonly MachineState[];
  /** `events_per_window`: the event counted; `start_event` is the only one declared. */
  readonly event?: string;
  /** `events_per_window`: the width of the sliding window, in seconds. */
  readonly window_s?: number;
  /** `seconds_since_change`: the digital tag whose changes restart the timer. */
  readonly input?: string;
  /** `seconds_since_change`: the state outside which the timer is held at zero. */
  readonly reset_on_state_exit?: MachineState;
}

/** One loaded document and its own digest. */
export interface RegistryFile {
  readonly name: string;
  readonly sha256: string;
}

/** The manual's registry, resolved; the input of `createAlarmEvaluator`. */
export interface AlarmRegistry {
  /** `manual` for `manual/spec`, `provisional` for the fixture. */
  readonly source: AlarmRegistrySource;
  /** The absolute directory the three documents were read from. */
  readonly specDir: string;
  /** SHA-256 over the three documents; what a report and a golden file record. */
  readonly sha256: string;
  readonly files: readonly RegistryFile[];
  /** Every `evaluation: sim` message, in ascending bit order. */
  readonly alarms: readonly ResolvedAlarm[];
  /** Every message that carries no bit, in file order. */
  readonly unevaluable: readonly UnevaluableAlarm[];
  readonly signals: ReadonlyMap<string, SignalDeclaration>;
  readonly settings: ReadonlyMap<string, SettingDeclaration>;
  readonly derived: ReadonlyMap<string, DerivedDeclaration>;
  /** The states the `running` guard stands for (`machine_states.aliases.running`). */
  readonly runningStates: readonly MachineState[];
}

/** Where `loadAlarmRegistry` reads from; the default is `resolveSpecDir()`. */
export interface LoadAlarmRegistryOptions {
  /** A directory holding `alarms.yaml`, `settings.yaml` and `signals.yaml`. */
  readonly specDir?: string;
}

function fail(where: string, message: string): never {
  throw new AlarmRegistryError(`${where}: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, `expected a mapping, found ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, `expected a list, found ${describe(value)}`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    fail(where, `expected a non-empty string, found ${describe(value)}`);
  }
  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(where, `expected a number, found ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
  fallback?: T,
): T {
  // A key the manual leaves out and a key it writes as `null` mean the same thing.
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  const text = asString(value, where);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(where, `unknown value ${JSON.stringify(text)} (${allowed.join(" | ")})`);
  }
  return text as T;
}

/** Converts a quantity between two units; only the duration units need a factor. */
function convert(value: number, from: string, to: string, where: string): number {
  if (from === to) return value;
  const fromSeconds = SECONDS_PER[from];
  const toSeconds = SECONDS_PER[to];
  if (fromSeconds === undefined || toSeconds === undefined) {
    fail(where, `cannot convert ${from} to ${to}`);
  }
  return (value * fromSeconds) / toSeconds;
}

/** The three documents of one directory, parsed, with their digests. */
interface SpecInput {
  readonly documents: Readonly<Record<string, unknown>>;
  readonly files: readonly RegistryFile[];
  readonly sha256: string;
}

/** True when a directory carries all three documents. */
export function hasSpecDocuments(dir: string): boolean {
  return SPEC_FILES.every((name) => existsSync(join(dir, name)));
}

/**
 * Which registry this checkout evaluates: the manual's when `manual/spec` carries all three
 * documents, the provisional fixture otherwise.
 *
 * It returns `undefined` only when neither directory is there, which is a checkout without
 * `tools/eval/fixtures/` — then the replay stamps empty alarm lists rather than guessing.
 */
export function resolveSpecDir(
  root: string = REPO_ROOT,
): { readonly dir: string; readonly source: AlarmRegistrySource } | undefined {
  const manual = join(root, MANUAL_SPEC_DIR);
  if (hasSpecDocuments(manual)) return { dir: manual, source: "manual" };
  const provisional = join(root, PROVISIONAL_SPEC_DIR);
  if (hasSpecDocuments(provisional)) return { dir: provisional, source: "provisional" };
  return undefined;
}

/**
 * Reads the three documents and folds them into one digest.
 *
 * The digest is over `<name>\n<sha256 of the bytes>\n` per document, in `SPEC_FILES` order,
 * so it is stable across platforms and line endings of the *listing* while still changing
 * with any byte of any document.
 */
function readSpec(dir: string): SpecInput {
  const documents: Record<string, unknown> = {};
  const files: RegistryFile[] = [];
  const digest = createHash("sha256");

  for (const name of SPEC_FILES) {
    const path = join(dir, name);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      fail(path, `cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    digest.update(`${name}\n${sha256}\n`);
    files.push({ name, sha256 });
    try {
      documents[name] = parseYaml(bytes.toString("utf8")) as unknown;
    } catch (error) {
      fail(path, `is not valid YAML (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { documents, files, sha256: digest.digest("hex") };
}

/** The entries of the `signals:` block, by tag id. */
function readSignals(document: unknown, where: string): Map<string, SignalDeclaration> {
  const root = asRecord(document, where);
  const entries = asArray(root["signals"], `${where} signals`);
  const byId = new Map<string, SignalDeclaration>();
  entries.forEach((entry, index) => {
    const signal = asRecord(entry, `${where} signals[${index}]`);
    const id = asString(signal["id"], `${where} signals[${index}].id`);
    const declaration: SignalDeclaration = {
      id,
      group: oneOf(signal["group"], ["analog", "digital", "extra"], `${where} ${id}.group`),
      unit: asString(signal["unit"], `${where} ${id}.unit`),
    };
    if (byId.has(id)) fail(`${where} ${id}`, "is declared twice");
    byId.set(id, declaration);
  });
  return byId;
}

/** The entries of the `settings:` block, by id. */
function readSettings(document: unknown, where: string): Map<string, SettingDeclaration> {
  const root = asRecord(document, where);
  const entries = asArray(root["settings"], `${where} settings`);
  const byId = new Map<string, SettingDeclaration>();
  entries.forEach((entry, index) => {
    const setting = asRecord(entry, `${where} settings[${index}]`);
    const id = asString(setting["id"], `${where} settings[${index}].id`);
    if (byId.has(id)) fail(`${where} ${id}`, "is declared twice");
    byId.set(id, {
      id,
      unit: asString(setting["unit"], `${where} ${id}.unit`),
      default: asNumber(setting["default"], `${where} ${id}.default`),
    });
  });
  return byId;
}

function readMachineState(value: unknown, where: string): MachineState {
  return oneOf(value, ["loaded", "unloaded", "off"], where);
}

/** The entries of the `derived:` block, by id, with the fields each kind needs. */
function readDerived(document: unknown, where: string): Map<string, DerivedDeclaration> {
  const root = asRecord(document, where);
  const raw = root["derived"];
  const byId = new Map<string, DerivedDeclaration>();
  if (raw === undefined || raw === null) return byId;

  asArray(raw, `${where} derived`).forEach((entry, index) => {
    const declared = asRecord(entry, `${where} derived[${index}]`);
    const id = asString(declared["id"], `${where} derived[${index}].id`);
    const at = `${where} derived ${id}`;
    const kind = oneOf(declared["kind"], DERIVED_KINDS, `${at}.kind`);
    const unit = asString(declared["unit"], `${at}.unit`);
    const common = { id, kind, unit };
    if (byId.has(id)) fail(at, "is declared twice");

    switch (kind) {
      case "abs_delta":
      case "delta": {
        const inputs = asArray(declared["inputs"], `${at}.inputs`).map((input, position) =>
          asString(input, `${at}.inputs[${position}]`),
        );
        if (inputs.length !== 2)
          fail(`${at}.inputs`, `needs exactly two tags, found ${inputs.length}`);
        byId.set(id, { ...common, inputs });
        break;
      }
      case "time_in_state":
        byId.set(id, { ...common, state: readMachineState(declared["state"], `${at}.state`) });
        break;
      case "time_in_states_total": {
        const states = asArray(declared["states"], `${at}.states`).map((state, position) =>
          readMachineState(state, `${at}.states[${position}]`),
        );
        if (states.length === 0) fail(`${at}.states`, "names no state");
        byId.set(id, { ...common, states });
        break;
      }
      case "events_per_window":
        byId.set(id, {
          ...common,
          event: asString(declared["event"], `${at}.event`),
          window_s: asNumber(declared["window_s"], `${at}.window_s`),
        });
        break;
      case "seconds_since_change": {
        const exit = declared["reset_on_state_exit"];
        byId.set(id, {
          ...common,
          input: asString(declared["input"], `${at}.input`),
          ...(exit === undefined
            ? {}
            : { reset_on_state_exit: readMachineState(exit, `${at}.reset_on_state_exit`) }),
        });
        break;
      }
    }
  });
  return byId;
}

/** `machine_states.aliases.running`, or the union of loaded and unloaded. */
function readRunningStates(document: unknown, where: string): readonly MachineState[] {
  const root = asRecord(document, where);
  const machineStates = root["machine_states"];
  if (machineStates === undefined || machineStates === null) return DEFAULT_RUNNING_STATES;
  const aliases = asRecord(machineStates, `${where} machine_states`)["aliases"];
  if (aliases === undefined || aliases === null) return DEFAULT_RUNNING_STATES;
  const running = asRecord(aliases, `${where} machine_states.aliases`)["running"];
  if (running === undefined || running === null) return DEFAULT_RUNNING_STATES;
  const states = asArray(running, `${where} machine_states.aliases.running`).map((state, index) =>
    readMachineState(state, `${where} machine_states.aliases.running[${index}]`),
  );
  if (states.length === 0) fail(`${where} machine_states.aliases.running`, "names no state");
  return states;
}

/** Everything a threshold or a delay resolves against. */
interface Registries {
  readonly signals: ReadonlyMap<string, SignalDeclaration>;
  readonly settings: ReadonlyMap<string, SettingDeclaration>;
  readonly derived: ReadonlyMap<string, DerivedDeclaration>;
}

/** A `{value, unit}` or `{setting, offset?}` threshold, resolved into `unit`. */
function resolveThreshold(
  value: unknown,
  unit: string,
  registries: Registries,
  where: string,
): number {
  const threshold = asRecord(value, where);
  const settingId = threshold["setting"];
  if (settingId !== undefined) {
    const id = asString(settingId, `${where}.setting`);
    const setting = registries.settings.get(id);
    if (setting === undefined) fail(where, `settings.yaml declares no ${id}`);
    const offset = threshold["offset"];
    const shift = offset === undefined ? 0 : asNumber(offset, `${where}.offset`);
    return convert(setting.default + shift, setting.unit, unit, where);
  }
  if (threshold["value"] === undefined || threshold["unit"] === undefined) {
    fail(where, "a threshold is {value, unit} or {setting, offset?}");
  }
  return convert(
    asNumber(threshold["value"], `${where}.value`),
    asString(threshold["unit"], `${where}.unit`),
    unit,
    where,
  );
}

/** `for_s` and `exclude_start_s`, resolved into whole seconds. */
function resolveDuration(value: unknown, registries: Registries, where: string): number {
  if (value === undefined || value === null) return 0;
  const seconds =
    typeof value === "number"
      ? asNumber(value, where)
      : resolveThreshold({ setting: asRecord(value, where)["setting"] }, "s", registries, where);
  if (!Number.isInteger(seconds)) fail(where, `${seconds} is not a whole number of seconds`);
  if (seconds < 0) fail(where, `${seconds} is negative`);
  return seconds;
}

/** The unit a leaf's threshold is expressed in: the tag's, or the derived quantity's. */
function unitOf(signal: string, registries: Registries, where: string): string {
  const tag = registries.signals.get(signal);
  if (tag !== undefined) return tag.unit;
  const derived = registries.derived.get(signal);
  if (derived !== undefined) return derived.unit;
  return fail(where, `${signal} is neither a signals.yaml tag nor a derived quantity`);
}

/** One `{signal, op, threshold}` leaf, resolved. */
function resolveLeaf(value: unknown, registries: Registries, where: string): Leaf {
  const leaf = asRecord(value, where);
  const signal = asString(leaf["signal"], `${where}.signal`);
  const op = oneOf(leaf["op"], LEAF_OPS, `${where}.op`);
  const unit = unitOf(signal, registries, `${where}.signal`);
  return {
    signal,
    op,
    threshold: resolveThreshold(leaf["threshold"], unit, registries, `${where}.threshold`),
    unit,
  };
}

/** A leaf, or one level of `all` / `any`. */
function resolveCondition(value: unknown, registries: Registries, where: string): Condition {
  const condition = asRecord(value, where);
  const all = condition["all"];
  const any = condition["any"];
  if (all !== undefined && any !== undefined) {
    fail(where, "a condition is either all or any, not both");
  }
  const branches = all ?? any;
  if (branches !== undefined) {
    const word = all === undefined ? "any" : "all";
    const leaves = asArray(branches, `${where}.${word}`).map((leaf, index) =>
      resolveLeaf(leaf, registries, `${where}.${word}[${index}]`),
    );
    if (leaves.length < 2) {
      fail(`${where}.${word}`, `needs at least two branches, found ${leaves.length}`);
    }
    return word === "all" ? { all: leaves } : { any: leaves };
  }
  return resolveLeaf(condition, registries, where);
}

/** Why one message carries no bit, in the words a report prints. */
function unevaluableReason(kind: TriggerKind, evaluation: string): string {
  if (kind === "external") return "an external input the simulator does not drive";
  if (kind === "counter") return "a maintenance counter, not a signal condition";
  return `evaluation: ${evaluation}`;
}

/** Resolves one `alarms.yaml` entry into a table row, or lists it as unevaluable. */
function resolveAlarm(
  entry: unknown,
  registries: Registries,
  where: string,
): { readonly alarm: ResolvedAlarm } | { readonly unevaluable: UnevaluableAlarm } {
  const record = asRecord(entry, where);
  const code = asString(record["code"], `${where}.code`);
  const at = `alarms.yaml ${code}`;
  const type = oneOf(record["type"], ALARM_TYPES, `${at}.type`);
  const evaluation = asString(record["evaluation"], `${at}.evaluation`);
  const trigger = asRecord(record["trigger"], `${at}.trigger`);
  const kind = oneOf(trigger["kind"], TRIGGER_KINDS, `${at}.trigger.kind`);

  // The manual writes `bit: null` rather than leaving the key out, so both spellings
  // mean "this message carries no bit".
  const declaredBit = record["bit"] ?? undefined;

  if (evaluation !== "sim" || kind !== "signal") {
    if (evaluation === "sim") {
      fail(`${at}.trigger.kind`, `evaluation: sim needs kind: signal, found ${kind}`);
    }
    if (declaredBit !== undefined) {
      fail(`${at}.bit`, "only a message with evaluation: sim carries a bit");
    }
    return {
      unevaluable: { code, type, kind, evaluation, reason: unevaluableReason(kind, evaluation) },
    };
  }

  const bit = asNumber(declaredBit, `${at}.bit`);
  if (!Number.isInteger(bit) || bit < 0 || bit > MAX_ALARM_BIT) {
    fail(`${at}.bit`, `${bit} is not an integer in 0..${MAX_ALARM_BIT}`);
  }

  const condition = resolveCondition(trigger["condition"], registries, `${at}.trigger.condition`);
  const reset = asRecord(record["reset"], `${at}.reset`);
  const mode = oneOf(reset["mode"], RESET_MODES, `${at}.reset.mode`);

  let hysteresis: number | undefined;
  if (mode === "auto_hysteresis") {
    const leaves = conditionLeaves(condition);
    if (leaves.length !== 1) {
      fail(`${at}.reset.mode`, "auto_hysteresis needs a single leaf condition to widen");
    }
    if (reset["hysteresis"] === undefined) {
      fail(`${at}.reset.hysteresis`, "reset.mode auto_hysteresis needs a band");
    }
    hysteresis = resolveThreshold(
      reset["hysteresis"],
      leaves[0]?.unit ?? "",
      registries,
      `${at}.reset.hysteresis`,
    );
  } else if (reset["hysteresis"] !== undefined) {
    fail(`${at}.reset.hysteresis`, `a band belongs to auto_hysteresis, not to ${mode}`);
  }

  return {
    alarm: {
      code,
      bit,
      type,
      title: asString(record["title"], `${at}.title`),
      state: oneOf(trigger["state"], TRIGGER_STATES, `${at}.trigger.state`, "any"),
      exclude_start_s: resolveDuration(
        trigger["exclude_start_s"],
        registries,
        `${at}.trigger.exclude_start_s`,
      ),
      condition,
      for_s: resolveDuration(trigger["for_s"], registries, `${at}.trigger.for_s`),
      reset: hysteresis === undefined ? { mode } : { mode, hysteresis },
    },
  };
}

/** `manual` only for the manual's own directory; every other path is a fixture. */
function sourceOf(specDir: string, root: string): AlarmRegistrySource {
  return resolvePath(specDir) === resolvePath(join(root, MANUAL_SPEC_DIR))
    ? "manual"
    : "provisional";
}

/**
 * Reads `alarms.yaml`, `settings.yaml` and `signals.yaml` and resolves them into one table.
 *
 * @throws AlarmRegistryError for anything the trigger grammar does not allow, naming the
 * message code and the field — a registry that cannot be evaluated is not a registry.
 */
export function loadAlarmRegistry(options: LoadAlarmRegistryOptions = {}): AlarmRegistry {
  const resolved = options.specDir ?? resolveSpecDir()?.dir;
  if (resolved === undefined) {
    throw new AlarmRegistryError(
      `no alarm registry under ${MANUAL_SPEC_DIR} or ${PROVISIONAL_SPEC_DIR} of ${REPO_ROOT}`,
    );
  }
  const specDir = resolvePath(resolved);
  if (!hasSpecDocuments(specDir)) {
    throw new AlarmRegistryError(`${specDir} carries no ${SPEC_FILES.join(", ")}`);
  }

  const input = readSpec(specDir);
  const signals = readSignals(input.documents["signals.yaml"], "signals.yaml");
  const settings = readSettings(input.documents["settings.yaml"], "settings.yaml");
  const derived = readDerived(input.documents["signals.yaml"], "signals.yaml");
  const registries: Registries = { signals, settings, derived };

  const document = asRecord(input.documents["alarms.yaml"], "alarms.yaml");
  const entries = asArray(document["alarms"], "alarms.yaml alarms");

  const alarms: ResolvedAlarm[] = [];
  const unevaluable: UnevaluableAlarm[] = [];
  const byBit = new Map<number, string>();
  const byCode = new Set<string>();

  entries.forEach((entry, index) => {
    const outcome = resolveAlarm(entry, registries, `alarms.yaml alarms[${index}]`);
    if ("unevaluable" in outcome) {
      if (byCode.has(outcome.unevaluable.code)) {
        fail(`alarms.yaml ${outcome.unevaluable.code}`, "is declared twice");
      }
      byCode.add(outcome.unevaluable.code);
      unevaluable.push(outcome.unevaluable);
      return;
    }
    const { alarm } = outcome;
    if (byCode.has(alarm.code)) fail(`alarms.yaml ${alarm.code}`, "is declared twice");
    byCode.add(alarm.code);
    const other = byBit.get(alarm.bit);
    if (other !== undefined) {
      fail(`alarms.yaml ${alarm.code}.bit`, `bit ${alarm.bit} is already taken by ${other}`);
    }
    byBit.set(alarm.bit, alarm.code);
    alarms.push(alarm);
  });

  alarms.sort((left, right) => left.bit - right.bit);

  return {
    source: sourceOf(specDir, REPO_ROOT),
    specDir,
    sha256: input.sha256,
    files: input.files,
    alarms,
    unevaluable,
    signals,
    settings,
    derived,
    runningStates: readRunningStates(input.documents["signals.yaml"], "signals.yaml"),
  };
}

/** The registries loaded so far in this process, keyed by their absolute directory. */
const cache = new Map<string, AlarmRegistry>();

/**
 * The registry this checkout evaluates, loaded once per directory.
 *
 * The three documents are committed and immutable during a run, so a replay that starts
 * 1.5 million samples does not re-parse 60 kB of YAML for every source it builds. It returns
 * `undefined` when no directory carries the documents at all; the caller then stamps empty
 * alarm lists.
 */
export function defaultAlarmRegistry(): AlarmRegistry | undefined {
  const resolved = resolveSpecDir();
  if (resolved === undefined) return undefined;
  const cached = cache.get(resolved.dir);
  if (cached !== undefined) return cached;
  const registry = loadAlarmRegistry({ specDir: resolved.dir });
  cache.set(resolved.dir, registry);
  return registry;
}

/** False when `EVAL_ALARMS` is `off`, which stamps every sample with an empty list. */
export function alarmsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (env[ALARMS_ENV] ?? "").toLowerCase() !== "off";
}
