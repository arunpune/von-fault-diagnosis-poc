// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// modulePath is the import path of this module; go.mod is the source of truth.
const modulePath = "fault-diagnosis-poc/services/modbus"

// groundTruthPackages are the package prefixes the gateway must never reach,
// directly or through any chain (ground-truth isolation).
//
// Beyond the replay engine and the injector it also keeps the CSV source, the
// controller emulation and the load-state rule out of the connector, so the
// gateway cannot grow a second opinion about the machine. It stamps and
// forwards.
func groundTruthPackages(module string) []string {
	return []string{
		module + "/internal/sim",
		module + "/internal/injection",
		module + "/internal/replay",
		module + "/internal/ctrl7",
		module + "/internal/machine",
	}
}

// gatewayPackages are the package prefixes the simulator must never reach: the
// machine does not contain its own connector.
func gatewayPackages(module string) []string {
	return []string{module + "/internal/gateway"}
}

// hasGoFiles reports whether dir holds at least one Go source file. A missing
// or empty directory is not an error here: the boundary test skips until the
// binary exists.
func hasGoFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".go") {
			return true
		}
	}
	return false
}

// TestGatewayNeverImportsSimOrInjection is the authoritative import-boundary
// check of the Go module; the depguard rule in .golangci.yml only mirrors it.
func TestGatewayNeverImportsSimOrInjection(t *testing.T) {
	t.Parallel()

	if !hasGoFiles(filepath.Join("..", "..", "cmd", "gateway")) {
		t.Skip("cmd/gateway not present yet")
	}

	deps, err := ListDeps(filepath.Join("..", ".."), "./cmd/gateway")
	if err != nil {
		t.Fatalf("listing the dependencies of ./cmd/gateway: %v", err)
	}
	if hits := Forbidden(deps, groundTruthPackages(modulePath)); len(hits) != 0 {
		t.Errorf("cmd/gateway reaches %q; the gateway stamps and forwards and "+
			"never sees replay or injection code (ground-truth isolation)", hits)
	}
}

// TestSimNeverImportsTheGateway is the other half of the boundary: the machine
// exposes registers and never polls itself.
func TestSimNeverImportsTheGateway(t *testing.T) {
	t.Parallel()

	if !hasGoFiles(filepath.Join("..", "..", "cmd", "modbus-sim")) {
		t.Skip("cmd/modbus-sim not present yet")
	}

	deps, err := ListDeps(filepath.Join("..", ".."), "./cmd/modbus-sim")
	if err != nil {
		t.Fatalf("listing the dependencies of ./cmd/modbus-sim: %v", err)
	}
	if hits := Forbidden(deps, gatewayPackages(modulePath)); len(hits) != 0 {
		t.Errorf("cmd/modbus-sim reaches %q; the machine never contains its own "+
			"connector (docs/architecture.md#import-boundaries)", hits)
	}
}

// TestBinariesDoNotShipTestUtilities keeps internal/testutil — fake clocks,
// fixture paths, the synthetic CSV generator — out of both images.
func TestBinariesDoNotShipTestUtilities(t *testing.T) {
	t.Parallel()

	testOnly := []string{modulePath + "/internal/testutil", modulePath + "/internal/schematest"}
	for _, cmd := range []string{"gateway", "modbus-sim"} {
		if !hasGoFiles(filepath.Join("..", "..", "cmd", cmd)) {
			continue
		}
		deps, err := ListDeps(filepath.Join("..", ".."), "./cmd/"+cmd)
		if err != nil {
			t.Fatalf("listing the dependencies of ./cmd/%s: %v", cmd, err)
		}
		if hits := Forbidden(deps, testOnly); len(hits) != 0 {
			t.Errorf("cmd/%s reaches the test-only packages %q", cmd, hits)
		}
	}
}

// TestForbiddenDetectsViolation proves the check above can fail. testdata/violating
// is a self-contained module whose gateway imports both an allowed package
// (internal/regmap) and a denied one (internal/sim); only the denied one is
// reported.
func TestForbiddenDetectsViolation(t *testing.T) {
	t.Parallel()

	const fixtureModule = "example.com/violating"

	deps, err := ListDeps(filepath.Join("testdata", "violating"), "./cmd/gateway")
	if err != nil {
		t.Fatalf("listing the dependencies of the violating fixture: %v", err)
	}
	if !slices.Contains(deps, fixtureModule+"/internal/regmap") {
		t.Fatalf("the fixture's dependency list is incomplete: %q", deps)
	}

	want := []string{fixtureModule + "/internal/sim"}
	if got := Forbidden(deps, groundTruthPackages(fixtureModule)); !slices.Equal(got, want) {
		t.Errorf("Forbidden(<violating fixture>) = %q, want %q", got, want)
	}
}
