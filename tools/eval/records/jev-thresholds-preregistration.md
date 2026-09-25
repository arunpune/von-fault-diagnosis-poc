<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Pre-registration: the Jev confidence thresholds

_Edited for publication: its paths were updated, one cost estimate of Jev's was removed because no figure of Jev's is published, internal decision identifiers and process narration were replaced by what they refer to, and the rules backend's confidence is no longer called "calibrated", because it is a margin over candidate supports, not a calibrated probability. The rule is unchanged. The planning documents it once cited are not part of this repository._

Decided on 2026-09-23, **before any Jev decision on the tuning list existed**. This file fixes how the gate
thresholds for Jev will be chosen, so that the choice cannot follow the data it is judged on. It changes nothing by
itself; the choice is made once, by the procedure below, after the prerequisites have landed.

Amended on 2026-09-24, **still before any Jev decision on the tuning list existed**: the persistence
`GATE_PERSIST_SIM_MIN` (N) enters the selection, and `august_oil_level_aug10` is reported apart. The
[amendment](#amendment-2026-09-24-before-any-jev-tuning-data) says what it changes and why. The sections below read as
amended, and the rest of the rule is unchanged.

## Scope

- The thresholds of `apps/backend/src/gate`: `ticket` at or above the ticket threshold, `review` at or above
  the review threshold, otherwise `log`. When this was written, both backends used `GATE_TICKET_MIN_CONFIDENCE` 0.85
  and `GATE_REVIEW_MIN_CONFIDENCE` 0.60.
- **Only Jev** (`JEV_MODEL` `jev-1.13.0`) gets its own thresholds; the README already says thresholds are tuned per Jev
  version. The rules backend keeps 0.60 / 0.85: its confidence is a gating quantity of its own (a margin over candidate
  supports, not a calibrated probability), on a different scale from Jev's reported probability. Making the gate read
  per-backend thresholds ships with the choice.
- **Since the amendment, the persistence before the ticket** (the sim minutes a symptom must persist before an
  episode without a ticket is decided): `GATE_PERSIST_SIM_MIN`, N, then 1, is chosen with Jev's pair, from N ∈ {0, 1}. N is not a per-backend value. The
  chosen N applies to the pipeline as a whole, every backend included. It is chosen on Jev's recordings, because Jev is
  the backend that diagnoses. The rules backend's diagnosis is a recorded baseline that no gate reads (E3 gates its detection only),
  so its figures at the chosen N are reported and never gated.
- The LLM backend is out of scope until it has been measured.

## Prerequisites

1. The changes of 2026-09-23 are in place: the diagnosis given the evidence the manual already uses (quiet hours and
   contrastive criteria), the downstream-leak injection made consistent, with a dev twin on the tuning list, the S304 state word and the
   persistence N, together with the two follow-ups to the leak injection decided on 2026-09-24 (the `guard_entry` ramp
   anchor, and `heavy_air_demand` without its oil offset), because each of them moves Jev's confidences. The follow-ups
   make the dev twin raise suspect events and decisions where it raised none, so a recording made before they landed
   would hold no answer for the twin's new requests. Like the rest of those changes, they were decided after the E3 and
   E4 results had been seen; this sentence was added on 2026-09-24 and changes only this prerequisite.
2. Jev has been recorded on the tuning list **twice**: once with `GATE_PERSIST_SIM_MIN` = 0 and once with
   `GATE_PERSIST_SIM_MIN` = 1. Each is a paid run, made with an explicit go-ahead. Both go into one cassette
   store, keyed by request digest, which keeps every repeated answer of each recording. (Amended on 2026-09-24; it read
   "recorded Jev on the tuning list", once.)

## Data

- **Only the tuning list**, as fixed on 2026-09-24, including the leak injection's dev twin.
- **Reported apart, never counted.** Two scenarios are reported apart. Each is listed on its own in the sweep report,
  and neither counts in the constraint or in the objective:
  - `unlabelled_leak_may19`: its target is inferred, not verified.
  - `august_oil_level_aug10` (amendment): it binds no labelled window, and its time is **not** negative time for the
    sweep.
- **Each N on its own recording.** The triples at N are scored on the replays of the recording made with
  `GATE_PERSIST_SIM_MIN` = N, and on no other. N changes which requests exist, so one N's recording cannot answer the
  other's requests.
- **Never the core-10** or any figure derived from it. Figures seen before this file was written (on the core-10, in
  sample) are not inputs.

## Procedure

`make eval-sweep` re-gates the recorded tuning-list decisions over a grid of **triples** with no new API call:

- N = `GATE_PERSIST_SIM_MIN` ∈ {0, 1}, each replayed from its own recording (amendment);
- review threshold ∈ {0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80};
- ticket threshold ∈ {0.70, 0.75, 0.80, 0.85, 0.90, 0.95};
- only pairs with review < ticket, the same pairs at each N.

For every triple, and every **resample** of its N's recording, the sweep computes the figures below on the tuning list,
the two scenarios reported apart excluded. The cassette store keeps each answer of a repeated request, so the sweep can
replay each alternative answer.

- **false tickets per negative machine-day** (ticket level);
- **false reviews per negative machine-day** (review level);
- **positives passed**: tuning scenarios with a positive target that pass at their expected level within their budget.

If either recording is missing, the sweep chooses nothing and names the missing recording.

## Selection rule

1. **Hard constraint:** at most **0.10 false tickets** and at most **0.50 false reviews** per negative machine-day, on
   **every** resample.
2. **Objective:** among the triples that meet the constraint, the most positives passed on the **median** resample.
3. **Ties:** fewer false reviews, then fewer false tickets, then **N = 1** (amendment), then the pair closest to
   0.60 / 0.85.
4. **Stay unless clearly better:** the incumbent is the triple **(N = 1, 0.60 / 0.85)**. A triple replaces it only if it
   meets the constraint, passes **at least one more positive** than the incumbent on the median resample, and never
   passes fewer on any resample. Otherwise Jev keeps 0.60 / 0.85 and the pipeline keeps N = 1. If the incumbent itself
   breaks the constraint, the qualifying triple with the most positives wins. If no triple qualifies, the thresholds and
   N stay as they are and the finding is recorded.

The stated priority when the two goals collide: **few false alarms first**, then as many faults detected as
possible.

## After the choice

- The chosen pair, the sweep report path and this file's commit are recorded, and Jev-derived figures are not
  published. Since the amendment, the choice is a triple, and its N is recorded with the pair. The record is written
  once, from the sweep's own runs, to `tools/eval/records/jev-thresholds-choice.md`
  (`fdp-eval sweep --preregistered --record-choice`), which is committed and which the held-out set's one run reads:
  that run is refused with any other triple. This sentence was added with the implementation, on 2026-09-24 and before
  any recording, and changes nothing in the rule.
- The fresh held-out set is authored and frozen before it is ever run, and runs **once**, with the chosen
  thresholds already fixed. Its result is the clean E4 figure. Every earlier figure stays labelled in-sample. It was
  decided on 2026-09-24, and the set was authored and sealed the same day, before any run of it
  (`tools/eval/records/heldout-seal.md`). This sentence was added then and changes nothing else in this file.

## Amendment (2026-09-24, before any Jev tuning data)

Two decisions were made on 2026-09-24, **before any Jev decision on the tuning list existed**: no recording of the
tuning list had been made. This amendment was committed on its own, before any recording.

**Decision 1: the persistence N enters the pre-registered selection.** The sweep evaluates triples (N, review, ticket) with N in
{0, 1}. Each N is evaluated on its **own** recording of the tuning list, the recorder run with `GATE_PERSIST_SIM_MIN` =
N. One cassette store, keyed by request digest, holds both recordings. The grid, the hard constraint on every resample
and the objective on the median resample are the same as before. The ties keep their existing clauses. After them, the
decision adds: "prefer N = 1 (the alarm-management default), then the pair closest to 0.60 / 0.85". Written out in
full, clause 3 is:

1. fewer false reviews;
2. then fewer false tickets;
3. then N = 1;
4. then the pair closest to 0.60 / 0.85.

The closeness clause, which already ended the ties, keeps its last place, after the new N clause. The incumbent that a
challenger must clearly beat ("stay unless clearly better") is **(N = 1, 0.60 / 0.85)**. The chosen N applies to the
pipeline as a whole, as `GATE_PERSIST_SIM_MIN`. The rules backend's diagnosis is a recorded baseline and is not gated.

**Decision 2: `august_oil_level_aug10` is reported apart**, like `unlabelled_leak_may19`. It counts neither in the
constraint nor in the objective. Its time is **not** negative time for the sweep, and the sweep report lists it
separately.

**Why.**

- **N.** A rules-backend reading of 2026-09-24 showed that the rules backend reads worse
  at N = 1 than at N = 0 on the merged ten-scenario tuning list. At N = 1, each episode's first decision moves to a
  later frame, and the choices that follow move with it. N changes which requests exist. It must therefore be chosen on
  the recordings of the backend that diagnoses, Jev, under the same pre-registered rule, and not on the rules backend.
  N = 1 was first chosen on the code as it stood before the 2026-09-23 changes to the diagnosis evidence and the leak
  injection.
- **August.** `august_oil_level_aug10` binds no labelled window. Its expectation is "at least one ticket, any fault", and
  its own file says "reported, never gated". Counting its time as negative time would score a correct oil-level
  ticket as a false alarm. On the tuning list's counted negative machine-days, one such ticket-level ticket is above
  the 0.10 limit, so a single correct ticket on 10 August would break clause 1 for its triple on that resample.

**What it changes above.** Scope, prerequisite 2, Data, Procedure, clauses 2 to 4 of the selection rule and the first
item of "After the choice" now read as amended.

**What it does not change.** The data (the tuning list only, never the core-10). The pairs of the grid. The constraint's
values. The objective. The existing tie clauses. Clause 4's "at least one more" and "never fewer". The `GATE_*`
thresholds of the rules and llm backends. The rules backend's confidence. Detection, scenarios, their expectations, labels and injections. The
rest of the rule is unchanged.

**Readings.** The implementation fixes, in its readings, what this file leaves open. One example is how clause 4's
"never fewer on any resample" compares two triples whose N differ, whose resamples come from two different recordings.
Those readings are written, and repeated in every sweep report, before any recording is made.

**Disclosure.** Like every design decision of 2026-09-23 and 2026-09-24, these two were made after the E3 and E4 results
had been seen, and every figure they move stays in-sample. The reading that prompted decision 1 is a rules-backend reading
of the tuning list at N = 0 and N = 1; no Jev decision on the tuning list existed when they were made, and no core-10
figure was used.
