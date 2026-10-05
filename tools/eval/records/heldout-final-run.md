<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The held-out set's final run

_Edited for publication: its paths were updated, the sentence that stated Von's outcome in words and the run's end time were removed (no figure or outcome of Von's is published), the commit identifier was replaced by a description, and process narration was made neutral._

The sealed held-out set (`tools/eval/records/heldout-seal.md`) was run **once**, on 2026-09-24. From this file's
commit on, the harness refuses every further held-out run. A second run would be a deliberate decision, recorded
here.

| Field | Value |
| --- | --- |
| Command | `EVAL_VON_MODE=live pnpm --filter @fdp/eval run eval -- --profile heldout --final-heldout --backends rules,von --record --confirm-live` |
| Environment | `GATE_PERSIST_SIM_MIN=1`, `VON_GATE_REVIEW_MIN_CONFIDENCE=0.65`, `VON_GATE_TICKET_MIN_CONFIDENCE=0.85` (the committed choice, `tools/eval/records/von-thresholds-choice.md`); rules at 0.60 / 0.85 |
| Exit code | not captured; the run completed, printed its table and wrote its report |
| Run id | `20260924-160021-heldout` |
| Tree | the repository as committed on 2026-09-24 at 15:58 UTC, with the choice record |
| Catalog | `reference`, sha256 `3b3d5d86bdc8e9d2aef8540ce2146289e48141d1a420401462bf77622be57e32` |
| Model | `von-1.13.0`, live, with the answers recorded as cassettes |
| Date | 2026-09-24, started 16:00 UTC |
| Report | `reports/eval/20260924-160021-heldout/report.md` and `run.json` (gitignored) |

## Outcome, in words

The seal sets no pass threshold for this set.

- **Von.** Von's per-scenario table stays in the gitignored report: no figure of Von's is published.
- **Rules (recorded baseline).**
  - Diagnosis: 0 of 4 positives passed at diagnosis level, and both negatives passed without a non-benign ticket.
  - Detection level (a suspect event in the credited span): 3 of the 4 positives were detected. The intake-valve
    injection was not, a known limit of the detection rules.
  - One negative day raised a `frequent_cycling` suspect event, so it fails the detection level's "no suspect event on
    a pure negative".
    It opened no ticket.

This is the first figure measured on data the design could not have been fitted to. The held-out days still fed
aggregate statistics and whole-recording replays, as the seal discloses under "What remains exposed". Every earlier
figure stays labelled in-sample.
