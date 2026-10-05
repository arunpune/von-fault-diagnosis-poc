<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Cassettes: recording Von once, replaying it offline

A cassette is one exchange with the live TypeSafe API: the request the harness sent and the answer Von gave. The
harness records cassettes once, with a key and an explicit `--confirm-live`, and replays them afterwards with no key, so
a run scores Von's real answers again as often as needed without calling the API. No live call happens before the
harness has printed its planned calls and estimated cost, and no recorded answer is committed
([below](#why-cassettes-are-not-committed)). How the evaluation uses them is in
[`docs/evaluation.md`](../../docs/evaluation.md#cassettes).

## What a cassette is

```text
tools/eval/fixtures/cassettes/von-1.13.0/<request_digest>.json      schema: tools/eval/schemas/cassette.schema.json
```

- `request_digest` is the sha256 of the canonical JSON of the request's `{ model, state, questions }`: keys sorted, no
  whitespace, values as `JSON.stringify` prints them (`src/backends/digest.ts`). The same question about the same state
  is the same cassette.
- `request` is what the backend sent: the decision state (fictional machine words) and the question set. `response` is
  what Von answered the first time: `model`, `answers` and `usage`. `recorded_wall_ts` and `backend_version` say when
  and by which `@fdp/backend` the request was built.
- A run can send the same request more than once: an episode whose state has not moved is decided again every interval
  with the same state and questions, and Von need not answer it the same way each time. `repeat_responses` holds the
  answer to every further time the recording run sent it, in order, and the replay serves the n-th answer to the n-th
  arrival, so a replay of the recorded profile makes every decision the live run made. A new recording run replaces a
  cassette's answers; it never appends to an older run's.
- `persist_sim_min` is the `GATE_PERSIST_SIM_MIN` of the recording run whose answers the cassette holds, and
  `other_recordings` keeps the answers of recording runs made at other values of it, one recording per value. The Von
  thresholds pre-registration records the tuning list twice, at 0 and at 1, into this one store (its amendment of
  2026-09-24 in [`records/von-thresholds-preregistration.md`](records/von-thresholds-preregistration.md)), and the two runs send many of the same requests. A recording run therefore replaces only the recording at
  its own value and keeps the others, and a replay at N is served the recording made at N: a cassette that holds no
  recording at N is a miss at N. A cassette recorded before recordings were told apart has no `persist_sim_min` and serves
  any value, except to the pre-registered sweep's replays: they read each N on the recording made at N and on no other,
  so there such a cassette is a miss, and a miss withholds the choice.
- The answers are stored as the API returned them. A Score answer's `legend` echoes each level exactly as the backend
  asked it, an object `{ summary, signals }`; the mock's response schema takes that shape, and the cassette server
  checks every recorded answer against it when it starts, so a recording it could not serve stops the run by name
  instead of failing every decision with a 500.
- A cassette never holds a key, a header or a scenario label. The store refuses a cassette whose digest is not the
  digest of its own request or whose file is not named after it, so an edited cassette is an error that names the file,
  never a silent miss.

## How Von is reached

`EVAL_VON_MODE` picks the mode; `auto`, the default, takes the first that applies:

| Mode       | When                                      | What answers                                                                                     |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `live`     | `TYPESAFE_API_KEY` is set                 | the TypeSafe API at `TYPESAFE_BASE_URL`, with `--confirm-live` only; `--record` writes cassettes |
| `cassette` | cassettes exist for `VON_MODEL`           | a local cassette server: the recorded answers, and the mock's answers for a miss                 |
| `mock`     | no key and no cassettes, and always in CI | the contracts' mock server; the report marks the column "mock — not informative"                 |

Before any live call the harness replays the run's scenarios once against the contracts' mock and prints the planned
calls and the estimated cost; without `--confirm-live` it stops there with exit 1. So with a key in the
environment, `auto` resolves to `live` and `make eval` prints the plan and refuses: set `EVAL_VON_MODE=cassette` or
`mock` to run without calling.

In every mode the backend is the pipeline's own `createVonBackend`: the same state, the same questions, the same SDK,
the same parser. A cassette hit also gets back the usage the live call billed, so a cassette run costs, in the report,
what the live run it replays cost. Cassette mode replays through the contracts mock, so it answers only `von-1.13.0`.

The report names the mode of every backend. `run.json` carries `cassette_hits`, `cassette_misses`, the digest of every
missed request and `cassette_reused`, the hits that asked for a request more often than its cassette recorded answers
and got the last one again; `report.md` repeats them under "Caveats", and the summary on stdout prints them. A cassette
recorded before `repeat_responses` existed holds one answer per request (the last one the run got), so its replay
reports reused hits, and those decisions need not be the live run's; re-recording keeps every answer.

## Workflow

Recording makes paid calls, so it is a deliberate step taken by hand: CI and the default Make targets never run
`record`, `test:live` or a live profile.

1. **Plan.** With `TYPESAFE_API_KEY` exported in the shell from your `.env` (never printed or copied elsewhere), ask for
   the plan:

   ```sh
   pnpm --filter @fdp/eval run record -- --profile core
   ```

   The harness replays the core profile once against the contracts' mock, prints the planned Von calls, tokens and cost
   at the dated prices, and stops with exit 1 having called nothing. Without a key it prints one line naming
   `TYPESAFE_API_KEY` and exits 1.

2. **Approve.** Check the printed calls and estimated cost against your budget; the next step spends it.

3. **Record.** Once, after that check:

   ```sh
   pnpm --filter @fdp/eval run record -- --profile core --confirm-live
   ```

   Every answered call is written as a cassette under `tools/eval/fixtures/cassettes/von-1.13.0/`, and the run writes its
   reports as `fdp-eval run` does.

4. **Replay, with no key.**

   ```sh
   EVAL_VON_MODE=cassette make eval
   ```

   A replay of the recorded profile expects zero misses and zero reused hits, and then makes every decision the live
   run made. The Von column is informative and, when every core-10 scenario was scored, decides the gate.

5. **Misses mean re-record.** A miss is a request no cassette answers: the backend's state or questions changed since the
   recording (new detection wording, a catalog change, a new question). The mock answers it, so the Von column is no
   longer Von's alone. The report lists the missed digests; the fix is to re-record (steps 1 to 3), never to edit a
   cassette.

## The tuning list and its resamples

The Von thresholds pre-registration ([`records/von-thresholds-preregistration.md`](records/von-thresholds-preregistration.md))
reads a recording of the tuning list, never of the core-10. It is recorded the same way, with `--tuning` in place of
`--profile core`:

```sh
GATE_PERSIST_SIM_MIN=0 VON_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning                  # the plan at N = 0; calls nothing
GATE_PERSIST_SIM_MIN=1 VON_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning                  # the plan at N = 1; calls nothing
GATE_PERSIST_SIM_MIN=0 VON_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning --confirm-live   # the recording at N = 0, paid
GATE_PERSIST_SIM_MIN=1 VON_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning --confirm-live   # the recording at N = 1, paid
```

Since the pre-registration's amendment of 2026-09-24 the sweep chooses `GATE_PERSIST_SIM_MIN` with Von's pair, each N on
its own recording, so the list is recorded twice. Both recordings go into the one store, each kept under its own N (above),
in either order. The plan and the recording run at the environment's N; the plan names it (`persist_sim_min` in the live
plan's log line), and `record` warns at an N the sweep does not replay. Record with `VON_GATE_REVIEW_MIN_CONFIDENCE=0.60`
and `VON_GATE_TICKET_MIN_CONFIDENCE` unset: the sweep replays with Von gated at 0.60 / 0.85, and `record` warns when
Von's pair is another. Then `make eval-sweep` replays each recording with no key, once per **resample**. Resample 0
serves every arrival of a request the answer it got live; resample r (`fdp-eval run --resample r`, cassette mode only) serves the answers of a repeated
request rotated by r, so the arrival resample 0 answers with answer i gets answer (i + r) mod k. Each resample is a
permutation of what Von really answered, and over as many resamples as the fullest cassette holds answers, every arrival is
served every answer. A request recorded once gets that answer in every resample. `run.json` carries the resample a run served
(`cassette_resample`) and the most answers any cassette it hit holds (`cassette_answers_max`). A resample can still miss: a
rotated answer can open a ticket the recording did not, an episode that owns a ticket is decided on another frame, and that
request has no cassette. The sweep then reports the miss and chooses nothing.

**Von's default pair.** The paragraph above describes the recordings as they were made. Von's pair now defaults to
0.65 / 0.85, the pre-registered choice ([`records/von-thresholds-choice.md`](records/von-thresholds-choice.md)). The
recordings made at 0.60 / 0.85 are the core profile's of 2026-09-23 and the tuning list's two of 2026-09-24. A cassette replay of any of them sets
`VON_GATE_REVIEW_MIN_CONFIDENCE=0.60`, and so does a re-recording; otherwise `record --tuning` warns and the replay's
requests miss. The pre-registered sweep sets that pair itself, whatever the environment says.

## Keys, rate limits and failures

- Keys come from the environment only and stay inside the configuration's `EvalSecrets`; the logger redacts key-shaped
  fields, and no key, header or raw provider body reaches a log, a report or a cassette. Replaying needs no key.
- Live calls go through one serial queue with a token bucket at 600 requests per minute. The SDK retries a 429 or a 529
  twice with backoff, honouring `retry-after`; the harness then pauses one full minute and tries once more, and a second
  failure is recorded as a failed decision. `run.json` gives each live backend's requests, retries and waited time.
- Failed decisions are never silent, in any mode. `run.json` gives each backend's `failures` and their
  `failure_reasons`; `report.md` opens its headline with a warning and stdout prints a `WARNING:` line above the gate.
  When every decision of a backend failed, its column is marked not informative and a gate it heads is `NOT SCORED`
  rather than a FAIL: there was no answer to judge.
- `--backends rules,von,llm` adds the optional LLM column (`LLM_MODEL`, default `claude-opus-5`). It runs live or not at
  all: without `LLM_API_KEY` it is dropped with a warning, and with it the plan and `--confirm-live` apply as for Von. It
  has no cassettes.

## Live smoke tests

```sh
pnpm --filter @fdp/eval test:live -- --confirm-live
```

`test/live/von.live.test.ts` and `test/live/anthropic.live.test.ts` each make one real decision about the F3 scenario's
first suspect event, check only its shape, the model id and the billed input tokens, and print the cost. Each is skipped
without its key and refuses to call without `--confirm-live`. They make paid calls, so run them only when you mean to.

## Why cassettes are not committed

Von is a third-party model, and whether its recorded answers and the figures derived from them may be published depends
on TypeSafe's terms. This repository therefore publishes none: `tools/eval/fixtures/cassettes/` stays in `.gitignore`,
every Von-derived figure stays in the gitignored `reports/`, and CI runs Von in mock mode, whose column is marked not
informative.

## Cost expectations

Everything in this section is an estimate, not a measurement. The decision count is an order of magnitude: roughly 100
to 200 decisions for the core profile. The token count per decision is what the contracts' mock bills for the backend's
golden F3 request, 4,306 input tokens (`ceil(bytes / 4)` of the state and the questions;
`apps/backend/test/fixtures/von/f3-usage.json`), rounded to about 4,300. Von bills input tokens only, at USD 0.042 per
million as published by TypeSafe, September 2026 (`VON_PRICE_INPUT_PER_MTOK`, `PRICES_AS_OF=2026-09-19`):

| Decisions | Estimated input tokens | Estimated cost at USD 0.042 per million |
| --------- | ---------------------- | --------------------------------------- |
| 100       | ≈ 430,000              | ≈ USD 0.018                             |
| 200       | ≈ 860,000              | ≈ USD 0.036                             |

The optional LLM column costs far more per decision. It is sent the same state and the same three questions, in prose;
at USD 5 and 25 per million input and output tokens, as published by Anthropic, September 2026, a request of about the
same size and an estimated 300 output tokens make roughly USD 0.03 a decision, so USD 3 to 6 for the core profile. The
plan the harness prints before any live run is the figure to approve; these are orders of magnitude.
