# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# The single documented entry point (docs/development.md). Every target carries
# a `##` comment that `make help` prints. GNU Make 3.81 compatible: no
# .ONESHELL, no $(file ...), no != and no ::=; recipes are POSIX sh.
#
# A delegating target whose implementation has not landed yet fails visibly
# instead of skipping, so a missing deliverable cannot hide. The exceptions
# are documented at the targets themselves: `test-integration` (a language may
# legitimately have no integration test yet, so `check-int` works before every
# language has one) and `fixtures` (it also runs on a machine without the
# dataset).

PNPM ?= pnpm
UV ?= uv
GO ?= go
COMPOSE ?= docker compose
# The file combination every compose target runs with; `up-dev` and the smoke
# script override it.
COMPOSE_FILES ?= -f compose.yaml
# How long `make up` waits for the stack: init's dependency wait (120 s) plus
# its download budget (3600 s) plus 600 s for the embedding model and 600 s for
# extraction and embeddings.
UP_WAIT_TIMEOUT_S ?= 4920
REUSE ?= uvx "reuse[charset-normalizer]@6.2.0"
GOMOD := services/modbus
BASE ?= origin/main
# The pinned image the committed manual PDFs are built in.
MANUAL_IMAGE ?= fdp-manual-build:local
# The workflow linter, pinned by digest; `.github/workflows/ci.yml` runs the
# same image.
ACTIONLINT_IMAGE ?= rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
# manual/tools sits outside the uv workspace on purpose, so it runs in a fresh
# worktree with no `make install`.
MANUAL_PY := $(UV) run --no-project --with-requirements manual/tools/requirements.txt
# WeasyPrint loads GObject and Pango through the dynamic loader. On macOS they
# live in the Homebrew prefix and nothing else puts them on the search path, so
# without this every WeasyPrint-backed test skips and check #9 cannot rebuild.
# DYLD_* is ignored on Linux, where the loader finds them itself.
# Override with an empty value or another prefix.
WEASYPRINT_ENV ?= DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib

.DEFAULT_GOAL := help

.PHONY: help doctor install up up-dev logs ps down reset reset-db compose-check fetch-dataset fixtures \
	test test-node test-go test-py test-init-quality test-integration \
	test-integration-node test-integration-go test-integration-py \
	test-init test-init-integration test-init-e2e \
	lint lint-ts lint-go lint-py boundaries spdx gt-paths env-check reuse-order blocklist commits actionlint \
	reuse reuse-spdx licenses fmt generate mosquitto-acl mosquitto-passwd \
	manual manual-image manual-native manual-html check-manual-spec check-manual \
	eval eval-stack eval-sweep e2e e2e-mock e2e-perf \
	manual-scanned \
	smoke smoke-quickstart smoke-live docker-smoke-sim check check-int ci hooks clean

help: ## List every target with its description
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN { FS = ":.*## " } { printf "  %-16s %s\n", $$1, $$2 }'

doctor: ## Check that the toolchain is installed and current
	@scripts/doctor.sh

install: ## Install every language's dependencies from the lock files
	$(PNPM) install --frozen-lockfile
	$(UV) sync --all-packages --frozen
	$(GO) -C $(GOMOD) mod download

fetch-dataset: ## Download MetroPT-3 into data/metropt3 and verify it against data/SHA256SUMS
	scripts/data/fetch-metropt3.sh

# METROPT_CSV_HOST is the host-side path the cutter reads, so a linked worktree
# points it at the main checkout instead of copying 208 MB. An absent source is
# a skip, unless FDP_REQUIRE_DATASET says the caller needs the dataset; the
# cutter itself prints the notice and picks the exit code.
fixtures: ## Cut the MetroPT-3 slices the tests read (gitignored output)
	@python3 scripts/data/cut-metropt-slices.py \
		--source "$${METROPT_CSV_HOST:-data/metropt3/MetroPT3(AirCompressor).csv}" \
		--out-dir data/fixtures/metropt3 --verify

