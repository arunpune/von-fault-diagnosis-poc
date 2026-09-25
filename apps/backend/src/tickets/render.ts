// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a technician reads on a ticket.
 *
 * Every sentence on a ticket comes from two places and no third: the catalog
 * entry the decision chose — its name, its summary, its checks, its remedy and
 * the manual section they were extracted from — and the evidence detection
 * already wrote in words on the suspect event. The decision backend
 * contributes numbers (the confidence, the probability mass, the severity) and,
 * for the language-model backend only, an optional short rationale. Nothing on
 * a ticket is free text a model invented about this machine.
 *
 * The evidence is taken from the event rather than rebuilt here. `detection/
 * suspect.ts` already turns `rules_fired[].detail` and the non-normal
 * observations into the `evidence_item` sentences the contract carries, and
 * writing that twice would let the ticket and the event disagree about what
 * was seen.
 */

import type {
  CatalogEntry,
  Decision,
  DecisionBackend,
  EntryCondition,
  EvidenceItem,
  ManualReference,
  SeverityLevel,
  SuspectEvent,
} from "@fdp/contracts";

/**
 * The part of a ticket a decision produces.
 *
 * It is everything the `ticket` contract carries except the identifiers, the
 * lifecycle and the counters, which belong to the ticket itself and not to the
 * decision that last changed it.
 */
export interface RenderedTicket {
  readonly fault_id: string;
  readonly condition_id: string;
  /** `"<cause name> — <condition title>"`, the ticket header. */
  readonly title: string;
  readonly cause: string;
  readonly remedy: string;
  readonly checks: readonly string[];
  readonly manual_ref: ManualReference;
  readonly evidence: readonly EvidenceItem[];
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly severity: SeverityLevel;
  readonly backend: DecisionBackend;
  readonly model: string;
  /** The language-model backend's short justification, when there is one. */
  readonly rationale: string | null;
}

/** The em dash that joins the cause and the condition in a ticket title. */
const TITLE_SEPARATOR = " — ";

/**
 * The condition the ticket is about.
 *
 * A cause explains several symptoms; the one the ticket's episode fired on is
 * the one a technician is looking at, so it wins, then the symptom of the
 * event behind this decision. An entry that lists neither falls back to its
 * first condition, which the contract guarantees exists (`conditions` has
 * `minItems: 1`).
 */
function conditionFor(candidate: CatalogEntry, symptomKeys: readonly string[]): EntryCondition {
  for (const symptomKey of symptomKeys) {
    const listed = candidate.conditions.find((condition) => condition.condition_id === symptomKey);
    if (listed !== undefined) return listed;
  }
  return candidate.conditions[0];
}

/**
 * Render one ticket body from the chosen candidate, the decision and the event.
 *
 * The caller passes the candidate the decision chose; this function does not
 * search the candidate list, because the choice is the decision's and a
 * mismatch here would silently put another cause's remedy on the ticket.
 *
 * `ticketSymptomKey` is the symptom of the episode that owns the ticket. It
 * differs from `event.symptom_key` only when a merged episode's decision
 * updates the ticket of the episode it was merged into, and it keeps the
 * ticket's header on the condition the ticket was opened for.
 *
 * @throws Error when `candidate` is not the cause the decision chose.
 */
export function renderTicket(
  candidate: CatalogEntry,
  decision: Decision,
  event: SuspectEvent,
  ticketSymptomKey: string = event.symptom_key,
): RenderedTicket {
  if (candidate.fault_id !== decision.choice) {
    throw new Error(
      `renderTicket: decision ${decision.decision_id} chose ${decision.choice}, ` +
        `not ${candidate.fault_id}`,
    );
  }

  const condition = conditionFor(candidate, [ticketSymptomKey, event.symptom_key]);
  return {
    fault_id: candidate.fault_id,
    condition_id: condition.condition_id,
    title: `${candidate.name}${TITLE_SEPARATOR}${condition.title}`,
    cause: candidate.summary,
    remedy: candidate.remedy,
    checks: [...candidate.checks],
    manual_ref: candidate.manual_ref,
    evidence: [...event.evidence],
    confidence: decision.confidence,
    probabilities: { ...decision.probabilities },
    severity: decision.severity.level,
    backend: decision.backend,
    model: decision.model,
    rationale: decision.rationale ?? null,
  };
}
