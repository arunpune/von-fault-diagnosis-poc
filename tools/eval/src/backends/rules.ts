// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The rules baseline of every report.
//
// It is the pipeline's own rules twin, `createRulesBackend` with the rule
// registry's severity hints, so the comparison the README promises is
// Jev against exactly the code that runs without a key. It reaches nothing, so
// its mode is `-` and closing it does nothing.
//
// Its `confidence` is a calibrated gating quantity (docs/decision-backends.md),
// not a probability: a report may set it beside Jev's only with both names on
// the page.

import { createRulesBackend } from "@fdp/backend/pipeline";

import { counted, millisecondsOf, newStats, SIGNAL_LABELS } from "./types.ts";
import type { BackendHandle, HandleDeps } from "./types.ts";

/** Builds the rules handle; the latency it reports comes from the run's fake wall clock. */
export function createRulesHandle(deps: HandleDeps): BackendHandle {
  const stats = newStats();
  const backend = createRulesBackend({ labels: SIGNAL_LABELS, now: millisecondsOf(deps.wall) });
  return {
    name: "rules",
    model: backend.model,
    mode: "-",
    backend: counted(backend, stats),
    stats,
    close: () => Promise.resolve(),
  };
}
