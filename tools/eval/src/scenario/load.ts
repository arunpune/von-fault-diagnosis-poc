// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Reading a scenario file, and the invariants the schema cannot state.
//
// JSON Schema can say that `from` and `to` are instants; it cannot say that
// `from` is the earlier one, that the file stem is the id, or that the `core`
// profile holds exactly the test split. Those rules keep scenarios bound to
// ground truth and the dev/test split honest, and they are checked here so that
// a scenario which passes the schema but contradicts them fails at load time
// with a named code rather than at scoring time with a strange number.
//
// Every failure is a `ScenarioError` carrying the file it came from and one of
// four codes — `schema`, `source`, `injection`, `ground_truth` — so
// `fdp-eval validate` can group them and so a test can assert which rule broke
// without matching prose.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HELDOUT_PROFILE, HELDOUT_SLICE_PREFIX, isHeldout, isHeldoutSlice } from "../heldout.ts";
import { parseIsoMs } from "../time.ts";
import { SCENARIO_SCHEMA_ID, validateScenario } from "./schema.ts";
import type { Profile, Scenario, ScenarioReplay } from "./schema.ts";

/** Where the committed scenarios live. */
export const SCENARIOS_DIR: string = fileURLToPath(new URL("../../scenarios/", import.meta.url));

/** Which rule a scenario broke. */
export type ScenarioErrorCode = "schema" | "source" | "injection" | "ground_truth";

/** A scenario file that cannot be used, with the rule it broke and the file it is in. */
export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly path: string;

  constructor(code: ScenarioErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ScenarioError";
    this.code = code;
    this.path = path;
  }
}

