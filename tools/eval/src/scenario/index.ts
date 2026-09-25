// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The scenario module (docs/evaluation.md, "Scenarios and profiles"): the
// schema, the loader and the ground-truth binding, behind one import.

export {
  SCENARIO_SCHEMA_ID,
  SCENARIO_SCHEMA_PATH,
  GROUPS,
  PROFILES,
  SPLITS,
  validateScenario,
} from "./schema.ts";
export type {
  Group,
  Profile,
  RangeOverride,
  Scenario,
  ScenarioDesignTarget,
  ScenarioExpect,
  ScenarioGroundTruth,
  ScenarioInjection,
  ScenarioReplay,
  ScenarioSource,
  SchemaIssue,
  Split,
} from "./schema.ts";

export {
  SCENARIOS_DIR,
  ScenarioError,
  applyProfile,
  inProfile,
  loadAll,
  loadScenario,
  scenarioFiles,
} from "./load.ts";
export type { ReplayRange, ScenarioErrorCode } from "./load.ts";

export { GAP_TAIL_MIN, bindScenario, failureScoringWindow } from "./bind.ts";
export type {
  BindDeps,
  BoundScenario,
  BoundSource,
  ExcludedWindow,
  ExclusionReason,
  GroundTruthApi,
  InjectionSpec,
  ScoringWindow,
  SliceApi,
} from "./bind.ts";
