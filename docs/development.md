<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Development

This guide walks through a working session on the repository: the toolchain and a first run, the three workspaces, running one piece outside Compose, the tests, the three gate levels and the conventions every commit follows. [CONTRIBUTING.md](../CONTRIBUTING.md) holds the rules in full, and this guide links its sections rather than repeating them. Read it after the README's [Quick start](../README.md#quick-start) and before your first change.

## The toolchain and `make doctor`

Everything is driven from the root `Makefile`. `make help` lists every target with a one-line description, and each target delegates to a package-level verb (`pnpm`, `uv run`, `go`, `docker compose`) that you can also call directly.

| Tool                   | Version                                               | Needed for                                              |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Node.js                | 24.21.0 (`.nvmrc`; `engines` accepts `>=24.18.0 <25`) | The TypeScript workspace                                |
| pnpm                   | 11.27.0 (`packageManager`)                            | Installing and running it                               |
| Go                     | 1.27                                                  | `services/modbus`                                       |
| uv                     | 0.12.12 or newer                                      | The Python workspace and every repository check         |
| Python                 | 3.13                                                  | The Python tools; uv installs it when it is missing     |
| GNU Make               | 3.81 or newer                                         | The entry point (macOS ships 3.81)                      |
| git                    | 2.31 or newer                                         | Worktrees and `--path-format`                           |
| golangci-lint          | 2.13.2                                                | `make lint-go`, which falls back to `go vet` without it |
| Docker with Compose v2 | Compose 2.24 or newer                                 | `make up`, the integration tests and the stack tests    |
| shellcheck             | 0.11.0                                                | Shell scripts (optional)                                |

```bash
make doctor    # one line per tool with the version found
make install   # pnpm, uv and Go dependencies, all from the lock files
```

`make doctor` (`scripts/doctor.sh`) exits non-zero when Node.js, pnpm, Go, uv, Python, git or Make is missing or outside its range, and only warns about golangci-lint, Docker and shellcheck. It never reads or prints an environment variable, so its output is safe to paste into an issue. `make install` runs `pnpm install --frozen-lockfile`, `uv sync --all-packages --frozen` and `go -C services/modbus mod download`, so it never re-resolves a dependency.

Some tests need more than the toolchain:

- **The MetroPT-3 slices.** `make fetch-dataset` downloads the dataset into `data/metropt3/` and verifies it against `data/SHA256SUMS` (a first `make up` puts it there too); `make fixtures` then cuts the slices into the gitignored `data/fixtures/metropt3/`. Tests that need a slice skip without it.
- **Chromium** for the browser tests: `pnpm --filter @fdp/frontend exec playwright install chromium`, once per machine.
- **WeasyPrint's native libraries** for `make check-manual`, `make manual-native` and the WeasyPrint-backed tests; `make manual` itself builds in a pinned container. On macOS the Makefile looks for the libraries in the Homebrew prefix through `WEASYPRINT_ENV`, which you can override; without them the WeasyPrint-backed tests skip.
- **Docker** for the integration, container and stack tests.

A first session on a fresh clone:

```bash
make doctor
make install
make fetch-dataset   # once: MetroPT-3 into data/metropt3/, verified
make fixtures        # the slices the tests and the evaluation read
make check           # lint and unit tests: the gate before every commit
make hooks           # optional: the pre-commit and commit-msg hooks
```

## The workspaces

Three language workspaces share the repository root, each with one lock file.

### pnpm for TypeScript

`pnpm-workspace.yaml` lists `apps/*`, `packages/*` and `tools/eval`:

