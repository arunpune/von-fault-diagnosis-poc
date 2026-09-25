// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// RequireDatasetEnv names the variable that turns an absent MetroPT-3 slice
// from a skip into a failure. CI sets it to 1 after its dataset-cache step.
const RequireDatasetEnv = "FDP_REQUIRE_DATASET"

// statFile is os.Stat behind a name the fixture helper can share.
func statFile(path string) (fs.FileInfo, error) { return os.Stat(path) }

// requireDataset reports whether an absent slice must fail the test.
func requireDataset() bool {
	v := os.Getenv(RequireDatasetEnv)
	return v != "" && v != "0"
}

// SlicesDir returns the absolute path of the gitignored directory
// `make fixtures` cuts the MetroPT-3 slices into.
func SlicesDir() string {
	return filepath.Join(repoRoot(), "data", "fixtures", "metropt3")
}

// SliceCSV returns the absolute path of the MetroPT-3 slice named name, as cut
// by `make fixtures` into data/fixtures/metropt3/<name>.csv from the
// definitions in data/fixtures/metropt3-slices.json.
//
// No MetroPT-3 row is committed, so the slices exist only where the dataset
// does. A test that needs one calls this helper and gets either a path, a skip
// with the command that produces the file, or — under FDP_REQUIRE_DATASET=1,
// which CI sets once it has restored the dataset — a failure. Tests that must
// run offline use SynthCSV instead.
func SliceCSV(t *testing.T, name string) string {
	t.Helper()

	path := filepath.Join(SlicesDir(), name+".csv")
	if _, err := statFile(path); err != nil {
		msg := "MetroPT-3 slice %q is not cut at %s; run `make fixtures` with the dataset in place (%v)"
		if requireDataset() {
			t.Fatalf(msg+" ["+RequireDatasetEnv+"=1]", name, path, err)
		}
		t.Skipf(msg, name, path, err)
	}
	return path
}
