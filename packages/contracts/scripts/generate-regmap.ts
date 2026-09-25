// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Turns the manual's signal, alarm and setting registries into the three committed register-map
// artefacts (docs/architecture.md#contracts):
//
//   manual/spec/{signals,alarms,settings}.yaml
//     -> packages/contracts/generated/register-map.json        (canonical, meta-schema validated)
//     -> packages/contracts/src/generated/register-map.ts      (typed const + helpers)
//     -> services/modbus/internal/regmap/register_map_gen.go   (the simulator's table)
//
// Run it with `pnpm --filter @fdp/contracts generate` (which runs `generate.ts` first) or with
// `pnpm --filter @fdp/contracts generate:regmap`. `scripts/check-drift.sh` proves the committed
// files still match their sources.
//
// While a worktree has no `manual/spec/signals.yaml`, the generator reads the provisional
// fixture under `test/fixtures/manual-spec/` instead and marks the output `provisional`. The
// fixture reproduces the manual's fixed registry verbatim, so no identifier is renamed when the
// real files land.
//
// Flags: `--out <dir>` writes all three files into one directory (the reproduction test uses
// it), `--spec-dir <dir>` forces the input directory.

import _Ajv2020 from "ajv/dist/2020.js";
import type { AnySchemaObject, ValidateFunction } from "ajv";
import _addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const MANUAL_SPEC_DIR = join(REPO_ROOT, "manual", "spec");
const FIXTURE_SPEC_DIR = join(PACKAGE_ROOT, "test", "fixtures", "manual-spec");
const GO_FILE = join(REPO_ROOT, "services", "modbus", "internal", "regmap", "register_map_gen.go");

/** The three input documents, in the order they are read and hashed. */
const INPUT_NAMES = ["signals", "alarms", "settings"] as const;
type InputName = (typeof INPUT_NAMES)[number];

// --- the constants the YAML does not carry (they mirror the simulator's layout.go) ---------

const MAP_VERSION = { major: 1, minor: 0 } as const;
const RING = { base: 1024, slots: 256, slot_regs: 32 } as const;
const HEADER_REGS = 32;
const SLOT_ANALOG_BASE = 7;
const SLOT_DIGITAL_BASE = 14;
const SLOT_EXTRA = 22;
const SLOT_ALARM_BITS = 23;
const ANALOG_COUNT = 7;
const DIGITAL_COUNT = 8;
const EXTRA_COUNT_MAX = 1;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const ALARM_BIT_COUNT = 32;

const MODBUS = {
  unit_id: 1,
  function_code: 3,
  word_order: "big_endian_high_word_first",
} as const;

const ENCODING = {
  analog: "int16_scaled",
  digital: "uint16_bool",
  u32: "two_registers_high_first",
  u64: "four_registers_high_first",
} as const;

const HEADER_FIELDS = [
  { name: "head_seq", offset: 0, type: "u32" },
  { name: "sim_ts_now", offset: 2, type: "u64", unit: "epoch_ms" },
  {
    name: "replay_state",
    offset: 6,
    type: "u16",
    enum: { "0": "stopped", "1": "playing", "2": "paused" },
  },
  { name: "replay_speed", offset: 7, type: "u16" },
  { name: "ring_slots", offset: 8, type: "u16" },
  { name: "slot_regs", offset: 9, type: "u16" },
  { name: "ring_base", offset: 10, type: "u32" },
  { name: "map_major", offset: 12, type: "u16" },
  { name: "map_minor", offset: 13, type: "u16" },
] as const;

// --- the vocabularies the generator accepts ------------------------------------------------

const GROUPS = ["analog", "digital", "extra"] as const;
const KINDS = ["pressure", "temperature", "current", "switch", "command", "status"] as const;
const UNITS = ["bar", "degC", "A", "bool"] as const;
const MODBUS_TYPES = ["int16", "uint16"] as const;
const OPS = ["gt", "lt", "eq"] as const;

type Group = (typeof GROUPS)[number];

/** Seconds per time unit; the only unit conversion the manual's registries need. */
const SECONDS_PER: Readonly<Record<string, number>> = { s: 1, min: 60, h: 3600 };

// --- the shapes read out of the manual's YAML (only the fields the generator reads) ---------

interface ManualSignal {
  readonly id: string;
  readonly panel_label: string;
  readonly name: string;
  readonly metropt_column: string | null;
  readonly group: string;
  readonly kind: string;
  readonly unit: string;
  readonly subsystem: string;
  readonly range?: { readonly min: number; readonly max: number };
  readonly modbus: { readonly type: string; readonly scale: number };
}

interface ManualDerived {
  readonly id: string;
  readonly kind: string;
  readonly inputs?: readonly string[];
  readonly state?: string;
  readonly unit: string;
}

interface ManualThreshold {
  readonly value?: number;
  readonly unit?: string;
  readonly setting?: string;
  readonly offset?: number;
}

interface ManualLeaf {
  readonly signal: string;
  readonly op: string;
  readonly threshold: ManualThreshold;
}

interface ManualCondition {
  readonly signal?: string;
  readonly op?: string;
  readonly threshold?: ManualThreshold;
  readonly all?: readonly ManualLeaf[];
  readonly any?: readonly ManualLeaf[];
}

type ManualDuration = number | { readonly setting: string };

interface ManualTrigger {
  readonly kind: string;
  readonly state?: string;
  readonly exclude_start_s?: ManualDuration;
  readonly condition?: ManualCondition;
  readonly for_s?: ManualDuration;
}

interface ManualAlarm {
  readonly code: string;
  readonly type: string;
  readonly bit: number | null;
  readonly evaluation: string;
  readonly title: string;
  readonly display: string;
  readonly family?: string;
  readonly rank?: number;
  readonly trigger: ManualTrigger;
  readonly reset: { readonly mode: string; readonly hysteresis?: ManualThreshold };
}