| Path                    | Package             | What it holds                                                                                                |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/backend`          | `@fdp/backend`      | The diagnosis backend: detection, retrieval, decisions, tickets, the REST API and the WebSocket              |
| `apps/frontend`         | `@fdp/frontend`     | The React dashboard, built by Vite and served by nginx                                                       |
| `packages/contracts`    | `@fdp/contracts`    | JSON Schemas, MQTT topics, the register map, their generated types and validators, the mock decision servers |
| `packages/ground-truth` | `@fdp/ground-truth` | The labels: failure windows, presets, injections                                                             |
| `packages/db-migrate`   | `@fdp/db-migrate`   | The migration runner the tests and the evaluation use                                                        |
| `tools/eval`            | `@fdp/eval`         | The evaluation harness, dev-time only                                                                        |

- **One version per dependency.** The `catalog:` block of `pnpm-workspace.yaml` holds every version once, and a package depends on `"<name>": "catalog:"`. Changing a pinned version is its own `build(deps):` commit that names the verified source.
- **Lifecycle scripts are blocked** unless `allowBuilds` allows the package, with the reason in a comment. `allowBuilds: {}` is not a valid state, and `minimumReleaseAgeExclude` is written by pnpm itself.
- **Sources in development, `dist/` in images.** A package that others import exports its TypeScript sources under the `@fdp/source` condition and its compiled output by default, so development and tests run the sources directly (`node --conditions=@fdp/source`, or Vitest with the condition) while the images build and run the compiled output. Only entry points are exported: `@fdp/backend` exports `./pipeline` alone.
- **TypeScript 5.9.3** with `erasableSyntaxOnly` and `verbatimModuleSyntax`: relative imports carry the `.ts` extension, `enum`, `namespace` and parameter properties are out, and type-only imports are marked as such.
- **Same verbs everywhere.** Each package keeps the scripts `lint`, `typecheck`, `test`, `test:integration` and `build` where it has them; run one with `pnpm --filter @fdp/<name> <script>`. At the root, `pnpm run lint` checks formatting, ESLint and the types of the whole workspace, `pnpm run lint:boundaries` runs dependency-cruiser and `pnpm test` runs the repository tests under `scripts/`.

### uv for Python

The root `pyproject.toml` is a virtual workspace root (`package = false`) for Python `>=3.13,<3.14` and uv `>=0.12.12`, with its members listed explicitly:

| Path                 | Distribution       | Console scripts                        | What it does                                                                                                |
| -------------------- | ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tools/init`         | `fdp-init`         | `fdp-init`                             | The one-shot init service: migrations, dataset, manual ingest, embeddings; the only Python in a stack image |
| `tools/manual-build` | `fdp-manual-build` | `fdp-manual-build`, `fdp-manual-check` | Builds the manual PDFs and runs their acceptance checks                                                     |
| `tools/repo-checks`  | `fdp-repo-checks`  | `fdp-checks`                           | The repository checks: SPDX headers, ground-truth paths, variables, `REUSE.toml` order, commits, licences   |
| `tools/blocklist`    | `fdp-blocklist`    | `fdp-blocklist`                        | The brand blocklist scanner                                                                                 |

- The root `dev` group holds the shared tools: pytest, pytest-cov, ruff, mypy in strict mode and import-linter, plus `fdp-init[llm]` so the optional Anthropic structurer is type-checked and tested.
- `uv run --package <distribution> …` targets one member. Add a dependency to one member at a time with `uv add --package <distribution> <name>==<version>`, never to the virtual root; `uv.lock` is regenerated, never merged by hand.
- pytest runs from the root over `tools/` and drops the `integration` marker by default; the other root markers are `network`, `weasyprint`, `docker` and `sources`.
- Two things stay outside the workspace on purpose: `manual/tools`, which runs through `uv run --no-project --with-requirements manual/tools/requirements.txt`, and the REUSE tool, which runs through `uvx`.

### One Go module

`services/modbus` is the module `fault-diagnosis-poc/services/modbus` (`go 1.27`), with the binaries in `cmd/modbus-sim` and `cmd/gateway` and everything else under `internal/`. It has its own `Makefile` with the same verbs, which the root reaches as `make -C services/modbus <verb>`: `test`, `test-race`, `test-integration`, `lint`, `fmt`, `vet`, `build`, `docker-smoke`, `e2e`, `bench` and `tidy`. golangci-lint is installed as a binary, never with `go get`. `internal/regmap/register_map_gen.go` is generated from the contracts; do not edit it.

