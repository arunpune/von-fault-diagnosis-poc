// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// From the pipeline's event log to the records the metrics score.
//
// The host keeps every `PipelineOutput`; the scorer wants tickets, decisions
// and the suspect events detection level is scored on. This module is the one
// translation between the two, and it is a pure function of the log: nothing
// here reads a clock, a file or the ground truth, so a stored event log
// summarises to the same records every time.
//
// **A ticket is scored once.** `tickets.episode_id` is unique, and a merged
// episode's decisions update its target's ticket rather than opening one of
// their own, so one ticket id is one scoring unit. Its record takes the fault
// and instant of the message that opened it (precision is attributed to what
// the first decision named), the fault it names now, whether it ever
// reached ticket level, and when it left the live state.
//
// **The level comes from the ticket status.** There is no review queue:
// a `review` gate outcome opens a ticket whose status is `review`, and a later
// decision above the ticket threshold promotes it to `open`. A ticket that was
// ever `open`, or was ever updated by a decision the gate passed as `ticket`,
// is a ticket-level ticket; one that never was stayed at review level.
//
// **A decision is kept whether or not it moved a ticket.** Abstention and cost
// are measured on the decisions, so every answered one becomes a
// `DecisionRecord`; a failed call is counted apart, since it has no choice to
// score. Rules and Jev confidences are different quantities (the rules one is a
// calibrated gating quantity, Jev's a probability): the record carries the
// backend beside the confidence so no report sets the two side by side unnamed.

import type { PipelineOutput, Ticket } from "@fdp/backend/pipeline";

import type { CatalogEntry } from "../catalog/types.ts";
import { NONE_OF_THESE } from "../metrics/types.ts";
import type {
  DecisionRecord,
  GateOutcome,
  Level,
  SuspectRecord,
  TicketRecord,
} from "../metrics/types.ts";

/** How many episodes each episode transition touched. */
export interface EpisodeCounts {
  readonly opened: number;
  readonly merged: number;
  readonly closed: number;
  readonly aborted: number;
}

/** What one scenario run adds up to, before any ground truth is applied. */
export interface ScenarioSummary {
  /** One record per ticket, in the order the tickets were opened. */
  readonly tickets: readonly TicketRecord[];
  /** Every answered decision, in the order it was made. */
  readonly decisions: readonly DecisionRecord[];
  /** Decisions whose call failed; they have no choice to score. */
  readonly failedDecisions: number;
  /**
   * Why they failed: the decision message's `error` as `<kind>: <message>`, counted. Left out by
   * a summary that does not read decision messages (stack mode).
   */
  readonly failureReasons?: Readonly<Record<string, number>>;
  /** Suspect events the pipeline emitted, re-decisions included. */
  readonly suspects: number;
  /**
   * The suspect events themselves, in the order they were emitted: what detection level is
   * scored on. Left out by a summary written before it existed.
   */
  readonly suspectEvents?: readonly SuspectRecord[];
  readonly episodes: EpisodeCounts;
  /** Tickets still `review` or `open` when the replay ended (`open_at_end`). */
  readonly openAtEnd: readonly string[];
}

/** The statuses a ticket is still live in. */
const LIVE_STATUSES: ReadonlySet<Ticket["status"]> = new Set(["review", "open"]);

/**
 * The causes a decision's choice counts as benign for.
 *
 * The catalog's own `benign` flags, plus any the caller adds — typically the scenario's bound
 * `benignFaultIds`, which the ticket side of the abstention metric already reads, so the two
 * sides of one abstain case judge the same causes benign.
 */
export function benignCauses(
  entries: readonly CatalogEntry[],
  alsoBenign: Iterable<string> = [],
): ReadonlySet<string> {
  const causes = new Set(alsoBenign);
  for (const entry of entries) if (entry.benign) causes.add(entry.fault_id);
  return causes;
}

/** What is known about one ticket while its messages are read in order. */
interface TicketTrail {
  readonly first: Ticket;
  latest: Ticket;
  level: Level;
  closedSimTs: string | undefined;
}