interface ManualSetting {
  readonly id: string;
  readonly unit: string;
  readonly default: number;
}

// --- the shapes written into register-map.json ---------------------------------------------

/** A leaf comparison: the part of a trigger that a composite repeats per branch. */
interface LeafTrigger {
  kind: "threshold" | "digital" | "state_duration" | "differential" | "derived";
  signal: string | null;
  signal_b?: string;
  op: string;
  threshold: number;
  value?: boolean;
  unit: string;
  state?: string;
  duration_s?: number;
  derived: string | null;
  abs: boolean;
  note: string;
}

/** A leaf or a one-level `all`/`any` composite, with the guards the manual puts on the message. */
interface OutputTrigger extends Omit<LeafTrigger, "kind"> {
  kind: LeafTrigger["kind"] | "composite";
  when: string;
  delay_s: number;
  start_mask_s: number;
  hysteresis: number;
  reset_mode: string;
  all?: LeafTrigger[];
  any?: LeafTrigger[];
}

interface OutputSignal {
  readonly tag: string;
  readonly label: string;
  readonly name: string;
  readonly metropt_column: string | null;
  readonly group: Group;
  readonly kind: string;
  readonly unit: string;
  readonly subsystem: string;
  readonly scale: number;
  readonly offset: number;
  readonly range: readonly [number, number];
}

interface OutputAlarm {
  readonly code: string;
  readonly bit: number;
  readonly type: string;
  readonly title: string;
  readonly display: string;
  readonly family: string | null;
  readonly rank: number | null;
  readonly trigger: OutputTrigger;
  readonly trigger_source: unknown;
}

/** Everything the three renderers need, resolved once. */
interface RegisterMap {
  readonly document: Record<string, unknown>;
  readonly signals: readonly OutputSignal[];
  readonly alarms: readonly OutputAlarm[];
  readonly provisional: boolean;
}

// --- input resolution ----------------------------------------------------------------------

function specFiles(dir: string): Record<InputName, string> {
  return {
    signals: join(dir, "signals.yaml"),
    alarms: join(dir, "alarms.yaml"),
    settings: join(dir, "settings.yaml"),
  };
}

/**
 * The manual's directory when it carries all three documents, the provisional fixture otherwise.
 */
export function resolveSpecDir(): { dir: string; provisional: boolean } {
  const files = specFiles(MANUAL_SPEC_DIR);
  if (INPUT_NAMES.every((name) => existsSync(files[name]))) {
    return { dir: MANUAL_SPEC_DIR, provisional: false };
  }
  return { dir: FIXTURE_SPEC_DIR, provisional: true };
}

function fail(message: string): never {
  throw new Error(`register map: ${message}`);
}

/**
 * Rewrites the manual's file-relative `$ref`s to the URN the referenced schema declares.
 *
 * The manual's schemas reference each other as `common.schema.json#/$defs/…` while carrying a
 * `urn:fdp:manual:<name>:v1` `$id`; a relative reference cannot be resolved against an opaque
 * URN, so the two are mapped onto each other here exactly as `manual/tools/load.py` does by
 * registering every schema under both names.
 */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string") {
      const match = /^([a-z0-9-]+)\.schema\.json(#.*)?$/.exec(child);
      out[key] = match ? `urn:fdp:manual:${match[1]}:v1${match[2] ?? ""}` : child;
    } else {
      out[key] = rewriteRefs(child);
    }
  }
  return out;
}

/**
 * The validators for the manual's own schemas, or `null` when the input directory carries none.
 *
 * The manual owns these schemas and the contracts package validates `manual/spec` with them
 * rather than re-declaring them, so Ajv runs without strict mode here: a strict-mode complaint
 * would be about the manual's authoring style, not about the data this generator reads. The
 * provisional fixture holds only the fields the generator reads and therefore ships no schemas
 * of its own.
 */
function loadInputValidators(specDir: string): Record<InputName, ValidateFunction> | null {
  const schemaDir = join(specDir, "schemas");
  const present = INPUT_NAMES.every((name) => existsSync(join(schemaDir, `${name}.schema.json`)));
  if (!present) return null;

  const ajv = new Ajv2020({ strict: false, allErrors: false, allowUnionTypes: true });
  addFormats(ajv);
  // `common.schema.json` is not one of the three inputs but every one of them refers to it.
  for (const name of [...INPUT_NAMES, "common"]) {
    const file = join(schemaDir, `${name}.schema.json`);
    if (!existsSync(file)) continue;
    ajv.addSchema(rewriteRefs(JSON.parse(readFileSync(file, "utf8"))) as AnySchemaObject);
  }

  const validators: Partial<Record<InputName, ValidateFunction>> = {};
  for (const name of INPUT_NAMES) {
    const validate = ajv.getSchema(`urn:fdp:manual:${name}:v1`);
    if (validate === undefined) fail(`${name}.schema.json did not compile`);
    validators[name] = validate;
  }
  return validators as Record<InputName, ValidateFunction>;
}

interface Inputs {
  readonly signals: readonly ManualSignal[];
  readonly derived: readonly ManualDerived[];
  readonly alarms: readonly ManualAlarm[];
  readonly settings: readonly ManualSetting[];
  readonly sources: Record<InputName, { path: string; sha256: string }>;
}

