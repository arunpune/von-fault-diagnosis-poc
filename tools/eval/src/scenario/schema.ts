// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario document: its TypeScript shape and the one compiled validator.
//
// `schemas/scenario.schema.json` is the source of truth; the types
// below are its hand-kept mirror, because @fdp/eval has no schema-to-type
// generator of its own and the contracts generator only covers the contract
// schemas. `test/scenarios.test.ts` and `load.test.ts` keep the two in step by
// validating every committed file through the schema and reading it as the
// type.
//
// Ajv is compiled once, at module load, with the same strictness the contracts
// package uses: an unknown keyword is a typo in the schema and must fail here
// rather than silently accept a scenario nobody checks. `useDefaults` is on, so
// `warmup_min` and `expect.max_false_tickets` are materialised by validation
// and the loader never has to spell the defaults a second time.

import _Ajv2020 from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** The `schema` field every scenario file repeats. */
export const SCENARIO_SCHEMA_ID = "urn:fdp:eval:scenario:v1";

/** Absolute path of the schema document, for error messages and for the report. */
export const SCENARIO_SCHEMA_PATH: string = fileURLToPath(
  new URL("../../schemas/scenario.schema.json", import.meta.url),
);

/**
 * The profiles a scenario can belong to, and the held-out set's own, which only its one final
 * run replays (tools/eval/records/heldout-seal.md).
 */
export const PROFILES = ["smoke", "core", "dev", "full", "heldout"] as const;

export type Profile = (typeof PROFILES)[number];

/**
 * The two halves of the dev/test split, and the held-out set, which neither
 * design nor the core-10 gate ever reads.
 */
export const SPLITS = ["dev", "test", "heldout"] as const;

export type Split = (typeof SPLITS)[number];

/** What kind of case a scenario is. */
export const GROUPS = [
  "recording_positive",
  "injected",
  "negative",
  "abstain",
  "diagnostic",
] as const;

export type Group = (typeof GROUPS)[number];

/** Where the rows come from: a named slice or the whole MetroPT-3 CSV. */
export type ScenarioSource = { readonly kind: "slice"; readonly name: string } | { kind: "csv" };

/** A shorter replay range for one profile; an omitted bound keeps the one of `replay`. */
export interface RangeOverride {
  readonly from?: string;
  readonly to?: string;
}

/** The half-open replay range in the dataset clock, with its per-profile overrides. */
export interface ScenarioReplay {
  readonly from: string;
  readonly to: string;
  readonly overrides?: Partial<Record<Profile, RangeOverride>>;
}

/** One scheduled injection, referring to `injections.json` by id and to nothing else. */
export interface ScenarioInjection {
  readonly injection_id: string;
  readonly at: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** Which ground truth applies, discriminated by `kind`. */
export type ScenarioGroundTruth =
  | { readonly kind: "failure"; readonly failure_id: string }
  | { readonly kind: "recording" }
  | { readonly kind: "injection" }
  | { readonly kind: "negative" }
  | { readonly kind: "abstain"; readonly reason: string }
  | { readonly kind: "diagnostic"; readonly note: string };

/** What passing means. */
export interface ScenarioExpect {
  readonly tickets: "at_least_one" | "none";
  readonly fault: "accepted" | "injected" | "benign_or_none" | "any";
  readonly within_min?: number;
  /** Materialised by validation: the schema default is 0. */
  readonly max_false_tickets: number;
  readonly pass_level: "detection" | "diagnosis";
}

/**
 * A design target: the causes a diagnosis of the scenario's unlabelled episodes is read against
 * in the tuning readout and the threshold sweep. It is not ground truth, and nothing that
 * scores, gates or selects reads it.
 */
export interface ScenarioDesignTarget {
  readonly accepted: readonly string[];
  readonly provenance: string;
}

/** One scenario document, exactly as `schemas/scenario.schema.json` declares it. */
export interface Scenario {
  readonly schema: typeof SCENARIO_SCHEMA_ID;
  readonly id: string;
  readonly title: string;
  readonly group: Group;
  readonly profiles: readonly Profile[];
  readonly split: Split;
  readonly positive: boolean;
  readonly source: ScenarioSource;
  readonly replay: ScenarioReplay;
  readonly injections?: readonly ScenarioInjection[];
  readonly ground_truth: ScenarioGroundTruth;
  readonly expect: ScenarioExpect;
  /** Only on a diagnostic scenario of the dev split; reported, never scored. */
  readonly design_target?: ScenarioDesignTarget;
  readonly native_alarm_codes?: readonly string[];
  /** Materialised by validation: the schema default is 60. */
  readonly warmup_min: number;
  readonly seed: number;
  readonly notes: string;
}

/** One schema failure, flattened the way @fdp/contracts flattens its own. */
export interface SchemaIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
  readonly text: string;
}

function compile(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: true });
  addFormats(ajv);
  const document = JSON.parse(readFileSync(SCENARIO_SCHEMA_PATH, "utf8")) as AnySchemaObject;
  return ajv.compile(document);
}

const validator: ValidateFunction = compile();

function toIssues(errors: readonly ErrorObject[] | null | undefined): SchemaIssue[] {
  if (errors === null || errors === undefined) {
    return [{ path: "", keyword: "unknown", message: "is invalid", text: "/ is invalid" }];
  }
  return errors.map((error) => {
    const message = error.message ?? "is invalid";
    return {
      path: error.instancePath,
      keyword: error.keyword,
      message,
      text: `${error.instancePath === "" ? "/" : error.instancePath} ${message}`,
    };
  });
}

/**
 * Validates one parsed scenario document.
 *
 * Defaults are written into `document` when it is valid, so the caller reads `warmup_min`
 * and `expect.max_false_tickets` without repeating the numbers.
 */
export function validateScenario(
  document: unknown,
): { ok: true; value: Scenario } | { ok: false; issues: SchemaIssue[] } {
  if (validator(document)) return { ok: true, value: document as Scenario };
  return { ok: false, issues: toIssues(validator.errors) };
}
