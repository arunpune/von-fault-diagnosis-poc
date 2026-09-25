# SPDX-FileCopyrightText: 2026 Meddle S.r.l.
# SPDX-License-Identifier: Apache-2.0
#
# Module-level verbs for the Go module. The root Makefile is the documented
# entry point and delegates here with `$(MAKE) -C services/modbus <verb>`; this
# file adds the module's build and docker verbs. GNU Make 3.81 compatible: no
# .ONESHELL, no $(file ...), no != and no ::=; recipes are POSIX sh.

GO ?= go
GOLANGCI_LINT ?= golangci-lint
# Build output; `out/` is gitignored and matches the Dockerfile's /out.
BIN_DIR ?= out

# How long the benchmarks measure each case. Two seconds is enough for the
# emit path to settle on this hardware; raise it when comparing runs.
BENCHTIME ?= 2s

.PHONY: lint fmt vet test test-race test-integration bench e2e build docker-smoke fixtures tidy clean

lint: ## Lint the module; the v2 formatters report unformatted files as issues
	@if command -v $(GOLANGCI_LINT) >/dev/null 2>&1; then \
		$(GOLANGCI_LINT) run ./...; \
	else \
		echo "golangci-lint is not installed (brew install golangci-lint); running go vet instead"; \
		$(GO) vet ./...; \
	fi

fmt: ## Format every package in place
	$(GOLANGCI_LINT) fmt ./...

vet: ## Run the standard vet checks
	$(GO) vet ./...

test: ## Run the unit tests
	$(GO) test ./...

test-race: ## Run the unit tests under the race detector
	$(GO) test -race ./...

test-integration: ## Run the tests behind the `integration` build tag
	$(GO) test -tags integration -race ./...

bench: ## Measure the emit path and the register store (README "Performance")
	$(GO) test ./internal/sim/ -run '^$$' -bench . -benchtime $(BENCHTIME) -benchmem

e2e: ## Run the full-stack scenarios alone: sim + gateway + a Mosquitto container
	$(GO) test -tags integration -race ./internal/e2e/... -timeout 10m

build: ## Build both binaries into $(BIN_DIR)
	$(GO) build -trimpath -o $(BIN_DIR)/modbus-sim ./cmd/modbus-sim
	$(GO) build -trimpath -o $(BIN_DIR)/gateway ./cmd/gateway

docker-smoke: ## Build both images and prove they run
	bash scripts/image-smoke.sh

fixtures: ## Cut the MetroPT-3 slices the tests read (delegates to the root)
	$(MAKE) -C ../.. fixtures

tidy: ## Reconcile go.mod and go.sum with the imports in the tree
	$(GO) mod tidy

clean: ## Remove the build output
	rm -rf $(BIN_DIR)