# `--wait` is what makes a failed init fail the command instead of leaving half
# a stack behind. The wait can expire while init is still downloading, which is
# not a failure of the stack, so the elapsed time tells the two apart and the
# message says what to do.
up: ## Build and start the whole stack in the background and wait until it is healthy
	@started=$$(date +%s); status=0; \
	$(COMPOSE) $(COMPOSE_FILES) up --build -d --wait --wait-timeout $(UP_WAIT_TIMEOUT_S) || status=$$?; \
	if [ $$status -ne 0 ] && [ $$(($$(date +%s) - $$started)) -ge $(UP_WAIT_TIMEOUT_S) ]; then \
		echo "up: init is still working: run 'make logs', then 'make up' again (downloads resume)"; \
	fi; \
	exit $$status

up-dev: ## Same as up, plus the fixed development ports of compose.dev.yaml
	@$(MAKE) up COMPOSE_FILES="-f compose.yaml -f compose.dev.yaml"

logs: ## Follow the logs of every service
	$(COMPOSE) $(COMPOSE_FILES) logs -f --tail=200

ps: ## Show the state of every service
	$(COMPOSE) $(COMPOSE_FILES) ps

down: ## Stop the stack and keep its volumes
	$(COMPOSE) $(COMPOSE_FILES) down --remove-orphans

reset: ## Stop the stack and delete its volumes; the next `make up` re-ingests
	$(COMPOSE) $(COMPOSE_FILES) down -v --remove-orphans

# `reset` also deletes the model cache, which costs the ≈ 91 MB download again.
# This drops the database volume only: the next `make up` re-creates the
# roles, re-applies the migrations and re-ingests the manual with the cached
# model. Compose names the volume itself, so a COMPOSE_PROJECT_NAME override is
# honoured, and `--no-interpolate` keeps every `.env` value out of the
# configuration it renders.
reset-db: ## Stop the stack and delete only the database volume; the model cache stays
	$(COMPOSE) $(COMPOSE_FILES) down --remove-orphans
	@volume=$$($(COMPOSE) $(COMPOSE_FILES) config --no-interpolate --format json \
		| python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["pgdata"]["name"])') \
		|| exit 1; \
	if docker volume inspect "$$volume" >/dev/null 2>&1; then \
		docker volume rm "$$volume"; \
	else \
		echo "reset-db: no volume $$volume; nothing to delete"; \
	fi

compose-check: ## Validate the compose files and the invariants the stack relies on
	scripts/ops/compose-check.sh

# The same linter the `lint` job runs, so a workflow mistake is caught before
# it is pushed (the image is pinned by digest). Neither the binary nor the
# image is part of the documented toolchain, so a machine that has neither and
# cannot pull skips with a notice instead of failing `make lint`.
actionlint: ## Lint the GitHub Actions workflows (skipped when neither actionlint nor the image is available)
	@if command -v actionlint >/dev/null 2>&1; then \
		actionlint -color; \
	elif command -v docker >/dev/null 2>&1 && { \
		docker image inspect $(ACTIONLINT_IMAGE) >/dev/null 2>&1 || \
		docker pull -q $(ACTIONLINT_IMAGE) >/dev/null 2>&1; }; then \
		docker run --rm -v "$(PWD):/repo" -w /repo $(ACTIONLINT_IMAGE) -color; \
	else \
		echo "actionlint: neither the binary nor $(ACTIONLINT_IMAGE) is available; skipping"; \
	fi

test: test-node test-go test-py ## Run the unit and contract tests of every language

test-node: ## Run the TypeScript unit tests
	$(PNPM) run test
	$(PNPM) -r run test

test-go: ## Run the Go unit tests
	$(MAKE) -C $(GOMOD) test

test-py: ## Run the Python unit tests
	$(WEASYPRINT_ENV) $(UV) run pytest
	$(MANUAL_PY) pytest manual/tools/tests -q

# Manual acceptance checks 3-5 on what init extracts, not on what the manual
# build prints: writes reports/init-extraction-quality.json.
test-init-quality: ## Measure init's extraction of the committed manuals against the reference catalog
	$(UV) run --package fdp-init pytest -m quality tools/init/tests/quality -q

# One sub-target per language, because CI runs them on separate runners
# and the Go layer runs only in the `go` job.
test-integration: test-integration-node test-integration-go test-integration-py ## Run the integration tests; a language without one yet is not a failure

