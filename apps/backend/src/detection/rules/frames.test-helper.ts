// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Frames for the rule tests.
 *
 * The detection rules are pure functions of a {@link FeatureFrame},
 * so a positive case is one real frame with one number moved. The frames are
 * replayed from whatever samples the test hands over — the synthetic
 * first-month cycle of `test/fixtures/synthetic`, or a generated fixture —
 * and every override is a value a reader can check against the threshold in
 * the table.
 *
 * The file is named `*.test-helper.ts` rather than `*.test.ts` so Vitest does
 * not collect it as a suite of its own, and it reads no fixture itself so the
 * `no-test-in-prod` boundary keeps holding.
 */

import { SIGNALS, type Sample } from "@fdp/contracts";

import { createFeatureEngine } from "../features.ts";
import { resolveRoles, type SignalRole, type SignalRoles } from "../signals.ts";
import { guardsPassed } from "../state.ts";
import type { FeatureFrame, MachineMode } from "../types.ts";
import type { RuleContext } from "./types.ts";

/** The register map every rule test reads signal ids and units from. */
export const ROLES: SignalRoles = resolveRoles(SIGNALS);

/** Every frame one stream of samples produced. */
export function framesOf(samples: readonly Sample[]): FeatureFrame[] {
  const engine = createFeatureEngine({ roles: ROLES });
  const frames: FeatureFrame[] = [];
  for (const sample of samples) {
    const update = engine.push(sample);
    if (update.frame !== undefined) frames.push(update.frame);
  }
  return frames;
}

/** The last frame of `frames` in `mode` that no guard suppresses. */
export function lastFrameIn(frames: readonly FeatureFrame[], mode: MachineMode): FeatureFrame {
  const found = [...frames]
    .reverse()
    .find((frame) => frame.mode === mode && guardsPassed(frame.guards));
  if (found === undefined) throw new Error(`no unguarded ${mode} frame in this stream`);
  return found;
}

/** The context a rule reads beside the frame, taken from the frame itself. */
export function contextOf(frame: FeatureFrame): RuleContext {
  return {
    rolling: frame.rolling,
    guards: frame.guards,
    activeAlarms: frame.active_alarms,
    nowSimTs: frame.sim_ts,
  };
}

/** The same frame with one signal reading a different value. */
export function withSignal(frame: FeatureFrame, role: SignalRole, value: number): FeatureFrame {
  return {
    ...frame,
    signals: { ...frame.signals, [role]: { ...frame.signals[role], value } },
  };
}

/** The same frame with the load-cycle-rate behaviour sitting in another band. */
export function withCycleRateLevel(
  frame: FeatureFrame,
  level: FeatureFrame["behaviours"]["load_cycle_rate"]["level"],
): FeatureFrame {
  return {
    ...frame,
    behaviours: {
      ...frame.behaviours,
      load_cycle_rate: { ...frame.behaviours.load_cycle_rate, level },
    },
  };
}

/** The same frame moved on by `seconds` of sim time, values unchanged. */
export function laterBy(frame: FeatureFrame, seconds: number): FeatureFrame {
  const simTsMs = frame.sim_ts_ms + seconds * 1000;
  return {
    ...frame,
    sim_ts: new Date(simTsMs).toISOString(),
    sim_ts_ms: simTsMs,
    window: { ...frame.window, to_sim_ts: new Date(simTsMs).toISOString() },
  };
}
