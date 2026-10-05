// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the status bar reads out of the live store, as selectors that return primitives: each
// part of the bar subscribes to the one word or number it shows, so a status that changes
// something else does not re-render it (rerender-derived-state rule).
//
// The lamps read the contract's watchdog flags (`status-backend.heartbeat.telemetry_silent`,
// `decision_api_silent`) as the words ok / silent, and say "unknown" while no backend status is
// known or the link is not open — a status held from before a disconnect is no longer news.

import type { DecisionBackend, SimulatorState, StatusSim } from "@/api/types";
import { humanize } from "@/lib/format";
import { fmtSim } from "@/lib/time";
import type { BackendIdentity, LiveState } from "@/store/live-store";

/** The dot of a lamp: lit, lit in the attention colour, or hollow. */
export type LampVariant = "ok" | "warn" | "off";

/** The link lamp's word: the client's state, or "incompatible" when `hello` was refused. */
export type LinkWord = LiveState["link"] | "incompatible";

export type HeartbeatWord = "ok" | "silent" | "unknown";

/** The decisions lamp adds "no model": the rules backend calls none. */
export type DecisionsWord = HeartbeatWord | "no model";

export const LAMP_VARIANT: Readonly<Record<LinkWord | DecisionsWord, LampVariant>> = {
  open: "ok",
  connecting: "off",
  reconnecting: "warn",
  closed: "off",
  incompatible: "warn",
  ok: "ok",
  silent: "warn",
  unknown: "off",
  "no model": "off",
};

/** How long the link may stay down before the banner under the status bar appears. */
export const RECONNECT_BANNER_DELAY_MS = 5_000;

export function selectLinkWord(live: LiveState): LinkWord {
  return live.link === "open" && live.linkNote !== null ? "incompatible" : live.link;
}

export function selectLinkNote(live: LiveState): string | null {
  return live.linkNote;
}

export function selectDroppedFrames(live: LiveState): number {
  return live.droppedFrames;
}

export function selectReconnecting(live: LiveState): boolean {
  return live.link === "reconnecting";
}

export function selectTelemetryWord(live: LiveState): HeartbeatWord {
  if (live.link !== "open" || live.backend === null) {
    return "unknown";
  }
  return live.backend.heartbeat.telemetry_silent ? "silent" : "ok";
}

export function selectDecisionsWord(live: LiveState): DecisionsWord {
  if (live.link !== "open") {
    return "unknown";
  }
  if (live.decisionBackend?.name === "rules") {
    return "no model";
  }
  if (live.backend === null) {
    return "unknown";
  }
  return live.backend.heartbeat.decision_api_silent ? "silent" : "ok";
}

/** Samples the gateway never read (`status-gateway.dropped_total`); 0 while none is known. */
export function selectDroppedSamples(live: LiveState): number {
  return live.gateway?.dropped_total ?? 0;
}

export function selectSimState(live: LiveState): SimulatorState | null {
  return live.sim?.state ?? null;
}

export function selectSimSpeed(live: LiveState): number | null {
  return live.sim?.speed ?? null;
}

/**
 * Where the replay cursor sits in the dataset, 0 to 1: `sim_ts` between `dataset.first_ts` and
 * `dataset.last_ts` (the status carries no position of its own). Null when the instants are not
 * readable or the dataset spans no time.
 */
export function datasetFraction(sim: StatusSim): number | null {
  const first = Date.parse(sim.dataset.first_ts);
  const last = Date.parse(sim.dataset.last_ts);
  const now = Date.parse(sim.sim_ts);
  if (!Number.isFinite(first) || !Number.isFinite(last) || !Number.isFinite(now) || last <= first) {
    return null;
  }
  return Math.min(Math.max((now - first) / (last - first), 0), 1);
}

/** The dataset position in thousandths: the bar moves, and re-renders, in 0.1 % steps. */
export function selectDatasetPermille(live: LiveState): number | null {
  if (live.sim === null) {
    return null;
  }
  const fraction = datasetFraction(live.sim);
  return fraction === null ? null : Math.round(fraction * 1_000);
}

/** "2020-02-01 00:00:00 → 2020-09-01 03:59:50 UTC", the dataset's extent in sim time. */
export function selectDatasetRange(live: LiveState): string | null {
  if (live.sim === null) {
    return null;
  }
  const { first_ts: first, last_ts: last } = live.sim.dataset;
  return `${fmtSim(first)} → ${fmtSim(last)} UTC`;
}

const BACKEND_NAMES: Readonly<Record<DecisionBackend, string>> = {
  von: "Von",
  llm: "Claude",
  rules: "Rules",
};

/** The chip's words: "Von · von-1.13.0", "Claude · <model>", "Rules" (its rule-set id is noise). */
export function backendLabel(backend: BackendIdentity | null): string {
  if (backend === null) {
    return "No backend yet";
  }
  if (backend.name === "rules") {
    return BACKEND_NAMES.rules;
  }
  const name: string = Object.hasOwn(BACKEND_NAMES, backend.name)
    ? BACKEND_NAMES[backend.name]
    : humanize(backend.name);
  return `${name} · ${backend.model}`;
}