/** A resolved replay range, in the dataset clock. */
export interface ReplayRange {
  readonly from: Date;
  readonly to: Date;
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ScenarioError("schema", path, `cannot be read (${String(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ScenarioError("schema", path, `is not JSON (${String(error)})`);
  }
}

function instant(path: string, what: string, value: string): Date {
  try {
    return parseIsoMs(value);
  } catch {
    throw new ScenarioError("schema", path, `${what} names no instant: ${value}`);
  }
}

/** `from` strictly before `to`, for the base range and for every override. */
function checkRanges(path: string, replay: ScenarioReplay): void {
  const from = instant(path, "replay.from", replay.from);
  const to = instant(path, "replay.to", replay.to);
  if (from.getTime() >= to.getTime()) {
    throw new ScenarioError(
      "schema",
      path,
      `replay.from ${replay.from} is not before ${replay.to}`,
    );
  }
  for (const [profile, override] of Object.entries(replay.overrides ?? {})) {
    const overrideFrom = override.from === undefined ? from : instant(path, profile, override.from);
    const overrideTo = override.to === undefined ? to : instant(path, profile, override.to);
    if (overrideFrom.getTime() >= overrideTo.getTime()) {
      throw new ScenarioError(
        "schema",
        path,
        `the ${profile} override is empty (${overrideFrom.toISOString()} → ${overrideTo.toISOString()})`,
      );
    }
    if (overrideFrom.getTime() < from.getTime() || overrideTo.getTime() > to.getTime()) {
      throw new ScenarioError(
        "schema",
        path,
        `the ${profile} override reaches outside the replay range`,
      );
    }
  }
}

/**
 * The rules of the held-out set (tools/eval/records/heldout-seal.md).
 *
 * A held-out scenario is in the `heldout` profile and no other, so no smoke, core, dev or full
 * run and no `--scenario` under one of them can ever select it; it replays a held-out slice, with
 * no per-profile override, so its sealed range is the range; and no other scenario replays a
 * held-out slice, so no other run touches those days through a scenario file.
 *
 * @returns true when the scenario is held out, and the dev/test split rules below do not apply
 * to it.
 */
function checkHeldout(path: string, scenario: Scenario): boolean {
  const profiles = new Set<Profile>(scenario.profiles);
  const onHeldoutSlice = scenario.source.kind === "slice" && isHeldoutSlice(scenario.source.name);
  if (!isHeldout(scenario)) {
    if (profiles.has(HELDOUT_PROFILE)) {
      throw new ScenarioError(
        "schema",
        path,
        `split is ${scenario.split}, so the profiles must not include heldout`,
      );
    }
    if (onHeldoutSlice) {
      throw new ScenarioError(
        "source",
        path,
        "replays a held-out slice, which only the held-out set may replay",
      );
    }
    return false;
  }
  if (profiles.size !== 1 || !profiles.has(HELDOUT_PROFILE)) {
    throw new ScenarioError(
      "schema",
      path,
      "split is heldout, so the profiles must be exactly [heldout]",
    );
  }
  if (!onHeldoutSlice) {
    throw new ScenarioError(
      "source",
      path,
      `split is heldout, so the scenario replays a slice named ${HELDOUT_SLICE_PREFIX}…`,
    );
  }
  if (scenario.replay.overrides !== undefined) {
    throw new ScenarioError(
      "schema",
      path,
      "split is heldout, so the replay range has no per-profile override",
    );
  }
  return true;
}

/**
 * The rules of the dev/test split that tie the profiles to the split.
 *
 * `core` is the test split and nothing else, `dev` is the dev split and nothing else, and
 * `smoke` is a subset of `core` — which is what makes "the core profile equals the core-10"
 * a mechanical fact rather than a convention a reviewer has to police. The held-out set has
 * rules of its own (`checkHeldout`).
 */
function checkSplit(path: string, scenario: Scenario): void {
  if (checkHeldout(path, scenario)) return;
  const profiles = new Set<Profile>(scenario.profiles);
  const isTest = scenario.split === "test";
  if (profiles.has("core") !== isTest) {
    throw new ScenarioError(
      "schema",
      path,
      isTest
        ? "split is test, so the profiles must include core"
        : "split is dev, so the profiles must not include core",
    );
  }
  if (profiles.has("dev") === isTest) {
    throw new ScenarioError(
      "schema",
      path,
      isTest
        ? "split is test, so the profiles must not include dev"
        : "split is dev, so the profiles must include dev",
    );
  }
  if (profiles.has("smoke") && !profiles.has("core")) {
    throw new ScenarioError("schema", path, "a smoke scenario is part of core");
  }
}

/** `positive` restates `expect.tickets`, and the two may never disagree. */
function checkPositive(path: string, scenario: Scenario): void {
  const expected = scenario.expect.tickets === "at_least_one";
  if (scenario.positive !== expected) {
    throw new ScenarioError(
      "schema",
      path,
      `positive is ${String(scenario.positive)} but expect.tickets is ${scenario.expect.tickets}`,
    );
  }
}

/** The `expect.fault` rules that only make sense with an injection or a failure window. */
function checkExpectAgainstGroundTruth(path: string, scenario: Scenario): void {
  const { kind } = scenario.ground_truth;
  if (scenario.expect.fault === "injected" && kind !== "injection") {
    throw new ScenarioError(
      "ground_truth",
      path,
      "expect.fault is injected but the ground truth is not an injection",
    );
  }
  if (scenario.expect.fault === "accepted" && kind !== "failure" && kind !== "recording") {
    throw new ScenarioError(
      "ground_truth",
      path,
      "expect.fault is accepted but the ground truth names no failure",
    );
  }
  if (kind === "injection" && (scenario.injections ?? []).length === 0) {
    throw new ScenarioError(
      "injection",
      path,
      "the ground truth is an injection but the scenario schedules none",
    );
  }
}

/**
 * A design target is a design aid for the tuning list, never ground truth: only a diagnostic
 * scenario of the dev split — one that is reported and never gated — may carry one, so no
 * core-10 scenario and no scored scenario can ever be judged against it.
 */
function checkDesignTarget(path: string, scenario: Scenario): void {
  if (scenario.design_target === undefined) return;
  if (scenario.group !== "diagnostic" || scenario.split !== "dev") {
    throw new ScenarioError(
      "ground_truth",
      path,
      `design_target is only for a diagnostic scenario of the dev split; this one is ${scenario.group}, split ${scenario.split}`,
    );
  }
}

/**
 * Reads and checks one scenario file.
 *
 * Only the rules that need nothing but the file itself are applied here; resolving the slice,
 * the injection ids and the failure id against the data is `bindScenario`'s work.
 *
 * @throws ScenarioError with the code of the rule that broke.
 */
export function loadScenario(path: string): Scenario {
  const document = readJson(path);
  const result = validateScenario(document);
  if (!result.ok) {
    const listed = result.issues.map((issue) => issue.text).join("; ");
    throw new ScenarioError("schema", path, `does not match ${SCENARIO_SCHEMA_ID}: ${listed}`);
  }

  const scenario = result.value;
  const stem = basename(path).replace(/\.json$/, "");
  if (scenario.id !== stem) {
    throw new ScenarioError(
      "schema",
      path,
      `declares id ${scenario.id} but the file stem is ${stem}`,
    );
  }

  checkRanges(path, scenario.replay);
  checkSplit(path, scenario);
  checkPositive(path, scenario);
  checkExpectAgainstGroundTruth(path, scenario);
  checkDesignTarget(path, scenario);

  for (const injection of scenario.injections ?? []) {
    instant(path, `injections[${injection.injection_id}].at`, injection.at);
  }

  return scenario;
}

/** Every scenario file of `directory`, sorted by id. */
export function loadAll(directory: string = SCENARIOS_DIR): Scenario[] {
  return scenarioFiles(directory)
    .map((path) => loadScenario(path))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Every `*.json` of `directory`, sorted by name, whether or not it loads. */
export function scenarioFiles(directory: string = SCENARIOS_DIR): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));
}

/** True when the scenario is part of `profile`. */
export function inProfile(scenario: Scenario, profile: Profile): boolean {
  return scenario.profiles.includes(profile);
}

/**
 * The replay range a profile uses: the base range with that profile's override applied.
 *
 * A profile the scenario does not belong to is not an error here — the runner filters first
 * — so the base range is returned for it.
 */
export function applyProfile(scenario: Scenario, profile: Profile): ReplayRange {
  const override = scenario.replay.overrides?.[profile];
  return {
    from: parseIsoMs(override?.from ?? scenario.replay.from),
    to: parseIsoMs(override?.to ?? scenario.replay.to),
  };
}