function ticketRecord(trail: TicketTrail): TicketRecord {
  return {
    ticketId: trail.first.ticket_id,
    episodeId: trail.first.episode_id,
    openedSimTs: new Date(trail.first.opened_sim_ts),
    faultAtOpen: trail.first.fault_id,
    faultLatest: trail.latest.fault_id,
    maxLevel: trail.level,
    ...(trail.closedSimTs === undefined ? {} : { closedSimTs: new Date(trail.closedSimTs) }),
  };
}

/** The level one ticket message proves: `ticket` once it is open or a `ticket` gate drove it. */
function levelOf(ticket: Ticket, gateByDecision: ReadonlyMap<string, GateOutcome>): Level {
  if (ticket.status === "open") return "ticket";
  return gateByDecision.get(ticket.latest_decision_id) === "ticket" ? "ticket" : "review";
}

/** When a ticket left the live state, or `undefined` while it is still review or open. */
function leftLiveAt(
  ticket: Ticket,
  closure: { readonly sim_ts: string } | null,
): string | undefined {
  if (LIVE_STATUSES.has(ticket.status)) return undefined;
  return ticket.resolved_sim_ts ?? closure?.sim_ts ?? ticket.updated_sim_ts;
}

/**
 * Summarises one scenario's event log into the records `scoreScenario` reads.
 *
 * @param events the outputs in the order the pipeline emitted them (the host's `events`).
 * @param benign the causes a choice counts as benign for; see `benignCauses`.
 */
export function summarise(
  events: readonly PipelineOutput[],
  benign: ReadonlySet<string>,
): ScenarioSummary {
  const trails = new Map<string, TicketTrail>();
  const gateByDecision = new Map<string, GateOutcome>();
  const decisions: DecisionRecord[] = [];
  const episodes = { opened: 0, merged: 0, closed: 0, aborted: 0 };
  let failedDecisions = 0;
  const failureReasons: Record<string, number> = {};
  const suspectEvents: SuspectRecord[] = [];

  for (const output of events) {
    switch (output.type) {
      case "suspect":
        suspectEvents.push({
          eventId: output.event.event_id,
          simTs: new Date(output.event.sim_ts),
          symptomKey: output.event.symptom_key,
        });
        break;
      case "decision": {
        const { decision } = output;
        gateByDecision.set(decision.decision_id, decision.gate.outcome);
        if (decision.status === "failed") {
          failedDecisions += 1;
          const reason =
            decision.error === null
              ? "unknown: no error recorded"
              : `${decision.error.kind}: ${decision.error.message}`;
          failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          break;
        }
        decisions.push({
          decisionId: decision.decision_id,
          episodeId: decision.episode_id,
          simTs: new Date(decision.sim_ts),
          choice: decision.choice,
          confidence: decision.confidence,
          gate: decision.gate.outcome,
          abstained: decision.gate.abstained,
          usage: {
            input_tokens: decision.usage.input_tokens,
            output_tokens: decision.usage.output_tokens,
          },
          backend: decision.backend,
          benignChoice: decision.choice !== NONE_OF_THESE && benign.has(decision.choice),
          ...(output.persistedSimMin === undefined
            ? {}
            : { persistedSimMin: output.persistedSimMin }),
        });
        break;
      }
      case "episode":
        episodes[output.action] += 1;
        break;
      case "ticket": {
        const { ticket } = output;
        const level = levelOf(ticket, gateByDecision);
        const closedSimTs = leftLiveAt(ticket, output.closure);
        const trail = trails.get(ticket.ticket_id);
        if (trail === undefined) {
          trails.set(ticket.ticket_id, { first: ticket, latest: ticket, level, closedSimTs });
          break;
        }
        trail.latest = ticket;
        if (level === "ticket") trail.level = "ticket";
        trail.closedSimTs = closedSimTs;
        break;
      }
      case "alarm":
        break;
    }
  }

  const tickets = [...trails.values()]
    .map(ticketRecord)
    .sort((left, right) => left.openedSimTs.getTime() - right.openedSimTs.getTime());
  const openAtEnd = [...trails.values()]
    .filter((trail) => LIVE_STATUSES.has(trail.latest.status))
    .map((trail) => trail.first.ticket_id);

  return {
    tickets,
    decisions,
    failedDecisions,
    failureReasons,
    suspects: suspectEvents.length,
    suspectEvents,
    episodes,
    openAtEnd,
  };
}