function readInputs(specDir: string): Inputs {
  const files = specFiles(specDir);
  const validators = loadInputValidators(specDir);
  const documents: Partial<Record<InputName, Record<string, unknown>>> = {};
  const sources: Partial<Record<InputName, { path: string; sha256: string }>> = {};

  for (const name of INPUT_NAMES) {
    const file = files[name];
    if (!existsSync(file)) fail(`${relative(REPO_ROOT, file)} does not exist`);
    const raw = readFileSync(file);
    const document = YAML.parse(raw.toString("utf8")) as Record<string, unknown>;
    const validate = validators?.[name];
    if (validate !== undefined && !validate(document)) {
      const first = validate.errors?.[0];
      fail(
        `${relative(REPO_ROOT, file)} does not match ${name}.schema.json` +
          (first ? `: ${first.instancePath} ${first.message ?? ""}`.trimEnd() : ""),
      );
    }
    documents[name] = document;
    sources[name] = {
      path: relative(REPO_ROOT, file).split("\\").join("/"),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  }

  const signalsDoc = documents.signals as Record<string, unknown>;
  return {
    signals: signalsDoc.signals as readonly ManualSignal[],
    derived: (signalsDoc.derived ?? []) as readonly ManualDerived[],
    alarms: (documents.alarms as Record<string, unknown>).alarms as readonly ManualAlarm[],
    settings: (documents.settings as Record<string, unknown>).settings as readonly ManualSetting[],
    sources: sources as Record<InputName, { path: string; sha256: string }>,
  };
}

// --- layout rules ---------------------------------------------------------------------------

function assignOffsets(signals: readonly ManualSignal[]): OutputSignal[] {
  const byId = new Set<string>();
  const byColumn = new Map<string, string>();
  const grouped: Record<Group, ManualSignal[]> = { analog: [], digital: [], extra: [] };

  for (const signal of signals) {
    if (byId.has(signal.id)) fail(`signals.yaml declares ${signal.id} twice`);
    byId.add(signal.id);

    if (!(GROUPS as readonly string[]).includes(signal.group)) {
      fail(`${signal.id}: unknown group ${JSON.stringify(signal.group)} (${GROUPS.join(" | ")})`);
    }
    if (!(KINDS as readonly string[]).includes(signal.kind)) {
      fail(`${signal.id}: unknown kind ${JSON.stringify(signal.kind)} (${KINDS.join(" | ")})`);
    }
    if (!(UNITS as readonly string[]).includes(signal.unit)) {
      fail(`${signal.id}: unknown unit ${JSON.stringify(signal.unit)} (${UNITS.join(" | ")})`);
    }
    if (!(MODBUS_TYPES as readonly string[]).includes(signal.modbus.type)) {
      fail(
        `${signal.id}: unknown modbus.type ${JSON.stringify(signal.modbus.type)} ` +
          `(${MODBUS_TYPES.join(" | ")})`,
      );
    }
    if (signal.metropt_column !== null) {
      const owner = byColumn.get(signal.metropt_column);
      if (owner !== undefined) {
        fail(`${signal.id} and ${owner} both map the CSV column ${signal.metropt_column}`);
      }
      byColumn.set(signal.metropt_column, signal.id);
    }
    grouped[signal.group as Group].push(signal);
  }

  if (grouped.analog.length !== ANALOG_COUNT) {
    fail(
      `exactly ${ANALOG_COUNT} signals must carry group: analog for offsets ` +
        `${SLOT_ANALOG_BASE}…${SLOT_DIGITAL_BASE - 1}, found ${grouped.analog.length}`,
    );
  }
  if (grouped.digital.length !== DIGITAL_COUNT) {
    fail(
      `exactly ${DIGITAL_COUNT} signals must carry group: digital for offsets ` +
        `${SLOT_DIGITAL_BASE}…${SLOT_EXTRA - 1}, found ${grouped.digital.length}`,
    );
  }
  if (grouped.extra.length > EXTRA_COUNT_MAX) {
    fail(
      `at most ${EXTRA_COUNT_MAX} signal may carry group: extra for offset ${SLOT_EXTRA}, ` +
        `found ${grouped.extra.length}`,
    );
  }

  const out: OutputSignal[] = [];
  const push = (signal: ManualSignal, offset: number): void => {
    const scale = signal.modbus.scale;
    if (signal.group === "digital") {
      if (signal.modbus.type !== "uint16" || scale !== 1) {
        fail(`${signal.id}: a digital signal is modbus {type: uint16, scale: 1}`);
      }
    } else {
      if (signal.modbus.type !== "int16") {
        fail(`${signal.id}: an analog signal is modbus {type: int16}`);
      }
      if (signal.range === undefined) fail(`${signal.id}: an analog signal needs a range`);
      if (signal.range.max * scale > INT16_MAX || signal.range.min * scale < INT16_MIN) {
        fail(
          `${signal.id}: range ${signal.range.min}…${signal.range.max} × scale ${scale} ` +
            `leaves the int16 range ${INT16_MIN}…${INT16_MAX}`,
        );
      }
    }
    const range = signal.range ?? { min: 0, max: 1 };
    out.push({
      tag: signal.id,
      label: signal.panel_label,
      name: signal.name,
      metropt_column: signal.metropt_column,
      group: signal.group as Group,
      kind: signal.kind,
      unit: signal.unit,
      subsystem: signal.subsystem,
      scale,
      offset,
      range: [range.min, range.max],
    });
  };

  grouped.analog.forEach((signal, index) => push(signal, SLOT_ANALOG_BASE + index));
  grouped.digital.forEach((signal, index) => push(signal, SLOT_DIGITAL_BASE + index));
  grouped.extra.forEach((signal) => push(signal, SLOT_EXTRA));
  return out;
}

// --- the manual's trigger grammar into the simulator's Trigger -------------------------------

interface Registries {
  readonly signals: ReadonlyMap<string, OutputSignal>;
  readonly derived: ReadonlyMap<string, ManualDerived>;
  readonly settings: ReadonlyMap<string, ManualSetting>;
}

/** Converts a quantity between two units; only the time units need a factor. */
function convert(value: number, from: string, to: string, where: string): number {
  if (from === to) return value;
  const fromSeconds = SECONDS_PER[from];
  const toSeconds = SECONDS_PER[to];
  if (fromSeconds === undefined || toSeconds === undefined) {
    fail(`${where}: cannot convert ${from} to ${to}`);
  }
  return (value * fromSeconds) / toSeconds;
}

/** A `{value, unit}` or `{setting, offset?}` threshold, resolved into `unit`. */
function resolveThreshold(
  threshold: ManualThreshold,
  unit: string,
  registries: Registries,
  where: string,
): number {
  if (threshold.setting !== undefined) {
    const setting = registries.settings.get(threshold.setting);
    if (setting === undefined) fail(`${where}: settings.yaml has no ${threshold.setting}`);
    return convert(setting.default + (threshold.offset ?? 0), setting.unit, unit, where);
  }
  if (threshold.value === undefined || threshold.unit === undefined) {
    fail(`${where}: a threshold is {value, unit} or {setting, offset?}`);
  }
  return convert(threshold.value, threshold.unit, unit, where);
}

/** `for_s` and `exclude_start_s`, resolved into whole seconds. */
function resolveDuration(
  duration: ManualDuration | undefined,
  registries: Registries,
  where: string,
): number {
  if (duration === undefined) return 0;
  const seconds =
    typeof duration === "number"
      ? duration
      : resolveThreshold({ setting: duration.setting }, "s", registries, where);
  if (!Number.isInteger(seconds)) fail(`${where}: ${seconds} is not a whole number of seconds`);
  return seconds;
}

function emptyLeaf(kind: LeafTrigger["kind"]): LeafTrigger {
  return {
    kind,
    signal: null,
    op: "",
    threshold: 0,
    unit: "",
    derived: null,
    abs: false,
    note: "",
  };
}

function translateLeaf(leaf: ManualLeaf, registries: Registries, where: string): LeafTrigger {
  if (!(OPS as readonly string[]).includes(leaf.op)) {
    fail(`${where}: unknown op ${JSON.stringify(leaf.op)} (${OPS.join(" | ")})`);
  }

  const signal = registries.signals.get(leaf.signal);
  if (signal !== undefined) {
    if (signal.group === "digital") {
      if (leaf.op !== "eq") fail(`${where}: a digital tag is compared with op: eq, not ${leaf.op}`);
      const value = resolveThreshold(leaf.threshold, "bool", registries, where);
      // `op` stays empty: `value` carries the comparison for a digital tag. The manual's own
      // `op: eq` is preserved verbatim under `trigger_source`.
      return {
        ...emptyLeaf("digital"),
        signal: signal.tag,
        threshold: value,
        value: value !== 0,
        unit: "bool",
      };
    }
    if (leaf.op === "eq") fail(`${where}: an analog tag is compared with op: gt or lt`);
    return {
      ...emptyLeaf("threshold"),
      signal: signal.tag,
      op: leaf.op,
      threshold: resolveThreshold(leaf.threshold, signal.unit, registries, where),
      unit: signal.unit,
    };
  }

  const derived = registries.derived.get(leaf.signal);
  if (derived === undefined) fail(`${where}: ${leaf.signal} is neither a tag nor a derived signal`);
  if (leaf.op === "eq") fail(`${where}: a derived quantity is compared with op: gt or lt`);
  const threshold = resolveThreshold(leaf.threshold, derived.unit, registries, where);

  switch (derived.kind) {
    case "time_in_state": {
      if (derived.state === undefined) fail(`${where}: ${derived.id} declares no state`);
      const seconds = convert(threshold, derived.unit, "s", where);
      if (!Number.isInteger(seconds)) fail(`${where}: ${seconds} is not a whole number of seconds`);
      return {
        ...emptyLeaf("state_duration"),
        op: leaf.op,
        unit: "s",
        state: derived.state,
        duration_s: seconds,
        derived: derived.id,
      };
    }
    case "abs_delta":
    case "delta": {
      const inputs = derived.inputs ?? [];
      if (inputs.length !== 2) fail(`${where}: ${derived.id} needs exactly two inputs`);
      const [a, b] = inputs as [string, string];
      for (const tag of [a, b]) {
        if (!registries.signals.has(tag))
          fail(`${where}: ${derived.id} references unknown tag ${tag}`);
      }
      return {
        ...emptyLeaf("differential"),
        signal: a,
        signal_b: b,
        op: leaf.op,
        threshold,
        unit: derived.unit,
        derived: derived.id,
        abs: derived.kind === "abs_delta",
      };
    }
    case "events_per_window":
    case "seconds_since_change":
    case "time_in_states_total":
      return {
        ...emptyLeaf("derived"),
        op: leaf.op,
        threshold,
        unit: derived.unit,
        derived: derived.id,
        note: `${derived.kind} quantity ${derived.id}`,
      };
    default:
      return fail(`${where}: unknown derived kind ${JSON.stringify(derived.kind)}`);
  }
}

function translateTrigger(alarm: ManualAlarm, registries: Registries): OutputTrigger {
  const where = `alarm ${alarm.code}`;
  const trigger = alarm.trigger;
  if (trigger.kind !== "signal") {
    fail(`${where}: only trigger.kind: signal is evaluated, found ${JSON.stringify(trigger.kind)}`);
  }
  const condition = trigger.condition;
  if (condition === undefined) fail(`${where}: trigger.condition is missing`);

  const guards = {
    when: trigger.state ?? "any",
    delay_s: resolveDuration(trigger.for_s, registries, `${where} for_s`),
    start_mask_s: resolveDuration(trigger.exclude_start_s, registries, `${where} exclude_start_s`),
    reset_mode: alarm.reset.mode,
  };

  const branches = condition.all ?? condition.any;
  if (branches !== undefined) {
    if (condition.all !== undefined && condition.any !== undefined) {
      fail(`${where}: a condition is either all or any, not both`);
    }
    const word = condition.all !== undefined ? "all" : "any";
    if (branches.length < 2) fail(`${where}: an ${word} condition needs at least two branches`);
    const leaves = branches.map((leaf, index) =>
      translateLeaf(leaf, registries, `${where} ${word}[${index}]`),
    );
    if (alarm.reset.mode === "auto_hysteresis") {
      fail(`${where}: auto_hysteresis needs a single leaf condition to apply the band to`);
    }
    const composite: OutputTrigger = {
      ...emptyLeaf("threshold"),
      ...guards,
      kind: "composite",
      hysteresis: 0,
      note: `${word} of ${branches.length} conditions`,
    };
    return condition.all !== undefined
      ? { ...composite, all: leaves }
      : { ...composite, any: leaves };
  }

  if (condition.signal === undefined || condition.op === undefined) {
    fail(`${where}: a condition is {signal, op, threshold} or a one-level all/any`);
  }
  const leaf = translateLeaf(
    { signal: condition.signal, op: condition.op, threshold: condition.threshold ?? {} },
    registries,
    where,
  );

  let hysteresis = 0;
  if (alarm.reset.mode === "auto_hysteresis") {
    if (alarm.reset.hysteresis === undefined) {
      fail(`${where}: reset.mode auto_hysteresis needs a hysteresis band`);
    }
    hysteresis = resolveThreshold(alarm.reset.hysteresis, leaf.unit, registries, `${where} reset`);
  }

  return { ...leaf, ...guards, hysteresis };
}

/** The manual's structured trigger, verbatim, with every setting reference resolved. */
function resolveTriggerSource(alarm: ManualAlarm, registries: Registries): unknown {
  const where = `alarm ${alarm.code} trigger_source`;
  const resolveRef = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolveRef);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.setting === "string") {
      const setting = registries.settings.get(record.setting);
      if (setting === undefined) fail(`${where}: settings.yaml has no ${record.setting}`);
      const offset = typeof record.offset === "number" ? record.offset : 0;
      return { ...record, unit: setting.unit, value: setting.default + offset };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = resolveRef(child);
    return out;
  };
  return resolveRef(alarm.trigger);
}

