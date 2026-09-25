// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// moduleRoot is this package's path to the module it guards. `go test` runs
// with the working directory set to the package directory.
var moduleRoot = filepath.Join("..", "..")

// gatewayRoots are the two directories the connector is built from.
func gatewayRoots() []string {
	return []string{
		filepath.Join(moduleRoot, "internal", "gateway"),
		filepath.Join(moduleRoot, "cmd", "gateway"),
	}
}

// groundTruthNeedles is the vocabulary of the ground-truth side: the topic
// prefix the simulator publishes it under, the word every injection name and
// field carries, and the environment variable that points at the catalogue
// (ground-truth isolation).
func groundTruthNeedles() []string {
	return []string{"gt/", "inject", "GT_DIR"}
}

// modbusWriteSelectors are the Modbus write calls banned from the connector:
// FC05, FC06, FC0F and FC10 under the names the pinned library and its peers
// give them. The gateway holds a read-only client — it reads the header and
// the ring and publishes what it read, and a write would let it steer the
// machine it is only supposed to observe.
func modbusWriteSelectors() []string {
	return []string{
		"WriteRegister",
		"WriteRegisters",
		"WriteCoil",
		"WriteCoils",
		"WriteMultipleRegisters",
	}
}

// isProductionSource reports whether path is a Go file that the connector
// ships, as opposed to a test.
//
// A test is exempt from the substring scan on purpose: the no-leak tests of
// internal/gateway assert that a published payload does *not* contain
// "inject", so they have to name the word they forbid. Everything a binary is
// built from — and every golden file a test compares against — is scanned.
func isProductionSource(path string) bool {
	return !strings.HasSuffix(path, "_test.go")
}

// TestGatewaySourceNeverNamesGroundTruth is the blunt half of the isolation
// check: beyond the import boundary, nothing the connector ships may so much
// as mention the ground-truth topics, the injector or the catalogue directory.
// A leak that arrived as a string constant, a comment or a golden payload is
// caught here rather than by a reviewer.
func TestGatewaySourceNeverNamesGroundTruth(t *testing.T) {
	t.Parallel()

	for _, root := range gatewayRoots() {
		hits, err := ScanText(root, groundTruthNeedles(), isProductionSource)
		if err != nil {
			t.Fatalf("scanning %s: %v", root, err)
		}
		for _, hit := range hits {
			t.Errorf("%s names the ground truth; the gateway stamps and forwards "+
				"and knows nothing about injections (ground-truth isolation)", hit)
		}
	}
}

// gtTopicFiles are the files of this module that may name a gt/ topic: the
// ground-truth publisher and the engine that feeds it, the control plane that
// reports what it started, the topic builder every publisher goes through, the
// message shapes packages/contracts pinned, the injector's own documentation,
// the simulator's entry point and the fixture helper that resolves
// testdata/gt.
//
// The list is deliberately explicit: a new file that names the topic prefix is
// a decision, and this test is where it is taken.
func gtTopicFiles() []string {
	return []string{
		"cmd/modbus-sim/main.go",
		"internal/contracts/messages.go",
		"internal/injection/doc.go",
		"internal/mqttio/topics.go",
		"internal/sim/control.go",
		"internal/sim/engine.go",
		"internal/sim/gt.go",
		"internal/testutil/fixtures.go",
	}
}

// TestOnlyTheGroundTruthFilesNameGtTopics pins the other direction: the gt/
// prefix stays where it belongs. It scans the module's own sources — tests
// and testdata excluded, since a test names whatever it asserts about — and
// compares the set of files against gtTopicFiles.
func TestOnlyTheGroundTruthFilesNameGtTopics(t *testing.T) {
	t.Parallel()

	keep := func(path string) bool {
		return isProductionSource(path) &&
			strings.HasSuffix(path, ".go") &&
			!strings.Contains(path, "/testdata/")
	}

	var got []string
	for _, dir := range []string{"internal", "cmd"} {
		hits, err := ScanText(filepath.Join(moduleRoot, dir), []string{"gt/"}, keep)
		if err != nil {
			t.Fatalf("scanning %s: %v", dir, err)
		}
		for _, hit := range hits {
			// ScanText reports one occurrence per line; the set of files is
			// what this test is about.
			rel := strings.TrimPrefix(hit.File, filepath.ToSlash(moduleRoot)+"/")
			if !slices.Contains(got, rel) {
				got = append(got, rel)
			}
		}
	}
	slices.Sort(got)

	want := gtTopicFiles()
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("the files naming a gt/ topic are %q, want %q; add the file to "+
			"gtTopicFiles when the mention "+
			"is deliberate", got, want)
	}
}

