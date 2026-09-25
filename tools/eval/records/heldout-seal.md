<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The held-out set, its selection rule and its seal

_Edited for publication: its paths were updated, commit identifiers were replaced by dates, and internal decision identifiers and process narration were replaced by what they refer to. The rule, the draw and the seal are unchanged. `heldout_selection.py` and the planning documents it once cited are not part of this repository; the planning statistics it reads are `data/metropt3-first-month-stats.json`._

Decided on 2026-09-24: **everything so far keeps its in-sample label, and a fresh held-out set is commissioned.** The
set is authored blind, frozen before it is ever run, and run once. Like every design decision of 2026-09-23 and
2026-09-24, this one was made **after the E3 and E4 results had been seen**. The held-out set is what makes a
figure clean from here on. It does not make an earlier figure clean, and every earlier figure stays labelled in-sample.

The set was built in this order, one commit each, all on 2026-09-24:

1. the selection rule and the script that applies it (`heldout_selection.py`), committed before the
   draw was run;
2. the guards that keep the set out of every run but the final one;
3. the six slice definitions the draw produced, then the six scenario files;
4. the draw's record and the sha256 seal of every file and slice entry (the sections [The draw](#the-draw-2026-09-24)
   and [The seal](#the-seal), below), with the test that holds the files to it.

## The one-run rule

**The held-out set runs once, after the Jev thresholds are fixed under the pre-registration**
(`tools/eval/records/jev-thresholds-preregistration.md`). "Fixed" means that the chosen pair, the sweep report path and the
pre-registration's commit are recorded, as its "After the choice" says. Its result is the clean E4 figure.

- **Before the run.** Nobody replays a held-out scenario in any mode (mock, rules, cassette, live, stack), plans a live run
  over it, sweeps it, tunes on it or reads its rows. `fdp-eval validate` is the one command allowed over it: it loads each
  file, checks it against the schema and binds it to ground truth, and replays nothing. No cassette holds a held-out
  request. The final run therefore needs an explicit go-ahead for a live Jev recording, and its Jev-derived figures
  are not published.
- **The run.** `EVAL_JEV_MODE=live pnpm --filter @fdp/eval run eval -- --profile heldout --final-heldout
  --confirm-live`, with `--backends` naming `jev`, and with the catalog and the thresholds of the choice. `--record` keeps the answers as cassettes. Every held-out scenario is replayed, none left out, with its sealed
  seed. The run uses no `--scenario`, `--seed`, `--fail-on-gate`, `--exit-eval` or `--tuning`, because each of them would
  change what is measured. The harness refuses every one of them, and it refuses Jev in any mode but live and a run not
  confirmed up front (see [The guards](#the-guards)).
- **After the run.** Straight after the run, whatever its outcome and an aborted run included, the operator commits
  `tools/eval/records/heldout-final-run.md`. It records the command, the exit code, the run id, the commit, the catalog and its
  sha256, the thresholds and the date. From that commit on, the harness refuses every further held-out run. A second run is
  never the operator's decision: it would be a deliberate decision of the project, recorded in that file.
- **What it reports.** Each scenario passes or fails by its own sealed `expect` block, at its own `pass_level`, per
  backend. The run's report lists them with their split, `heldout`. The figure is that table: positives passed out of four
  and negatives without a non-benign ticket out of two, per backend. This file sets no pass threshold for the set, and reads
  no pass or fail into those counts.

## Selection rule (written before the draw)

The rule reads only committed metadata, at one fixed tree: the repository as it stood on 2026-09-24, just before the
rule was committed.
`heldout_selection.py` applies it with the Python standard library and prints the draw. The rule never opens
the MetroPT-3 CSV, a cut slice, a run report, a cassette or a plot. Days and instants are in the dataset clock (UTC,
[`docs/dataset.md`](../../../docs/dataset.md#sampling-size-and-clock)), and a day is the half-open `[D 00:00, D+1 00:00)`.

### Eligible days

- **E0, candidates.** 2020-03-01 to 2020-08-31. February is the first month, the training split every normal band,
  first-month statistic and quiet-hours reading comes from, so none of its days is held out
  from the detector. The recording ends at 2020-09-01 00:00.

A candidate day is eligible only when none of the following touches it:

- **E1, labelled failures ±48 h.** Every failure of `metropt3-failures.json` (F1, F2, F3, F4 and F4b), from the earliest
  of its `start`, `precursor_from` and `data_onset` to the latest of its `end`, `data_recovery` and `maintenance`, widened
  by 48 h on each side. Every excluded window whose reason is `repair` or `secondary_positive` is widened the same way.
- **E2, unlabelled episodes ±48 h.** Every `unlabelled_episodes` entry of the failure table (the short episodes included;
  [`docs/dataset.md`](../../../docs/dataset.md#unlabelled-episodes)), and every stuck-loaded run of at least 45 minutes in the planning statistics
  (`continuous_load_episodes_ge_45min`), widened by 48 h on each side.
- **E3, known anomalies on the day.** Every other excluded window of the failure table (frozen logger, depot
  depressurisation, unlabelled positive). Every frozen block, and every stretch of at least 30 s with the low-pressure
  switch closed (`lps_episodes_ge_30s`). Every block of at least an hour with the oil level or the flow pulses at zero.
  Each is read from the planning statistics' `start` and `end` fields only.
- **E4, gaps.** Every gap over one hour (`gaps_over_1h`), with the 30-minute tail the harness keeps after a gap. Every
  held-out day therefore replays whole, as the three whole-day slices already in use do.
- **E5, days already used.** Every day a segment of `data/fixtures/metropt3-slices.json` touches, and every day an
  existing scenario replays. The whole-recording `metropt3_full` is the one exception, since it replays every day. The
  tuning cases are scenarios, so they are covered.
- **E6, days anyone wrote down.** Every candidate day named by a tracked text file of the tree: prose, code, tests and
  fixtures, in the forms the documents use (`2020-07-14`, `07-14`, `14 July`, `10–13 July`, `July 14`, `14-07-2020`,
  `7/14/2020`). Binary files are not scanned, and neither are five text files: the two lock files, and the three
  machine-written listings that E1–E5 read field by field (the failure table, the slice manifest, and the planning
  statistics, whose `daily` table names every day by construction). A day someone wrote down is a day someone may have looked at. The scan errs on the side of excluding a day.

### The cases

- **Positives: four, from the injection definitions as they stand after the leak injection was made consistent**
  (`air_leak_downstream` with the `guard_entry` anchor and no oil offset). The two definitions behind the core-10's injected positives,
  `air_leak_downstream` and `oil_cooler_fouling`, are always in the set. The held-out set re-measures what the core-10
  measures. The draw adds two more from the other non-benign definitions, taken in id order: `dryer_tower_switching_failure`,
  `intake_valve_sticking`, `motor_overload` and `separator_drain_blocked`. The benign definitions (`heavy_air_demand`, now
  without its oil offset, `high_ambient_temperature` and `oil_temperature_sensor_fault`) cannot make a positive, because a
  positive expects a ticket naming the injected fault. They are outside this set.
- **Negatives: two normal days**, no injection.

### The draw

Every draw is `pick(label, k, n)`: the SHA-256 of `"fdp-h6-heldout-2026-09-24|<label>|<k>"`, read as a big-endian
integer, modulo `n`. It is drawn without replacement from a list in a fixed order.

1. **Definitions.** Two draws, `pick("definition", k, n)` for k = 0 and 1, from the four other non-benign definitions in id
   order. The four positive definitions are then taken in id order.
2. **Days.** Six draws, `pick("day", k, n)` for k = 0 to 5, from the eligible days in calendar order. The first four go to
   the positives in definition order, and the last two are the negatives.
3. **Injection instants.** For each positive, one draw sets the minute of its day:
   `60 + pick("time|<injection_id>", 0, latest − 60 + 1)`, with `latest = 1440 − 60 − max(duration, budget)`. `duration`
   is the definition's `default_duration_sim_min`. `budget` is the `within_min` of that definition's committed scenarios.
   The injection starts after the 60-minute warm-up. Both its window and its budget end at least an hour before midnight.

### The scenario fields the rule fixes

- **Replay.** The whole day, from its own slice `heldout-<mon><dd>`, one segment `[D 00:00, D+1 00:00)`. `make fixtures`
  cuts it, and `--report` measures its rows and sha256. `used_by` lists what consumes it; the six held-out
  entries keep the labels they were sealed with.
- **Positives.** Id `heldout_<injection_id>_<mon><dd>`, group `injected`, ground truth `injection`, one injection at the
  drawn instant with `magnitude` 1 and the definition's default duration. The expectation is the one the definition's
  committed scenarios carry: at least one ticket, the injected fault, within the definition's `within_min`, no false
  ticket, at diagnosis level. No expectation is chosen here.
- **Negatives.** Id `heldout_normal_<mon><dd>`, group and ground truth `negative`. The expectation is that of the existing
  normal days (`baseline_feb03_normal`, `summer_normal_jul05`): no ticket, benign or none, no false ticket, at detection
  level.
- **All six.** Split `heldout`, profiles `["heldout"]` only, `warmup_min` 60. Seeds are the odd numbers from 51, above every
  seed in use: the positives take them in definition order, then the negatives in draw order.

## Blindness

**What the author did.** The author read the planning documents, the failure table, the injection definitions, the slice
manifest and the scenario files, all of which are metadata. The author also read the planning statistics' anomaly lists,
their start and end instants only, through the script.

**What the author did not do.** No MetroPT-3 row of a candidate day was read: not the CSV, not a cut held-out slice, not the
statistics' `daily` table. No core-10 or tuning-list report, `run.json`, event log or cassette was opened. No held-out
scenario was run in any mode.

**What remains exposed.** This is disclosed, not hidden:

- **Aggregate statistics.** Statistics over the whole recording, held-out days included, existed before this set: the
  planning statistics (`data/metropt3-first-month-stats.json`, its `daily` table among them), a count of the short drain
  episodes made for a labelling decision, and the duration statistics that chose `GATE_PERSIST_SIM_MIN` = 1 (every day outside the labelled windows ±48 h
  and the core-10 slices). The held-out days contributed to those aggregates. The evidence that none of them was studied
  on its own is E6: no committed document names it.
- **The whole-recording scenario.** `metropt3_full` (profiles `dev` and `full`) replays every day, these included, without
  an injection. Dev runs have been made, E6 runs the full profile, and the reports of
  such runs list every ticket with its time. Until the final run, nobody reads a full-recording report's tickets on a held-out day. The two
  negatives are held out from design; they are not held out from every replay ever made. The four positives inject a fault
  no run has seen on its day.
- **The decision itself.** This decision and every design decision of 2026-09-23 and 2026-09-24 were made after the E3
  and E4 results had been seen. This set is the first data that design could not have been fitted to.

## The draw (2026-09-24)

`python3 heldout_selection.py` printed what follows. It ran once with its result shown, after the rule and
the script were committed. Running it again prints the same, because it reads that fixed tree and its seed is fixed.

Three earlier runs are disclosed. All three happened before the rule was committed, and none showed a day. The script
ran twice with its result held back, to check that it worked: once printing only the number of eligible days (8), and
once with the draw discarded unread. A scratch prototype of E0–E6 printed the number of days each rule touched and the
list of days the tracked text names. The rule was not changed after any of these runs.

**Eligible days: 8 of the 184 candidates.** They are 2020-03-17, 2020-03-22, 2020-03-23, 2020-04-05, 2020-04-24,
2020-06-26, 2020-06-29 and 2020-08-01. A day can be excluded by several rules at once. Over the 184 candidates, E1
touches 28 days, E2 64, E3 127, E4 127, E5 19 and E6 112.

**Definitions.** `air_leak_downstream` and `oil_cooler_fouling` by the rule; `intake_valve_sticking` and
`motor_overload` by the draw.

| Case | Scenario | Slice | Day (2020) | Injection | Budget | Seed |
| --- | --- | --- | --- | --- | --- | --- |
| positive | `heldout_air_leak_downstream_jun26` | `heldout-jun26` | 26 June | `air_leak_downstream` at 12:03, 240 min | 180 min | 51 |
| positive | `heldout_intake_valve_sticking_mar17` | `heldout-mar17` | 17 March | `intake_valve_sticking` at 14:50, 180 min | 120 min | 53 |
| positive | `heldout_motor_overload_mar22` | `heldout-mar22` | 22 March | `motor_overload` at 04:29, 240 min | 120 min | 55 |
| positive | `heldout_oil_cooler_fouling_jun29` | `heldout-jun29` | 29 June | `oil_cooler_fouling` at 06:39, 600 min | 360 min | 57 |
| negative | `heldout_normal_aug01` | `heldout-aug01` | 1 August | — | — | 59 |
| negative | `heldout_normal_apr05` | `heldout-apr05` | 5 April | — | — | 61 |

The instants are in the data clock (UTC). Each injection runs at magnitude 1 for its definition's default duration.
Every day replays whole, `[D 00:00, D+1 00:00)`. `make fixtures` cut the six slices, and `--report` measured their
rows: 8,551, 8,717, 8,716, 8,678, 8,677 and 8,684, in calendar order. Nothing was read from them beyond those counts and
their hashes.

**Checked without a run.** `pnpm --filter @fdp/eval run validate` loads and binds all 28 scenario files, the six
included, for the `core` and the `heldout` profiles. Each positive binds one window on its injected fault, and no
held-out day carries an excluded window. `make fixtures --verify` and `scripts/data/slices.test.ts` check each held-out
slice's bytes, row count, segment and timestamps against its definition, without replaying it. No held-out scenario was
run, in any mode.

## The seal

The files below are frozen. `tools/eval/test/heldout-seal.test.ts` recomputes every hash here on each test run. It
fails when a held-out file or slice entry changes, or when one is added or removed without a new seal. A new seal is a
deliberate decision: it is recorded in this file, with its reason, and it is not an edit made to fit a result.

Scenario files: the sha256 of the committed bytes, in `sha256sum -c` form.

```text
ef5509d8ddc2dc733da3c322db35321e65d75abbf97977c88c05ab5ab65f80c6  tools/eval/scenarios/heldout_air_leak_downstream_jun26.json
42d8cbb848f5de4b837162d8238c716c8e70dcee831af1342b44e847e536b633  tools/eval/scenarios/heldout_intake_valve_sticking_mar17.json
e29bf5dd385496890ab66f37298beb91a2bacddc39e92173f0f415330d0569f3  tools/eval/scenarios/heldout_motor_overload_mar22.json
cd10e1c593298155d3f7301bc289c5cb5b523387889cd0f11b265d9f704b2ab4  tools/eval/scenarios/heldout_normal_apr05.json
0b1df73563b28912fbae64c1854a12362a16e79ed9303d565cb3665d9e013fa3  tools/eval/scenarios/heldout_normal_aug01.json
e915ae2c2e4bbb53791ec4ef2f1324254fb8aaaf083659366c319aac4ed63bad  tools/eval/scenarios/heldout_oil_cooler_fouling_jun29.json
```

Slice entries of `data/fixtures/metropt3-slices.json`: the sha256 of each entry's canonical JSON, with keys sorted and
no whitespace (Python's `json.dumps(entry, sort_keys=True, separators=(",", ":"))`, the harness's `canonicalJson`). The
entry carries the cut file's own sha256, so this also seals the rows.

```text
f48d0deec08796ef7951a8bccdf6f894a2dae85abaaef332e752efca11fcfa4f  slice-entry:heldout-mar17
50e92c8ca801f6a1bfe1785d2251d3d11afa34a78c4cbe367a02d949fe4bbd6e  slice-entry:heldout-mar22
8ef5a388c2f760a29728ff579ddecf1d0c813d3e5e6b5c8cd26c9b89fc89350f  slice-entry:heldout-apr05
6d0649abba2f9a61dbd708bb43ab78f75fcfbc4865a60378f4e31fe9f373d0f2  slice-entry:heldout-jun26
275b92771fddc606a4dfe1833779bb9f2616a5130f97699a2d8cb529f9fe845c  slice-entry:heldout-jun29
a6031a9de5874f2e4a2104f0042188b71d90b917be934b75a892d5d5eed2b477  slice-entry:heldout-aug01
```

Sealed on 2026-09-24. **Rule: the held-out set runs once, after the Jev thresholds are fixed under the
pre-registration.**

## The guards

Each guard sits where the thing it guards is decided. Every one is tested without replaying a held-out scenario:
`tools/eval/src/heldout.test.ts`, the sweep tests and `tools/eval/test/heldout-seal.test.ts`.

- **The loader** (`scenario/load.ts`). Split `heldout` holds if and only if the profiles are exactly `["heldout"]`. A
  held-out scenario replays a `heldout-*` slice and has no per-profile override. No other scenario may replay a
  `heldout-*` slice. So `smoke`, `core`, `dev` and `full` can never select a held-out scenario.
- **The selection** (`runner/run.ts`). `--scenario` under any other profile refuses a held-out id by name. The run loop
  refuses `heldout` without `--final-heldout`, and refuses it once the record exists, before anything is bound.
- **The tuning list** (`tuning.ts`). Its guard refuses a held-out id.
- **The configuration** (`config.ts`). `--profile heldout` is refused without `--final-heldout`. It is also refused when
  it comes from `EVAL_PROFILE`, with `--scenario`, `--seed`, `--fail-on-gate` or `--exit-eval`, without `jev` in
  `--backends`, with `EVAL_JEV_MODE` other than `live`, and without `--confirm-live`. `--final-heldout` with any other
  profile or with `--tuning` is refused. Once `tools/eval/records/heldout-final-run.md` exists, every held-out run is refused.
- **The live plan** (`backends/select.ts`). The plan is a mock replay. It never runs for a held-out run that would not go
  on to run.
- **The sweep** (`commands/sweep.ts`, `metrics/sweep.ts`). A run of the held-out set is never re-gated, whatever the
  flags.
- **The chosen triple** (`config.ts`, `choice.ts`; added on 2026-09-24 with the Jev thresholds pre-registration's
  amendment, and changing nothing sealed). The final run is refused unless `GATE_PERSIST_SIM_MIN`,
  `JEV_GATE_REVIEW_MIN_CONFIDENCE` and `JEV_GATE_TICKET_MIN_CONFIDENCE` are exactly the triple the pre-registered sweep
  chose. The triple is read from its committed record, `tools/eval/records/jev-thresholds-choice.md`, and the run is also refused
  before that record exists or while it is uncommitted or changed since its commit.
- **The slice replay test** (`replay/index.test.ts`). It replays every defined slice except the held-out ones.