// --- the canonical document ------------------------------------------------------------------

function slotFields(signals: readonly OutputSignal[]): Record<string, unknown>[] {
  const fields: Record<string, unknown>[] = [
    { name: "seq", offset: 0, type: "u32" },
    { name: "sim_ts", offset: 2, type: "u64", unit: "epoch_ms" },
    { name: "flags", offset: 6, type: "u16", bits: { discontinuity: 0, missing: 1 } },
  ];
  for (const signal of signals) {
    fields.push(
      signal.group === "digital"
        ? { name: signal.tag, offset: signal.offset, type: "u16", signal: signal.tag }
        : {
            name: signal.tag,
            offset: signal.offset,
            type: "i16",
            scale: signal.scale,
            unit: signal.unit,
            signal: signal.tag,
          },
    );
  }
  fields.push({ name: "alarm_bits", offset: SLOT_ALARM_BITS, type: "u32" });
  return fields;
}

function renderTriggerJson(trigger: OutputTrigger | LeafTrigger, leaf: boolean): unknown {
  const out: Record<string, unknown> = { kind: trigger.kind, signal: trigger.signal };
  if (trigger.signal_b !== undefined) out.signal_b = trigger.signal_b;
  out.op = trigger.op;
  out.threshold = trigger.threshold;
  if (trigger.value !== undefined) out.value = trigger.value;
  out.unit = trigger.unit;
  if (trigger.state !== undefined) out.state = trigger.state;
  if (trigger.duration_s !== undefined) out.duration_s = trigger.duration_s;
  if (!leaf) {
    const full = trigger as OutputTrigger;
    out.when = full.when;
    out.delay_s = full.delay_s;
    out.start_mask_s = full.start_mask_s;
    out.hysteresis = full.hysteresis;
    out.reset_mode = full.reset_mode;
  }
  out.derived = trigger.derived;
  out.abs = trigger.abs;
  out.note = trigger.note;
  if (!leaf) {
    const full = trigger as OutputTrigger;
    if (full.all !== undefined) out.all = full.all.map((child) => renderTriggerJson(child, true));
    if (full.any !== undefined) out.any = full.any.map((child) => renderTriggerJson(child, true));
  }
  return out;
}

