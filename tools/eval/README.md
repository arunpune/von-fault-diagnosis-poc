<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# `@fdp/eval`

The evaluation harness. It replays MetroPT-3 windows and injected faults through the backend's own
pipeline, scores the tickets and decisions that come out against ground truth, and writes the
numbers the README promises: precision and recall per fault, lead time against the controller's own
alarm, tickets per machine-day, abstention accuracy, cost, and the rules-only baseline beside Jev.

It runs in process and in TypeScript, so what it scores is the backend's own pipeline rather than a
re-implementation, and its replay is checked against the Go simulator's for parity. How the
evaluation is designed — scenarios, metrics, gates and reports — is in
[`docs/evaluation.md`](../../docs/evaluation.md); this page is the package's reference.

This is a **dev-time package**: nothing imports it, no image ships it, and it has no build step. It
runs straight from TypeScript through the `@fdp/source` export condition, so `pnpm install` is the
only preparation.

## What is here

| File | What it does |
| --- | --- |
| `src/cli.ts` | `fdp-eval`: dispatches `run`, `validate`, `record`, `score-stack` and `sweep` to `src/commands/<name>.ts`. |
| `src/slices.ts` | Resolves a MetroPT-3 slice by name from the shared definitions (see "Data" below). |
| `src/time.ts` | The dataset clock (`2020-02-01 00:00:00`, UTC) beside the `iso_ts` of `@fdp/contracts`. |
| `src/ids.ts` | Derived run ids (`<yyyymmdd-hhmmss>-<profile>`) and injection instance ids (`inj-<bootid>-<n>`). |
| `src/log.ts` | Three levels to stderr, with every secret-shaped field redacted before it is written. |
| `src/replay/` | Streams a slice or the whole CSV into `telemetry-samples` batches — `csv.ts` (rows), `quantise.ts` (the register codec), `index.ts` (samples, flags and batching), `inject.ts` (fault overlays) and `ambient.ts` (the synthetic lane) — and ports the CTRL-7 controller: `alarm-registry.ts` (the manual's messages, resolved), `derived.ts` (the six derived quantities) and `alarms.ts` (the evaluator that fills `sample.alarms`). |
| `fixtures/alarms-provisional/` | A five-message controller registry in the manual's grammar, read when a checkout carries no `manual/spec` and used as a unit-test fixture otherwise. |
| `src/scenario/` | The scenario schema, the loader and the binding that resolves windows, accepted faults and excluded ranges against `@fdp/ground-truth`. |
| `src/catalog/` | The reference fault catalog mapped to contracts `CatalogEntry` rows, from either the contracts envelope or the legacy PDF-build shape. |
| `src/commands/validate.ts` | `fdp-eval validate` — every scenario loaded and bound, plus the catalog cross-check and its report. |
| `src/metrics/` | The scoring library — ticket/window matching, precision and recall, lead time, machine-day rates, abstention, cost, the MetroPT-3 check, comparison and the threshold sweep. It imports nothing but `node:` builtins and itself. |
| `scenarios/` | The 21 evaluation scenarios, the core leak's dev twin and the six sealed held-out scenarios, each carrying its `split` and `positive`. |
| `src/config.ts` | Flags and environment into one frozen configuration; the keys and the database URL live in `EvalSecrets`, which prints as `[redacted]`. |
| `src/backends/` | The rules baseline and Jev against the contracts' mock, each wrapped to count its calls; the live Jev and LLM handles (`jev.ts`, `llm.ts`) behind one rate-limited queue each (`ratelimit.ts`), the cassette store and replay server (`digest.ts`, `cassette.ts`, `cassette-server.ts`) and the plan with its cost estimate that every live run prints first (`plan.ts`). |
| `src/runner/host.ts`, `recorder.ts` | One scenario through a fresh pipeline with a fake wall clock, and its event log summarised into tickets and decisions. |
| `src/runner/run.ts` | The scenario loop, the core-10 gate, the E3 check of `--exit-eval e3` and the exit codes; `types.ts` holds the run record the writers read. |
| `src/tuning.ts` | The explicit tuning list, its guard against test-split data and the shared-slice report. |
| `src/heldout.ts`, `test/heldout-seal.test.ts` | The names the sealed held-out set's guards share, and the test that holds its six files and slice entries to their seal in [`records/heldout-seal.md`](records/heldout-seal.md). |
| `src/report/` | `json.ts` (`run.json`, validated against `schemas/report.schema.json` before it is written), `markdown.ts` (`report.md`), `console.ts` (the summary table), `events.ts` (the per-scenario event logs) and `provenance.ts` (commit, runtime, ground-truth digests). |
| `src/commands/run.ts` | `fdp-eval run`, its flags and the exit codes. |
| `test/e2e/smoke.test.ts` | The smoke profile through the real CLI: exit 0 within 180 s, a valid `run.json`, both backends on all five scenarios, and no key in anything the run wrote. |
| `src/runner/full.ts` | The full profile's calendar-month progress and the whole-recording summary of E6. |
| `src/catalog/ingested.ts` | The `ingested` catalog source, read from `app.v_catalog_entries` and `app.catalog_conditions` as role `eval`. |
| `src/stack/` | Stack mode — `db.ts` (the read-only SELECTs), `score.ts` (rows to records, windows and covered time), `report.ts` (`run.json`, `report.md`, `stack.json`). |
| `src/commands/score-stack.ts`, `sweep.ts` | `fdp-eval score-stack` and `fdp-eval sweep`. |
| `src/commands/regate.ts`, `preregistered.ts`, `src/choice.ts` | A stored run back in the metrics' vocabulary and re-gated at one pair, which both sweeps share; `fdp-eval sweep --preregistered`, the choice of the triple by [`records/jev-thresholds-preregistration.md`](records/jev-thresholds-preregistration.md) (per-N resample replays, the grid, the rule, its readings); the committed choice record it writes and the held-out run reads. |
| `test/integration/stack-score.test.ts`, `full-profile.test.ts` | Stack mode and the ingested catalog against a migrated Postgres; one month of the full profile over the real CSV. |
| `src/commands/record.ts` | `fdp-eval record`, a live run with `--record` that writes cassettes (see [CASSETTES.md](CASSETTES.md)). |
| `test/backends/cassette-roundtrip.test.ts` | Record, replay and a counted miss through the real run, offline, against a scripted mock (integration suite). |
| `test/live/` | The opt-in live smoke tests, run only by `test:live` with keys and `--confirm-live`. |
| `records/` | The pre-registration of Jev's thresholds and its recorded choice, and the held-out set's seal and final-run record; each notes how it was edited for publication in the italic line at its top. |

## Commands

| Command | Runs |
| --- | --- |
| `make eval` | `pnpm --filter @fdp/eval run eval` → `fdp-eval run`, profile from `EVAL_PROFILE` (default `core`) |
| `make eval-stack` | `fdp-eval score-stack --db-url "$(DATABASE_URL_EVAL)"`: the stack `scripts/smoke.sh --keep` left running (its `reports/smoke/db-url-eval`), else `postgres://eval:eval@localhost:5432/fdp` |
| `make eval-sweep` | `fdp-eval sweep --preregistered --out reports/eval/sweep`: the triple (`GATE_PERSIST_SIM_MIN` and Jev's pair) chosen as [the pre-registration](records/jev-thresholds-preregistration.md) fixed and amended, from the tuning list's recordings at N = 0 and N = 1 replayed from cassettes, every resample |
| `pnpm --filter @fdp/eval run validate` | checks the scenario files against the schema and ground truth |
| `pnpm --filter @fdp/eval run record` | records model answers into cassettes (needs `--confirm-live`) |
| `pnpm --filter @fdp/eval run score-stack` | scores a run of the Compose stack from the database |
| `pnpm --filter @fdp/eval run sweep` | re-gates a stored `--tuning` run over a grid of gate thresholds; `--preregistered` makes the pre-registered choice of Jev's thresholds |
| `pnpm --filter @fdp/eval test` | the offline suite: no Docker, no key, no dataset needed |
| `pnpm --filter @fdp/eval test:integration` | the Docker-backed suites, the cassette round trip and the end-to-end smoke run |
| `pnpm --filter @fdp/eval test:live -- --confirm-live` | the live smoke tests against the real APIs; keys required, and every call is paid |
| `pnpm --filter @fdp/eval typecheck` / `lint` | `tsc --noEmit` / `eslint` |

Exit codes of `fdp-eval`: **0** the run completed (and the gate held under `--fail-on-gate`), **1**
a usage or configuration error, **2** the gate failed under `--fail-on-gate` or a condition
`--exit-eval` covered broke, **3** the run was aborted — a scenario error or a missing fixture. An
`--exit-eval` check that could not see every condition is `INCOMPLETE`, exits 0 on its own, and is
never a pass.

### Profiles

`EVAL_PROFILE` (or `--profile`) selects `smoke` (five scenarios, no keys, what CI runs, in under 180
s), `core` (the default: the core-10, which is the test split), `dev` (their complement) or `full`
(the whole recording). Every scenario with its group, split, replayed window and profiles is listed
in [docs/evaluation.md](../../docs/evaluation.md#every-scenario), and the gate in
[When a scenario passes, and the gate](../../docs/evaluation.md#when-a-scenario-passes-and-the-gate).
A positive's time budget is the `within_min` of its scenario file: in the core-10, F1 180 minutes,
F2 and F3 120, F4 60, `inject_oil_cooler_fouling` 360 and `inject_air_leak_downstream` 180; in the
dev split, `f4_precursor_jul14` 600, `metropt3_full` 180, `inject_air_leak_downstream_jul05` and
`inject_dryer_tower_switching_failure` 180, and `inject_intake_valve_sticking`,
`inject_motor_overload` and `inject_separator_drain_blocked` 120. `dev` is **not** a tuning set — it
replays `metropt3_full` and `f4_precursor_jul14`, which carry the headline failures — so tuning uses
`--tuning` instead (see "Tuning" below).

### The held-out set

`heldout` is the sealed held-out set: six scenarios on six days of their own, split `heldout`, drawn
blind and sealed in [`records/heldout-seal.md`](records/heldout-seal.md). **It runs once, after the
Jev thresholds are fixed under the pre-registration**, and nothing else replays it: no other
profile, `--scenario`, the tuning list, the sweep or a live plan selects it. The one run is
`EVAL_JEV_MODE=live … --profile heldout --final-heldout --confirm-live` with `jev` among the
backends; the harness refuses `heldout` without `--final-heldout`, with `--scenario`, `--seed`,
`--fail-on-gate` or `--exit-eval`, with any triple (`GATE_PERSIST_SIM_MIN` and Jev's pair) but the
one the pre-registered sweep chose and
[`records/jev-thresholds-choice.md`](records/jev-thresholds-choice.md) records, and for good once
[`records/heldout-final-run.md`](records/heldout-final-run.md) records the run. `fdp-eval validate`
is the one command that may read the six files before then.

## Running an evaluation

```bash
make fixtures                                             # once: cut the slices
EVAL_PROFILE=smoke EVAL_JEV_MODE=mock make eval           # what CI runs, about 3 s
pnpm --filter @fdp/eval run eval -- --profile core --fail-on-gate      # the core-10 counts only
pnpm --filter @fdp/eval run eval -- --profile core --backends rules \
  --catalog file:reports/eval/ingested-realistic.json     # the headline catalog, as init extracts it
pnpm --filter @fdp/eval run eval -- --profile smoke --scenario f3_air_leak_jun05
pnpm --filter @fdp/eval run eval -- --tuning --backends rules --catalog reference   # tuning readout
pnpm --filter @fdp/eval run eval -- --help                # every flag
```

The flags: `--profile`, `--backends rules,jev[,llm]` (default `rules,jev`), `--scenario <id>`
(repeatable; it narrows the profile and refuses an id the profile does not replay),
`--catalog reference|file:<path>|ingested`, `--db-url`, `--record`, `--confirm-live`, `--out <dir>`
(default `reports/eval` at the repository root), `--jobs 1`, `--seed` and `--fail-on-gate`, plus
`--exit-eval e3` and `--tuning` (below), and `--resample <r>` (cassette mode only: serve each
repeated request's recorded answers rotated by r; see [CASSETTES.md](CASSETTES.md)). Flags win over
the environment. The gate reads each backend's own pair: `GATE_TICKET_MIN_CONFIDENCE` and
`GATE_REVIEW_MIN_CONFIDENCE` for rules and llm, `JEV_GATE_TICKET_MIN_CONFIDENCE` and
`JEV_GATE_REVIEW_MIN_CONFIDENCE` for Jev (0.85 and 0.65 by default, the pre-registered choice in
[`records/jev-thresholds-choice.md`](records/jev-thresholds-choice.md), whatever `GATE_*` says), and
`run.json` records it on `backends[].thresholds`. `EVAL_JEV_MODE` picks how Jev is reached (`auto`,
`live`, `cassette`, `mock`); without a key or cassettes, and always in CI, it is the contracts' mock
server, and every Jev figure of such a run is **not informative**; how cassettes are recorded,
replayed and kept is [CASSETTES.md](CASSETTES.md). With `TYPESAFE_API_KEY` exported, `auto` resolves
to `live`, so every live run is planned first and refused (exit 1) without `--confirm-live`:
`make eval` then prints the plan and stops, and `EVAL_JEV_MODE=cassette` or `mock` runs it without
calling. `make eval` passes no flag, so a flag goes through
`pnpm --filter @fdp/eval run eval -- <flags>`.

Before the first row is replayed the run loads and binds every scenario, checks that its rows are
on this machine, loads the catalog and builds the backends, so a typo or a missing slice fails in a
second rather than at the end. Each scenario then replays once per backend through a fresh pipeline.

### Outputs

```text
<out>/latest.json                               a copy of the newest run.json
<out>/<yyyymmdd-hhmmss>-<profile>/run.json      the run, urn:fdp:eval:report:v1
<out>/<yyyymmdd-hhmmss>-<profile>/report.md     the same, for a person
<out>/<yyyymmdd-hhmmss>-<profile>/scenarios/<scenario>.<backend>.jsonl   every pipeline output
```

`run.json` is validated against [`schemas/report.schema.json`](schemas/report.schema.json) before it
is written. It restates the run (commit, Node, backend version, ground-truth version and data
digests, catalog source and digest, alarm registry, thresholds, prices), lists the backends with
their mode and call counts, holds one entry per scenario and backend, and ends with the summary and
the gate — then, when the run asked for them, the `tuning` and `exit_eval` blocks. A scenario entry
keeps what a re-score needs — its windows, excluded windows, benign causes and every decision with
its choice and confidence — in the field names of `fixtures/metrics/`. The event logs keep every
output of the pipeline except a decision's state and its raw provider bodies; the state is
represented by its `state_digest`. Reports are written under the gitignored `reports/`, and
Jev-derived figures stay there: they are not published
([CASSETTES.md](CASSETTES.md#why-cassettes-are-not-committed)).

A summary table is printed on stdout (log lines go to stderr): one line per scenario with each
backend's detection, review-diagnosis and diagnosis flags, the gate, the MetroPT-3 check and where
the files are.

**Three pass levels.** *Detection* is read on suspect events, not tickets: a positive passes when a
suspect event after the warmup falls in the credited span `[span_from, end)` of one of its windows
within its `within_min` budget, and a normal-operation negative (group `negative`) when it raises
none; an abstain case keeps the ticket rule. *Review diagnosis* is the ticket rule — a ticket naming
an accepted fault at review-or-ticket level in time, the false tickets within the allowance — which
"detection" named before E3 was re-scoped to detection on 2026-09-24. *Diagnosis* adds that the
first ticket-level ticket in the window names an accepted fault. The rules backend is gated at
detection and Jev at diagnosis; the rules backend's two diagnosis flags are a recorded baseline.

### Reading the report

`report.md` has eight sections, in this order.

1. **Headline** — the core-10 gate with both counts (≥ 8 of 10 and ≥ 5 of the 6
   positives), the MetroPT-3 check labelled *in-sample* (the rules were designed after looking at
   F1–F4) — at detection level too for a backend gated there — the E3 verdict, every E3 condition
   with its evidence and the rules backend's diagnosis baseline when the run was started with
   `--exit-eval e3`, and every scenario with its group, split and three pass flags per backend.
2. **Comparison** — one row per metric, one column per backend with its mode in the heading; a
   mock Jev column reads *mock — not informative*.
3. **Per-fault precision and recall**, at ticket and at review level.
4. **Lead times** — per detected window, against the controller's own alarm and the low-pressure
   switch; `≥` marks a latency measured from an onset that is only a lower bound (F1).
5. **Abstention** — accuracy and explicit abstention rate, and why each case was judged as it was.
6. **Cost** — decisions, tokens and dollars per backend at the dated prices.
7. **Scenarios** — one section per scenario and backend: windows, the suspect events read at
   detection level, every ticket with its verdict, excluded-window hits, what was still open when
   the replay ended, the reasons it failed, and a design target's reading when the scenario carries
   one.
8. **Caveats** — the backends' modes, the catalog source, a provisional alarm registry, open
   tickets, the provisional label set, what an in-process run cannot see, on a
   `--tuning` run the tuning scenarios that share a slice with the core-10, and every design-target
   reading, marked as never gated.

A ticket's verdict is one of `tp`, `recovered` (right after a wrong one in the same window),
`duplicate` (a second right one), `misdiagnosed`, `fp`, `ignored` (opened inside an excluded
window), `benign` (a cause the scenario calls normal operation) or `warmup` (opened before the
scenario's warmup ended, replayed but never scored). Diagnostic scenarios are replayed and listed
but never scored.

**Which gate.** Each backend is counted at its own level — rules at detection, Jev at diagnosis —
and the gate the run reports (and `--fail-on-gate` enforces) is Jev's only when Jev ran live or from
cassettes; with a mock Jev it is the rules baseline's. A run that scored all ten core-10 scenarios
passes or fails by the core-10 rule: at least 8 of the 10 and 5 of the 6 positives. A run that
scored only some of them — the smoke profile, a `--scenario` list — is `attainable` while the
failures it has seen still leave room for both thresholds and `unattainable` once they do not; only
a core run decides the gate.

## E3 and the tuning list

Two flags serve the E3 exit evaluation and design tuning: `--exit-eval e3` checks every E3 condition
a run can see, and `--tuning` replays the explicit tuning list, which keeps design work off the test
split.

### `--exit-eval e3`: every E3 condition, not only the counts

`--fail-on-gate` enforces the core-10 counts and nothing else, and six positives plus the baseline
and depot days already make 8/10. E3
([the evaluation gates](../../docs/evaluation.md#the-evaluation-gates-e1-to-e6))
asks for more, so `--exit-eval e3` checks all five of its conditions on the **rules** backend (E3 is
rules-only; with `--backends rules,jev` it reads the rules pairs, and a `--backends` list without
`rules` is refused). E3 was re-scoped on 2026-09-24, after the E3 and E4 results had been seen: it
gates the rules layer's **detection** — suspect events — and no longer its diagnosis; the thresholds
did not move:

| Condition | Holds when |
| --- | --- |
| `core10_counts` | ≥ 8 of the core-10 and ≥ 5 of the 6 positives pass at detection level: a suspect event after the warmup in a positive's credited span within its `within_min` budget |
| `metropt3_check` | every headline failure (the failure table's `in_headline`: F1–F4) has a suspect event in its credited span within its core-10 scenario's budget |
| `negatives_no_suspect` | no suspect event at all — warmup and excluded-window ones included — on the normal-operation negatives `baseline_feb03_normal` and `frozen_logger_jun22` |
| `abstain_non_benign` | no ticket naming a non-benign cause — warmup and excluded-window ones included — on the abstain cases `inject_high_ambient_benign` and `inject_oil_temperature_sensor_fault` |
| `depot_no_ticket` | no ticket at all, benign ones included, on `depot_lps_jul31` |

Each condition is `pass`, `fail` or `not_covered`, with its evidence: counts, failures detected and
missed, and every breaking suspect event or ticket (with the verdict `scenarios[]` gives it). A
scenario covers a condition only when the run replayed its whole range, so a scenario the run left
out or shortened (the smoke overrides) is never counted as passed. The verdict is `fail` when a
covered condition broke (**exit 2**, with or without `--fail-on-gate`), `pass` only when all five
were covered and held, and `incomplete` otherwise: `E3 INCOMPLETE — not a pass; not covered: …` on
the console and in report.md's headline, exit 0 on its own. `run.json` carries the check as its
`exit_eval` block, and beside the conditions its `baseline`: the rules backend's diagnosis figures
— the core-10 at review diagnosis and at diagnosis, and the MetroPT-3 check on tickets at
review-or-ticket level — marked `gated: false`, reported and never part of the verdict. E4 (Jev,
≥ 8/10 at diagnosis level) is the diagnosis gate.

No single run covers all five, because `frozen_logger_jun22` is dev split and a core run never
replays it. The E3 recipe is therefore two readings plus the ablation (`EVAL_JEV_MODE=mock`; keys
are never needed):

```bash
# 1. The headline: the core-10 on the catalog init extracts from the realistic PDF.
uv run --package fdp-init fdp-init export-catalog --manual data/manual/cau-7-realistic.pdf \
  --out reports/eval/ingested-realistic.json
pnpm --filter @fdp/eval run eval -- --profile core --backends rules,jev \
  --catalog file:reports/eval/ingested-realistic.json --fail-on-gate --exit-eval e3
# 2. The ablation: the same on the reference catalog.
pnpm --filter @fdp/eval run eval -- --profile core --backends rules,jev \
  --catalog reference --fail-on-gate --exit-eval e3
# 3. The one E3 negative a core run never replays.
pnpm --filter @fdp/eval run eval -- --profile dev --backends rules \
  --scenario frozen_logger_jun22 --exit-eval e3
```

E3 passes only when neither the headline reading nor the frozen-logger reading is `fail` and
everything one of them lists under `not_covered` is shown to pass by the other; the ablation is
reported beside them. The headline reads the extracted catalog because that is the path the stack
ships.

### Tuning

**Never tune on `--profile dev`, on a core-10 result or on the smoke outcomes.** `dev` replays
`metropt3_full` and `f4_precursor_jul14`, which carry the headline failures; the core-10 is the test
split; and the smoke replays core-10 scenarios, so its `it.fails` markers flip mechanically.
Design tuning — thresholds, word semantics, phase and onset parameters, retrieval text, the
threshold sweep — reads only synthetic frames and the explicit list of `src/tuning.ts`:
`summer_normal_jul05`, `frozen_logger_jun22`, `f4b_recurrence_jul17`, `unlabelled_leak_may19`
(a design case, below), `august_oil_level_aug10`,
`inject_dryer_tower_switching_failure`, `inject_intake_valve_sticking`, `inject_motor_overload`,
`inject_separator_drain_blocked` and `inject_air_leak_downstream_jul05`. The last is the dev twin
of the core-10 `inject_air_leak_downstream`, added on 2026-09-23: the same injection at the same
02:00 for 240 minutes with the same expectation, replayed on the summer slice of
`summer_normal_jul05`, which no core-10 scenario replays. It is in the `dev` profile only, so the
core and full runs behind E3, E4 and E6 never replay it; the tuning readout does. The twin came
with a change to the leak injection ([docs/simulation.md](../../docs/simulation.md)) made after the
E3 and E4 results had been seen and argued from physics, so the core scenario's later figures stay
in-sample.

`--tuning` replays exactly that list, each scenario over its dev range. It cannot be combined with
`--profile` or `--scenario` (exit 1), it beats `EVAL_PROFILE`, and the run is recorded with profile
`tuning` and a run id ending in `-tuning`. Before anything is replayed, a guard refuses (exit 1,
naming each id) any core-10 scenario, any scenario bound to a headline failure
(`f4_precursor_jul14`) and any `recording` scenario (`metropt3_full`). The four dev injections
replay `baseline-feb03`, the day five core-10 scenarios replay; the dev/test split allows that, so
they are reported rather than refused — on the console, in report.md's caveats and in `run.json`'s
`tuning` block. The gate and MetroPT-3 lines of a tuning run read as any partial run's (the core-10
is unscored) and are not a tuning signal.

**The fixed list and the design case.** The list was fixed on 2026-09-24, after the E3 and E4
results had been seen, the four dev injections on `baseline-feb03` included. `unlabelled_leak_may19`
is a design case: its scenario file carries an optional `design_target` — `dryer_purge_leak` or
`downstream_air_leak`, "inferred from the signature-A analysis, unverified" — that the loader allows
only on a diagnostic scenario of the dev split. A run reads each pair's tickets and decisions inside
the scenario's unlabelled episode against it (`src/metrics/design.ts`) and reports the reading in
`run.json`'s `design_targets`, in report.md and on the console; `fdp-eval sweep` reads it at every
grid pair in a section of `sweep.md` and in `sweep.json`. Every reading is marked `gated: false`: no
pass rule, gate, E3 condition or sweep row reads it, the episode stays an excluded window
([docs/dataset.md](../../docs/dataset.md#unlabelled-episodes)), and the pre-registered threshold
selection leaves may19 out.

## The full profile (E6)

`EVAL_PROFILE=full make eval` replays the full profile's scenarios, `metropt3_full` among them: the
whole MetroPT-3 recording, 1 February to 1 September 2020, streamed from the CSV `METROPT_CSV`
names (default `data/metropt3/MetroPT3(AirCompressor).csv`, which `make fetch-dataset` downloads).
It runs through the same host and the one pipeline as every other scenario; `src/runner/full.ts`
cuts the range into calendar months for progress only, one log line per month with its samples
per second, so episodes and controller timers run across month boundaries untouched. The rules
backend replays the whole file at about 25,000 samples/s, a minute per backend, far above the
1,500 samples/s the profile needs, so no worker threads are used and `--jobs` stays 1.

Beside the usual summary, which pools the fixture slices of F1–F4 with the recording, the run reads
the recording on its own — what E6 asks — as report.md's "Whole recording" headline, a console line
and `run.json`'s `full_recording` block: the in-sample MetroPT-3 check over the recording's four
headline windows at ticket and at review level, false tickets per machine-day over its negative time
(about 158 machine-days once the excluded windows are out) at both levels, and every ticket opened
inside an unlabelled episode, listed apart and never counted as a false positive
([unlabelled episodes](../../docs/dataset.md#unlabelled-episodes)).
`test/integration/full-profile.test.ts` replays February 2020 when `METROPT_CSV` is set and prints
the throughput.

## Stack mode (E5)

```bash
scripts/smoke.sh --keep && make eval-stack      # the CI stack, found through reports/smoke/db-url-eval
make up-dev && make eval-stack                  # a dev stack, Postgres on localhost:5432
pnpm --filter @fdp/eval run score-stack -- --db-url postgres://eval:eval@localhost:5432/fdp \
  --from 2020-06-05T00:00:00Z                   # only sim time from 5 June on
```

`fdp-eval score-stack` scores what a running Compose stack left in Postgres, as role `eval` and
inside one read-only transaction, so it can write nothing: the ingested catalog the stack ranked,
its tickets, decisions, episodes, controller alarms and cost ledger, and the ground truth the
overlay stored — `gt.v_injection_windows` and `gt.markers`. What was replayed is read from the
one-minute telemetry aggregates: each island of consecutive minutes is a segment, the holes between
them are the jumps and the gaps. The windows are every headline failure window the segments
overlap — a jump to the F3 preset lands in F3's — and every injection window, clipped to the
segments; a ticket's fault at open is what the decision that opened it named. Each backend is
scored by the in-process metrics as one scenario, `stack_replay`, and written as a normal
`run.json` and `report.md` with `run.mode: "stack"` under `reports/eval/<yyyymmdd-hhmmss>-stack/`,
beside `stack.json`, which names the segments, the markers and the presets and failures they
resolve to, every window and where it came from, the thresholds and the ledger. `latest.json` is
left alone. The report's caveat says retrieval used the backend's Postgres path. Exit 3 when the
database holds nothing replayed or diagnosed in the range.

## The threshold sweep

```bash
make eval-sweep                                              # the pre-registered choice of Jev's thresholds
pnpm --filter @fdp/eval run sweep -- --run reports/eval/<run>/run.json --grid 0.6:0.95:0.05x0.5:0.8:0.05
```

`fdp-eval sweep` re-gates a stored run's decisions for every (ticket, review) pair of the grid — by
default ticket floors 0.60–0.95 and review floors 0.50–0.80 in steps of 0.05, each review floor at
or below its ticket floor — and scores the rebuilt tickets with the run's own scorer, so the warmup,
the excluded windows and the abstention rule count as the run counted them. It prints one table per
backend — tickets, micro precision and recall at ticket and review level, false tickets per
machine-day, abstention accuracy — and writes `sweep.json` and `sweep.md` into the run's directory.
The row at the run's own thresholds (marked `*`) must give the run back, and the command says
whether it does; the merges the run made are recovered from `run.json` and held, and so are the
decisions it took, so every row is marked approximate. Holding the decisions is an approximation
because an episode that owns no ticket is decided only once its evidence has held for
`GATE_PERSIST_SIM_MIN`, while one that owns a ticket is decided at once: a pair that opens a ticket
sooner or later than the run did would have taken other decisions. One half of that is respected: a
decision whose evidence had not yet held for `GATE_PERSIST_SIM_MIN` (its `persisted_sim_min` in
`run.json`), which only an episode owning a ticket could take, never opens a ticket at another pair.
Each backend is re-gated around the pair its gate applied (`backends[].thresholds`; Jev has its own
pair since 2026-09-24). It reads a `--tuning` run only: a stack run, another profile or a test-split
scenario is refused (exit 1) unless `--allow-test-split` is given, which reports and never chooses.
Every table is a reading, not a proposal: a `GATE_*` change is a deliberate decision that cites the
tuning run, and no threshold is lowered to pass E3.

### The pre-registered choice of Jev's thresholds and the persistence

`make eval-sweep` runs `fdp-eval sweep --preregistered`, the procedure
[`records/jev-thresholds-preregistration.md`](records/jev-thresholds-preregistration.md) fixed
before any Jev decision on the tuning list existed. Its amendment of 2026-09-24, also made before
any, makes the choice a **triple**: `GATE_PERSIST_SIM_MIN` (N, the sim minutes a symptom must
persist before an episode without a ticket is decided) with Jev's review and ticket thresholds. It
calls nothing:

1. For each N of 0 and 1, it replays the tuning list for Jev alone, from that N's own recording,
   gated at 0.60 / 0.85 (the pair of the recordings) with `GATE_PERSIST_SIM_MIN` = N. The first
   replay goes into `reports/eval/sweep/persist-<N>/resample-0/`, then once more per further
   answer the fullest cassette it hit holds at N into `resample-<r>/` (`--resample r`: each
   repeated request's recorded answers rotated by r). The store serves a replay at N the answers
   recorded at N and no others ([CASSETTES.md](CASSETTES.md)). `--from-runs` sweeps the runs
   already there instead.
2. It re-gates every resample over the grid at each N: review 0.50–0.80 and ticket 0.70–0.95 in
   steps of 0.05, review below ticket, so 36 pairs per N and 72 triples. It pools, over the list
   less the two scenarios reported apart, the false tickets and false reviews per negative
   machine-day and the positives passed at their level within their budget.
   - The two reported apart are `unlabelled_leak_may19` (the design case) and
     `august_oil_level_aug10` (the amendment). Neither counts in the constraint or the objective,
     and neither's time is negative time. The report lists both on their own, with every ticket
     they opened.
3. It applies the rule as amended.
   - The constraint: at most 0.10 false tickets and 0.50 false reviews per negative machine-day on
     every resample.
   - The objective: the most positives on the median resample.
   - The ties: fewer false reviews, then fewer false tickets, then N = 1, then the pair closest to
     0.60 / 0.85.
   - Stay unless clearly better: a triple replaces (N = 1, 0.60 / 0.85) only with at least one more
     positive on the median resample, and never fewer on any resample. The readings in the report
     say how "never fewer" compares two N, whose resamples come from different recordings.
   - If (N = 1, 0.60 / 0.85) itself breaks the constraint, the qualifying triple with the most
     positives wins. If no triple qualifies, the thresholds and N stay as they are and the finding
     is recorded.

It writes `preregistered-sweep.json` (v2) and `.md` beside the resample runs. They hold the chosen
triple, or "keep N = 1, 0.60 / 0.85", with the reason, every triple's figures, the scenarios reported
apart, the readings of the rule and the in-sample disclosure. It refuses a run that is not exactly
the tuning list, or that ran at another N than its recording. It chooses nothing, and says why, in
three cases:

- **A recording is missing.** An N whose replay found no cassette recorded at N is named, with the
  command that records it; an empty store names both.
- **A resample had a cassette miss or a failed decision.** The mock answered, or nothing did.
- **A resample is not given back.** Re-gated at 0.60 / 0.85, it does not reproduce its own run.

`--record-choice` writes the choice once to
[`records/jev-thresholds-choice.md`](records/jev-thresholds-choice.md), from the runs already swept
when given with `--from-runs` (`src/choice.ts`). The record holds the triple as the three variables,
the outcome, the pre-registration's commit, the report's path, the catalog and the resample runs. It
holds no Jev figure, and not the clause of the rule that decided, because each clause states an
outcome of Jev's figures on the tuning list and neither is published. It refuses a withheld choice
and an existing record. The record is then committed, and the choice applied by setting
`GATE_PERSIST_SIM_MIN`, `JEV_GATE_REVIEW_MIN_CONFIDENCE` and `JEV_GATE_TICKET_MIN_CONFIDENCE`. The
sealed held-out set's one run is refused with any other triple, or before the record is committed.

The recordings are the paid steps before it, one per N. Without `--confirm-live`, each of these
commands prints its plan and calls nothing:

```bash
GATE_PERSIST_SIM_MIN=0 JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning
GATE_PERSIST_SIM_MIN=1 JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning
```

The same two commands with `--confirm-live` record ([CASSETTES.md](CASSETTES.md)).

Since 2026-09-24 the code defaults are the chosen triple: N = 1, Jev at 0.65 / 0.85. Which clause
decided is not published, because each clause states an outcome of Jev's figures.
The recordings were made at 0.60 / 0.85, and the sweep still replays them there. A re-recording of the
tuning list therefore sets `JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60`, or `record` warns, and so does any
other cassette replay of those recordings.

## In CI

The `eval-smoke` job of `.github/workflows/ci.yml` runs
`pnpm --filter @fdp/eval run eval -- --fail-on-gate` with `EVAL_PROFILE=smoke` and
`EVAL_JEV_MODE=mock` in every run of the workflow, and uploads `reports/eval/**` as the `eval-smoke`
artifact. With the rules backend gated at detection level the smoke scenarios leave the core-10
gate attainable, so the job exits 0; it exits 2 once they put the gate out of reach. The Docker suites
(`pnpm --filter @fdp/eval test:integration`: parity, stack mode, the smoke E2E) run in the node leg
of the `test-integration` job; the full-profile test skips there, because CI sets no `METROPT_CSV`.

## Data: definitions here, rows never

[Ground rule 5](../../CONTRIBUTING.md#ground-rules) lets MetroPT-3 reach a machine by download only.
The consequence: **no row of the dataset is committed anywhere in this repository**, this package
included. What the harness reads is cut on the machine that runs it:

```bash
make fetch-dataset   # download MetroPT-3 into data/metropt3/ and verify it (once)
make fixtures        # cut every slice into the gitignored data/fixtures/metropt3/
```

`data/fixtures/metropt3-slices.json` holds the definition of every slice — its segments in the
dataset clock, its row count and the SHA-256 of the cut file — and `src/slices.ts` is how the
harness asks for one: `sliceDef(name)` works in any checkout, `slicePath(name)` says where a slice
would be, and `requireSlice(name)` returns it or fails with the command that produces it. Tests
skip when a slice is absent and **fail** when `FDP_REQUIRE_DATASET=1`, which CI sets once it has
restored the dataset. To reuse a copy of the 218 MB source CSV already on disk, for example in
another checkout, point `METROPT_CSV_HOST` at it.

`fixtures/catalog.json` is the reference fault catalog `make manual` writes. The harness reads it and
never edits it. `fixtures/cassettes/` holds recorded model answers and is gitignored: recorded Jev
answers are not published ([CASSETTES.md](CASSETTES.md#why-cassettes-are-not-committed)).

## The isolation rule

[Ground rule 3](../../CONTRIBUTING.md#ground-rules): the evaluation harness and the user-interface
overlay are the **only** readers of ground truth. The pipeline under test receives
`telemetry-samples` batches and nothing else — the same thing the gateway would publish — while the
labels stay on this side of the boundary (`@fdp/ground-truth` in process, the `gt` schema as role
`eval` in stack mode).

`package.json` therefore lists exactly `@fdp/contracts`, `@fdp/ground-truth` and `@fdp/backend`
(only its `./pipeline` export) from the workspace, and `@fdp/db-migrate` as a dev dependency for
the `/testing` helper the stack-mode test starts Postgres with. Stack mode reads `gt` only as role
`eval`, whose grants there are SELECT, inside a read-only transaction.
`test/boundaries.test.ts` asserts that list, greps the sources for any deeper backend import, and
runs the root dependency-cruiser rules `eval-only-pipeline-entry` and `eval-allowed-imports` over
this package.

## No keys, ever, in a report

Keys come from the environment and are never written down: not in a report, not in a log line, not
in a cassette. `src/log.ts` redacts every field whose name looks like a key, a token, a password or
an authorization header before anything is formatted, and the live backends are opt-in — CI runs
the harness in mock mode and skips them. The report tests and the smoke E2E grep every file a run
writes, and both of its output streams, for the mock key and for a bearer header.
