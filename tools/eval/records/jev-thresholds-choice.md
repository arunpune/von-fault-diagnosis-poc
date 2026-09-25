<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The Jev thresholds choice

_Edited for publication: its paths were updated, commit identifiers were replaced by dates, and the line naming the selection-rule clause that decided the choice was removed, because naming it would state an outcome of Jev's figures on the tuning list, and no figure or outcome of Jev's is published._

Recorded on 2026-09-24 by `fdp-eval sweep --preregistered --record-choice`, from the
pre-registered sweep of the tuning list (`tools/eval/records/jev-thresholds-preregistration.md`, as amended on 2026-09-24).
This file is written once and committed. The sealed held-out set's one run reads the triple below and runs with
exactly it (`tools/eval/records/heldout-seal.md`); a new choice would be a deliberate decision, recorded with its reason.

**Outcome.** The pipeline and Jev run at N = 1, 0.65 / 0.85; before the choice they ran at N = 1, 0.60 / 0.85.

**The triple**, as the three variables the held-out run and the stack are given:

```text
GATE_PERSIST_SIM_MIN=1
JEV_GATE_REVIEW_MIN_CONFIDENCE=0.65
JEV_GATE_TICKET_MIN_CONFIDENCE=0.85
```

**Where it came from.**

- The pre-registration: `tools/eval/records/jev-thresholds-preregistration.md`, last changed on 2026-09-24 (12:38 UTC), before the sweep ran.
- The sweep report: `reports/eval/sweep/preregistered-sweep.md` (gitignored; its Jev figures are not published).
- The catalog the tuning list was replayed with: `reference`, sha256 `3b3d5d86bdc8e9d2aef8540ce2146289e48141d1a420401462bf77622be57e32`.
- The resample runs, each recording replayed from its own cassettes, all at one tree (the repository as committed on
  2026-09-24 at 15:52 UTC):
  - GATE_PERSIST_SIM_MIN = 0: `20260924-155659-tuning`, `20260924-155702-tuning`, `20260924-155705-tuning`, `20260924-155708-tuning`, `20260924-155711-tuning`
  - GATE_PERSIST_SIM_MIN = 1: `20260924-155714-tuning`, `20260924-155718-tuning`, `20260924-155720-tuning`, `20260924-155723-tuning`, `20260924-155726-tuning`

**Disclosure.** The pre-registration and every decision it rests on were made
after the E3 and E4 results had been seen, so every figure they move stays in-sample. The held-out set's one run is the
first clean figure.