# One workspace project at a time: `db-migrate` and `eval` both hold containers
# for the length of a test, and `pnpm -r` would otherwise start them together.
# It is the same reason `tools/eval/vitest.integration.config.ts` sets
# `fileParallelism: false` — two suites at once fight over the Docker daemon,
# and what gives way is the host port a published container is reached on: the
# forward accepts the connection and carries nothing, so the parity harness
# waits out its whole connect budget while the broker's own log never mentions
# it. Serialising them costs about fifteen seconds and removes the failure.
test-integration-node: ## Run the TypeScript integration tests
	$(PNPM) run test:integration
	$(PNPM) -r --workspace-concurrency=1 run --if-present test:integration

test-integration-go: ## Run the Go integration tests
	$(MAKE) -C $(GOMOD) test-integration

test-integration-py: ## Run the Python integration tests; an empty collection (exit 5) is not a failure
	@$(UV) run pytest -m integration; rc=$$?; if [ $$rc -eq 5 ]; then rc=0; fi; exit $$rc

# The layers of the init service, one at a time.
# `test-py` and `test-integration-py` already collect tools/init/tests, so the
# umbrellas do not run the first two a second time. The container end-to-end
# test runs in no other target, so the full gate `ci` calls it: it builds the
# init image, skips without Docker unless FDP_REQUIRE_DOCKER=1, and reuses a
# warm model cache when INIT_TEST_MODEL_CACHE names one.
test-init: ## Run the init unit tests
	$(UV) run --package fdp-init pytest tools/init/tests/unit tools/init/tests/test_package.py

test-init-integration: ## Run the init integration tests against pgvector and Mosquitto (Docker)
	$(UV) run --package fdp-init pytest -m integration tools/init/tests/integration

test-init-e2e: ## Build the init image and run it end to end (Docker; network on a cold model cache)
	$(UV) run --package fdp-init pytest -m e2e tools/init/tests/e2e

lint: spdx gt-paths env-check reuse-order blocklist compose-check actionlint lint-ts lint-py lint-go boundaries ## Run every linter, fast repository checks first

lint-ts: ## Lint and type-check the TypeScript workspace
	$(PNPM) run lint

lint-go: ## Lint the Go module
	$(MAKE) -C $(GOMOD) lint

lint-py: ## Lint, format-check and type-check the Python workspace
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy
	$(UV) run lint-imports

# One recipe line per language: TypeScript, Go, then Python.
boundaries: ## Enforce the allowed import directions in all three languages
	$(PNPM) run lint:boundaries
	cd $(GOMOD) && $(GO) test ./internal/arch/...
	$(UV) run lint-imports

spdx: ## Check the SPDX headers of every tracked file (offline)
	$(UV) run fdp-checks spdx

gt-paths: ## Check that no diagnosis path reaches ground truth
	$(UV) run fdp-checks gt-paths

env-check: ## Check .env.example against the README table and the compose files
	$(UV) run fdp-checks env

reuse-order: ## Check that REUSE.toml still resolves every licence class
	$(UV) run fdp-checks reuse-order

blocklist: ## Scan the repository for real brand names
	$(UV) run fdp-blocklist scan

commits: ## Check the Conventional Commits subjects of BASE..HEAD (BASE defaults to origin/main)
	$(UV) run fdp-checks commits --range $(BASE)..HEAD

licenses: ## Audit the licences of every dependency
	$(UV) run fdp-checks licenses

reuse: ## Check REUSE/SPDX compliance of the whole tree
	$(REUSE) lint

reuse-spdx: ## Write an SPDX SBOM to reports/sbom.spdx
	@mkdir -p reports
	$(REUSE) spdx -o reports/sbom.spdx

fmt: ## Format every language in place
	$(PNPM) run fmt
	$(MAKE) -C $(GOMOD) fmt
	$(UV) run ruff format .
	$(UV) run ruff check --fix .

generate: ## Regenerate the contract artefacts
	$(PNPM) --filter @fdp/contracts generate

# The broker's two generated files. The ACL follows
# packages/contracts/topics.json and `scripts/ops/acl.test.ts` fails on drift;
# the hashed passwd exists only for the testcontainers helpers that copy files
# into a stock image, and its salts are random, so regenerate it only when
# infra/mosquitto/passwd.txt changes.
mosquitto-acl: ## Render infra/mosquitto/acl from packages/contracts/topics.json
	$(PNPM) exec tsx scripts/ops/render-mosquitto-acl.ts $(ARGS)