### Generated files

- `make generate` (`pnpm --filter @fdp/contracts generate`) regenerates the contract artefacts from the schemas, `topics.json` and the manual's signal and alarm registries: the TypeScript types, validators and topic builders, `packages/contracts/generated/register-map.json` and the Go register map. Commit the result; `pnpm --filter @fdp/contracts check-drift` fails when the committed files are stale, as CI's `contract-drift` job does.
- `make mosquitto-acl` renders `infra/mosquitto/acl` from `packages/contracts/topics.json`, and `make mosquitto-passwd` rehashes `infra/mosquitto/passwd` after `passwd.txt` changes.

## Running a piece outside Compose

To iterate on one piece, start the rest of the stack with the fixed development ports and run that piece from source against it. `make up-dev` is `make up` plus `compose.dev.yaml`:

| Port                 | Service      | Use                                                                          |
| -------------------- | ------------ | ---------------------------------------------------------------------------- |
| `UI_PORT` (8080)     | `frontend`   | The built UI                                                                 |
| `MQTT_PORT` (1883)   | `mqtt`       | The broker, for example `mosquitto_sub -h localhost -p 1883 -t 'plant/#' -v` |
| `MODBUS_PORT` (5020) | `modbus-sim` | The emulated Modbus device                                                   |
| 5432                 | `postgres`   | `psql "postgres://eval:eval@localhost:5432/fdp"` and `make eval-stack`       |
| 3000                 | `backend`    | The REST API and `/ws` without nginx; the Vite dev server's default target   |
| 8081                 | `modbus-sim` | `GET /status` and `GET /healthz` of the simulator                            |
| 8082                 | `gateway`    | `GET /healthz` of the gateway                                                |

The first three are the ports every stack publishes; tests and CI never use `compose.dev.yaml` and run on ephemeral ports under a unique project name instead. The README's [Troubleshooting](../README.md#troubleshooting) section shows how to run a second copy the same way. What these ports expose is in [security.md](security.md).

### The frontend dev server

```bash
make up-dev                        # the stack, with the backend on localhost:3000
pnpm --filter @fdp/frontend dev    # Vite on http://localhost:5173
```

The dev server and `vite preview` proxy `/api` and `/ws` to `FDP_BACKEND_URL` (default `http://localhost:3000`), as nginx does in the container, so the application never names a backend host. The variable is read at dev time only. The package's own commands are in [`apps/frontend/README.md`](../apps/frontend/README.md).

### The backend from source

Stop the backend container so port 3000 is free, then point the process at the published ports ([`apps/backend/README.md`](../apps/backend/README.md)):

```bash
make up-dev
docker compose -f compose.yaml -f compose.dev.yaml stop backend
pnpm --filter @fdp/backend build
PG_HOST=localhost PG_GT_PASSWORD=gt_rw \
MQTT_URL=mqtt://localhost:1883 MQTT_BACKEND_OPS_PASSWORD=backend-ops \
MODEL_CACHE_DIR="$HOME/.cache/fdp-models" EMBEDDER_ALLOW_DOWNLOAD=true \
node apps/backend/dist/index.js
```

The overlay's two credentials have no default in `apps/backend/src/overlay/config.ts`, so the command names them; every other variable falls back to its default. `EMBEDDER_ALLOW_DOWNLOAD=true` fetches the pinned embedding model into the cache directory the first time. `NODE_ENV` defaults to `development` outside the image, and outside production the REST surface also answers cross-origin requests. The `frontend` container keeps proxying to the stopped `backend` container, so pair a backend run from source with the Vite dev server above.

### init on the host

```bash
POSTGRES_HOST=localhost MQTT_URL=mqtt://localhost:1883 LOG_FORMAT=text \
  uv run --package fdp-init fdp-init run
```

