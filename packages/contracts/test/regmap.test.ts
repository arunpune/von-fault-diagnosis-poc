// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The register map. The generated JSON is what the gateway and the backend decode with, the
// generated Go table is what the simulator serves, and the simulator's own
// `register_map_json_test.go` compares its hand-written `layout.go` against the same JSON — so a
// silent change here becomes three services that disagree about what register 12 means.

import type { AnySchemaObject } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { generateRegisterMap } from "../scripts/generate-regmap.ts";
import {
  ALARMS,
  REGISTER_MAP,
  SIGNALS,
  alarmByCode,
  alarmCodes,
  decodeAnalog,
  encodeAnalog,
  signalById,
  slotAddress,
} from "../src/generated/register-map.ts";
import { AJV_OPTIONS } from "../src/generated/validators.ts";
import { contractsDir } from "../src/testing.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

const repoRoot = join(contractsDir, "..", "..");
const committedJson = join(contractsDir, "generated", "register-map.json");
const committedTs = join(contractsDir, "src", "generated", "register-map.ts");
const committedGo = join(
  repoRoot,
  "services",
  "modbus",
  "internal",
  "regmap",
  "register_map_gen.go",
);
const fixtureSpecDir = join(contractsDir, "test", "fixtures", "manual-spec");
const manualSignals = join(repoRoot, "manual", "spec", "signals.yaml");

const temporaryDirs: string[] = [];

function temporaryDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-contracts-regmap-"));
  temporaryDirs.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirs) rmSync(directory, { recursive: true, force: true });
});

/** The committed document, read from disk rather than through the generated module. */
const document = JSON.parse(readFileSync(committedJson, "utf8")) as typeof REGISTER_MAP;

/** The manual's fixed registry in register order. */
const REGISTRY_TAGS = [
  "discharge_pressure",
  "line_pressure",
  "separator_discharge_pressure",
  "dryer_purge_pressure",
  "reservoir_pressure",
  "oil_temperature",
  "motor_current",
  "intake_closed",
  "load_valve",
  "dryer_tower",
  "regulator_contact",
  "low_pressure_switch",
  "purge_switch",
  "oil_level_ok",
  "flow_pulse",
  "ambient_temperature",
] as const;

/** A spec directory holding the provisional fixture, with one file patched. */
function patchedSpecDir(file: string, from: string, to: string): string {
  const directory = temporaryDir();
  cpSync(fixtureSpecDir, directory, { recursive: true });
  const target = join(directory, file);
  const text = readFileSync(target, "utf8");
  expect(text).toContain(from);
  writeFileSync(target, text.replace(from, to));
  return directory;
}

