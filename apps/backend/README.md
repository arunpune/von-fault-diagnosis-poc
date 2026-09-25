<!--
SPDX-FileCopyrightText: 2026 Meddle S.r.l.
SPDX-License-Identifier: CC-BY-4.0
-->

# `@fdp/backend` — the diagnosis backend

The service that reads telemetry from the broker, decides what the machine is doing, asks the decision backend what is wrong with it,
and serves the result over REST and WebSocket. Where it sits in the stack is in [`docs/architecture.md`](../../docs/architecture.md); the
contracts it speaks are [`@fdp/contracts`](../../packages/contracts/README.md) and the schema it writes is
[`db/migrations`](../../db/migrations).

One pipeline (`src/pipeline`, the entry `tools/eval` also imports) does the diagnosis; `src/runtime` hosts it: the diagnosis broker
client feeds it telemetry, and the sinks write every event, decision, episode, ticket and cost row as `app_rw`, publish them on the
broker and push them to the browser over `GET /ws`.

## Running it

```bash
pnpm --filter @fdp/backend build     # tsc -> dist/, entry point dist/index.js
pnpm --filter @fdp/backend lint      # types, ESLint and the import boundaries
pnpm --filter @fdp/backend test      # unit and architecture tests, no Docker
pnpm --filter @fdp/backend test:integration   # testcontainers: PostgreSQL and Mosquitto
```

From the repository root, `make up` builds the image and starts the whole stack; the backend answers on the port the frontend proxies.

To run the backend from source against the rest of the stack, start the stack with the fixed development ports of
[`compose.dev.yaml`](../../compose.dev.yaml) (PostgreSQL on 5432, the broker on 1883), stop its own backend container so port 3000 is
free, and point the process at `localhost`:

```bash
make up-dev
docker compose -f compose.yaml -f compose.dev.yaml stop backend
pnpm --filter @fdp/backend build
PG_HOST=localhost PG_GT_PASSWORD=gt_rw \
MQTT_URL=mqtt://localhost:1883 MQTT_BACKEND_OPS_PASSWORD=backend-ops \
MODEL_CACHE_DIR="$HOME/.cache/fdp-models" EMBEDDER_ALLOW_DOWNLOAD=true \
node apps/backend/dist/index.js
```

The two overlay credentials are read by `src/overlay/config.ts` alone and have no default there, so a hand-run process names them; the
other variables fall back to the defaults below. `EMBEDDER_ALLOW_DOWNLOAD=true` fetches the pinned model into the cache directory the
first time (init does that for the Compose stack) and is not needed once the files are there.

Start-up runs these steps in order, one log line per step, failing fast with a named cause and exit code 1:

1. the environment (`src/config/env.ts`; a wrong variable is named, never its value);
2. the `app_rw` pool and the migration it must be at — against a database init has not prepared, the process says `run init first`;
3. the signal roles of the register map;
4. the query embedder, offline from `MODEL_CACHE_DIR` (a missing or corrupt file names its path);
5. the retriever, the decision backend (`DECISION_BACKEND`), the open episodes and tickets read back from the database, the pipeline;
6. the overlay (its own pool and broker credential), then the diagnosis broker client and its subscriptions;
7. the HTTP server and `/ws`, the retained `plant/cau-7/status/backend`, and a one-second timer for the heartbeat, the aggregate writes
   (every five seconds or five hundred rows) and the retention run (every ten minutes).

SIGTERM or SIGINT shuts it down the same road back — timers, the queued telemetry and the open minute of aggregates, the WebSocket
clients (1001), the broker clients, the pools — within ten seconds, then exits 0.

## Tests

| Layer | Command | Needs |
| --- | --- | --- |
| Unit and architecture | `pnpm --filter @fdp/backend test` | nothing |
| Types, lint, boundaries | `pnpm --filter @fdp/backend lint` | nothing |
| Integration | `pnpm --filter @fdp/backend test:integration` | Docker; the fixtures below for the dataset suites |
| Live smoke | `pnpm --filter @fdp/backend test:live` | Docker and a real API key |

The running service is tested whole, `startApp` against the containers, by five suites:

| Suite | Proves |
| --- | --- |
| `e2e-ticket.test.ts` | telemetry → suspect event → decision → ticket → WS frame → REST close with a verdict, with Jev (mock, `best-overlap`, retries off) and with the rules backend; every row in place, the cost exact; no ticket on the February baseline |
| `heartbeat.test.ts` | `telemetry_silent` and `decision_api_silent` raised and cleared on a real broker within seconds (one- and two-second timeouts) |
| `mqtt-acl.test.ts` | the running diagnosis client receives nothing on the ground-truth root while `eval` does, is refused the command topic (PUBACK 0x87), and `createDiagClient` refuses a missing credential |
| `secrets.test.ts` | a sentinel `TYPESAFE_API_KEY` appears in no log line, table, REST body, WS frame, MQTT payload or image layer |
| `image.test.ts` | the image exits with `run init first` against an unprepared database, and with the Compose environment answers `/api/health` 200 and publishes its status retained |