function buildRegisterMap(inputs: Inputs, provisional: boolean): RegisterMap {
  const signals = assignOffsets(inputs.signals);
  const registries: Registries = {
    signals: new Map(signals.map((signal) => [signal.tag, signal])),
    derived: new Map(inputs.derived.map((derived) => [derived.id, derived])),
    settings: new Map(inputs.settings.map((setting) => [setting.id, setting])),
  };

  const evaluated: OutputAlarm[] = [];
  const withoutBit: Record<string, unknown>[] = [];
  const bits = new Map<number, string>();
  const codes = new Set<string>();

  for (const alarm of inputs.alarms) {
    if (codes.has(alarm.code)) fail(`alarms.yaml declares ${alarm.code} twice`);
    codes.add(alarm.code);

    const simulated = alarm.evaluation === "sim";
    if (!simulated) {
      if (alarm.bit !== null && alarm.bit !== undefined) {
        fail(`${alarm.code}: only a message with evaluation: sim carries a bit`);
      }
      withoutBit.push({
        code: alarm.code,
        type: alarm.type,
        title: alarm.title,
        evaluation: alarm.evaluation,
      });
      continue;
    }

    const bit = alarm.bit;
    if (bit === null || bit === undefined) fail(`${alarm.code}: evaluation: sim needs a bit`);
    if (!Number.isInteger(bit) || bit < 0 || bit >= ALARM_BIT_COUNT) {
      fail(`${alarm.code}: bit ${bit} is outside 0…${ALARM_BIT_COUNT - 1}`);
    }
    const owner = bits.get(bit);
    if (owner !== undefined) fail(`${alarm.code} and ${owner} both claim bit ${bit}`);
    bits.set(bit, alarm.code);

    evaluated.push({
      code: alarm.code,
      bit,
      type: alarm.type,
      title: alarm.title,
      display: alarm.display,
      family: alarm.family ?? null,
      rank: alarm.rank ?? null,
      trigger: translateTrigger(alarm, registries),
      trigger_source: resolveTriggerSource(alarm, registries),
    });
  }

  evaluated.sort((a, b) => a.bit - b.bit);

  const document: Record<string, unknown> = {
    version: MAP_VERSION,
    source: {
      signals: inputs.sources.signals.path,
      alarms: inputs.sources.alarms.path,
      settings: inputs.sources.settings.path,
      signals_sha256: inputs.sources.signals.sha256,
      alarms_sha256: inputs.sources.alarms.sha256,
      settings_sha256: inputs.sources.settings.sha256,
      provisional,
    },
    modbus: MODBUS,
    encoding: ENCODING,
    header: { base: 0, regs: HEADER_REGS, fields: HEADER_FIELDS },
    ring: RING,
    slot: { fields: slotFields(signals) },
    signals,
    alarms: evaluated.map((alarm) => ({
      code: alarm.code,
      bit: alarm.bit,
      type: alarm.type,
      title: alarm.title,
      display: alarm.display,
      family: alarm.family,
      rank: alarm.rank,
      trigger: renderTriggerJson(alarm.trigger, false),
      trigger_source: alarm.trigger_source,
    })),
    messages_without_bit: withoutBit,
  };

  return { document, signals, alarms: evaluated, provisional };
}

