// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The parameters of one injection, as the "Inject fault" dialog offers them. An instance runs with
// two parameters: its strength, `magnitude`, bounded by the injection's own definition, and its
// length in simulated minutes, `duration_sim_min`, from one minute to ten simulated days. Both
// travel as overrides of the catalog's defaults in
// `{ args: { injection_id, params: { magnitude, duration_sim_min } } }`.

import type { InjectArgs, InjectionDef, ParamDef } from "@/api/types";
import { fmtNumber } from "@/lib/format";
import { fmtDuration } from "@/lib/time";

/** The overrides the inject command accepts; any other name is refused as `bad_args`. */
export type InjectOverrides = NonNullable<InjectArgs["params"]>;

/** The longest instance the simulator runs, in simulated minutes. */
const MAX_DURATION_SIM_MIN = 14_400;

/** Durations worth offering, from half an hour to ten days of simulated time, in minutes. */
const DURATION_STEPS_SIM_MIN = [
  30,
  60,
  120,
  180,
  240,
  300,
  360,
  480,
  600,
  720,
  1_080,
  1_440,
  2_880,
  4_320,
  7_200,
  10_080,
  MAX_DURATION_SIM_MIN,
];

/** Definition parameters the command can override; the duration has a slider of its own. */
const TUNABLE_PARAMS: ReadonlySet<string> = new Set<keyof InjectOverrides>(["magnitude"]);

/** About this many slider positions between a parameter's bounds. */
const PARAM_POSITIONS = 40;
/** Step sizes a slider moves by, times a power of ten. */
const NICE_FACTORS = [1, 2, 2.5, 5, 10];

/** The parameters of a definition that get a slider, in the definition's order. */
export function tunableParams(entry: InjectionDef): ParamDef[] {
  return entry.params.filter((param) => TUNABLE_PARAMS.has(param.name));
}

/**
 * A round step that splits a parameter's range into about forty positions: 0.05 for a magnitude
 * between 0.25 and 2. A range that is empty or inverted gets a step of one.
 */
export function paramStep({ min, max }: ParamDef): number {
  const span = max - min;
  if (!(span > 0)) {
    return 1;
  }
  const raw = span / PARAM_POSITIONS;
  const power = 10 ** Math.floor(Math.log10(raw));
  const factor = NICE_FACTORS.find((candidate) => candidate * power >= raw) ?? 10;
  return factor * power;
}

function decimalsOf(step: number): number {
  const [, fraction = ""] = String(step).split(".");
  return fraction.length;
}

/** A parameter value with as many decimals as its step: "1.00" for a step of 0.05. */
export function fmtParam(value: number, step: number): string {
  return fmtNumber(value, decimalsOf(step));
}

/**
 * The duration slider's positions: the steps plus the injection's own default (an integer from
 * 1 to 14 400 by the catalog's schema), ascending and without repeats.
 */
export function durationSteps(defaultSimMin: number): number[] {
  return [...new Set([...DURATION_STEPS_SIM_MIN, defaultSimMin])].toSorted((a, b) => a - b);
}

/** A length in simulated minutes as the dialog shows it: "10 h", "1 d 12 h". */
export function fmtSimMinutes(minutes: number): string {
  return fmtDuration(minutes * 60, "s");
}

/** The `inject` arguments for a definition, the chosen parameter values and a duration. */
export function injectArgs(
  entry: InjectionDef,
  values: ReadonlyMap<string, number>,
  durationSimMin: number,
): InjectArgs {
  const magnitude = values.get("magnitude");
  const params: InjectOverrides = {
    ...(magnitude === undefined ? {} : { magnitude }),
    duration_sim_min: durationSimMin,
  };
  return { injection_id: entry.injection_id, params };
}
