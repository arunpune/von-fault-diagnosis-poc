<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Security model

This guide covers what the Fault Diagnosis PoC protects and what it leaves open on purpose: the ports and the API the stack exposes, the credentials it uses, the data that leaves it with each decision backend, the boundaries inside it and how its dependencies are vetted. Read it before you run the stack anywhere other than your own machine, add an API key or ingest a manual of your own. The README's [Security and privacy](../README.md#security-and-privacy) section is the short version.

## Scope

The stack is a read-only proof of concept. Its security model follows from what the project leaves out of scope: any write to a PLC or machine, safety functions, production deployment and authentication.

- **Read-only.** The diagnosis reads telemetry and raises alerts and tickets; it never writes to the machine. The machine itself is emulated: `modbus-sim` answers function code 03 (read holding registers) on unit id 1 and refuses every write, coil, discrete-input and input-register request with exception 01, illegal function (`services/modbus/internal/sim/server.go`). The gateway polls it with a read-only client, and `services/modbus/internal/arch/isolation_test.go` fails when gateway code calls a Modbus write function.
- **The simulation controls are the only commands.** Play, pause, speed, jump, inject, clear and reset travel on `plant/cau-7/control/cmd`, which only the `backend-ops` broker credential may write and only the simulator reads. They steer the replay, never a real machine.
- **No authentication.** The UI, the REST API, the WebSocket and the emulated Modbus device have no login, and the broker admits anonymous readers. The published listeners speak plain HTTP, MQTT and Modbus TCP: neither nginx nor Mosquitto is configured for TLS.
- **Not a safety function.** The machine and its manual are fictional; do not use either to operate or maintain real equipment.

What the design does protect is narrower, and each part is enforced in code or by a check rather than by convention:

- the two API keys, which reach only the containers that need them and never Git, an image, a log or the UI ([Credentials](#credentials));
- the data sent to a decision service, which describes the symptom in words and never carries raw telemetry ([What leaves the stack](#what-leaves-the-stack));
- ground truth, kept away from the diagnosis code so the evaluation stays honest; the broker ACL that enforces it is an isolation boundary, not a security control ([Isolation inside the stack](#isolation-inside-the-stack));
- the repository's content: no third-party manual, no real brand name and no copyleft runtime dependency ([The supply chain](#the-supply-chain)).

## What the stack exposes

```mermaid
flowchart LR
    BR["Browser"] -->|"UI_PORT, default 8080"| FE["frontend<br/>nginx"]
    FE -->|"/api/ and /ws, same origin"| BE["backend<br/>REST and WebSocket"]
    MC["Any MQTT client"] -->|"MQTT_PORT, default 1883<br/>anonymous: read plant topics"| MQ{{"mqtt<br/>Mosquitto with ACL"}}
    MB["Any Modbus client"] -->|"MODBUS_PORT, default 5020<br/>function code 03 only"| SIM["modbus-sim"]
    BE <-->|"backend-diag and backend-ops"| MQ
    BE <-->|"app_rw and gt_rw"| DB[("postgres<br/>published only by make up-dev")]
```

### Published and development ports

`compose.yaml` publishes three ports. `make up-dev` adds four fixed development ports from `compose.dev.yaml`, which tests and CI never use.

| Port                 | Service      | Protocol           | What anyone who reaches it can do                                                                  | Published by       |
| -------------------- | ------------ | ------------------ | -------------------------------------------------------------------------------------------------- | ------------------ |
| `UI_PORT` (8080)     | `frontend`   | HTTP and WebSocket | Load the dashboard, call the REST API under `/api/` and open `/ws`, with no login                  | `compose.yaml`     |
| `MQTT_PORT` (1883)   | `mqtt`       | MQTT               | Without credentials, subscribe to telemetry, status, events, decisions and alerts; publish nothing | `compose.yaml`     |
| `MODBUS_PORT` (5020) | `modbus-sim` | Modbus TCP         | Read the holding registers of unit id 1; every write is refused                                    | `compose.yaml`     |
| 5432                 | `postgres`   | PostgreSQL         | Log in as any role whose password is known; the defaults are published                             | `compose.dev.yaml` |
| 3000                 | `backend`    | HTTP and WebSocket | The same REST API and `/ws`, without nginx in front                                                | `compose.dev.yaml` |
| 8081                 | `modbus-sim` | HTTP               | `GET /status` and `GET /healthz`: the replay state and nothing about fault injection               | `compose.dev.yaml` |
| 8082                 | `gateway`    | HTTP               | `GET /healthz`                                                                                     | `compose.dev.yaml` |

None of these mappings names a host address, so Docker publishes each one on every interface of the host. The one loopback-only mapping is in `compose.ci.yaml`, which publishes Postgres on an ephemeral port of `127.0.0.1` for `make eval-stack`. Keep the published ports on a machine or network you trust; the README's [Troubleshooting](../README.md#troubleshooting) section shows how to move them or run a second copy on ephemeral ports.

### The UI and the API

The `frontend` image serves the built app with nginx and, under the same origin, proxies the backend (`apps/frontend/nginx/default.conf.template`): `/api/` goes to `http://backend:3000/api/` and `/ws` to the backend's WebSocket, while `/healthz` is answered by nginx itself and `server_tokens off` hides its version. The browser therefore never needs a second host or cross-origin requests, and the UI holds no configuration and no key of its own.

Without authentication, anyone who reaches the UI port can:

- read everything the dashboard shows, including the ground-truth overlay under `GET /api/overlay/*` (the jump presets, injection types and failure windows, the active and past injections and the replay markers), which the UI builds its **Jump to** and **Inject fault** menus and its chart overlays from;
- drive the simulation with `POST /api/sim/*` (play, pause, speed, jump, inject, clear, reset), which the backend forwards to the simulator over the broker;
- close any ticket as correct or wrong with `POST /api/tickets/:id/close`. The verdict is stored with the ticket; the evaluation's stack scoring reads only the closure time, never the verdict ([decision-backends.md](decision-backends.md)).

These are the only two kinds of write routes. The WebSocket streams from server to client; the only frames a browser sends are `subscribe` and `ping`, capped at 64 KiB. The backend image sets `NODE_ENV=production`, and the REST surface answers cross-origin requests only outside production, for example when you run the backend from source as [development.md](development.md) describes. The routes and frames are listed in [api.md](api.md).

### Anonymous MQTT reads

`infra/mosquitto/mosquitto.conf` sets `allow_anonymous true` beside a password file and an ACL. The ACL's general block, which applies to anonymous clients only, grants reads of `plant/cau-7/telemetry/#`, `plant/cau-7/status/#`, `plant/cau-7/events/#`, `plant/cau-7/decisions`, `plant/cau-7/alerts/#` and `$SYS/#`, and no write at all. Ground truth under `gt/#` and the control topics under `plant/cau-7/control/#` need a credential. This is what lets the README's `mosquitto_sub -h localhost -p 1883 -t 'plant/#' -v` work with no setup, and it also means an anonymous reader sees every decision, with its candidate faults and manual references.

Mosquitto grants a subscription to a denied filter and then never delivers on it, so the repository's isolation tests assert non-delivery against a positive control, never a `SUBACK` code; the measured semantics of the ACL are in [api.md](api.md#broker-acl).

## Credentials

### The two secrets

Only two variables are secrets, and neither has a default.

| Variable           | Enables                                                                                                | Received by       |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ----------------- |
| `TYPESAFE_API_KEY` | The Von decision backend; when it is set and `DECISION_BACKEND` is not, Von becomes the active backend | `backend`         |
| `LLM_API_KEY`      | The LLM decision backend (with `DECISION_BACKEND=llm`) and init's optional catalog pass                | `backend`, `init` |

Both are read from the gitignored `.env`, which Compose reads for interpolation only: no service uses `env_file`, and each receives the variables `compose.yaml` names for it. `make compose-check`, part of `make lint`, renders the configuration and fails when either key reaches any other service. A backend whose key is missing fails at start-up with a message naming the variable, instead of falling back to another backend. The CI stack sets `TYPESAFE_API_KEY: fdp-ci-mock-key` in `compose.ci.yaml`, which is not a secret: the mock decision service accepts any non-empty bearer token, and the CI workflow uses no repository secret.

### Where the keys never appear

| Place                          | What keeps the keys out                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git                            | `.gitignore` excludes `.env` and `.env.*` except `.env.example`, which holds both keys as empty assignments; `make env-check` fails when either carries a value there                                                                                                                                                                                                                                                                                                                      |
| Images                         | The root `.dockerignore` keeps `.env` out of the build context of every image in the stack, and `make compose-check` fails if it stops doing so; the frontend's own ignore file admits only the files its build needs                                                                                                                                                                                                                                                                      |
| Logs                           | The backend wraps each key in a `Secret` that prints `[redacted]` (`apps/backend/src/config/secret.ts`), its logger redacts authorization headers and `apiKey`, `api_key` and `password` fields (`apps/backend/src/log.ts`), the Von SDK's own logger is switched off and provider error bodies are dropped; init masks secrets when it prints its settings and logs no request body, response body or header; the evaluation harness keeps its keys in an object that prints `[redacted]` |
| The UI                         | The frontend has no key; `FDP_BACKEND_URL` is read at dev time only, by the Vite dev and preview servers, and no `VITE_*` variable reaches the bundle                                                                                                                                                                                                                                                                                                                                      |
| Rendered Compose configuration | `make compose-check` renders with `--env-file /dev/null`, so the keys come out empty; `make reset-db` renders with `--no-interpolate`; `scripts/smoke.sh` never runs a command that renders the configuration and checks the keys with `grep -q` only                                                                                                                                                                                                                                      |
| The database                   | Each decision stores the provider's request and response bodies without headers or key material                                                                                                                                                                                                                                                                                                                                                                                            |

One command outside the Make targets does print them: a plain `docker compose config` reads `.env` and prints the interpolated configuration, keys included. `make doctor` never reads or prints an environment variable, so its output is safe to share.

### The PoC defaults

Every other credential is a published default, meant to be left as is on a trusted machine. Each has a line in `.env.example`, commented out with its value.

| Credential                                       | Variable                     | Default        | Used by                                                        |
| ------------------------------------------------ | ---------------------------- | -------------- | -------------------------------------------------------------- |
| Postgres superuser `fdp_admin` (`POSTGRES_USER`) | `POSTGRES_PASSWORD`          | `fdp_admin`    | `init`, which runs the migrations and the ingest as this role  |
| Role `app_rw`                                    | `PG_APP_PASSWORD`            | `app_rw`       | The backend's diagnosis pool                                   |
| Role `gt_rw`                                     | `PG_GT_PASSWORD`             | `gt_rw`        | The backend's overlay pool                                     |
| Role `eval`                                      | `PG_EVAL_PASSWORD`           | `eval`         | The evaluation tool on the host (`make eval-stack`) and `psql` |
| Broker user `gateway`                            | `MQTT_GATEWAY_PASSWORD`      | `gateway`      | `gateway`                                                      |
| Broker user `sim`                                | `MQTT_SIM_PASSWORD`          | `sim`          | `modbus-sim`                                                   |
| Broker user `backend-diag`                       | `MQTT_BACKEND_DIAG_PASSWORD` | `backend-diag` | The backend's diagnosis client                                 |
| Broker user `backend-ops`                        | `MQTT_BACKEND_OPS_PASSWORD`  | `backend-ops`  | The backend's overlay and control client                       |
| Broker user `eval`                               | `MQTT_EVAL_PASSWORD`         | `eval`         | Tests and debugging from the host, read-only                   |

`compose.yaml` passes every database password to `postgres`, which creates the roles, and every broker password to `mqtt`, which hashes them, and each client service receives only its own. Inside the backend, the overlay's two credentials (`PG_GT_PASSWORD` and `MQTT_BACKEND_OPS_PASSWORD`) are read by `apps/backend/src/overlay/config.ts` alone; the diagnosis side's configuration holds neither.

### Changing a password

Set the new value in `.env`; Compose hands the same variable to the server and to its client, so both sides agree.

- **Database passwords.** Postgres creates its roles once, on an empty data volume (`infra/postgres/initdb/00-roles.sh`), so a changed `POSTGRES_PASSWORD` or `PG_*_PASSWORD` takes effect only on a new volume. Run `make reset-db`, then `make up`. `make reset-db` deletes the database volume alone: the next start re-creates the roles, re-applies the migrations and re-ingests the manual with the cached embedding model. `make reset` also works but deletes the model cache too, so the model is downloaded again.
- **Broker passwords.** The broker's entrypoint hashes the password file from the `MQTT_<USER>_PASSWORD` variables at every container start, so a new value takes effect on the next `make up`, with no rebuild and no reset.
- **Host tools.** `make eval-stack` connects with `DATABASE_URL_EVAL`: the URL a stack kept by `scripts/smoke.sh --keep` wrote to `reports/smoke/db-url-eval`, else `postgres://eval:eval@localhost:5432/fdp`. After changing `PG_EVAL_PASSWORD`, pass the new URL, as in `make eval-stack DATABASE_URL_EVAL=postgres://eval:<password>@localhost:5432/fdp`.

## What leaves the stack

```mermaid
flowchart LR
    subgraph stack["Compose stack"]
        BE["backend<br/>the rules backend sends nothing"]
        INIT["init<br/>one-shot"]
    end
    BE -->|"Von: one request per decision"| TS["TypeSafe API"]
    BE -->|"LLM: one request per decision"| AN["Anthropic API"]
    INIT -->|"with LLM_API_KEY: one request per ingest"| AN
    INIT -->|"when missing: download, then verify SHA-256"| DL["MetroPT-3 archive<br/>embedding model files"]
```

### The decision state

Raw telemetry never leaves the stack. Detection turns every reading into a level, a trend or a duration in code, and `apps/backend/src/decision/state.ts` builds the one state that all three backends read, in words:

- **machine**: one fixed sentence describing the kind of unit, its operating mode and for how long, and an ambient bucket (cold, mild, warm, hot or unknown);
- **symptom**: the manual's title for the condition, any co-present conditions and how long the symptom has lasted;
- **observations**: at most twelve signals, each with its tag id, its name, a level, a trend and how long they have held, plus a sentence comparing busy and quiet hours for signals detection watches that way;
- **controller alarms**: the active alarm codes with their titles, or `none`;
- **candidates**: at most six causes from the fault catalog, each with its fault id, name, condition title, its expected signal movements in the manual's own words and a benign flag.

No sample value, time series, timestamp or ground-truth field enters the state. The candidates do carry the manual's wording, so with a manual of your own those sentences leave with every Von or LLM decision. The backend stores each decision's state and the provider's request and response bodies in its own database (`app.decisions`), never on the broker.

### Per decision backend

| Backend | Active when                                                                           | What leaves, per decision                                                                                | Where it goes                                                                                                              |
| ------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rules   | `DECISION_BACKEND` and `TYPESAFE_API_KEY` are both unset, or `DECISION_BACKEND=rules` | Nothing: candidates are scored inside the backend                                                        | —                                                                                                                          |
| Von     | `TYPESAFE_API_KEY` is set and `DECISION_BACKEND` is unset, or `DECISION_BACKEND=von`  | One `POST /v1/systemone` with the state, the pinned model id and the question set, authorised by the key | `TYPESAFE_BASE_URL`, by default `https://api.typesafe.ai`                                                                  |
| LLM     | `DECISION_BACKEND=llm`                                                                | One Messages API call with a fixed system prompt, the same state as JSON and the answer schema           | The Anthropic API through its SDK; `compose.yaml` forwards no `LLM_BASE_URL`, so the stack uses the SDK's default endpoint |

Adding `TYPESAFE_API_KEY` to `.env` is enough to switch the default backend from rules to Von on the next `make up`, and from then on every decision sends a request. In the stack the backend loads the embedding model read-only from the cache init filled, with `EMBEDDER_ALLOW_DOWNLOAD=false`, so the decision requests are the only calls it makes outside the stack. How each backend asks and answers is in [decision-backends.md](decision-backends.md).

### Init's optional LLM pass

With `LLM_API_KEY` set and `LLM_PROVIDER=anthropic` (the default), init asks Claude to repair the fault catalog it extracted from the manual (`tools/init/src/fdp_init/catalog/anthropic_structurer.py`). It sends one request per ingest, holding the troubleshooting and controller-message chapters of the extracted text (the whole text when it cannot find those chapters) and the draft catalog read from the manual's tables. The answer is validated locally, and the draft is kept whenever the answer fails a rule, so the model can improve the catalog but never fail a run.

The catalog mode (`llm` with a key, `tables` without) is part of init's skip check, so adding or removing `LLM_API_KEY` makes the next start re-ingest the manual, and with a key that sends the request. With a manual of your own in `data/byo-manual/`, that text is your manual's: use only manuals you are allowed to use, and allowed to send to a third party. [manual.md](manual.md) covers bringing your own manual.

### Downloads and host tools

When they are missing, init downloads the MetroPT-3 archive from `METROPT_URL` (the UCI archive until the planned project mirror is published) and the embedding model files from the URLs pinned in `packages/contracts/embedding.json`. These requests fetch files and send nothing of the stack's data, and init verifies each file against a committed SHA-256 before using it ([dataset.md](dataset.md)).

Tools that run on the host sit outside the stack. The evaluation harness plans a live Von run first and refuses it without `--confirm-live`; without a key or recorded cassettes it uses the contracts' mock server ([evaluation.md](evaluation.md)). `make smoke-live` and the `test:live` scripts are opt-in, paid calls with your own keys, and CI never runs them.

## Isolation inside the stack

The mechanisms below keep the parts of the stack from reaching each other's data. The largest of them, ground-truth isolation, is described end to end in [architecture.md](architecture.md#ground-truth-isolation).

### Broker clients and the ACL

Every service connects to the broker with its own credential, and `infra/mosquitto/acl` is rendered from the `acl` block of `packages/contracts/topics.json` by `make mosquitto-acl`; a test fails when the two drift. [api.md](api.md#broker-acl) has the table of what each of the five credentials and the anonymous client may read and write. What matters for isolation: the backend opens two connections from two modules, the diagnosis client as `backend-diag`, which reads telemetry and status only and receives nothing from `gt/#`, and the overlay client as `backend-ops`, the only reader of `gt/#` and of the acknowledgements and the only writer of the control topic; the simulator alone writes under `gt/`; anonymous clients and `eval` read and never write.

### Database roles

init runs the migrations and the ingest as the superuser `fdp_admin` (`POSTGRES_USER`), which owns both schemas and every object in them. `infra/postgres/initdb/00-roles.sh` creates three login roles, each `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, revokes `CREATE` on schema `public` from `PUBLIC` and lets all three read the migration bookkeeping table `public.schema_migrations`. The migrations in `db/migrations/` only grant and revoke; they never create a role. The backend's diagnosis pool connects as `app_rw`, with DML on schema `app` and no privilege on `gt`, not even `USAGE`; its overlay pool as `gt_rw`, with DML on `gt` only; the evaluation as `eval`, which the migrations grant DML on `app` and `USAGE` and `SELECT` only on `gt`, though the harness never writes: it runs in process without a database, and `make eval-stack` reads a running stack inside one read-only transaction. A database test asserts that `app_rw` has no usage right on schema `gt` and `gt_rw` none on schema `app`. The role table and the schemas are in [architecture.md](architecture.md#persistence), and the migrations in [`db/README.md`](../db/README.md).

### Ground truth

Ground truth, which fault is present and when, lives in four places, and each has its own guard against the diagnosis code:

| Where                                                         | Who may read it                                                | What keeps the diagnosis out                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/ground-truth`                                       | `tools/eval`, the simulator (a copy in its image), their tests | Import boundaries in TypeScript, Go and Python, and `make gt-paths`, all in `make lint` |
| MQTT root `gt/`                                               | The overlay client (`backend-ops`), `eval`                     | The broker ACL: `backend-diag` and anonymous clients receive nothing there              |
| Postgres schema `gt`                                          | The overlay (`gt_rw`), `eval`                                  | Role `app_rw` holds no privilege on it                                                  |
| `tools/eval/scenarios` and `tools/eval/fixtures/catalog.json` | The evaluation harness                                         | No other package imports `@fdp/eval`                                                    |

Telemetry carries no injected flag, and a replay jump reaches detection only as a discontinuity flag. This boundary protects the honesty of the evaluation, not a secret from the user: the UI shows the same ground truth through the read-only overlay routes on purpose.

### Containers and volumes

The backend image runs as the `node` user and the simulator and gateway images as `nonroot` on a distroless base, while init runs as root to write its bind mounts (hence the ownership note in the README's [Troubleshooting](../README.md#troubleshooting)). Only init writes the embedding model cache, which the backend mounts read-only; `data/metropt3` is writable for init and read-only for the simulator, and the manual folders are read-only for init.

## The supply chain

### Pinned and verified dependencies

Ground rule 8 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)) is "verify before pinning": every dependency is pinned at a version checked against its registry when it is added, as [CONTRIBUTING.md §9](../CONTRIBUTING.md#9-adding-a-dependency) describes.

- **Lock files.** `pnpm-lock.yaml`, `uv.lock` and `services/modbus/go.sum`; `make install` installs from them without re-resolving.
- **npm versions** live once in the `catalog:` block of `pnpm-workspace.yaml`. A dependency's lifecycle script runs only when `allowBuilds` allows its package, each entry with its reason in a comment; `onnxruntime-node` is the only one allowed today.
- **Images** are pinned by version tag in the Dockerfiles and `compose.yaml`, and the distroless and Python bases also by digest.
- **CI actions** are pinned to the commit of their release tag, the workflow runs with read-only repository contents and no secret, and `scripts/ops/ci-workflow.test.ts` fails on an unpinned action or a `secrets.` reference.
- **Downloads** are verified: `data/SHA256SUMS` holds the hashes of the MetroPT-3 archive, the CSV and every cut slice, and `packages/contracts/embedding.json` the model revision and file hashes.

### The licence audit

Ground rule 9 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)) keeps GPL and AGPL out of anything that ships. `make licenses` (`fdp-checks licenses`) reads the Node, Python and Go dependency trees, splits them into runtime (anything in a Compose image) and dev scope, and judges each licence against `tools/repo-checks/licenses-policy.toml`:

- runtime licences must be on the permissive allow list; `MPL-2.0`, `Unlicense` and `LGPL-*` are flagged and pass only with a reviewed entry in `[flagged-accepted]`; `GPL-*`, `AGPL-*`, `SSPL-*`, `EUPL-*`, `CC-BY-SA-*` and `CC-BY-NC-*` fail;
- dev scope may carry copyleft, which the report lists and never fails, because none of it ships; the dev-only copyleft tools include the REUSE tool, golangci-lint, shellcheck and Pyphen;
- the report goes to `reports/licenses.md`, and the Go collector needs the network on a cold module cache.

### SPDX headers and REUSE

Every file carries an SPDX header or is covered by `REUSE.toml` or a `.license` sidecar, the licensing layout of ground rule 4. `make spdx` checks the headers offline, `make reuse-order` guards the order of `REUSE.toml`, `make reuse` runs `reuse lint` over the whole tree and `make reuse-spdx` writes an SPDX SBOM to `reports/sbom.spdx`.

### The brand blocklist

Ground rules 1 and 2 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)) keep third-party manuals and real brand names out of the repository: a manual of your own goes in the gitignored `data/byo-manual/`, and a scanner checks for names. The term list is committed only as salted digests of normalised word n-grams in `tools/blocklist/data/blocklist.sha256`; the plain list lives in the gitignored `tools/blocklist/private/`, so no brand name is in Git, not even in the scanner's data. `make blocklist` scans every tracked and untracked-but-not-ignored file plus the text of the manual PDFs, and the opt-in pre-commit hook scans what is staged. The model-code patterns run only where the private list exists. False positives go in `tools/blocklist/data/allow.txt` with a reason; a real brand name is removed, never exempted.

### Dependabot

`.github/dependabot.yml` asks for weekly update pull requests, grouped per ecosystem with at most three open at a time, for the GitHub Actions (with `ci(deps)` commit subjects) and for the base images of the seven Dockerfile directories, npm, the uv workspace (`pyproject.toml` and `uv.lock`) and the Go module (with `build(deps)`). Each such pull request runs the whole workflow, so an image bump that breaks the stack fails the `stack` job before a human reads the diff.

## Reporting a vulnerability

Report a suspected vulnerability privately, through GitHub's private vulnerability reporting, as [SECURITY.md](../SECURITY.md) describes, and never in a public issue or pull request. Leave key values out of the report; the output of `make doctor` and `make compose-check` is safe to include, since neither prints an environment value.

The absence of authentication and the published default passwords are documented properties of the scope above, not findings. What matters most is anything that breaks a guarantee this guide makes: a key appearing where it should never appear, raw telemetry or a key leaving with a decision, a write reaching the emulated machine other than through the simulation controls, ground truth reaching the diagnosis, or a vulnerable dependency.

## Further reading

- [SECURITY.md](../SECURITY.md): how to report a vulnerability, and what is in scope.
- [CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules): the ten ground rules, and how a dependency is verified and added.
- [architecture.md](architecture.md#ground-truth-isolation): ground-truth isolation, the broker and the database roles.
- [`db/README.md`](../db/README.md): the migrations and their grants.
- [`REUSE.toml`](../REUSE.toml) and [`NOTICE`](../NOTICE): the licensing layout.
- Code: `infra/mosquitto/`, `infra/postgres/initdb/00-roles.sh`, `db/migrations/`, `apps/frontend/nginx/default.conf.template`, `apps/backend/src/decision/state.ts`, `apps/backend/src/config/secret.ts`, `apps/backend/src/log.ts`, `tools/init/src/fdp_init/catalog/anthropic_structurer.py`, `scripts/ops/compose-check.sh`, `tools/repo-checks/licenses-policy.toml`, `tools/blocklist/` and `.github/dependabot.yml`.
- Related guides: [architecture.md](architecture.md), [api.md](api.md), [decision-backends.md](decision-backends.md), [manual.md](manual.md), [dataset.md](dataset.md), [evaluation.md](evaluation.md) and [development.md](development.md).