// TestGatewayMakesNoModbusWriteCall holds the read-only rule: the connector's
// client is read-only. The depguard boundary cannot see this — the write lives
// in the same library as the read the gateway needs — so the check is a go/ast
// scan over the connector's files, tests included.
func TestGatewayMakesNoModbusWriteCall(t *testing.T) {
	t.Parallel()

	for _, root := range gatewayRoots() {
		refs, err := ScanSelectors(root, modbusWriteSelectors())
		if err != nil {
			t.Fatalf("scanning %s: %v", root, err)
		}
		for _, ref := range refs {
			t.Errorf("%s writes to the machine; the gateway holds a read-only "+
				"Modbus client", ref)
		}
	}
}

// violatingGateway is the fixture both positive controls read: a gateway that
// breaks every rule of this file at once. It lives under testdata/, so the go
// tool never builds it.
var violatingGateway = filepath.Join("testdata", "violating", "cmd", "gateway")

// TestScanSelectorsFindsAWriteCall proves the scan above can fail.
func TestScanSelectorsFindsAWriteCall(t *testing.T) {
	t.Parallel()

	refs, err := ScanSelectors(violatingGateway, modbusWriteSelectors())
	if err != nil {
		t.Fatalf("scanning the violating fixture: %v", err)
	}

	got := make([]string, 0, len(refs))
	for _, ref := range refs {
		got = append(got, ref.Expr)
	}
	want := []string{"c.WriteRegister"}
	if !slices.Equal(got, want) {
		t.Errorf("ScanSelectors(<violating fixture>) = %q, want %q", got, want)
	}
}

// TestScanTextFindsTheGroundTruthVocabulary proves the substring scan can
// fail, and that a test file is exempt while the production file beside it is
// not: the fixture's writes_test.go carries the same three needles.
func TestScanTextFindsTheGroundTruthVocabulary(t *testing.T) {
	t.Parallel()

	hits, err := ScanText(violatingGateway, groundTruthNeedles(), isProductionSource)
	if err != nil {
		t.Fatalf("scanning the violating fixture: %v", err)
	}

	var got []string
	for _, hit := range hits {
		if !slices.Contains(got, hit.Needle) {
			got = append(got, hit.Needle)
		}
		if strings.HasSuffix(hit.File, "_test.go") {
			t.Errorf("%s was scanned; a test names what it forbids", hit)
		}
	}
	slices.Sort(got)

	want := slices.Clone(groundTruthNeedles())
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("ScanText(<violating fixture>) found %q, want %q", got, want)
	}
}

// TestScanRootsThatDoNotExistAreNotAnError keeps both scans usable before the
// directory they scan exists: the boundary tests must not fail on an absent
// directory.
func TestScanRootsThatDoNotExistAreNotAnError(t *testing.T) {
	t.Parallel()

	missing := filepath.Join(t.TempDir(), "absent")

	refs, err := ScanSelectors(missing, modbusWriteSelectors())
	if err != nil {
		t.Errorf("ScanSelectors(<absent>) returned %v, want no error", err)
	}
	if len(refs) != 0 {
		t.Errorf("ScanSelectors(<absent>) = %v, want none", refs)
	}

	hits, err := ScanText(missing, groundTruthNeedles(), nil)
	if err != nil {
		t.Errorf("ScanText(<absent>) returned %v, want no error", err)
	}
	if len(hits) != 0 {
		t.Errorf("ScanText(<absent>) = %v, want none", hits)
	}
}