// --- renderers --------------------------------------------------------------------------------

function renderJson(map: RegisterMap): string {
  return `${JSON.stringify(map.document, null, 2)}\n`;
}

// The SPDX tags below belong to the generated files, not to this script, so they are fenced
// off: `reuse lint` would otherwise report this generator as carrying two licences.
// REUSE-IgnoreStart
const TS_BANNER = [
  "// Code generated by `pnpm --filter @fdp/contracts generate`. DO NOT EDIT.",
  "// Sources: manual/spec/signals.yaml, alarms.yaml, settings.yaml.",
  "// SPDX-FileCopyrightText: 2026 Meddle S.r.l.",
  "// SPDX-License-Identifier: Apache-2.0",
].join("\n");

const GO_BANNER = [
  "// Code generated by @fdp/contracts generate from manual/spec/signals.yaml and alarms.yaml. DO NOT EDIT.",
  "// SPDX-FileCopyrightText: 2026 Meddle S.r.l.",
  "// SPDX-License-Identifier: Apache-2.0",
].join("\n");
// REUSE-IgnoreEnd

function renderTypeScript(map: RegisterMap): string {
  const literal = JSON.stringify(map.document, null, 2);
  return `${TS_BANNER}

/** One signal of the register map, in the consumer-friendly view. */
export interface Signal {
  readonly tag: string;
  readonly label: string;
  readonly name: string;
  readonly metropt_column: string | null;
  readonly group: "analog" | "digital" | "extra";
  readonly kind: string;
  readonly unit: string;
  readonly subsystem: string;
  readonly scale: number;
  readonly offset: number;
  readonly range: readonly [number, number];
}

/** One branch of an \`all\`/\`any\` trigger: a comparison without the message's own guards. */
export interface TriggerLeaf {
  readonly kind: "threshold" | "digital" | "state_duration" | "differential" | "derived";
  /** The tag being compared, or \`null\` for a trigger on a derived quantity. */
  readonly signal: string | null;
  /** The second tag of a differential. */
  readonly signal_b?: string;
  /** \`"gt"\` or \`"lt"\`; empty for a digital, whose \`value\` carries the comparison. */
  readonly op: string;
  readonly threshold: number;
  /** A digital trigger is active while its tag equals this. */
  readonly value?: boolean;
  readonly unit: string;
  /** The machine state a \`state_duration\` trigger counts. */
  readonly state?: string;
  readonly duration_s?: number;
  /** The derived signal the condition referenced, or \`null\` for a plain tag. */
  readonly derived: string | null;
  readonly abs: boolean;
  readonly note: string;
}

/** The evaluation rule of one alarm, with the manual's state guard, delay and reset band. */
export interface Trigger extends Omit<TriggerLeaf, "kind"> {
  readonly kind: TriggerLeaf["kind"] | "composite";
  /** The manual's trigger state verbatim: \`any | loaded | unloaded | off | running\`. */
  readonly when: string;
  readonly delay_s: number;
  /** Seconds after a motor start during which the condition is ignored. */
  readonly start_mask_s: number;
  readonly hysteresis: number;
  readonly reset_mode: string;
  readonly all?: readonly TriggerLeaf[];
  readonly any?: readonly TriggerLeaf[];
}

/** One alarm of the register map, in the consumer-friendly view. */
export interface Alarm {
  readonly code: string;
  readonly bit: number;
  readonly type: string;
  readonly title: string;
  readonly display: string;
  readonly family: string | null;
  readonly rank: number | null;
  readonly trigger: Trigger;
}

/** The whole register map, exactly as \`generated/register-map.json\` holds it. */
export const REGISTER_MAP = ${literal} as const;

/** Every signal, in \`signals.yaml\` order: 7 analog, 8 digital, then the synthetic extra. */
export const SIGNALS: readonly Signal[] = REGISTER_MAP.signals;

/** Every alarm the simulator evaluates, ascending bit. */
export const ALARMS: readonly Alarm[] = REGISTER_MAP.alarms;

/** The signal with this tag, or \`undefined\`. */
export function signalById(tag: string): Signal | undefined {
  return SIGNALS.find((signal) => signal.tag === tag);
}

/** The alarm with this code, or \`undefined\`. */
export function alarmByCode(code: string): Alarm | undefined {
  return ALARMS.find((alarm) => alarm.code === code);
}

/** The first register of the ring slot holding sample \`seq\`. */
export function slotAddress(seq: number): number {
  const { base, slots, slot_regs } = REGISTER_MAP.ring;
  return base + (seq % slots) * slot_regs;
}

/** The two's-complement \`int16\` register for an analog value. */
export function encodeAnalog(
  value: number,
  scale: number,
): { readonly register: number; readonly missing: boolean } {
  if (!Number.isFinite(value)) return { register: 0, missing: true };
  const scaled = Math.round(value * scale);
  return { register: Math.min(32767, Math.max(-32768, scaled)), missing: false };
}

/** The analog value behind a raw \`uint16\` register read, honouring the \`int16\` sign. */
export function decodeAnalog(register: number, scale: number): number {
  const unsigned = register & 0xffff;
  const signed = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
  return signed / scale;
}

/** The codes of every alarm whose bit is set in \`bits\`, ascending bit. */
export function alarmCodes(bits: number): string[] {
  const field = bits >>> 0;
  return ALARMS.filter((alarm) => ((field >>> alarm.bit) & 1) === 1).map((alarm) => alarm.code);
}
`;
}

