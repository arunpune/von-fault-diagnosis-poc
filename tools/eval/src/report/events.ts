// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The per-scenario event log: every pipeline output of one scenario replayed
// against one backend, one JSON object per line.
//
// It is the host's whole record, minus the two things no file may carry: the
// state a decision backend saw and the raw bodies it exchanged with its
// provider. Both sit on a decision event's `output`, because `app.decisions`
// stores them; on disk the state is represented by its `state_digest` and the
// bodies are not represented at all. The output is copied field by field from
// an allow-list rather than by deleting the two members, so a field the backend
// adds later stays out of the log until somebody decides it belongs there.

import { writeFileSync } from "node:fs";

import type { DecisionOutput } from "@fdp/backend/pipeline";

import type { TimedOutput } from "../runner/host.ts";

/** A decision backend's answer as the event log keeps it: no `state`, no `raw`. */
export type LoggedDecisionOutput = Omit<DecisionOutput, "state" | "raw">;

type TimedDecision = Extract<TimedOutput, { readonly type: "decision" }>;

/** A decision event as it is written. */
export type LoggedDecision = Omit<TimedDecision, "output"> & {
  readonly output: LoggedDecisionOutput | null;
};

/** One line of the event log. */
export type LoggedEvent = Exclude<TimedOutput, { readonly type: "decision" }> | LoggedDecision;

/** The file name of one scenario's log for one backend: `<scenario id>.<backend>.jsonl`. */
export function eventLogName(scenarioId: string, backend: string): string {
  return `${scenarioId}.${backend}.jsonl`;
}

/** The members of a backend's answer that may leave the process. */
function keptOutput(output: DecisionOutput): LoggedDecisionOutput {
  return {
    backend: output.backend,
    model: output.model,
    choice: output.choice,
    probabilities: output.probabilities,
    confidence: output.confidence,
    support: output.support,
    severity: output.severity,
    usage: output.usage,
    latency_ms: output.latency_ms,
    ...(output.request_id === undefined ? {} : { request_id: output.request_id }),
    state_digest: output.state_digest,
  };
}

/** One output as the log writes it; everything but a decision's `output` passes unchanged. */
export function loggedEvent(event: TimedOutput): LoggedEvent {
  if (event.type !== "decision") return event;
  return { ...event, output: event.output === null ? null : keptOutput(event.output) };
}

/** The log as text: one JSON object per line, a newline after the last. */
export function renderEventLog(events: readonly TimedOutput[]): string {
  return events.map((event) => `${JSON.stringify(loggedEvent(event))}\n`).join("");
}

/** Writes one scenario's log to `path`, replacing whatever was there. */
export function writeEventLog(path: string, events: readonly TimedOutput[]): void {
  writeFileSync(path, renderEventLog(events), "utf8");
}
