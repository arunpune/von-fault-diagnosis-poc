// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The request bodies the fake backend accepts, checked the way the backend's schemas check them
// (contracts `api-sim-command`, `control-cmd` and `api-ticket-close`), and the `api-error` body
// every refusal carries. A body the schema refuses is a 400 at the route; what the schema accepts
// but the simulator cannot do (an unknown preset, a magnitude out of bounds) is the simulator's
// acknowledgement with an error code instead, which `scenario.ts` decides.

import type { ApiErrorBody, ApiTicketClose, InjectArgs, SimCommandName } from "@/api/types";

/** The `iso_ts` grammar of the contracts: milliseconds and a literal Z. */
export const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const PRESET_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_DURATION_SIM_MIN = 14_400;

export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/** Why the control-cmd schema refuses these arguments, or null when it accepts them. */
export function argumentIssue(cmd: SimCommandName, args: Record<string, unknown>): string | null {
  switch (cmd) {
    case "play":
    case "pause":
    case "clear_injections":
    case "reset":
      return Object.keys(args).length === 0 ? null : `${cmd} takes no arguments`;
    case "set_speed": {
      const { speed } = args;
      const valid =
        hasOnlyKeys(args, ["speed"]) &&
        typeof speed === "number" &&
        Number.isInteger(speed) &&
        speed >= 1 &&
        speed <= 3600;
      return valid ? null : "speed must be an integer from 1 to 3600";
    }
    case "jump": {
      const byPreset = typeof args.preset_id === "string" && PRESET_ID_PATTERN.test(args.preset_id);
      const byInstant = typeof args.sim_ts === "string" && ISO_PATTERN.test(args.sim_ts);
      const single = Object.keys(args).length === 1;
      return single && (byPreset || byInstant)
        ? null
        : "jump takes exactly one of preset_id or sim_ts";
    }
    case "inject":
      return injectIssue(args);
  }
}

function injectIssue(args: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(args, ["injection_id", "params"])) {
    return "inject takes injection_id and params only";
  }
  if (typeof args.injection_id !== "string" || !IDENTIFIER_PATTERN.test(args.injection_id)) {
    return "injection_id must be an identifier";
  }
  if (args.params === undefined) {
    return null;
  }
  if (!isRecord(args.params) || !hasOnlyKeys(args.params, ["magnitude", "duration_sim_min"])) {
    return "params takes magnitude and duration_sim_min only";
  }
  const { magnitude, duration_sim_min: duration } = args.params;
  if (magnitude !== undefined && !(typeof magnitude === "number" && magnitude > 0)) {
    return "magnitude must be a positive number";
  }
  const durationValid =
    duration === undefined ||
    (typeof duration === "number" &&
      Number.isInteger(duration) &&
      duration >= 1 &&
      duration <= MAX_DURATION_SIM_MIN);
  return durationValid
    ? null
    : `duration_sim_min must be an integer from 1 to ${MAX_DURATION_SIM_MIN}`;
}

/** The inject arguments, typed; `argumentIssue` has accepted them already. */
export function injectArgsOf(args: Record<string, unknown>): InjectArgs {
  const params = isRecord(args.params) ? args.params : {};
  const { magnitude, duration_sim_min: duration } = params;
  return {
    injection_id: String(args.injection_id),
    params: {
      ...(typeof magnitude === "number" ? { magnitude } : {}),
      ...(typeof duration === "number" ? { duration_sim_min: duration } : {}),
    },
  };
}

/** The body of `POST /api/tickets/:id/close`, or null when it is not one. */
export function closeBodyOf(body: unknown): ApiTicketClose | null {
  if (!isRecord(body) || !hasOnlyKeys(body, ["verdict", "note", "closed_by"])) {
    return null;
  }
  const { verdict, note, closed_by: closedBy } = body;
  if (verdict !== "correct" && verdict !== "wrong") {
    return null;
  }
  if (
    (note !== undefined && typeof note !== "string") ||
    (closedBy !== undefined && typeof closedBy !== "string")
  ) {
    return null;
  }
  return {
    verdict,
    ...(note === undefined ? {} : { note }),
    ...(closedBy === undefined ? {} : { closed_by: closedBy }),
  };
}