mosquitto-passwd: ## Rehash infra/mosquitto/passwd from infra/mosquitto/passwd.txt
	scripts/ops/mosquitto-passwd.sh

# The reference build runs in the container: WeasyPrint's line breaking
# depends on the Pango and HarfBuzz versions, which differ between macOS and
# Linux. `manual-native` is for iteration and never writes into
# data/manual.
manual-image: ## Build the pinned image the committed manual PDFs come from
	docker build -f tools/manual-build/Dockerfile -t $(MANUAL_IMAGE) .

manual: manual-image ## Rebuild the manual PDFs from manual/spec in the pinned container
	docker run --rm --user $$(id -u):$$(id -g) -v $(PWD):/work \
		-e SOURCE_DATE_EPOCH=1767225600 $(MANUAL_IMAGE) build

manual-native: ## Rebuild the PDFs natively into tools/manual-build/.build/native (iteration only)
	$(WEASYPRINT_ENV) $(UV) run --package fdp-manual-build \
		fdp-manual-build build --out-dir tools/manual-build/.build/native --no-catalog

manual-html: ## Write the intermediate HTML of both variants and stop, for a browser
	$(UV) run --package fdp-manual-build fdp-manual-build build --html-only

# The optional scanned variant: the realistic PDF rasterised, skewed and
# noised for OCR tests. data/manual/.gitignore keeps it out of Git, and the
# manifest is left alone unless --update-manifest is passed.
manual-scanned: manual-image ## Write data/manual/cau-7-scanned.pdf, an image-only OCR test copy (not committed)
	docker run --rm --user $$(id -u):$$(id -g) -v $(PWD):/work $(MANUAL_IMAGE) scanned

check-manual-spec: ## Validate manual/spec and the chapters against the manual's content rules
	$(MANUAL_PY) python manual/tools/validate.py --strict --report
	$(MANUAL_PY) python manual/tools/content_checks.py --variant both

# Check #9 rebuilds the manual in process. The pinned container build stays
# the reference, because it makes the PDFs reproducible: hand it over with
# `make check-manual REBUILT_DIR=.rebuild` after `make manual`, exactly as the
# check-manual CI job does.
check-manual: ## Run the manual acceptance checks and write reports/manual-check.*
	@mkdir -p reports
	$(WEASYPRINT_ENV) $(UV) run --package fdp-manual-build fdp-manual-check \
		$(if $(REBUILT_DIR),--rebuilt-dir $(REBUILT_DIR),) --report-dir reports

eval: ## Run the evaluation scenarios and write a report to reports/
	$(PNPM) --filter @fdp/eval run eval