The runtime suites store the fixture catalog the way init does and use a deterministic hash embedder unless the pinned model is in
`MODEL_CACHE_DIR` (default `<tmp>/fdp-models`); `image.test.ts` fills that cache once, as init fills the Compose volume. The two
image suites build the Dockerfile themselves (a cache hit after the first build) and remove their tags afterwards.

`test/arch/imports.test.ts` is the one to read first: it proves the ground-truth boundary of
[ground rule 3](../../CONTRIBUTING.md#ground-rules) four times over, including by adding a forbidden import to a throw-away copy of `src` and checking that dependency-cruiser refuses it.

The integration suites start their containers on random host ports and label them `fdp.worktree=<directory>`, so several checkouts
can run them at the same time. Every wall-clock bound is multiplied by `FDP_TIMING_SLACK` (1 locally, 3 in CI).

## Telemetry fixtures

No MetroPT-3 row is committed anywhere ([ground rule 5](../../CONTRIBUTING.md#ground-rules)), so the fixtures this package replays are built on the machine
that runs the tests, in two steps:

```bash
make fixtures                          # cuts the slices into data/fixtures/metropt3/
pnpm --filter @fdp/backend fixtures    # turns six of them into data/fixtures/metropt3/backend/
```

Both directories are git-ignored. To reuse a copy of the 218 MB source CSV that is already on disk, for example in another checkout,
point the cutter at it: `METROPT_CSV_HOST=/path/to/MetroPT3(AirCompressor).csv make fixtures`.

| Fixture | Window (data clock) | What it is for |
| --- | --- | --- |
| `baseline-feb` | 2020-02-03 00:00–06:00 | a first-month morning; every rule must stay silent |
| `unlabelled-may19` | 2020-05-19 21:00 → 05-20 23:30 | a continuous-load episode outside every scored window |
| `summer-jul05` | 2020-07-05 → 07-06 | a normal summer day; the seasonal-drift negative |
| `frozen-jun22` | 2020-06-22 12:00 → 06-23 00:00 | the frozen-logger guard |
| `depot-apr30` | 2020-04-30 23:00 → 05-01 13:00 | a depot depressurisation, motor off; the parked guard |
| `gap-jump` | synthetic | a baseline hour, then the May episode across a `discontinuity` |

A test that reads one skips when it is absent; `FDP_REQUIRE_DATASET=1` turns that skip into a failure, which is what CI sets.

The signatures the recording shows only inside a labelled failure window — fast decay, frequent cycling, the low-pressure switch — are
**not** taken from the data. `test/fixtures/synthetic/` builds them from the first-month statistics in
[`data/metropt3-first-month-stats.json`](../../data/metropt3-first-month-stats.json) (written by
[`scripts/data/metropt3_stats.py`](../../scripts/data/metropt3_stats.py)), so a positive test case is a number a reader can check. Onset
timing against the real failures belongs to the `tools/eval` scenarios and their dev/test split
([`docs/evaluation.md`](../../docs/evaluation.md)), never here.

## Configuration

Every variable is read once, in `src/config/env.ts`, into a typed `Env`. An empty string counts as unset, so a blank
interpolation in Compose falls back to the default below. The two API keys are wrapped in a `Secret` whose `toString`, `toJSON` and
`util.inspect` all answer `[redacted]`.

The user-facing variables are listed in [`.env.example`](../../.env.example) and in the repository README. These three are
backend tuning, also listed in the README's Configuration table and, commented out, in `.env.example`:

| Variable | Default | Effect |
| --- | --- | --- |
| `EMBEDDER_ALLOW_DOWNLOAD` | `false` | lets the embedder fetch a missing model file instead of failing at start-up |
| `RULES_DISABLED` | `flow_pulses_missing` | comma-separated rule ids the detection registry leaves out |
| `WS_TELEMETRY_INTERVAL_MS` | `250` | how often the WebSocket hub flushes one decimated `telemetry.series` frame per client |

The rest, with the defaults this package applies when Compose does not pass one:

| Variable | Default | Used by |
| --- | --- | --- |
| `NODE_ENV` | `development` | the image sets `production`; outside production the REST surface answers cross-origin requests |
| `PORT` | `3000` | the HTTP server (`0` binds any free port, which is what the tests do) |
| `LOG_LEVEL` | `info` | the logger |
| `UNIT_ID` | `cau-7` | topics and rows |
| `MQTT_URL` | `mqtt://mqtt:1883` | the broker adapter |
| `MQTT_BACKEND_DIAG_PASSWORD` | `backend-diag` | the diagnosis broker credential |
| `PG_HOST`, `PG_PORT`, `POSTGRES_DB`, `PG_APP_PASSWORD` | `localhost`, `5432`, `fdp`, `app_rw` | composed into the `app_rw` pool URL |
| `DATABASE_URL_APP` | — | a development override for that URL |
| `DECISION_BACKEND` | `jev` with a TypeSafe key, else `rules` | which answer engine runs |
| `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_MODEL` | —, `https://api.typesafe.ai`, `jev-1.13.0` | the Jev backend; the model must be a pinned version, never an alias |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | `anthropic`, —, `claude-opus-5`, — | the LLM backend |
| `JEV_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK`, `PRICES_AS_OF` | `0.042`, `5`, `25`, `2026-09-19` | the cost ledger; the defaults are USD per million tokens as published by TypeSafe and Anthropic, September 2026 |
| `GATE_TICKET_MIN_CONFIDENCE`, `GATE_REVIEW_MIN_CONFIDENCE` | `0.85`, `0.60` | the confidence gate, for the rules and llm backends |
| `JEV_GATE_TICKET_MIN_CONFIDENCE`, `JEV_GATE_REVIEW_MIN_CONFIDENCE` | `0.85`, `0.65` | Jev's own gate thresholds, fixed before the held-out run; independent of `GATE_*` |
| `GATE_PERSIST_SIM_MIN` | `1` | sim minutes a symptom must keep firing before an episode without a ticket is decided, so before it can open a review or a ticket (`0` decides at once) |
| `DECISION_INTERVAL_SIM_MIN`, `EPISODE_CLEAR_SIM_MIN` | `30`, `120` | episodes |
| `HEARTBEAT_TELEMETRY_TIMEOUT_S`, `HEARTBEAT_DECISION_TIMEOUT_S` | `15`, `60` | the watchdogs |
| `TELEMETRY_RETENTION_SIM_DAYS` | `365` | aggregate retention |
| `MODEL_CACHE_DIR` | `/models` | the embedder |

`PG_GT_PASSWORD`, `DATABASE_URL_GT` and `MQTT_BACKEND_OPS_PASSWORD` are **deliberately absent** from this list. They belong to the
overlay, the one module that may see recorded truth, and `src/overlay/config.ts` is their only reader. ESLint refuses
`process.env` anywhere else in `src`, and `test/arch/imports.test.ts` checks that the `Env` type carries no such key.

## Boundaries

Three mechanical checks keep the diagnosis side away from the recorded truth
([ground-truth isolation](../../docs/architecture.md#ground-truth-isolation)):

- **the package** — `@fdp/ground-truth` is not a dependency here, so pnpm's strict `node_modules` cannot resolve it;
- **the modules** — `.dependency-cruiser.cjs` refuses an import of the overlay, of the ground-truth package or of the broker and
  database drivers from a diagnosis module, and refuses any host inside `src/pipeline`; `eslint.config.js` mirrors the first two for
  editor feedback;
- **the runtime** — the broker's access list and the PostgreSQL roles, asserted in the integration suites.

`package.json#exports` names one entry, `./pipeline`, with the `@fdp/source` condition first so `tools/eval` resolves the source
without a build.

## The image

```bash
docker build -f apps/backend/Dockerfile .
```

The build context is the repository root, because the package resolves `@fdp/contracts` through the workspace — which also means the
root [`.dockerignore`](../../.dockerignore) is the exclusion list that applies, and this directory deliberately has none of its own.
The image is Debian-based (`node:24.21.0-trixie-slim`): `onnxruntime-node` ships prebuilt binaries for glibc only. It runs
`node dist/index.js` as the `node` user and carries a healthcheck that calls `GET /api/health`.

## `GET /api/health`

The body is the contracts' `api-health`: the two database roles, the two broker credentials, the two watchdogs, the replay position and
free-form counters. A link reports `ok` only while a probe the composition root gave the route says so; the running service wires all
four, so a link that is down answers 503, which is the rule the schema states.

The counters are the runtime's: batches handled and queued, samples charted, invalid payloads dropped by the broker adapter, database
writes and publications that failed, and the WebSocket clients. A failed write is logged and counted, never thrown, so these are where a
degraded run shows first.