Outside the container, relative paths resolve against the repository root, so init reads `data/manual/`, `data/metropt3/`, `db/migrations` and `packages/contracts` from the checkout and caches the model in `data/models/`. `fdp-init --help` lists the other commands (`wait`, `migrate`, `dataset`, `model`, `ingest`, `report`, `export-catalog`), and `docker compose run --rm init report` prints the last ingest report of the stack ([`tools/init/README.md`](../tools/init/README.md)).

### The simulator and the gateway

`make -C services/modbus build` writes both binaries to `services/modbus/out/`. They read their configuration from the environment, listed in the "Environment" section of [`services/modbus/README.md`](../services/modbus/README.md); `SIM_HTTP_PORT` and `GATEWAY_HTTP_PORT` matter only when a binary runs outside Compose. From `services/modbus`, `go run ./cmd/modbus-sim index --csv <file>` indexes a CSV without starting a server.

## The tests

| Level               | Command                               | Lives in                                                                                                                                                      | Needs                                                                                                 |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Unit and contract   | `make test`                           | `*.test.ts` beside the code and under `scripts/`, Go `_test.go` files, `tools/*/tests`, `manual/tools/tests`, the contract suite in `packages/contracts/test` | The toolchain; tests that need a slice, the embedding model or WeasyPrint skip without it             |
| Integration         | `make test-integration`               | `*.integration.test.ts` and each package's `test:integration`, Go files behind the `integration` build tag, pytest's `integration` marker                     | Docker                                                                                                |
| init container      | `make test-init-e2e`                  | `tools/init/tests/e2e`                                                                                                                                        | Docker, and the network on a cold model cache                                                         |
| Browser, mock mode  | `make e2e-mock`, `make e2e-perf`      | `apps/frontend/e2e`                                                                                                                                           | Chromium; no Docker                                                                                   |
| Browser, stack mode | `make e2e`                            | `apps/frontend/e2e/tour.spec.ts`                                                                                                                              | The CI stack `make smoke SMOKE_ARGS=--keep` leaves running                                            |
| Stack smoke         | `make smoke`, `make smoke-quickstart` | `scripts/smoke.sh`                                                                                                                                            | Docker with Compose 2.24 or newer, `python3`, 5 GB of free disk and the CI slice from `make fixtures` |
| Live smoke          | `make smoke-live`                     | `scripts/smoke.sh`                                                                                                                                            | Docker and both keys in `.env`; paid calls                                                            |
| Evaluation          | `make eval`                           | `tools/eval`                                                                                                                                                  | The MetroPT-3 slices, and the full CSV for `EVAL_PROFILE=full`; no Docker                             |

### Unit and contract tests