# `scripts/smoke.sh --keep` writes the eval role's URL of the stack it left
# running to reports/smoke/db-url-eval; without that file the target reads the
# Postgres compose.dev.yaml publishes on localhost:5432. The role's password is
# the PoC default (docs/security.md), not a secret.
EVAL_STACK_URL_FILE := reports/smoke/db-url-eval
DATABASE_URL_EVAL ?= $(if $(wildcard $(EVAL_STACK_URL_FILE)),$(shell cat $(EVAL_STACK_URL_FILE)),postgres://eval:eval@localhost:5432/fdp)

eval-stack: ## Score the running stack from its database, read-only as the eval role
	$(PNPM) --filter @fdp/eval run score-stack -- --db-url "$(DATABASE_URL_EVAL)"

# The pre-registered choice of Von's gate thresholds and, since its amendment of
# 2026-09-24, of GATE_PERSIST_SIM_MIN with them: a triple
# (tools/eval/records/von-thresholds-preregistration.md). It replays the
# explicit tuning list only, never a --profile dev or a core run, with Von
# answered from cassettes and nothing called: each N of 0 and 1 from its own
# recording, once per resample that recording holds, into
# $(EVAL_SWEEP_OUT)/persist-<N>/resample-<r>/. It then re-gates every resample
# over the pre-registered grid, applies the selection rule and writes
# preregistered-sweep.json and .md there, or names a missing recording and
# chooses nothing; reports/eval/latest.json stays `make eval`'s. The two
# recordings are paid live runs that come before it:
# `GATE_PERSIST_SIM_MIN=<N> VON_GATE_REVIEW_MIN_CONFIDENCE=0.60 pnpm --filter @fdp/eval run record -- --tuning --confirm-live`
# for N = 0 and N = 1. The choice is recorded, once, with
# `pnpm --filter @fdp/eval run sweep -- --preregistered --from-runs --record-choice`.
EVAL_SWEEP_OUT ?= reports/eval/sweep

eval-sweep: ## Re-gate Von's recorded tuning-list answers at N = 0 and 1 over the pre-registered grid, every resample
	$(PNPM) --filter @fdp/eval run sweep -- --preregistered --out "$(CURDIR)/$(EVAL_SWEEP_OUT)"

# `scripts/smoke.sh --mode ci --keep` writes the URL of the stack it left
# running to reports/smoke/ui-url. `make e2e` runs the README tour against
# E2E_BASE_URL when it is set, else against that URL, else against
# http://localhost:8080. The tour's expectations hold only on that CI stack
# (the mock decision service answering as Von), not on a `make up` stack.
# Its `stack-setup` project rewinds the replay first, so the target can run
# again on the same stack.
E2E_UI_URL_FILE := reports/smoke/ui-url
E2E_BASE_URL ?= $(if $(wildcard $(E2E_UI_URL_FILE)),$(shell cat $(E2E_UI_URL_FILE)),http://localhost:8080)

e2e: ## Run the browser tour against a running stack (E2E_BASE_URL, else reports/smoke/ui-url)
	E2E_BASE_URL="$(E2E_BASE_URL)" $(PNPM) --filter @fdp/frontend run e2e:stack

e2e-mock: ## Run the browser tests against the fake backend: projects mock and perf, no Docker
	$(PNPM) --filter @fdp/frontend run e2e:mock

e2e-perf: ## Run the browser streaming budget against the fake backend (project perf)
	$(PNPM) --filter @fdp/frontend run e2e:perf

# The Compose smoke test (scripts/smoke.sh). Each target builds and
# starts its own stack on ephemeral ports and tears it down again; SMOKE_ARGS
# passes options through, e.g. `make smoke SMOKE_ARGS=--keep` leaves the stack
# for `make e2e` and `make eval-stack`. smoke-live reads the keys of ENV_FILE
# (default ./.env) with grep -q only and exits 5 when one is missing.
SMOKE_ARGS ?=

smoke: ## Build the CI stack (mock decision service) and assert the README tour through the API
	scripts/smoke.sh --mode ci $(SMOKE_ARGS)

smoke-quickstart: ## Run the README quick start with the rules backend and assert the tour
	scripts/smoke.sh --mode quickstart $(SMOKE_ARGS)

smoke-live: ## Assert one von and one llm decision with the keys of ENV_FILE (default ./.env)
	scripts/smoke.sh --mode live $(SMOKE_ARGS)

# The image smoke of the Go module: it starts nothing of the stack, so it needs
# no `make up` and collides with no running one.
docker-smoke-sim: ## Build the simulator and gateway images and prove they run
	$(MAKE) -C $(GOMOD) docker-smoke

# The three gate levels (docs/development.md). Each one is its
# prerequisites in order, so `make -k check` still shows every failure.
check: lint test ## Fast gate before a commit: lint plus the unit tests
	@echo "check: green (lint, unit and contract tests)"

check-int: check test-integration ## Gate before a pull request that touches the database, the broker or the images: check plus the integration tests
	@echo "check-int: green (check plus the integration tests)"

ci: lint test test-integration test-init-e2e reuse licenses check-manual ## Full gate: lint, every test, REUSE, licences and the manual checks
	@echo "ci: green (the full gate)"

hooks: ## Enable the opt-in git hooks in .githooks
	git config core.hooksPath .githooks
	@echo "hooks: core.hooksPath is .githooks; pre-commit checks the staged"
	@echo "       headers and brands, commit-msg the subject. Skip one commit"
	@echo "       with 'git commit --no-verify', disable them again with"
	@echo "       'git config --unset core.hooksPath'."

clean: ## Remove installed dependencies, build output and reports
	rm -rf node_modules .venv coverage
	rm -rf apps/*/node_modules packages/*/node_modules tools/*/node_modules
	rm -rf apps/*/dist packages/*/dist tools/*/dist
	rm -rf apps/*/coverage packages/*/coverage tools/*/coverage
	rm -rf .pytest_cache .ruff_cache .mypy_cache .import_linter_cache
	rm -rf reports/*