/** A Go literal for a float64; `1000` stays `1000` and `0.5` stays `0.5`. */
function goFloat(value: number): string {
  if (!Number.isFinite(value)) fail(`${value} is not a finite number`);
  return Object.is(value, -0) ? "0" : String(value);
}

function goString(value: string): string {
  return JSON.stringify(value);
}

/** `Key: value` for every field whose value is not the Go zero value, in declaration order. */
function goTriggerFields(trigger: OutputTrigger | LeafTrigger): string[] {
  const parts: string[] = [`Kind: ${goString(trigger.kind)}`];
  if (trigger.signal !== null) parts.push(`Signal: ${goString(trigger.signal)}`);
  if (trigger.signal_b !== undefined) parts.push(`SignalB: ${goString(trigger.signal_b)}`);
  if (trigger.op !== "") parts.push(`Op: ${goString(trigger.op)}`);
  if (trigger.threshold !== 0) parts.push(`Threshold: ${goFloat(trigger.threshold)}`);
  if (trigger.value === true) parts.push("Value: true");
  const full = "when" in trigger ? trigger : undefined;
  if (full !== undefined && full.hysteresis !== 0) {
    parts.push(`Hysteresis: ${goFloat(full.hysteresis)}`);
  }
  if (full !== undefined && full.delay_s !== 0) parts.push(`DelayS: ${full.delay_s}`);
  if (trigger.state !== undefined) parts.push(`State: ${goString(trigger.state)}`);
  if (trigger.duration_s !== undefined) parts.push(`DurationS: ${trigger.duration_s}`);
  if (full !== undefined) parts.push(`When: ${goString(full.when)}`);
  if (full !== undefined && full.start_mask_s !== 0) parts.push(`StartMaskS: ${full.start_mask_s}`);
  if (trigger.abs) parts.push("Abs: true");
  if (trigger.derived !== null) parts.push(`Derived: ${goString(trigger.derived)}`);
  if (full !== undefined) parts.push(`ResetMode: ${goString(full.reset_mode)}`);
  if (trigger.note !== "") parts.push(`Note: ${goString(trigger.note)}`);
  if (full?.all !== undefined) parts.push(`All: ${goLeafSlice(full.all)}`);
  if (full?.any !== undefined) parts.push(`Any: ${goLeafSlice(full.any)}`);
  return parts;
}

function goLeafSlice(leaves: readonly LeafTrigger[]): string {
  return `[]Trigger{${leaves.map((leaf) => `{${goTriggerFields(leaf).join(", ")}}`).join(", ")}}`;
}