describe("register-map.json", () => {
  it("validates against schemas/meta/register-map.schema.json", () => {
    const ajv = new Ajv2020({ ...AJV_OPTIONS });
    addFormats(ajv);
    const meta = JSON.parse(
      readFileSync(join(contractsDir, "schemas", "meta", "register-map.schema.json"), "utf8"),
    ) as AnySchemaObject;
    const validate = ajv.compile(meta);
    const ok = validate(document);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("keeps the header block, the ring and the fixed slot fields", () => {
    expect(document.version).toEqual({ major: 1, minor: 0 });
    expect(document.header.base).toBe(0);
    expect(document.header.regs).toBe(32);
    expect(document.ring).toEqual({ base: 1024, slots: 256, slot_regs: 32 });
    expect(document.modbus).toEqual({
      unit_id: 1,
      function_code: 3,
      word_order: "big_endian_high_word_first",
    });
    const fixed = Object.fromEntries(document.slot.fields.map((f) => [f.name, f.offset]));
    expect(fixed).toMatchObject({ seq: 0, sim_ts: 2, flags: 6, alarm_bits: 23 });
  });

  it("gives every header and slot field a unique offset inside the 32-register block", () => {
    for (const block of [document.header.fields, document.slot.fields]) {
      const offsets = block.map((field) => field.offset);
      expect(new Set(offsets).size).toBe(offsets.length);
      for (const offset of offsets) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThanOrEqual(31);
      }
    }
  });

  it("lays out 7 analog, 8 digital and 1 extra signal at their fixed offsets", () => {
    const byGroup = (group: string) => SIGNALS.filter((signal) => signal.group === group);
    expect(byGroup("analog")).toHaveLength(7);
    expect(byGroup("digital")).toHaveLength(8);
    expect(byGroup("extra")).toHaveLength(1);

    expect(byGroup("analog").map((s) => s.offset)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(byGroup("digital").map((s) => s.offset)).toEqual([14, 15, 16, 17, 18, 19, 20, 21]);
    expect(byGroup("extra").map((s) => s.offset)).toEqual([22]);
  });

  it("carries the manual's fixed registry in register order with its scales", () => {
    expect(SIGNALS.map((signal) => signal.tag)).toEqual([...REGISTRY_TAGS]);
    expect(signalById("discharge_pressure")).toMatchObject({ metropt_column: "TP2", scale: 1000 });
    expect(signalById("oil_temperature")).toMatchObject({
      metropt_column: "Oil_temperature",
      scale: 100,
    });
    expect(signalById("motor_current")).toMatchObject({ unit: "A", scale: 100 });
    expect(signalById("load_valve")).toMatchObject({ metropt_column: "DV_eletric", scale: 1 });
    expect(signalById("ambient_temperature")).toMatchObject({ metropt_column: null, scale: 100 });
    expect(signalById("no_such_tag")).toBeUndefined();
  });

  it("gives the 27 evaluated messages bits 0…26 and leaves the other 8 without one", () => {
    expect(ALARMS).toHaveLength(27);
    expect(ALARMS.map((alarm) => alarm.bit)).toEqual([...Array(27).keys()]);
    expect(new Set(ALARMS.map((alarm) => alarm.code)).size).toBe(27);
    expect(alarmByCode("W101")?.bit).toBe(0);
    expect(alarmByCode("W117")?.bit).toBe(16);
    expect(alarmByCode("X201")?.bit).toBe(17);
    expect(alarmByCode("S306")?.bit).toBe(26);

    expect(document.messages_without_bit.map((message) => message.code)).toEqual([
      "S307",
      "S308",
      "M401",
      "M402",
      "M403",
      "M404",
      "M405",
      "M406",
    ]);
    for (const message of document.messages_without_bit) expect(message.evaluation).toBe("none");
  });

  it("is generated from manual/spec, so `provisional` is false", () => {
    // The provisional fixture only drives the generator while the manual's files are missing from a
    // worktree. Once they exist the committed output must come from them.
    expect(readFileSync(manualSignals, "utf8").length).toBeGreaterThan(0);
    expect(document.source.provisional).toBe(false);
    expect(document.source.signals).toBe("manual/spec/signals.yaml");
    expect(document.source.signals_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(committedGo, "utf8")).toContain("const Provisional bool = false");
  });
});

describe("trigger translation", () => {
  const trigger = (code: string) => {
    const alarm = alarmByCode(code);
    expect(alarm, `alarms[] has no ${code}`).toBeDefined();
    return alarm!.trigger;
  };

  it("every message with `evaluation: sim` gets a real trigger", () => {
    for (const alarm of ALARMS) {
      expect(alarm.trigger.kind, alarm.code).not.toBe("unsupported");
      expect(alarm.trigger.kind, alarm.code).toBeTruthy();
      expect(alarm.trigger.when, alarm.code).toBeTruthy();
    }
    expect(new Set(ALARMS.map((alarm) => alarm.trigger.kind))).toEqual(
      new Set(["threshold", "digital", "state_duration", "differential", "derived", "composite"]),
    );
  });

  it("W104 is a threshold on oil_temperature resolved from settings.yaml", () => {
    expect(trigger("W104")).toMatchObject({
      kind: "threshold",
      signal: "oil_temperature",
      op: "gt",
      threshold: 75,
      unit: "degC",
      when: "running",
      delay_s: 300,
      hysteresis: 5,
      reset_mode: "auto_hysteresis",
    });
  });

  it("W101 is a digital trigger on low_pressure_switch", () => {
    expect(trigger("W101")).toMatchObject({
      kind: "digital",
      signal: "low_pressure_switch",
      value: true,
      unit: "bool",
      when: "any",
      delay_s: 10,
    });
  });

  it("W102 is a state_duration whose minutes became seconds", () => {
    expect(trigger("W102")).toMatchObject({
      kind: "state_duration",
      state: "loaded",
      duration_s: 600,
      derived: "continuous_load_time",
      when: "loaded",
    });
  });

  it("W113 is an absolute differential between the reservoir and the line", () => {
    expect(trigger("W113")).toMatchObject({
      kind: "differential",
      signal: "reservoir_pressure",
      signal_b: "line_pressure",
      op: "gt",
      threshold: 0.5,
      abs: true,
      derived: "reservoir_line_delta",
    });
    expect(trigger("W117")).toMatchObject({
      kind: "differential",
      signal: "discharge_pressure",
      signal_b: "line_pressure",
      abs: false,
      derived: "discharge_line_delta",
    });
  });

  it("W108 and W111 are derived quantities, never `unsupported`", () => {
    expect(trigger("W108")).toMatchObject({
      kind: "derived",
      derived: "motor_starts_per_hour",
      op: "gt",
      threshold: 6,
      unit: "per_hour",
      note: "events_per_window quantity motor_starts_per_hour",
    });
    expect(trigger("W111")).toMatchObject({
      kind: "derived",
      derived: "seconds_since_tower_change",
      threshold: 180,
      unit: "s",
    });
  });

  it("S304 is an `all` composite and S305/S306 are `any` composites", () => {
    const start = trigger("S304");
    expect(start.kind).toBe("composite");
    expect(start.note).toContain("all");
    expect(start.all).toHaveLength(2);
    expect(start.all?.[0]).toMatchObject({ kind: "digital", signal: "load_valve", value: true });
    expect(start.all?.[1]).toMatchObject({ kind: "threshold", signal: "motor_current", op: "lt" });
    expect(start.any).toBeUndefined();

    for (const code of ["S305", "S306"]) {
      const sensor = trigger(code);
      expect(sensor.kind, code).toBe("composite");
      expect(sensor.note, code).toContain("any");
      expect(sensor.any, code).toHaveLength(2);
    }
  });

  it("W106, W107, X203 and S303 carry the motor start mask", () => {
    for (const code of ["W106", "W107", "X203", "S303"]) {
      expect(trigger(code).start_mask_s, code).toBeGreaterThan(0);
    }
    expect(trigger("W104").start_mask_s).toBe(0);
  });

  it("X204 resolves a setting with an offset", () => {
    // cut_out_pressure default 10.0 bar + 0.5 bar offset.
    expect(trigger("X204")).toMatchObject({ signal: "line_pressure", op: "gt", threshold: 10.5 });
  });

  it("keeps the manual's structured trigger beside the translation", () => {
    const w104 = document.alarms.find((alarm) => alarm.code === "W104");
    expect(w104?.trigger_source).toMatchObject({
      kind: "signal",
      state: "running",
      condition: {
        signal: "oil_temperature",
        op: "gt",
        threshold: { setting: "oil_temperature_warning", unit: "degC", value: 75 },
      },
    });
  });
});

describe("the generated TypeScript module", () => {
  it("exposes the JSON unchanged", () => {
    expect(REGISTER_MAP).toEqual(document);
    expect(SIGNALS).toEqual(document.signals);
    expect(ALARMS).toEqual(document.alarms);
  });

  it("addresses ring slots with base + (seq mod slots) × slot_regs", () => {
    expect(slotAddress(0)).toBe(1024);
    expect(slotAddress(1)).toBe(1056);
    expect(slotAddress(255)).toBe(1024 + 255 * 32);
    expect(slotAddress(256)).toBe(1024);
    expect(slotAddress(1_000_003)).toBe(1024 + (1_000_003 % 256) * 32);
  });

  it("round trips analog values through the int16 encoding", () => {
    const cases: readonly (readonly [number, number, number])[] = [
      [9.358, 1000, 9358],
      [-0.012, 1000, -12],
      [89.05, 100, 8905],
      [6.0, 100, 600],
    ];
    for (const [value, scale, register] of cases) {
      expect(encodeAnalog(value, scale)).toEqual({ register, missing: false });
      expect(decodeAnalog(register, scale)).toBeCloseTo(value, 10);
      // The same register read back off the wire as an unsigned word.
      expect(decodeAnalog(register & 0xffff, scale)).toBeCloseTo(value, 10);
    }
    expect(-12 & 0xffff).toBe(65524);
    expect(decodeAnalog(65524, 1000)).toBeCloseTo(-0.012, 10);
  });

  it("reports an unparsable value as missing and clamps the int16 range", () => {
    expect(encodeAnalog(Number.NaN, 1000)).toEqual({ register: 0, missing: true });
    expect(encodeAnalog(Number.POSITIVE_INFINITY, 100)).toEqual({ register: 0, missing: true });
    expect(encodeAnalog(1000, 1000)).toEqual({ register: 32767, missing: false });
    expect(encodeAnalog(-1000, 1000)).toEqual({ register: -32768, missing: false });
  });

  it("expands an alarm bit field into codes, ascending bit", () => {
    expect(alarmCodes(0)).toEqual([]);
    expect(alarmCodes((1 << 0) | (1 << 12))).toEqual(["W101", "W113"]);
    expect(alarmCodes(1 << 26)).toEqual(["S306"]);
    // Bits above the highest alarm are ignored: a newer minor map may set one.
    expect(alarmCodes(0xf8000000)).toEqual([]);
    expect(alarmCodes(0xffffffff)).toEqual(ALARMS.map((alarm) => alarm.code));
  });
});

describe("the generator", () => {
  it("reproduces the three committed files byte for byte", () => {
    const out = temporaryDir();
    const written = generateRegisterMap({ outDir: out });
    const pairs: readonly (readonly [string, string])[] = [
      [written.json, committedJson],
      [written.typescript, committedTs],
      [written.go, committedGo],
    ];
    for (const [fresh, committed] of pairs) {
      expect(readFileSync(fresh, "utf8"), committed).toBe(readFileSync(committed, "utf8"));
      expect(readFileSync(fresh).equals(readFileSync(committed))).toBe(true);
    }
  });

  it("is byte-stable across two runs", () => {
    const first = generateRegisterMap({ outDir: temporaryDir() });
    const second = generateRegisterMap({ outDir: temporaryDir() });
    expect(readFileSync(second.json).equals(readFileSync(first.json))).toBe(true);
    expect(readFileSync(second.typescript).equals(readFileSync(first.typescript))).toBe(true);
    expect(readFileSync(second.go).equals(readFileSync(first.go))).toBe(true);
  });

  it("marks output generated from the provisional fixture", () => {
    const out = temporaryDir();
    const written = generateRegisterMap({ outDir: out, specDir: fixtureSpecDir });
    const provisional = JSON.parse(readFileSync(written.json, "utf8")) as typeof REGISTER_MAP;
    expect(provisional.source.provisional).toBe(true);
    expect(provisional.source.signals).toBe(
      "packages/contracts/test/fixtures/manual-spec/signals.yaml",
    );
    expect(readFileSync(written.go, "utf8")).toContain("const Provisional bool = true");
    // The fixture reproduces the manual's fixed registry, so nothing but `source` differs.
    expect(provisional.signals).toEqual(document.signals);
    expect(provisional.alarms).toEqual(document.alarms);
    expect(provisional.messages_without_bit).toEqual(document.messages_without_bit);
  });

  it("names the rule it enforces when the layout is wrong", () => {
    const missingAnalog = patchedSpecDir(
      "signals.yaml",
      "    metropt_column: Motor_current\n    group: analog",
      "    metropt_column: Motor_current\n    group: digital",
    );
    expect(() => generateRegisterMap({ outDir: temporaryDir(), specDir: missingAnalog })).toThrow(
      /exactly 7 signals must carry group: analog/,
    );

    const duplicateBit = patchedSpecDir(
      "alarms.yaml",
      "  - code: W102\n    type: warning\n    bit: 1",
      "  - code: W102\n    type: warning\n    bit: 0",
    );
    expect(() => generateRegisterMap({ outDir: temporaryDir(), specDir: duplicateBit })).toThrow(
      /W102 and W101 both claim bit 0/,
    );

    const overflow = patchedSpecDir(
      "signals.yaml",
      "    range:\n      min: -1\n      max: 16\n    modbus:\n      type: int16\n      scale: 1000",
      "    range:\n      min: -1\n      max: 16\n    modbus:\n      type: int16\n      scale: 100000",
    );
    expect(() => generateRegisterMap({ outDir: temporaryDir(), specDir: overflow })).toThrow(
      /leaves the int16 range/,
    );

    const unknownUnit = patchedSpecDir("signals.yaml", "    unit: bar\n", "    unit: psi\n");
    expect(() => generateRegisterMap({ outDir: temporaryDir(), specDir: unknownUnit })).toThrow(
      /unknown unit "psi"/,
    );

    const strayBit = patchedSpecDir(
      "alarms.yaml",
      "  - code: S307\n    type: shutdown\n    bit: null",
      "  - code: S307\n    type: shutdown\n    bit: 30",
    );
    expect(() => generateRegisterMap({ outDir: temporaryDir(), specDir: strayBit })).toThrow(
      /only a message with evaluation: sim carries a bit/,
    );
  });
});
