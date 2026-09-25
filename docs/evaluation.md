<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Evaluation

This guide covers the evaluation harness in `tools/eval`: what it replays and how it keeps ground truth away from the diagnosis, the scenarios and profiles, the three ways it reaches Jev, the metrics and the evaluation gates they feed, how to read a report, how to score a running stack and sweep the gate thresholds, and where the current results stand. Read it before you run `make eval`, when a report or an evaluation record needs interpreting, and before you change a scenario or a metric. The package's own [README](../tools/eval/README.md) lists every flag and file, and [`tools/eval/records/`](../tools/eval/records/) holds the records of the threshold choice and the held-out set.

Running it needs the development toolchain of [development.md](development.md) and the dataset slices, but neither Docker nor a key:

```bash
make install         # the workspace dependencies, once
make fetch-dataset   # download MetroPT-3 into data/metropt3/ and verify it, once
make fixtures        # cut the slices the scenarios replay into data/fixtures/metropt3/, once
make eval            # the core profile with the rules baseline and Jev; reports under reports/eval/
```

Without a key and without recorded cassettes, Jev runs against a mock server and its column is marked not informative (see [How Jev runs](#how-jev-runs)).

The harness reads its settings from its flags and the process environment, never from `.env`: neither `make eval` nor the harness loads that file, so set a variable on the command line (`EVAL_PROFILE=full make eval`) or export it. `make eval` passes no flag, so flags go through the package script, as in `pnpm --filter @fdp/eval run eval -- --help`.

## What the harness replays, and how it stays apart from the diagnosis

`tools/eval` is the workspace package `@fdp/eval`, written in TypeScript and run straight from source, so it can import the backend's own pipeline. A run does not talk to a running stack (that is [stack mode](#scoring-a-running-stack)). It builds the backend's own pipeline in process, `createPipeline()` from `@fdp/backend/pipeline`, with the backend's catalog retriever, decision backends and confidence gate, and feeds it telemetry it replays itself. Nothing in the harness re-implements detection, retrieval, the decision or the gate: it adds the input (the replay, the injections and the controller's alarms) and the judgement (the labels and the metrics).

```mermaid
flowchart TB
    CFG["Flags and environment<br/>profile, backends, Jev mode"] --> SEL["Select the scenarios<br/>a profile, a scenario list or the tuning list"]
    SEL --> BIND["Bind each scenario to ground truth<br/>windows, accepted faults, excluded windows"]
    GT[("@fdp/ground-truth<br/>failure table, injections")] --> BIND
    BIND --> PREP["Check the slices are cut, load the catalog,<br/>build the backends, plan any live call"]
    PREP --> PAIR{"Next scenario<br/>and backend"}
    PAIR --> REPLAY["Replay the slice or the CSV<br/>ambient lane, injections, CTRL-7 alarms"]
    GT -->|"injection definitions"| REPLAY
    subgraph pipe["@fdp/backend/pipeline, the production code"]
        DIAG["Detection, retrieval,<br/>decision backend, gate"]
    end
    REPLAY -->|"telemetry-samples only"| DIAG
    DIAG -->|"events, decisions, tickets"| REC["Recorder"]
    REC --> SCORE["Score against the bound windows"]
    REPLAY -->|"alarm raises"| SCORE
    SCORE -->|"next pair"| PAIR
    PAIR -->|"all pairs done"| SUM["Summary, core-10 gate,<br/>MetroPT-3 check, exit eval"]
    SUM --> OUT["run.json, latest.json, report.md,<br/>console summary, exit code"]
```

Everything that can fail on configuration fails before the first row is replayed: a scenario that does not bind, a slice that is not cut, a catalog that cannot be read or a live call without consent. Each scenario is then replayed once per backend through a fresh pipeline.

### The replay

The replay engine in `tools/eval/src/replay/` reproduces the simulator's value path. For each row of a slice, or of the whole CSV, it follows the simulator's own order: it classifies the machine state from the recorded values, fills the synthetic ambient-temperature lane, overlays any scheduled injection with the simulator's transforms, evaluates a port of the CTRL-7 controller's alarm logic over the manual's alarm registry (`manual/spec/alarms.yaml`), and finally quantises the values through the register codec, so the pipeline sees what a Modbus reader would decode. Samples leave in `telemetry-samples` batches of at most 25, the message the gateway publishes, with the discontinuity flag on the first sample and after any step longer than 60 s. The ambient lane is filled on every replay, recordings included, because the simulator writes it into every sample. The injections and the replay clock are described in [simulation.md](simulation.md).

A parity test proves the port against the real simulator and gateway: `tools/eval/test/integration/parity.test.ts` builds both images, replays the same slice through them and through the port, and compares sample by sample: untouched tags equal, injected analog tags within one register step, the ambient lane within 0.35 °C, noise compared statistically and the alarm lists identical. It needs Docker, so it runs in `make test-integration`, never in `make eval`.

### What an in-process run does not exercise

The in-process pipeline has no database, broker or browser. Retrieval is the pipeline's database-free catalog retriever (signal moves and keywords), not the Postgres vector and full-text search the stack uses, and there is no MQTT or WebSocket transport and no heartbeat. Every report says so in its caveats, and [stack mode](#scoring-a-running-stack) measures the stack itself. Wall time is a fake clock that advances 1 ms per batch, so with the rules backend, the mock or the same cassettes two runs of the same profile give the same metrics; the generated ticket and episode ids and the wall-clock stamps differ. A live Jev answer is the one input that is not reproducible.

### Ground truth stays on the harness side

Ground rule 3 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)) makes the harness and the backend's read-only overlay the only readers of ground truth. The harness reads labels in two places: in process from `@fdp/ground-truth` (the failure table and the injection definitions), and in stack mode from the `gt` schema as the `eval` database role, whose grants there are SELECT, inside a read-only transaction. The pipeline under test receives `telemetry-samples` batches and nothing else: the injection definitions go to the replay engine, which overlays them on the rows before they become samples, and no scenario, window or label reaches a pipeline port. Mechanical guards keep it that way:

- the dependency-cruiser rules `eval-only-pipeline-entry` and `eval-allowed-imports` limit the harness to `@fdp/contracts`, `@fdp/ground-truth`, `@fdp/db-migrate` and the backend's single `./pipeline` entry, and `no-gt-reachable-from-diagnosis` keeps any chain of imports from leading diagnosis code to ground truth or to the harness;
- `tools/eval/test/boundaries.test.ts` repeats the allow-list inside the package;
- a host test serialises the pipeline's ports and checks that no `failure_id`, `injection_id`, `preset_id` or `gt/` string is in them.