function renderGo(map: RegisterMap): string {
  const signals = map.signals
    .map((signal) => {
      const kind = signal.group === "digital" ? "KindDigital" : "KindAnalog";
      // A digital tag carries no engineering unit; the manual's `bool` stays in the JSON.
      const unit = signal.group === "digital" ? "" : signal.unit;
      return (
        `\t{Tag: ${goString(signal.tag)}, Column: ${goString(signal.metropt_column ?? "")}, ` +
        `Kind: ${kind}, Unit: ${goString(unit)}, Scale: ${goFloat(signal.scale)}, ` +
        `Offset: ${signal.offset}},`
      );
    })
    .join("\n");

  const alarms = map.alarms
    .map(
      (alarm) =>
        `\t{Code: ${goString(alarm.code)}, Bit: ${alarm.bit}, Type: ${goString(alarm.type)}, ` +
        `Trigger: Trigger{${goTriggerFields(alarm.trigger).join(", ")}}},`,
    )
    .join("\n");

  return `${GO_BANNER}
//
// Shape: the register map of docs/simulation.md, plus the Trigger fields the
// manual's alarm grammar needs.
// Register addresses are hand-written in layout.go; this file carries no address.

package regmap

// MapMajor changes when a scale changes or a signal is removed; a gateway
// refuses a device whose major differs from its own.
const MapMajor uint16 = ${MAP_VERSION.major}

// MapMinor changes when a signal is added in the slot's reserved area.
const MapMinor uint16 = ${MAP_VERSION.minor}

// Provisional is true while the map was generated from the fallback fixture
// under packages/contracts/test/fixtures/manual-spec rather than from
// manual/spec.
const Provisional bool = ${String(map.provisional)}

// Kind distinguishes the two register encodings of a slot field.
type Kind uint8

// The signal kinds.
const (
	KindAnalog  Kind = 1
	KindDigital Kind = 2
)

// Signal is one slot field. Offset is the register offset inside the slot
// (${SLOT_ANALOG_BASE}..${SLOT_DIGITAL_BASE - 1} analog in signals.yaml order, ${SLOT_DIGITAL_BASE}..${SLOT_EXTRA - 1} digital in signals.yaml order,
// ${SLOT_EXTRA} the ambient extra).
type Signal struct {
	Tag    string  // signals.yaml id; the key of telemetry \`values\`
	Column string  // MetroPT-3 CSV column (verbatim, e.g. "DV_eletric"); "" for synthetic extras
	Kind   Kind    //
	Unit   string  // "bar", "degC", "A"; "" for digitals
	Scale  float64 // register = round(value*Scale) as int16; 1 for digitals
	Offset uint16  //
}

// Signals lists the slot fields in register order: ${ANALOG_COUNT} analog, ${DIGITAL_COUNT} digital, then
// the synthetic extra.
var Signals = []Signal{
${signals}
}

// Trigger is the CTRL-7 evaluation rule of an alarm (docs/simulation.md,
// "Controller alarms"). The fields below the DelayS group extend the plain
// threshold rule: they come from the manual's trigger grammar, and
// internal/ctrl7 implements every Kind.
type Trigger struct {
	Kind       string  // "threshold" | "digital" | "state_duration" | "differential" | "derived" | "composite"
	Signal     string  // tag (threshold, digital, differential A)
	SignalB    string  // tag (differential B)
	Op         string  // "gt" | "lt"
	Threshold  float64 //
	Value      bool    // digital: active when signal == Value
	Hysteresis float64 // reset band for threshold/differential
	DelayS     int     // condition must hold for DelayS seconds of sim time before the bit is set
	State      string  // state_duration: "loaded" | "unloaded" | "off"
	DurationS  int     // state_duration
	When       string  // the manual's trigger state verbatim: "any" | "loaded" | "unloaded" | "off" | "running"
	StartMaskS int     // motor-start mask: the condition is ignored for this many seconds after a start
	Abs        bool    // differential on the absolute difference
	Derived    string  // derived signal id the condition referenced ("" for a plain tag)
	ResetMode  string  // "auto" | "auto_hysteresis" | "manual" | "manual_service"
	Note       string  // free-text provenance from the generator
	All        []Trigger
	Any        []Trigger
}

// Alarm is one CTRL-7 message that the simulator evaluates into alarm_bits.
type Alarm struct {
	Code    string // e.g. "W104"
	Bit     uint8  // 0..31, unique
	Type    string // "warning" | "shutdown_warning" | "shutdown" | "service"
	Trigger Trigger
}

// Alarms lists the evaluated messages in ascending bit order.
var Alarms = []Alarm{
${alarms}
}
`;
}

// --- entry point --------------------------------------------------------------------------------

/** Where one run writes its three files. */
export interface RegisterMapOutputs {
  readonly json: string;
  readonly typescript: string;
  readonly go: string;
}

export interface GenerateOptions {
  /** Write all three files into this directory instead of their committed locations. */
  readonly outDir?: string;
  /** Read the registries from here instead of resolving `manual/spec` or the fixture. */
  readonly specDir?: string;
}

function write(file: string, contents: string): void {
  const normalised = contents.replace(/\r\n/g, "\n");
  writeFileSync(file, normalised.endsWith("\n") ? normalised : `${normalised}\n`);
}

/** Reads the registries, applies the layout rules and writes the three artefacts. */
export function generateRegisterMap(options: GenerateOptions = {}): RegisterMapOutputs {
  const resolved =
    options.specDir === undefined
      ? resolveSpecDir()
      : {
          dir: resolve(options.specDir),
          provisional: resolve(options.specDir) !== MANUAL_SPEC_DIR,
        };
  const map = buildRegisterMap(readInputs(resolved.dir), resolved.provisional);

  const files: RegisterMapOutputs =
    options.outDir === undefined
      ? {
          json: join(PACKAGE_ROOT, "generated", "register-map.json"),
          typescript: join(PACKAGE_ROOT, "src", "generated", "register-map.ts"),
          go: GO_FILE,
        }
      : {
          json: join(options.outDir, "register-map.json"),
          typescript: join(options.outDir, "register-map.ts"),
          go: join(options.outDir, "register_map_gen.go"),
        };

  for (const file of Object.values(files)) {
    mkdirSync(resolve(file, ".."), { recursive: true });
  }
  write(files.json, renderJson(map));
  write(files.typescript, renderTypeScript(map));
  write(files.go, renderGo(map));
  return files;
}

function optionsFromArgv(argv: readonly string[]): GenerateOptions {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined) fail(`${flag} needs a directory`);
    return value;
  };
  const outDir = read("--out");
  const specDir = read("--spec-dir");
  return {
    ...(outDir === undefined ? {} : { outDir }),
    ...(specDir === undefined ? {} : { specDir }),
  };
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const written = generateRegisterMap(optionsFromArgv(process.argv.slice(2)));
  process.stdout.write(
    `@fdp/contracts: wrote ${relative(REPO_ROOT, written.json)}, ` +
      `${relative(REPO_ROOT, written.typescript)} and ${relative(REPO_ROOT, written.go)}\n`,
  );
}
