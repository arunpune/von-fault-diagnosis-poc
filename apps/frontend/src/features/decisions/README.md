<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Decisions

`App.tsx` loads the default export of `DecisionSheet.tsx` lazily from this fixed path and drives it from the `#/decisions/<id>` hash route with the props `{ decisionId: string | null; onClose(): void }`: a non-null id opens the sheet, `onClose` clears the route. Keep the default export and those props; everything the sheet imports stays in its own chunk, except `decision-text.ts`, which the alerts feed shares.

- `DecisionSheet.tsx` — the sheet: header (chosen cause, "No matching fault" or "Decision failed"; choice id, severity, gate word, backend and model, sim time) and the sections in their fixed order; "Decision" with the id while loading, when the id is unknown, and with a retry when the load fails.
- `Candidates.tsx` — candidates by probability with fault id, manual reference and evidence-match support, "None of these" last; each row expands into its catalog entry (`useCatalogFault(faultId, open)`).
- `SeverityDetail.tsx`, `DecisionEvidence.tsx`, `DecisionTicket.tsx`, `DecisionCost.tsx`, `DecisionInput.tsx`, `DecisionSection.tsx` — the other sections; the input section renders only when `GET /api/decisions/:id` returned a `state`.
- `decision-text.ts` — the words a decision reads in: gate word (Ticket, Review, Logged, Abstained), chosen title, failure kind, backend label, price line. `signal-moves.ts` puts a catalog cause's expected signal movements into sentences; `use-signal-labels.ts` names signal ids from `GET /api/signals`.

The shapes are the contract's ([`packages/contracts`](../../../../../packages/contracts/README.md)): `Decision.event_id`, `status`, the `support` map and `error.kind`; `Candidate.name` and `benign`; `SuspectEvent.rule_ids` and `evidence[]`; `CatalogEntry.name`, `summary` and `signal_moves[].text`.