The stack-wide picture is in [architecture.md](architecture.md#ground-truth-isolation) and in the README's [ground-truth diagram](../README.md#ground-truth-stays-out-of-the-diagnosis).

## Scenarios and profiles

### The scenario format

A scenario is one JSON file in `tools/eval/scenarios/`, named after its id and validated against `tools/eval/schemas/scenario.schema.json` (`urn:fdp:eval:scenario:v1`). It states what to replay, what to inject, which ground truth applies and what passing means. It never carries a label of its own: failure times, accepted fault ids and excluded windows are resolved from `@fdp/ground-truth` when the file is loaded, so the failure table and the injection definitions stay the single source. A reference that does not resolve (a slice that does not cover the range, an unknown injection or failure id, a parameter outside its bounds) fails at load time. `pnpm --filter @fdp/eval run validate` loads and binds every file without replaying a row, checks the reference catalog and writes `reports/eval/catalog-validation.md`.

| Field                  | What it says                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `title`, `notes` | The id equals the file stem; the notes say why this window and where its facts come from                                                                                                                              |
| `group`                | `recording_positive`, `injected`, `negative`, `abstain` or `diagnostic`                                                                                                                                               |
| `split`, `positive`    | `test` for the ten scenarios the gates count, `heldout` for the sealed held-out set, `dev` for the rest; `positive` is true exactly when the scenario expects a ticket                                                |
| `profiles`             | The profiles that replay it                                                                                                                                                                                           |
| `source`               | A named slice of `data/fixtures/metropt3-slices.json`, or `{ "kind": "csv" }` for the whole recording at `METROPT_CSV`                                                                                                |
| `replay`               | The half-open range `[from, to)` in the dataset clock (UTC), with optional per-profile overrides                                                                                                                      |
| `injections`           | Injection ids from `packages/ground-truth/data/injections.json`, each with its start and parameters                                                                                                                   |
| `ground_truth`         | `failure` (a failure id), `recording` (every headline failure in the range), `injection`, `negative`, `abstain` (with a reason) or `diagnostic` (with a note)                                                         |
| `expect`               | `tickets` (`at_least_one` or `none`), `fault` (`accepted`, `injected`, `benign_or_none` or `any`), `within_min` (the latency budget of a positive), `max_false_tickets` and `pass_level` (`detection` or `diagnosis`) |
| `design_target`        | Optional, on a diagnostic dev scenario only: the causes a diagnosis of its unlabelled episode is read against and where they come from; reported by the tuning readout and the sweep, never scored or gated           |
| `native_alarm_codes`   | The controller codes lead time is measured against                                                                                                                                                                    |
| `warmup_min`           | Minutes at the start that are replayed but whose tickets are not scored (default 60)                                                                                                                                  |
| `seed`                 | Recorded with the run; nothing in the replay consumes it today, because injection noise is seeded from the instance id                                                                                                |

An example, `tools/eval/scenarios/f3_air_leak_jun05.json` with its `notes` left out:

```json
{
  "schema": "urn:fdp:eval:scenario:v1",
  "id": "f3_air_leak_jun05",
  "title": "Air leak, signature A, 5 June 2020",
  "group": "recording_positive",
  "profiles": ["smoke", "core", "full"],
  "split": "test",
  "positive": true,
  "source": { "kind": "slice", "name": "f3-jun05" },
  "replay": {
    "from": "2020-06-05T04:00:00.000Z",
    "to": "2020-06-06T04:00:00.000Z",
    "overrides": { "smoke": { "to": "2020-06-05T14:00:00.000Z" } }
  },
  "ground_truth": { "kind": "failure", "failure_id": "F3" },
  "expect": {
    "tickets": "at_least_one",
    "fault": "accepted",
    "within_min": 120,
    "max_false_tickets": 0,
    "pass_level": "diagnosis"
  },
  "native_alarm_codes": ["W101", "W102", "W103"],
  "warmup_min": 60,
  "seed": 11
}
```

### Groups, splits and the core-10

- `recording_positive`: a stretch of the recording with a documented failure, or the whole recording.
- `injected`: a catalog fault injected into a normal working day: 3 February 2020, except the leak's dev twin on
  5 July 2020 and the held-out injections on their drawn days.
- `negative`: normal operation, which should open no ticket.
- `abstain`: a benign cause with alarming symptoms (a warm machine room, a faulty oil-temperature transmitter, a depot depressurisation), which should open no ticket naming a fault that is not benign.
- `diagnostic`: replayed and listed but never scored, because its windows are unlabelled or secondary.

The ten scenarios of the `test` split are the core-10, the set the evaluation gates count. Six of them are positives: the four recorded air leaks F1 to F4 and two injected faults. Twelve more scenarios are the `dev` split, and six are the sealed `heldout` split ([below](#the-held-out-set)).

### The profiles

| Profile          | Scenarios                                                                                                                   | What it is for                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke`          | 5, four of them over a shortened range                                                                                      | A fast check; the `eval-smoke` job of `.github/workflows/ci.yml` runs it with Jev on the mock                                          |
| `core` (default) | 10, the core-10                                                                                                             | The gates of E3 and E4                                                                                                                 |
| `dev`            | 12, the dev split: every scenario outside the core-10 and the held-out set                                                  | The complement of `core`; not a tuning set, because it replays `metropt3_full` and `f4_precursor_jul14`, which cover headline failures |
| `full`           | 18, the core-10 and the dev split less its three diagnostic scenarios and the leak's dev twin, the whole recording included | E6; needs the full CSV at `METROPT_CSV` (default `data/metropt3/MetroPT3(AirCompressor).csv`)                                          |
| `heldout`        | 6, the sealed held-out set                                                                                                  | One run, after Jev's thresholds were fixed; refused ever since ([The held-out set](#the-held-out-set))                                 |
| `--tuning`       | 10, the list in `tools/eval/src/tuning.ts`                                                                                  | The only scenarios design tuning and the threshold sweep may read, so the core-10 stays out of every tuning decision                   |

`--tuning` replaces the profile: it cannot be combined with `--profile` or `--scenario`, it ignores `EVAL_PROFILE`, and the run is recorded with profile `tuning`. Before anything is replayed, a guard refuses any core-10 scenario, any scenario bound to a headline failure and any `recording` scenario. The four dev injections replay the same day as five core-10 scenarios; they inject faults the core-10 does not, so they are reported rather than refused.

The full profile streams the whole recording through one pipeline, with a progress line per calendar month; nothing restarts at a month boundary. The rules backend replays the whole recording in about a minute on a development machine.

### Every scenario

| Scenario                               | Group              | Split   | Replays (UTC, 2020)                                                                      | Profiles          |
| -------------------------------------- | ------------------ | ------- | ---------------------------------------------------------------------------------------- | ----------------- |
| `f1_air_leak_apr18`                    | recording_positive | test    | slice `f1-apr18`, 17 Apr 20:00 to 19 Apr 04:00; failure F1                               | core, full        |
| `f2_air_leak_may30`                    | recording_positive | test    | slice `f2-may30`, 29 May 18:00 to 30 May 12:00; failure F2                               | core, full        |
| `f3_air_leak_jun05`                    | recording_positive | test    | slice `f3-jun05`, 5 Jun 04:00 to 6 Jun 04:00 (smoke: to 5 Jun 14:00); failure F3         | smoke, core, full |
| `f4_air_leak_jul15`                    | recording_positive | test    | slice `f4-jul15`, 15 Jul 12:00 to 16 Jul 02:00; failure F4                               | core, full        |
| `inject_oil_cooler_fouling`            | injected           | test    | slice `baseline-feb03`, 3 Feb (smoke: to 10:00); `oil_cooler_fouling` at 02:00           | smoke, core, full |
| `inject_air_leak_downstream`           | injected           | test    | slice `baseline-feb03`, 3 Feb; `air_leak_downstream` at 02:00                            | core, full        |
| `inject_high_ambient_benign`           | abstain            | test    | slice `baseline-feb03`, 3 Feb; `high_ambient_temperature` at 02:00                       | core, full        |
| `inject_oil_temperature_sensor_fault`  | abstain            | test    | slice `baseline-feb03`, 3 Feb (smoke: to 10:00); `oil_temperature_sensor_fault` at 02:00 | smoke, core, full |
| `baseline_feb03_normal`                | negative           | test    | slice `baseline-feb03`, 3 Feb (smoke: to 08:00)                                          | smoke, core, full |
| `depot_lps_jul31`                      | abstain            | test    | slice `depot-jul31`, 31 Jul 00:00 to 08:00                                               | smoke, core, full |
| `f4_precursor_jul14`                   | recording_positive | dev     | slice `f4-jul15`, 14 Jul 06:00 to 15 Jul 14:30; failure F4 from its precursor            | dev, full         |
| `metropt3_full`                        | recording_positive | dev     | the whole CSV, 1 Feb 00:00 to 1 Sep 00:00; every headline failure                        | dev, full         |
| `inject_dryer_tower_switching_failure` | injected           | dev     | slice `baseline-feb03`, 3 Feb; injection at 02:00                                        | dev, full         |
| `inject_intake_valve_sticking`         | injected           | dev     | slice `baseline-feb03`, 3 Feb; injection at 02:00                                        | dev, full         |
| `inject_motor_overload`                | injected           | dev     | slice `baseline-feb03`, 3 Feb; injection at 02:00                                        | dev, full         |
| `inject_separator_drain_blocked`       | injected           | dev     | slice `baseline-feb03`, 3 Feb; injection at 02:00                                        | dev, full         |
| `inject_air_leak_downstream_jul05`     | injected           | dev     | slice `summer-jul05`, 5 Jul; `air_leak_downstream` at 02:00, the core leak's dev twin    | dev               |
| `summer_normal_jul05`                  | negative           | dev     | slice `summer-jul05`, 5 Jul                                                              | dev, full         |
| `frozen_logger_jun22`                  | negative           | dev     | slice `frozen-jun22`, 22 Jun 12:00 to 23 Jun 00:00                                       | dev, full         |
| `f4b_recurrence_jul17`                 | diagnostic         | dev     | slice `f4b-jul17`, 16 Jul 18:00 to 17 Jul 08:00; failure F4b                             | dev               |
| `unlabelled_leak_may19`                | diagnostic         | dev     | slice `unlabelled-may19`, 19 May 20:00 to 21 May 00:00                                   | dev               |
| `august_oil_level_aug10`               | diagnostic         | dev     | slice `august-aug10`, 10 Aug                                                             | dev               |
| `heldout_air_leak_downstream_jun26`    | injected           | heldout | slice `heldout-jun26`, 26 Jun; `air_leak_downstream` at 12:03                            | heldout           |
| `heldout_intake_valve_sticking_mar17`  | injected           | heldout | slice `heldout-mar17`, 17 Mar; `intake_valve_sticking` at 14:50                          | heldout           |
| `heldout_motor_overload_mar22`         | injected           | heldout | slice `heldout-mar22`, 22 Mar; `motor_overload` at 04:29                                 | heldout           |
| `heldout_oil_cooler_fouling_jun29`     | injected           | heldout | slice `heldout-jun29`, 29 Jun; `oil_cooler_fouling` at 06:39                             | heldout           |
| `heldout_normal_apr05`                 | negative           | heldout | slice `heldout-apr05`, 5 Apr                                                             | heldout           |
| `heldout_normal_aug01`                 | negative           | heldout | slice `heldout-aug01`, 1 Aug                                                             | heldout           |

A day without times, such as "3 Feb", is the whole day from 00:00 to 00:00. The slices, the failure table and its excluded windows are described in [dataset.md](dataset.md).

### The held-out set

Every scenario above except the six `heldout` ones was written, or had its window chosen, by people who had seen the recording's headline failures, and several scoring and design rules were set after the in-sample results had been seen ([Decisions that shape the figures](#decisions-that-shape-the-figures)). The held-out set is the one measurement nothing in the design could have been fitted to. Its six scenarios sit on six days of their own, each replayed whole from its own slice: four positives, which inject `air_leak_downstream` and `oil_cooler_fouling` (the two faults behind the core-10's injected positives) and two faults drawn from the other non-benign definitions, `intake_valve_sticking` and `motor_overload`, and two normal days. The days, the two drawn faults and the injection instants were drawn by a fixed, seeded rule from the days no committed file named and no labelled failure, unlabelled episode, known anomaly, gap or existing slice touched, without reading a row of those days. Each scenario carries the expectation of the committed scenarios for its fault or for a normal day, and the set has no pass threshold of its own. [`tools/eval/records/heldout-seal.md`](../tools/eval/records/heldout-seal.md) records the rule, the draw, what stayed exposed and the SHA-256 seal of every file; `tools/eval/test/heldout-seal.test.ts` fails when a sealed file changes.

The set runs once. Until that run only `fdp-eval validate` could read it: no other profile, `--scenario`, the tuning list, the sweep or a live plan selects it. The one run is

```bash
EVAL_JEV_MODE=live pnpm --filter @fdp/eval run eval -- --profile heldout --final-heldout --backends rules,jev --record --confirm-live
```

and the harness refuses `heldout` without `--final-heldout`, with `--scenario`, `--seed`, `--fail-on-gate` or `--exit-eval`, with Jev in any mode but live, and with any gate triple but the one recorded in [`tools/eval/records/jev-thresholds-choice.md`](../tools/eval/records/jev-thresholds-choice.md). The run was made on 2026-09-24 and is recorded in [`tools/eval/records/heldout-final-run.md`](../tools/eval/records/heldout-final-run.md); since that record exists, every further held-out run is refused.

### Running a profile

| Flag                       | Default                       | What it does                                                                                                                                                                 |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>`         | `EVAL_PROFILE`, else `core`   | `smoke`, `core`, `dev`, `full` or `heldout`; the flag wins over the variable                                                                                                 |
| `--tuning`                 | off                           | Replay the tuning list instead of a profile                                                                                                                                  |
| `--scenario <id>`          | every scenario of the profile | Narrow the run; repeatable; an id outside the profile is refused                                                                                                             |
| `--backends <list>`        | `rules,jev`                   | Any of `rules`, `jev` and `llm`, in report order                                                                                                                             |
| `--catalog <source>`       | `reference`                   | `reference` (`tools/eval/fixtures/catalog.json`, written by `make manual`), `file:<path>` (a contracts catalog document) or `ingested` (a stack's database, with `--db-url`) |
| `--db-url <url>`           | none                          | The `eval` role's connection string, for `--catalog ingested`                                                                                                                |
| `--record`                 | off                           | Write every live Jev answer as a cassette                                                                                                                                    |
| `--confirm-live`           | off                           | Allow a live backend to call its API                                                                                                                                         |
| `--out <dir>`              | `reports/eval`                | Where the run directory is written                                                                                                                                           |
| `--fail-on-gate`           | off                           | Exit 2 when the core-10 gate fails, is out of reach or is not scored                                                                                                         |
| `--exit-eval e3`           | off                           | Check every E3 condition the run can see; exit 2 when one breaks                                                                                                             |
| `--resample <n>`           | 0                             | Cassette mode only: serve the n-th rotation of each repeated request's recorded answers ([Choosing Jev's thresholds](#choosing-jevs-thresholds))                             |
| `--final-heldout`          | off                           | The held-out set's one run; refused once it is recorded                                                                                                                      |
| `--jobs <n>`, `--seed <n>` | 1, none                       | `--jobs` above 1 is refused, because the loop is sequential; `--seed` is recorded on every scenario run                                                                      |

The backend variables of the README's [Configuration](../README.md#configuration) table, such as the model ids, the prices, `GATE_TICKET_MIN_CONFIDENCE`, `GATE_REVIEW_MIN_CONFIDENCE`, `DECISION_INTERVAL_SIM_MIN`, `EPISODE_CLEAR_SIM_MIN` and `RULES_DISABLED`, are read with the same defaults as the backend and passed to the pipeline unchanged; like every other setting, they come from the environment, not from `.env`. Some examples, from the package README:

```bash
EVAL_PROFILE=smoke EVAL_JEV_MODE=mock make eval
pnpm --filter @fdp/eval run eval -- --profile smoke --scenario f3_air_leak_jun05
pnpm --filter @fdp/eval run eval -- --tuning --backends rules --catalog reference
EVAL_PROFILE=full make eval
```

## How Jev runs

`--backends` names the backends a run compares. The rules baseline always runs in process and costs nothing. Jev is always the pipeline's own `createJevBackend`, with the same state, the same questions, the same SDK and the same parser; `EVAL_JEV_MODE` decides only where its requests go.

| Mode       | `auto` picks it when                         | What answers                                                                                    | The Jev column                        |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------- |
| `live`     | `TYPESAFE_API_KEY` is set in the environment | The TypeSafe API at `TYPESAFE_BASE_URL`, after a plan and `--confirm-live`                      | Informative                           |
| `cassette` | No key, and cassettes exist for `JEV_MODEL`  | A local server replaying recorded answers; a miss is answered by the mock and counted           | Informative, with its hits and misses |
| `mock`     | Neither                                      | The contracts' mock TypeSafe server from `@fdp/contracts/mock`, with its `best-overlap` answers | `mock — not informative`              |

```mermaid
flowchart TD
    M{"EVAL_JEV_MODE"} -->|"live, cassette or mock"| AS["That mode, or exit 1<br/>when it cannot be built"]
    M -->|"auto, the default"| K{"TYPESAFE_API_KEY<br/>in the environment?"}
    K -->|"yes"| L["live<br/>planned first, calls only<br/>with the confirm-live flag"]
    K -->|"no"| C{"Cassettes for<br/>JEV_MODEL?"}
    C -->|"yes"| CS["cassette<br/>recorded answers,<br/>misses answered by the mock"]
    C -->|"no"| MK["mock<br/>column not informative"]
```

An explicit `EVAL_JEV_MODE` is taken as asked and fails with exit 1 when it cannot be built: `live` without a key, `cassette` without cassettes. The cassette and mock modes answer only `jev-1.13.0`, the one model the mock serves.

### Live runs and recording

A live run is planned before anything is called, so a paid call is never a surprise: the harness replays the run's scenarios once against the mock, counts the decisions, prices them at the dated prices and logs the plan. Without `--confirm-live` it stops there with exit 1, having called nothing. So `make eval` with `TYPESAFE_API_KEY` exported prints the plan and refuses, while `EVAL_JEV_MODE=cassette` or `mock` runs without calling. Live calls go through one serial queue per backend at 600 requests per minute; the SDK retries a 429 or 529 twice, and the harness then waits 60 s and tries once more before it records a failed decision.

```bash
# with TYPESAFE_API_KEY exported, a live run: the plan and its estimated cost are logged first
pnpm --filter @fdp/eval run eval -- --confirm-live
# a recording: a run with Jev live and --record forced on
pnpm --filter @fdp/eval run record -- --profile core --confirm-live
```

A recording is a paid run; [`tools/eval/CASSETTES.md`](../tools/eval/CASSETTES.md) has the workflow and the cost expectations, and [security.md](security.md) covers the keys.

### Cassettes

A cassette is one exchange with the live API, stored as `tools/eval/fixtures/cassettes/jev-1.13.0/<request_digest>.json` against `tools/eval/schemas/cassette.schema.json`. The digest is the SHA-256 of the canonical JSON of the request's model, state and questions, so the same question about the same state is the same cassette. A cassette keeps every answer its recording run received for that request, in order, and a replay serves the n-th answer to the n-th arrival, so a replay of the recorded profile makes every decision the live run made; an arrival past the last recorded answer gets that answer again and is counted as reused. A hit also returns the recorded token usage, so the report's cost is the live run's. The store refuses an edited or misnamed cassette, and the server checks every recorded answer against the mock's response schema when it starts.

A miss means the backend's state or questions changed since the recording. The mock answers it, the report lists the missed digests, and the remedy is to re-record, never to edit a cassette. Giving the diagnosis the evidence the manual uses to separate high air demand from a leak changed every Jev request, so cassettes recorded before that change no longer match. `auto` picks cassette mode as soon as any cassette exists for `JEV_MODEL`, whichever profile it was recorded for, so set `EVAL_JEV_MODE=mock` when a run covers scenarios the cassettes were never recorded for.

Cassettes are gitignored until TypeSafe's terms allow publishing them, so a fresh clone has none and runs Jev on the mock.

### The mock

Without a key or cassettes, and always in CI, Jev talks to the contracts' mock server on a free local port. The backend, the state, the questions and the parser are the real ones; only the judgement is not Jev's, because the mock answers with its deterministic `best-overlap` policy. A Jev figure produced in mock mode is never quoted as a result.

### The optional LLM column

`--backends rules,jev,llm` adds the Anthropic Claude backend (`LLM_MODEL`, default `claude-opus-5`). It runs live or not at all: without `LLM_API_KEY` it is dropped with a warning, and with the key the plan and `--confirm-live` apply as for Jev. It has no cassettes. The backends themselves are described in [decision-backends.md](decision-backends.md).

### How every report says which

- The header of `report.md` lists each backend with its mode and model, and every column heading carries the mode: `jev · live`, `jev · cassette` or `jev · mock — not informative`.
- `run.json` records each backend's `mode`, whether it is `informative`, its calls and failures and, in cassette mode, `cassette_hits`, `cassette_misses`, `cassette_miss_digests` and `cassette_reused`; a live backend adds its rate-limit counters.
- The report's caveats and the console summary repeat the mode with those counters.
- Every table that carries Jev figures opens with a notice: Jev-derived figures stay in the gitignored `reports/` until TypeSafe's terms allow publishing them.

The run's gate is Jev's only when Jev ran live or from cassettes; with a mock Jev it is the rules baseline's. Failed decisions are never silent: `report.md` opens with a bold warning and the console prints a `WARNING:` line with their count and reasons. When every decision of a backend failed, its column is marked not informative and a gate it heads reads `NOT SCORED` rather than a fail.

## The metrics

The code is `tools/eval/src/metrics/`: pure functions that import no pipeline code and serve the in-process runner, stack mode and the sweep alike.

### Tickets, windows and the two levels

The unit of scoring is the ticket, one per episode; the gate and the episodes are described in [decision-backends.md](decision-backends.md). Scoring decisions instead would count one leak dozens of times, because an episode is decided again every 30 simulated minutes while its rule keeps firing. Each ticket is summarised by when it opened, the fault it named when it opened, its latest fault and its highest level: `ticket` once it reached the ticket threshold, `review` if it never left the review queue. Every figure is computed at two levels:

- ticket level counts only the tickets that reached the ticket threshold;
- review level counts every ticket, review items included.

Tickets are matched against the windows a scenario binds from ground truth:

- a failure window from the MetroPT-3 failure table, with its accepted fault ids;
- an injection window from the injection's start for its duration, whose accepted fault is the injection definition's `fault_id`; the window of a benign injection is never a positive;
- excluded windows, which count as neither positive nor negative: the failure table's frozen-logger blocks, repairs, depot depressurisations, unlabelled positive episodes and the secondary positive F4b, and the recording's gaps over one hour, each extended by a 30-minute tail.

A failure window takes precedence over an excluded window that overlaps it. Tickets opened during the warmup (`warmup_min` after the replay start) are replayed but never scored.

### The true-positive span

A ticket is a true positive for a positive window when it opens inside the window's true-positive span and names an accepted fault. The span runs from `span_from` to the window's end. `lead_from` is the failure's `precursor_from` when it has one, else its labelled start; `span_from` is the earlier of `lead_from` and the data onset when the onset is known, else `lead_from`. The rule is `spanFrom` in `tools/eval/src/metrics/match.ts`, the only implementation. On the committed failure table:

| Window | Labelled start | `lead_from`                 | Data onset                   | Span opens      |
| ------ | -------------- | --------------------------- | ---------------------------- | --------------- |
| F1     | 18 Apr 00:00   | the start                   | 00:23:59, only a lower bound | 18 Apr 00:00    |
| F2     | 29 May 23:30   | the start                   | 23:14:56                     | 29 May 23:14:56 |
| F3     | 5 Jun 10:00    | the start                   | 09:48:30                     | 5 Jun 09:48:30  |
| F4     | 15 Jul 14:30   | the precursor, 14 Jul 21:28 | 15 Jul 14:25:23              | 14 Jul 21:28    |
| F4b    | 16 Jul 20:00   | the start                   | 17 Jul 00:54                 | 16 Jul 20:00    |

Opening the span at a known onset credits a system that sees a failure in the data before its labelled start. The rule was set after the in-sample results had been seen, so every figure it affects stays labelled in-sample. It moved no label: the failure table is unedited, and a ticket opened before the onset, such as one on F2's early purge-pressure blips at 21:36 and 22:51 on 29 May, is still a false positive, because those blips count as negative time. One consequence was kept on purpose: a ticket-level ticket that names a benign cause and opens between the onset and the labelled start of F2 or F3 is the first ticket inside the window, so the scenario fails diagnosis even when a correct ticket follows.

### Ticket verdicts

Every ticket a replay opened carries one verdict:

| Verdict        | Meaning                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tp`           | The first ticket inside a positive window's span that names an accepted fault                                                                                                   |
| `recovered`    | A correct ticket after a misdiagnosis in the same window; it is the window's true positive                                                                                      |
| `duplicate`    | A later correct ticket for a window already detected; never a false positive                                                                                                    |
| `misdiagnosed` | Inside a positive window's span, naming another fault that is not benign; a false positive for the fault it names, and the window stays missed unless a later ticket is correct |
| `benign`       | Names a cause the ground truth calls benign; neither a true nor a false positive                                                                                                |
| `ignored`      | Opened inside an excluded window and outside every positive window; counted apart, never scored                                                                                 |
| `fp`           | Any other ticket                                                                                                                                                                |
| `warmup`       | Opened during the warmup; replayed, never scored                                                                                                                                |

The verdicts are read from the review-level classification, in which every ticket takes part. A positive window without a true positive is a false negative. Where two windows overlap, a ticket is scored against the one that accepts its fault.

### Precision and recall per fault

- Precision for a fault is its true positives over its true and false positives. Each ticket counts for the fault it named when it opened, so a misdiagnosis is a false positive for the fault it wrongly named.
- Recall for a fault is the number of detected windows that accept it over the number of windows that accept it; a window that accepts two faults is one chance for each.
- The micro aggregate pools the counters, with false negatives counted per window; the macro aggregate averages the per-fault ratios that are defined. A ratio with a zero denominator is `null` in `run.json` and a dash in `report.md`, never 0.

Both are reported at ticket and review level.

### Lead time against the unit's own alarms

Lead time is how many minutes before the controller's own warning the system named the fault:

```text
lead time (min) = first native alarm raise in [span_from, end) − first correct ticket
```

A positive figure means the ticket came first. How each part is measured now:

- The native alarms are the scenario's `native_alarm_codes`: W101 (line pressure low), W102 (continuous load time exceeded) and W103 (dryer purge pressure high) for every F1 to F4 scenario and for `metropt3_full`. A scenario without the field uses every warning, shutdown warning and shutdown code of the registry except W116 (oil level low).
- The raises come from the harness's CTRL-7 port, evaluated on the replayed values; in stack mode they are read from `app.native_alarms`. The report header names the alarm registry and its SHA-256, and a report made with the provisional registry of `tools/eval/fixtures/alarms-provisional/` says its lead times are indicative only.
- The search for the first raise covers the same stretch in which a ticket is credited, `[span_from, end)`; it used to cover `[lead_from, end)`. In-process scoring, stack mode and the sweep's re-score share the one `spanFrom`; the sweep passes no alarms, so its rows carry no lead time.
- The first correct ticket is the window's true positive at review level, so an item that only reached the review queue counts.
- A window nobody detected has no lead-time row: its miss is already a false negative.

For F3 the change moves the reference from nothing to the first warning inside the credited stretch. The search from 10:00 found no raise of W101 to W103 in F3's replay; the search from the onset finds W103 at 09:51:19, then W102 at 09:58:35. For F2 the reference becomes the W103 raised at 23:16:35; F1, F4 and F4b do not move.

```mermaid
gantt
    title F3 on 5 June 2020 as the scorer reads it now (UTC)
    dateFormat YYYY-MM-DD HH:mm:ss
    axisFormat %H:%M
    todayMarker off
    section Failure table
    Labelled window, continues to 7 June :active, lab, 2020-06-05 10:00:00, 2020-06-05 10:30:00
    Data onset :milestone, onset, 2020-06-05 09:48:30, 0d
    section Scoring
    True-positive span and native-alarm search :span, 2020-06-05 09:48:30, 2020-06-05 10:30:00
    section CTRL-7 raises
    W103 dryer purge pressure high :milestone, w103, 2020-06-05 09:51:19, 0d
    W102 continuous load time exceeded :milestone, w102, 2020-06-05 09:58:35, 0d
```

Two figures sit beside the lead time in the report:

- Lead vs LPS measures against the failure table's own `native_alarm_first`, the first activation of the low-pressure switch, which the table records for F3, F4 and the secondary F4b but not for F1 and F2. It does not move with the span.
- Detection latency is the first correct ticket minus the data onset (for an injected window, the injection start). F1's onset is only a lower bound, so its latency carries `≥`.

The latency budget of a scenario, `within_min`, runs from the later of the data onset and the end of the warmup.

### False tickets per negative machine-day

A rate over wall time would flatter a backend that ran while the logger was frozen, so the rates divide by machine time the replay actually covered:

- Covered machine-days are the replayed range minus the union of its excluded windows (the frozen-logger blocks, repairs, depot depressurisations, unlabelled episodes, F4b and the gaps over one hour with their 30-minute tail). Overlapping stretches are subtracted once, and gaps shorter than an hour are not subtracted.
- Negative machine-days are the covered time minus the positive windows, each from where its span opens.
- Tickets per machine-day are the scored tickets, review items included, over the covered machine-days.
- False tickets per negative machine-day are the false positives, misdiagnoses included, over the negative machine-days. The comparison table counts them at review level; the whole-recording block of a full run gives both levels.

Over the whole recording this leaves 158.1 negative machine-days. Subtracting every gap (909.5 hours) and the frozen-logger blocks (170.6 hours) from the 213.2-day span would give about 168; the binder instead subtracts only the gaps over one hour, with their 30-minute tail, but also every excluded window and the headline windows. In stack mode the covered time is the telemetry minutes the stack aggregated, minus the jumps, the gaps and the excluded windows.

### "None of these": abstention accuracy

The abstain cases are the scenarios of the `abstain` group; in the core-10 they are `depot_lps_jul31`, `inject_high_ambient_benign` and `inject_oil_temperature_sensor_fault`. A case is correct when no scored ticket names a fault that is not benign and every decision in it either answered `none_of_these` with a confidence at or above the review threshold, named a benign cause, or was gated to a log line. Abstention accuracy is the share of correct cases. The explicit abstention rate beside it is the share of decisions in those cases flagged `abstained`, that is `none_of_these` at or above the review threshold: how often the backend said "none of these" in as many words.

### Detections inside unlabelled episodes

The failure table lists unlabelled positive episodes, stretches that look like a failure but were never reported, as excluded windows. A ticket opened inside one is `ignored` by the matching and is never a false positive. The whole-recording block of a full run lists every such ticket, warmup included, with its fault, level and episode, and counts them separately.

### The MetroPT-3 check

The check asks whether each of the four headline failures (the failure table's `in_headline`: F1 to F4) was found. On tickets it asks for a true positive: at ticket level for Jev (E4), at review or ticket level for the rules backend's baseline. At detection level, which E3 reads, it asks for a suspect event in the failure's credited span within its scenario's budget; every backend summary carries it beside the ticket check. Every report labels it in-sample, because the detection rules were designed after inspecting F1 to F4. A run's summary pools every scenario that binds a headline window; a full run also reads the whole recording on its own, in the `full_recording` block, which is what E6 reads.

### Cost

Each decision costs its input tokens times the input price plus its output tokens times the output price, per million tokens, at the dated prices (`JEV_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK`, `PRICES_AS_OF`), summed per scenario, per backend and per ticket. Jev bills input tokens only, the rules backend costs nothing, and a cassette hit carries the usage the live call billed.

### When a scenario passes, and the gate

- Detection level, read on suspect events rather than tickets: a positive needs a suspect event, raised after the warmup, in the credited span of one of its windows (the true-positive span above) within its budget; a normal-operation negative (group `negative`) needs to raise no suspect event after the warmup outside the excluded windows; an abstain scenario keeps the ticket rule of review diagnosis.
- Review diagnosis: a scenario that expects a ticket needs a true positive at review level that opens within its budget, and no more false tickets than `max_false_tickets`; a negative or abstain scenario needs zero false tickets (benign, warmup and ignored tickets are not false). This is what the detection level meant before E3 was scored on suspect events.
- Diagnosis level: review diagnosis and, for a scenario that expects a ticket, the first ticket-level ticket inside the window names an accepted fault within the budget; a negative or abstain scenario passes diagnosis when it passes review diagnosis.
- Diagnostic scenarios print `reported` and never enter the summary.

The core-10 gate passes with at least 8 of the 10 scenarios and at least 5 of the 6 positives at the backend's level, rules at detection and Jev at diagnosis, so a backend that never raises anything cannot pass on the negatives alone. The rules backend's two diagnosis flags are reported beside it as a baseline and never gated. A core-10 scenario the run did not score counts as failed. A partial run (the smoke profile, a scenario list, a tuning run) reports the gate as `attainable` or `unattainable` instead of `pass` or `fail`; only a core run decides it. `--fail-on-gate` exits 2 on `fail`, `unattainable` and `not_scored`.

### The evaluation gates E1 to E6

The project is checked against six evaluation gates, E1 to E6, each a command with a pass condition. The same scenario files and metric code serve every gate; only the profile, the backends and the pass level change. A pass never depends on editing a scenario's expectation or the ground truth to fit a result, a key is never needed for E1 to E3 or E5, every report names the backend's mode, and a Jev figure produced in mock mode is never quoted as a result.

- **E1, the source of truth and the reference catalog.** `make check-manual` passes every acceptance check of the manual PDFs ([manual.md](manual.md#acceptance-checks)), and `pnpm --filter @fdp/eval run validate` loads the reference catalog with every fault id the ground truth uses resolved.
- **E2, contracts, ground truth and simulation.** The harness's unit and integration tests pass, the parity test among them: the TypeScript replay matches the simulator and the gateway ([The replay](#the-replay)).

The four this harness scores:

| Exit eval                | Backend and level | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E3, rules-only detection | rules, detection  | At least 8 of the core-10 and 5 of the 6 positives pass at detection level, a suspect event in each positive's credited span within its budget; the MetroPT-3 check finds 4 of 4 at that detection level on the F1 to F4 slices; `baseline_feb03_normal` and `frozen_logger_jun22` raise no suspect event, warmup and excluded windows included; `inject_high_ambient_benign` and `inject_oil_temperature_sensor_fault` produce no ticket naming a cause that is not benign; `depot_lps_jul31` opens no ticket at all. The rules backend's tickets are reported as a baseline, never gated |
| E4, the Jev backend      | jev, diagnosis    | At least 8 of the core-10 and 5 of the 6 positives pass; the MetroPT-3 check finds 4 of 4 at ticket level, or 4 of 4 at review level with a written note per miss; abstention accuracy is at least the rules baseline's; zero cassette misses when replaying; cost per decision reported and the core profile under USD 0.05                                                                                                                                                                                                                                                               |
| E5, the whole system     | the stack         | `make smoke`, `make e2e` and `make eval-stack` pass on one kept stack; the stack scoring finds the jump to F3, the `oil_cooler_fouling` injection window, a ticket or review item naming an accepted fault in the F3 window and a review or ticket item for the injected fault; the `eval` role reads `gt.*` and cannot write; the smoke profile is green in CI                                                                                                                                                                                                                            |
| E6, the full dataset     | rules or jev      | The MetroPT-3 check finds 4 of 4 at ticket level on the whole recording for at least one backend; false tickets per negative machine-day are reported (target at most 0.5 with Jev; a higher figure does not fail the gate but must be discussed in the CHANGELOG); detections inside unlabelled episodes are reported separately                                                                                                                                                                                                                                                          |

E3 is scored at detection level, a suspect event in the credited span, rather than on tickets. It is checked with `--exit-eval e3`, which reads the rules backend, marks each of its five conditions (`core10_counts`, `metropt3_check`, `negatives_no_suspect`, `abstain_non_benign`, `depot_no_ticket`) `pass`, `fail` or `not_covered` (a condition counts as covered only when the run replayed the scenario's whole range, and an uncovered condition is never passed), and gives the verdict `pass`, `fail` or `incomplete`; beside it, `exit_eval.baseline` records the rules backend's diagnosis figures with `gated: false`. No single run covers all of E3, because `frozen_logger_jun22` is in the dev split, so its recipe is two readings plus an ablation on the reference catalog:

```bash
# no key needed
uv run --package fdp-init fdp-init export-catalog --manual data/manual/cau-7-realistic.pdf --out reports/eval/ingested-realistic.json
EVAL_JEV_MODE=mock pnpm --filter @fdp/eval run eval -- --profile core --backends rules,jev --catalog file:reports/eval/ingested-realistic.json --fail-on-gate --exit-eval e3
EVAL_JEV_MODE=mock pnpm --filter @fdp/eval run eval -- --profile core --backends rules,jev --catalog reference --fail-on-gate --exit-eval e3
pnpm --filter @fdp/eval run eval -- --profile dev --backends rules --scenario frozen_logger_jun22 --exit-eval e3
```

The headline reading scores the catalog init extracts from the realistic PDF, the path the stack ships; the reference catalog is the ablation. E3 passes only when neither the headline reading nor the frozen-logger reading is `fail` and each shows the conditions the other did not cover. E4 is `make eval` with Jev live or from cassettes, then `make eval-sweep`; E6 is `EVAL_PROFILE=full make eval`.

## Reading a report

### Where the files go

```text
reports/eval/
├── latest.json                        a copy of the newest in-process run.json
├── catalog-validation.md              written by fdp-eval validate
├── ingested-realistic.json            the catalog exported for E3's headline reading, when made
├── <yyyymmdd-hhmmss>-<profile>/       one in-process run: smoke, core, dev, full, heldout or tuning
│   ├── run.json                       the run, schema urn:fdp:eval:report:v1
│   ├── report.md                      the same run for a person
│   └── scenarios/<scenario>.<backend>.jsonl
├── <yyyymmdd-hhmmss>-stack/           a stack scoring: run.json, report.md, stack.json, scenarios/
└── sweep/                             make eval-sweep: the pre-registered choice of the triple
    ├── preregistered-sweep.json       every triple on every resample, the rule's outcome and its reason
    ├── preregistered-sweep.md         the same for a person
    └── persist-<N>/resample-<r>/      one tuning replay per N and resample: latest.json and a run directory
```

A run id is the UTC start time and the profile, such as `20260923-113630-full`; a second run in the same second gets a `-2` suffix. `reports/` is gitignored. Each event log in `scenarios/` holds every output of the pipeline for one scenario and backend, except a decision's state and raw provider bodies, which appear only as a `state_digest`. No key enters a report, a log line or a cassette, and no header or raw provider body enters a report.

### The console summary

A run prints its summary on stdout; log lines go to stderr. It gives one line per scenario with each backend's `detection · review diagnosis · diagnosis` flags, a `WARNING:` line for failed decisions, the gate with both counts, the cassette or live counters, the MetroPT-3 check, the whole-recording line of a full run, the tuning list's shared slices, the `--exit-eval` verdict and the paths of `run.json` and `report.md`. The whole-recording line of the rules-only full run of [Current results](#the-rules-only-baseline-on-the-whole-recording) (in-sample and provisional) reads:

```text
whole recording (metropt3_full, rules): MetroPT-3 check 0/4 ticket, 0/4 review; false tickets per machine-day 0.063 ticket, 0.209 review over 158.1 negative machine-days; 0 detection(s) inside unlabelled episodes
```

### report.md

The page opens with a header table: the profile, the scenario filter, each backend with its mode and model, the catalog and its SHA-256, the alarm registry, the ground-truth package version and data digests, the gate thresholds, the rules left out, the prices, the commit, the runtime and the wall clock. Eight sections follow:

| Section                        | What it holds                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline                       | Failed-decision warnings; the core-10 gate with both counts; the MetroPT-3 check, labelled in-sample; a full run's whole-recording figures; under `--exit-eval e3`, the verdict, every condition with its evidence and the rules diagnosis baseline; every scenario with its group, split and `detection · review diagnosis · diagnosis` per backend |
| Comparison                     | One row per metric, one column per backend with its mode; the rules confidence and Jev's are never compared, because the rules confidence is a margin, not a probability                                                                                                                                                                             |
| Per-fault precision and recall | Precision and recall at ticket and review level, and true positives, false positives and false negatives at ticket level, per backend and fault                                                                                                                                                                                                      |
| Lead times                     | Per detected window: the first correct ticket, the native alarm and when it was raised, the lead vs native, the lead vs LPS and the latency                                                                                                                                                                                                          |
| Abstention                     | Accuracy, correct cases, the explicit abstention rate, and why each case was judged as it was                                                                                                                                                                                                                                                        |
| Cost                           | Decisions, tokens and dollars per backend at the dated prices, and the run's total                                                                                                                                                                                                                                                                   |
| Scenarios                      | Per scenario and backend: the pass flags and their reasons, the suspect events read at detection level, the replay, the decisions by gate outcome, the windows, every ticket with its verdict, the excluded windows, what was still open when the replay ended and a design target's reading                                                         |
| Caveats                        | The backends' modes and counters, the catalog source, a provisional or disabled alarm registry, tickets still open, the provisional failure table, the limits of an in-process run, partial-run and tuning notes, an incomplete exit eval                                                                                                            |

A ticket still open when its replay ended is scored as it stood, as opened at its opening time.

### run.json

`run.json` is validated against `tools/eval/schemas/report.schema.json` before it is written. It holds `run` (the id, the mode `in_process` or `stack`, the profile, the commit, the Node and backend versions, the ground-truth version and digests, the catalog, the alarm registry, the thresholds and the prices), `backends[]`, `scenarios[]` (one per scenario and backend, with its windows, excluded windows, benign faults, tickets with their verdicts, suspect events, every decision with its choice, confidence and gate outcome, its metrics and its pass flags), `summary` and `gate`, and, when the run asked for them, `tuning`, `exit_eval` and `full_recording`, and `design_targets` when a replayed scenario carries one (never gated). A stored `run.json` holds everything a re-score needs, which is what the sweep reads.

### Exit codes

| Code | Meaning                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | The run completed; under `--fail-on-gate` the gate held; an incomplete `--exit-eval` check alone is still 0                 |
| 1    | A usage or configuration error, including a live run without `--confirm-live`                                               |
| 2    | Under `--fail-on-gate` the gate failed, or `--exit-eval` found a covered condition broken                                   |
| 3    | The run was aborted: a scenario that does not bind, rows missing on this machine, an unreadable catalog, a pipeline failure |

## Scoring a running stack and sweeping the gate thresholds

### Scoring a running stack

`make eval-stack` runs `fdp-eval score-stack` against a running Compose stack, for example the one `make smoke SMOKE_ARGS=--keep` leaves running, or a `make up-dev` stack after you have played a scenario in the UI. It connects as the `eval` role through `DATABASE_URL_EVAL`, which defaults to the URL `scripts/smoke.sh --keep` writes to `reports/smoke/db-url-eval`, else to `postgres://eval:eval@localhost:5432/fdp`, the Postgres `compose.dev.yaml` publishes.

```bash
make smoke SMOKE_ARGS=--keep && make eval-stack
pnpm --filter @fdp/eval run score-stack -- --db-url postgres://eval:eval@localhost:5432/fdp --from 2020-06-05T00:00:00Z
```

Everything is read inside one read-only transaction: the catalog the stack ingested, its tickets, decisions, episodes, controller alarms and cost ledger, the ground truth the overlay stored (`gt.v_injection_windows` and `gt.markers`) and the one-minute telemetry aggregates. Each island of consecutive telemetry minutes is a replayed segment. The windows are every headline failure window the segments overlap, so a jump to the F3 preset lands in F3's, and every injection window; a ticket's fault at open is what the decision that opened it named, and a ticket a technician closed is read as it stood at its first closure, without the verdict. Each backend is scored by the same metrics as one scenario, `stack_replay`, and written to `reports/eval/<yyyymmdd-hhmmss>-stack/` as `run.json` with `run.mode: "stack"`, `report.md` with a closing "Stack inputs" section, and `stack.json`, which names the segments, markers and windows with their origin, the thresholds and the ledger. The command never writes to the database or to `latest.json`; `--from` and `--to` limit the simulated time it scores, and it exits 3 when the database holds nothing replayed or decided in that range. Retrieval here is the backend's Postgres path, and a stack whose Jev endpoint is the mock, such as the CI stack, has a Jev column that is not informative.

### Sweeping the gate thresholds

```bash
pnpm --filter @fdp/eval run eval -- --tuning --out reports/eval/tuning
pnpm --filter @fdp/eval run sweep -- --run reports/eval/tuning/latest.json --grid 0.6:0.95:0.05x0.5:0.8:0.05
```

`fdp-eval sweep` re-gates a stored tuning run's decisions over a grid of threshold pairs. The gate depends only on a decision's choice and confidence, so no model is called again. The default grid is every ticket threshold from 0.60 to 0.95 with every review threshold from 0.50 to 0.80 at or below it, in steps of 0.05: 46 pairs. For each backend and pair the rebuilt tickets are scored by the run's own scorer, and the table gives the tickets, the micro precision and recall at ticket and review level, the false tickets per machine-day and the abstention accuracy. Each backend is re-gated around the pair its gate applied, and the row at that pair is marked and checked to reproduce the run. The run's episode merges are held as they were at every pair, and so are its decisions: an episode that owns no ticket is decided only once its evidence has held for `GATE_PERSIST_SIM_MIN`, while one that owns a ticket is decided at once, so a pair that opens a ticket sooner or later than the run did would have taken other decisions. A decision whose evidence had not yet held that long, which only an episode owning a ticket could take, never opens a ticket at another pair. Every row is still approximate. The output is a table per backend on stdout and `sweep.json` and `sweep.md` in the run's directory.

The sweep reads a tuning run only, so no threshold is chosen on the scenarios the gates count. It refuses a stack run and, unless `--allow-test-split` is given (which reports and never chooses), any run that is not a tuning run. The design target of `unlabelled_leak_may19` is read at every pair in a section of its own, marked as never counted; no row reads it. Its tables are readings, not proposals: a change to a `GATE_*` default cites the tuning run it rests on, and no threshold is lowered to pass an evaluation gate. The gate itself is described in [decision-backends.md](decision-backends.md), and the detection rules' own thresholds in [detection.md](detection.md).

### Choosing Jev's thresholds

The gate reads a pair of thresholds per backend. Jev's is `JEV_GATE_TICKET_MIN_CONFIDENCE` and `JEV_GATE_REVIEW_MIN_CONFIDENCE`, which default to ticket 0.85 and review 0.65. The rules and LLM backends keep the global pair, 0.60 and 0.85, because the rules confidence is a margin over candidate supports, a gating quantity on a different scale and not a calibrated probability.

Jev's pair, together with the persistence before a ticket (`GATE_PERSIST_SIM_MIN`, N), was chosen by a rule fixed in advance, before any Jev decision on the tuning list existed: [`tools/eval/records/jev-thresholds-preregistration.md`](../tools/eval/records/jev-thresholds-preregistration.md). The rule reads the tuning list only, never the core-10 or the held-out set; it sets a hard limit of 0.10 false tickets and 0.50 false reviews per negative machine-day, then applies the objective, tie and replacement clauses the file states, starting from the incumbent N = 1, 0.60 / 0.85. Its outcome, N = 1 with Jev at 0.65 / 0.85, is recorded in [`tools/eval/records/jev-thresholds-choice.md`](../tools/eval/records/jev-thresholds-choice.md), and those are the code defaults. Which clause decided is not published, because each clause states an outcome of Jev's figures on the tuning list.

The choice needs one Jev recording of the tuning list per N, made at 0.60 / 0.85:

```bash
GATE_PERSIST_SIM_MIN=0 JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning   # the plan at N = 0; calls nothing
GATE_PERSIST_SIM_MIN=1 JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning   # the plan at N = 1; calls nothing
make eval-sweep                                                                                             # after both recordings, with no key
```

The same two `record` commands with `--confirm-live` make the recordings, which are paid ([`tools/eval/CASSETTES.md`](../tools/eval/CASSETTES.md)). Because Jev's review threshold now defaults to 0.65, `record --tuning` warns unless `JEV_GATE_REVIEW_MIN_CONFIDENCE=0.60` is set, and any other cassette replay of the recordings made at 0.60 / 0.85 needs the same setting, or its requests miss. `make eval-sweep` sets that pair itself, whatever the environment says.

`make eval-sweep` runs `fdp-eval sweep --preregistered`. For each N of 0 and 1 it replays the tuning list for Jev alone from that N's recording, gated at 0.60 / 0.85, once per resample: resample 0 is the recording as it was answered, and each further resample serves every repeated request's recorded answers in another rotation (`--resample`), as many as the fullest cassette holds. It re-gates every resample over the pre-registered grid (review 0.50 to 0.80, ticket 0.70 to 0.95, review below ticket: 36 pairs), counts false tickets, false reviews and passed positives over the tuning list less `unlabelled_leak_may19` and `august_oil_level_aug10`, which are reported apart, and applies the selection rule as written: ties prefer N = 1 after fewer false reviews and fewer false tickets, before the pair closest to 0.60 / 0.85. It writes `reports/eval/sweep/preregistered-sweep.json` and `.md` with the chosen triple or "keep N = 1, 0.60 / 0.85", the reason and the readings of the rule it applied. It chooses nothing when a recording is missing or a resample could not be read as Jev's own answers: a cassette miss, a failed decision, or a replay the re-gating does not give back. The chosen N applies to the whole pipeline.

`pnpm --filter @fdp/eval run sweep -- --preregistered --from-runs --record-choice` writes the choice once to `tools/eval/records/jev-thresholds-choice.md`, with no Jev figure in it, and refuses when a record already exists. The held-out set's one run is refused with any other triple.

## Current results

Every figure below comes from the rules backend (`rules-v1`, no key, no cost) and the reference catalog unless it says otherwise. The detection rules were designed after inspecting F1 to F4, and the rules listed under [Decisions that shape the figures](#decisions-that-shape-the-figures) were set after the in-sample results had been seen, so every core-10 and whole-recording figure is in-sample. The figures are also provisional, because the failure table is a proposal that has not been independently reviewed. The held-out set is the one clean measurement.

Jev was evaluated live and from recorded cassettes, on the core profile, the tuning list and the held-out set. Its results are unpublished pending TypeSafe's terms: every Jev-derived figure stays in the gitignored `reports/`.

| Gate                                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3, rules-only detection               | Passes at detection level, in-sample, with both the realistic PDF's catalog and the reference catalog: 9 of 10 core-10, 5 of 6 positives and the MetroPT-3 check 4 of 4 at detection level, with every negative, abstain and depot condition met. `inject_air_leak_downstream` raises no suspect event. The rules diagnosis baseline, reported and never gated, is 4 of 10 and 0 of 6                                                                     |
| E4, the Jev backend at diagnosis level | Evaluated; results unpublished pending TypeSafe's terms                                                                                                                                                                                                                                                                                                                                                                                                   |
| E5, the whole system                   | The Compose smoke, the browser tour and the stack scoring passed on one kept stack on 2026-09-23, before the backend and gate changes of 2026-09-24, and have not been re-run since. The quick-start smoke (`make smoke-quickstart`), which runs the README's path with the rules backend and no key, stopped at its ticket check in the same round: the F3 decision stays below the review threshold, so no ticket opens, and E5 is not green as a whole |
| E6, the full dataset                   | Not met by the rules backend: 0 of 4 at ticket level on the whole recording (below). No Jev recording of the full profile was made                                                                                                                                                                                                                                                                                                                        |

### The rules-only baseline on the whole recording

`EVAL_PROFILE=full make eval` with the rules backend and the reference catalog (run `20260924-103619-full`):

| Measure                                | Value                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Replayed                               | 1,516,418 samples, 1 February to 31 August 2020, with 158.1 negative machine-days |
| Suspect events                         | 2,704, in 344 episodes                                                            |
| Decisions                              | 1,612: 1,507 gated to a log line, 72 to review, 33 to a ticket                    |
| MetroPT-3 check                        | 0 of 4 at ticket level, 0 of 4 at review level                                    |
| False tickets per negative machine-day | 0.063 at ticket level (10), 0.209 at review level (33)                            |
| Detections inside unlabelled episodes  | 0, reported separately, never a false positive                                    |

An earlier run, made before the evidence that separates high air demand from a leak, the injection changes and the persistence before a ticket, read 2,481 suspect events, 1,655 decisions (1,548 log, 68 review, 39 ticket), 0.089 and 0.253 false tickets per negative machine-day and 1 detection inside an unlabelled episode. The recording includes the core-10's days, so the difference is in-sample too, and nothing was tuned on it.

The rules confidence is a margin between the best candidates' supports, a gating quantity and not a calibrated probability ([decision-backends.md](decision-backends.md#why-the-confidence-is-a-margin)). For scale, E6 asks for 4 of 4 at ticket level and, for Jev, at most 0.5 false tickets per negative machine-day.

### The held-out run

The held-out set ran once, on 2026-09-24, with the rules backend and Jev, at N = 1 with Jev at 0.65 / 0.85 and the rules backend at 0.60 / 0.85 ([`tools/eval/records/heldout-final-run.md`](../tools/eval/records/heldout-final-run.md)). The set has no pass threshold. The rules backend's figures, the only clean ones published:

- Diagnosis: 0 of the 4 positives passed at diagnosis level, and both negatives passed without a ticket naming a cause that is not benign.
- Detection (a suspect event in the credited span): 3 of the 4 positives were detected; the intake-valve injection was not, a known limit of the detection rules.
- One negative day raised a `frequent_cycling` suspect event, so it fails the detection-level rule of no suspect event on a normal day. It opened no ticket.

Jev's figures on the held-out set are unpublished, like its other results.

### Decisions that shape the figures

Seven scoring and design rules were set after the in-sample results had been seen. Each bears on what the evaluation measures or how its figures are labelled:

| Rule                                                                                              | Effect on the evaluation                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The credited true-positive span opens at the earlier of the window start and the known data onset | The span opens at the onset for F2 and F3, and lead time searches its native alarm from there; a benign first ticket inside the span still fails diagnosis                                              |
| The downstream-leak injection keeps only the faster idle decay                                    | The leak injection keeps only its idle decay, over each whole not-loaded period, and no oil offset (nor does heavy demand); a dev twin on 5 July joins the tuning list                                  |
| F2's early purge-pressure blips count as negative time                                            | The labels stay; tickets on the blips stay false positives                                                                                                                                              |
| The diagnosis gets the evidence the manual uses to separate high air demand from a leak           | Changes detection's evidence, the Jev criteria and the candidate order, not the metrics; every Jev request changed, so earlier cassettes miss                                                           |
| E3 is scored at detection level: a suspect event in the credited span                             | E3 reads suspect events in each positive's credited span within its budget, and no suspect event on the normal-operation negatives; the thresholds stay; the rules diagnosis is a baseline, never gated |
| A sealed held-out set, run once                                                                   | Every earlier figure stays in-sample; six held-out scenarios, validated and never replayed before, ran once after Jev's thresholds were fixed ([The held-out set](#the-held-out-set))                   |
| The tuning list's design target                                                                   | Fixes what tuning may read; `unlabelled_leak_may19`'s design target (the signature-A pair, inferred and unverified) is reported by the tuning readout and the sweep, never gated                        |

The persistence before a ticket (`GATE_PERSIST_SIM_MIN`) was set the same way. The held-out set does not make any earlier figure clean.

Because `reports/` is gitignored, the records under [`tools/eval/records/`](../tools/eval/records/) repeat the commands, run ids and settings they quote; the [CHANGELOG](../CHANGELOG.md) and the README's [Evaluation](../README.md#evaluation) section summarise the rules baseline.

## Further reading

- [`tools/eval/README.md`](../tools/eval/README.md) and [`tools/eval/CASSETTES.md`](../tools/eval/CASSETTES.md): the package, its commands and the cassette workflow.
- [`tools/eval/records/`](../tools/eval/records/): the threshold pre-registration and choice, the held-out seal and its one run.
- Code: `tools/eval/src/replay/`, `tools/eval/src/scenario/`, `tools/eval/src/backends/`, `tools/eval/src/metrics/`, `tools/eval/src/report/`, `tools/eval/src/stack/`, `tools/eval/src/commands/sweep.ts`, `tools/eval/scenarios/` and `tools/eval/schemas/`.
- The other guides: [dataset.md](dataset.md), [simulation.md](simulation.md), [decision-backends.md](decision-backends.md), [detection.md](detection.md), [architecture.md](architecture.md) and [development.md](development.md).