`make test` runs `test-node` (the root Vitest project over `scripts/**/*.test.ts`, then every package's `test`), `test-go` (`go test ./...` in `services/modbus`) and `test-py` (`uv run pytest` over `tools/`, then the `manual/tools` tests). The contract layer lives in `packages/contracts`: every schema has one valid and one invalid fixture under `packages/contracts/fixtures/`, the contracts suite validates all of them, and the Go and Python tests validate what their code emits against the same schema files. To run one package, use its own verb, such as `pnpm --filter @fdp/backend test` or `make test-init`.

### Integration tests

`make test-integration` runs one sub-target per language: `test-integration-node` (the root `scripts/**/*.integration.test.ts`, then each package's `test:integration`, one package at a time so their containers do not compete for the Docker daemon), `test-integration-go` (`go test -tags integration -race ./...`) and `test-integration-py` (`uv run pytest -m integration`). The tests start the pinned Postgres and Mosquitto images through testcontainers on random host ports, with the committed broker configuration, and they hold the proofs `make test` cannot give: the database roles, the broker ACL, migration conformance, the container images and cross-language parity. A language that has no integration test yet is not a failure; a failing test is.

### Browser tests in two modes

Playwright runs one README tour, `e2e/tour.spec.ts`, in two modes:

```mermaid
flowchart LR
    PW["Playwright<br/>Chromium"]
    subgraph mockMode["make e2e-mock: no Docker"]
        VP["vite preview<br/>the built app"] -->|"/api and /ws"| FB["fake backend<br/>e2e/fake-backend"]
    end
    subgraph stackMode["make e2e: a running stack"]
        NG["frontend nginx<br/>at E2E_BASE_URL"] -->|"/api and /ws"| ST["backend and the rest<br/>of the Compose stack"]
    end
    PW -->|"projects mock and perf"| VP
    PW -->|"project stack"| NG
```

- **Mock mode.** `e2e/launch.ts` builds the app, serves it with `vite preview` and starts the scripted fake backend of `e2e/fake-backend/`, both on ports the system picks, so several worktrees can run the suite at once. The `mock` project runs the tour and the accessibility checks, and the `perf` project the streaming budget (`make e2e-perf` runs it alone). `E2E_SKIP_BUILD=1` reuses `dist/`.
- **Stack mode.** The `stack` project runs the tour against `E2E_BASE_URL`, else the URL a kept smoke stack wrote to `reports/smoke/ui-url`, else `http://localhost:8080`. The tour expects the CI stack, with Von answered by the mock TypeSafe server and the CI slice; it does not pass on a `make up` stack. Its setup waits for `GET /api/health`, rewinds the replay and sets 600×, so `make e2e` can run again on the same stack.

Reports land in `apps/frontend/playwright-report/`. The fake backend and its control routes are described in [`apps/frontend/README.md`](../apps/frontend/README.md).

### Stack smoke tests

`scripts/smoke.sh` builds its own stack under a unique project name on ephemeral ports, walks the README tour through the API and tears the stack down again:

- `make smoke` runs `compose.yaml` with `compose.ci.yaml`: the CI fixture slice and the mock decision service answering as Von. This is what CI runs.
- `make smoke-quickstart` runs the README quick start with the rules backend, on a copy of `.env.example` that selects the CI slice; it never touches your `.env` or a running demo.
- `make smoke-live` asserts one Von and one LLM decision with the keys of `.env`: opt-in, and the calls are paid.

`make smoke SMOKE_ARGS=--keep` leaves the stack up for `make e2e` and `make eval-stack`; remove it afterwards with `docker compose -p "$(cat reports/smoke/project)" down -v --remove-orphans`. The exit code says what failed: 1 an assertion, 2 the stack did not come up, 3 a decision opened no ticket where one is required, 4 a usage error, 5 live mode without its keys. `make smoke-quickstart` currently stops at its ticket assertion with exit 3 and a `known failure` line: on the real stack the rules backend's decision on the 5 June leak lands at gate `log`, so neither a ticket nor a review item opens. It is a recorded known failure ([evaluation.md](evaluation.md#current-results)), and no threshold is lowered to pass it.

### The evaluation

`make eval` replays the evaluation scenarios in process, through the backend's own pipeline, and writes a report to `reports/eval/`; it needs no Docker and no running stack. `EVAL_PROFILE` picks `smoke` (five short scenarios, what CI runs), `core` (the default), `dev` (the dev split, outside the core-10 and the held-out set) or `full` (the core-10 and the dev split less its diagnostic scenarios and the leak's dev twin, the whole recording included, from the downloaded CSV), and `EVAL_VON_MODE` picks how Von is reached: `auto`, `live`, `cassette` or `mock`. With `TYPESAFE_API_KEY` exported, `auto` resolves to `live`, and a live run is planned and refused without `--confirm-live`, which `make eval` never passes; flags go through `pnpm --filter @fdp/eval run eval -- <flags>`. `make eval-stack` scores a running stack from its database as the `eval` role, and `make eval-sweep` chooses Von's gate thresholds as pre-registered, re-gating the tuning scenarios' recorded Von answers over a grid of pairs with no API call. Scenarios, metrics and reports are in [evaluation.md](evaluation.md).

### What every test follows

- Tests are deterministic: fake clocks, seeded randomness, committed fixtures, random host ports and a unique Compose project name, so parallel worktrees never collide.
- The decision backend in tests is the contracts' mock TypeSafe server. No test calls a live API except the opt-in live ones, and CI holds no key.
- No test contains a real brand name.
- A test whose resource is missing skips with a message. CI sets `FDP_REQUIRE_DOCKER=1`, `FDP_REQUIRE_DATASET=1`, `FDP_REQUIRE_SCHEMAS=1` and `FDP_REQUIRE_CONTRACTS=1`, plus `FDP_REQUIRE_MODEL=1` in its integration job, so that such a skip fails there; set the same variables locally to be sure nothing was skipped. `FDP_TIMING_SLACK` multiplies every wall-clock bound, and CI sets it to 3.

## The three gate levels

| Gate             | Runs                                                                   | When                                                                                         |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `make check`     | `lint test`                                                            | Before every commit                                                                          |
| `make check-int` | `check test-integration`                                               | Before a pull request that touches the database, the broker or the images                    |
| `make ci`        | `lint test test-integration test-init-e2e reuse licenses check-manual` | Before a larger pull request; CI runs these targets as separate jobs, except `test-init-e2e` |

Each gate contains the one before it:

```mermaid
flowchart TB
    subgraph gci["make ci: the full gate"]
        subgraph gint["make check-int: plus the integration tests"]
            subgraph gcheck["make check: before every commit"]
                nlint["lint"]
                ntest["test"]
            end
            nti["test-integration"]
        end
        ninit["test-init-e2e"]
        nreuse["reuse"]
        nlic["licenses"]
        ncm["check-manual"]
    end
```

- A gate is its prerequisites in order, so `make -k check` keeps going and shows every failure at once.
- `make lint` runs, in this order, the repository checks `spdx`, `gt-paths`, `env-check`, `reuse-order` and `blocklist` (seconds), then `compose-check` and `actionlint`, then the language linters `lint-ts`, `lint-py`, `lint-go` and `boundaries`. Without Docker, `compose-check` runs only its source checks and says so, and `actionlint` is skipped when neither its binary nor its pinned image is available, so `make check` needs no Docker.
- `make check` runs no integration test: the database-role, broker-ACL, migration-conformance, container and parity proofs all sit behind `make check-int`.
- `make ci` also needs Docker, WeasyPrint for the manual checks, and the network on cold caches: the REUSE tool through `uvx`, the Go licence collector and the init image's model download. A target whose implementation is missing fails rather than skips; the one exception is a language with no integration test yet.
- The stack checks belong to no gate. They run against one kept stack, as CI's `stack` job does: `scripts/smoke.sh --mode ci --keep --report reports/smoke`, then `make e2e` and `make eval-stack`.
- `scripts/foundation-smoke.sh` clones a revision into a temporary directory and runs `make install` and `make check` there with nothing but the documented toolchain. Run it before you claim that a change works on a clean clone.

### In CI

`.github/workflows/ci.yml` runs the same targets as separate jobs, except `make test-init-e2e`, which only `make ci` runs:

| Job                                                    | Runs                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `lint`                                                 | `make lint`; on a pull request also `fdp-checks commits` over the pull request's commits     |
| `test`                                                 | `make test`                                                                                  |
| `test-integration (node)`, `test-integration (python)` | `make test-integration-node`, `make test-integration-py`                                     |
| `reuse`, `licenses`                                    | `make reuse`, `make licenses`                                                                |
| `contract-drift`                                       | Regenerates the contract artefacts and the broker ACL, and fails on a diff                   |
| `manual-spec`, `check-manual`                          | `make check-manual-spec`; the manual rebuilt in its pinned image, then its acceptance checks |
| `go`                                                   | The Go module's vet, unit, race and integration tests, its lint and the image smoke          |
| `frontend`                                             | Type-check, lint, test and build the frontend, then `e2e:mock`                               |
| `foundation-smoke`                                     | `scripts/foundation-smoke.sh`                                                                |
| `stack`                                                | `scripts/smoke.sh --mode ci --keep`, then `make e2e` and `make eval-stack`                   |
| `quickstart`                                           | `make up` in a fresh clone, then `scripts/smoke.sh --mode quickstart`                        |
| `eval-smoke`                                           | The smoke profile with `--fail-on-gate`                                                      |

Two advisory jobs run only on demand or weekly: `mosquitto-next` and `quickstart-download`. The workflow uses no repository secret. `quickstart` is a recorded known failure: with the rules backend on the catalog of the realistic PDF, the decision on the 5 June leak stays below the review threshold, so the job stops at its ticket assertion. Its log names the reason, and the job is not weakened to pass.

## The conventions

### Commits

Every commit is a Conventional Commit, as in this one from the history:

```text
test(frontend): accessibility checks with axe
```

- **Types:** `feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor`, `perf`, `style`.
- **Scopes**, required: `repo`, `manual`, `pdf`, `contracts`, `gt`, `db`, `sim`, `gateway`, `init`, `backend`, `frontend`, `eval`, `infra`, `ci`, `deps`, `docs`, `data` and `merge` (merge commits).
- **Subject:** lower-case, imperative and at most 72 characters after `: `; a `!` after the scope marks a breaking change. Merge and revert subjects that git writes itself are exempt.
- **Body:** optional; say what changed and why.
- **Staging:** name explicit paths, never `git add -A` or `git add .`, and never commit `.env`, `data/metropt3/*`, `node_modules`, `.venv` or build output.

`make commits` checks the subjects of `BASE..HEAD`, with `BASE` defaulting to `origin/main`; in a fork, name the upstream remote, as in `make commits BASE=upstream/main`. The scopes and types are those of `tools/repo-checks/src/fdp_repo_checks/commands/commits.py`, and the full rules are in [CONTRIBUTING.md §4](../CONTRIBUTING.md#4-commits).

### Branches and shared files

A change arrives as a pull request against `main` from a feature branch, as [CONTRIBUTING.md §3](../CONTRIBUTING.md#3-branches-and-pull-requests) describes. Files that many kinds of change touch (the root manifests and lock files, `Makefile`, `compose*.yaml`, the workflows, `README.md`, `CHANGELOG.md`, `.env.example`, `REUSE.toml` and the lint configurations) get small, self-contained edits, and lock files are regenerated rather than merged ([CONTRIBUTING.md §5](../CONTRIBUTING.md#5-shared-files)). `.env.example` and the README's [Configuration](../README.md#configuration) table change together, and `make env-check` must stay green.

### The opt-in git hooks

```bash
make hooks   # git config core.hooksPath .githooks
```

The `pre-commit` hook runs `fdp-checks spdx --staged` and `fdp-blocklist scan --staged`; the `commit-msg` hook checks the subject grammar of the message being written. Both call `uv run --frozen --all-packages`, so they work before `make install`, and both stop with a hint when uv is not on the PATH. Skip them for one commit with `git commit --no-verify`, and switch them off with `git config --unset core.hooksPath`.

### SPDX headers and REUSE

Every file whose format has comments carries the project's two-line SPDX header, a copyright line for "2026 Meddle S.r.l." and a licence identifier, in that format's comment syntax, the licensing layout of ground rule 4 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)). Code and configuration are Apache-2.0; the manual, the fault catalog, synthetic data and documentation are CC-BY-4.0; trivial dotfiles, lock files and `.githooks/*` are CC0-1.0; fonts keep OFL-1.1 and copied shadcn/ui sources keep MIT. The licence of each path is recorded in [`REUSE.toml`](../REUSE.toml) and in the files' own SPDX headers, and [`NOTICE`](../NOTICE) summarises the licences in use; the exact header lines are in [CONTRIBUTING.md §6](../CONTRIBUTING.md#6-licences-and-spdx-headers).

- A format without comments (JSON, PDF, CSV, fonts) is covered by a `REUSE.toml` table or a `<file>.license` sidecar instead.
- `REUSE.toml` resolves a path against its last matching table, so new tables go below the line `# --- specific annotations: append below this line, never above ---`.
- `make spdx` checks the headers offline and also runs in the pre-commit hook, `make reuse-order` guards the table order, and `make reuse` runs `reuse lint` over the whole tree.

### The brand blocklist

Ground rule 2 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)): no manufacturer, product line, controller name, model code or part number of a real machine may enter the repository, whether in code, a test, the manual or a commit message. `make blocklist` scans every tracked and untracked-but-not-ignored file and the manual PDFs; `uv run fdp-blocklist list` shows the section names and term counts, and `uv run fdp-blocklist self-test` checks the matcher with synthetic terms. The committed term list is hashed, and extending it is described in [CONTRIBUTING.md §7](../CONTRIBUTING.md#7-no-real-brand-names). A false positive gets a line in `tools/blocklist/data/allow.txt` with its reason; a real brand name is removed from the file, never exempted.

### Import boundaries

Ground rule 3 ([CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules)) keeps ground truth out of the diagnosis, and the boundaries are enforced in all three languages: dependency-cruiser mirrored by ESLint for TypeScript (`pnpm run lint:boundaries`), an import test mirrored by golangci-lint's `depguard` for Go (`go test ./internal/arch/...` in `services/modbus`) and import-linter for Python (`uv run lint-imports`). `make boundaries` runs all three, and `make gt-paths` also fails when a diagnosis path names a ground-truth package, topic or table. A new workspace member has to join every list that names the members ([CONTRIBUTING.md §8](../CONTRIBUTING.md#8-import-boundaries)). The allowed import directions, the rule names and the tests that prove the rules fire are in [architecture.md](architecture.md#import-boundaries).

### The CHANGELOG

[`CHANGELOG.md`](../CHANGELOG.md) follows Keep a Changelog, with one section per release. A pull request describes its user-visible changes, and the maintainers carry them into the CHANGELOG.

### Formatting and dependencies

`make fmt` formats every language in place: Prettier and ESLint fixes, golangci-lint's formatters for Go and ruff for Python. Prettier leaves `README.md`, `CHANGELOG.md`, the evaluation records under `tools/eval/records/` and the byte-pinned sources and fixtures that `.prettierignore` lists alone, while the guides under `docs/` are formatted like everything else. A new dependency is verified at its registry when you add it (ground rule 8), and the commit body names the source it was verified against; it is added per ecosystem as [CONTRIBUTING.md §9](../CONTRIBUTING.md#9-adding-a-dependency) describes; `make licenses` must stay green ([security.md](security.md) covers the licence policy).

## Further reading

- [`CONTRIBUTING.md`](../CONTRIBUTING.md): the prerequisites, the daily loop, commits, licences, the blocklist and the tests.
- [`REUSE.toml`](../REUSE.toml) and [`NOTICE`](../NOTICE): the licence of every path and the licences in use.
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): the CI workflow and its jobs, each commented with what it runs and why.
- Package guides: [`apps/backend/README.md`](../apps/backend/README.md), [`apps/frontend/README.md`](../apps/frontend/README.md), [`services/modbus/README.md`](../services/modbus/README.md), [`tools/init/README.md`](../tools/init/README.md) and [`tools/eval/README.md`](../tools/eval/README.md).
- Code: `Makefile`, `scripts/doctor.sh`, `scripts/smoke.sh`, `scripts/foundation-smoke.sh`, `.githooks/`, `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, `pyproject.toml` and `services/modbus/go.mod`.
- Related guides: [architecture.md](architecture.md), [security.md](security.md), [evaluation.md](evaluation.md) and [api.md](api.md).
