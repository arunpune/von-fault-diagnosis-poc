// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// helperEnv turns TestSliceCSVHelperProcess from a no-op into the one-line
// probe the two subprocess cases below run.
const helperEnv = "FDP_SLICE_HELPER"

// missingSlice is a name `make fixtures` never cuts.
const missingSlice = "no-such-slice-for-tests"

func TestSlicesDir(t *testing.T) {
	t.Parallel()

	dir := testutil.SlicesDir()
	assert.True(t, filepath.IsAbs(dir), "the resolver returns an absolute path")
	assert.True(t, strings.HasSuffix(dir, filepath.Join("data", "fixtures", "metropt3")),
		"slices live in the gitignored data/fixtures/metropt3, got %s", dir)
	require.DirExists(t, filepath.Dir(dir), "data/fixtures is part of the checkout")
}

// TestSliceCSV asks for the day slice the simulator tests read. It resolves to
// a path once `make fixtures` has cut it and skips with the command to run
// otherwise, so the suite is green with or without the dataset.
func TestSliceCSV(t *testing.T) {
	t.Setenv(testutil.RequireDatasetEnv, "0")

	const name = "sim-day-2020-02-01"
	path := testutil.SliceCSV(t, name) // skips the test when the slice is absent
	assert.Equal(t, filepath.Join(testutil.SlicesDir(), name+".csv"), path)
	require.FileExists(t, path)
}

// TestSliceCSVSkipsWhenAbsent runs the resolver in a subprocess so the skip is
// observed instead of ending this test.
func TestSliceCSVSkipsWhenAbsent(t *testing.T) {
	t.Parallel()

	out, err := runSliceHelper(t, "0")
	require.NoError(t, err, "an absent slice must not fail the suite:\n%s", out)
	assert.Contains(t, out, "SKIP")
	assert.Contains(t, out, missingSlice)
	assert.Contains(t, out, "make fixtures")
}

// TestSliceCSVFailsWhenTheDatasetIsRequired covers the other half: CI sets
// FDP_REQUIRE_DATASET=1 after restoring the dataset, and a slice that is still
// missing is then a failure, not a silent skip.
func TestSliceCSVFailsWhenTheDatasetIsRequired(t *testing.T) {
	t.Parallel()

	out, err := runSliceHelper(t, "1")
	require.Error(t, err, "an absent slice must fail under FDP_REQUIRE_DATASET=1:\n%s", out)
	assert.Contains(t, out, "FAIL")
	assert.Contains(t, out, testutil.RequireDatasetEnv+"=1")
	assert.NotContains(t, out, "SKIP")
}

// runSliceHelper re-runs this test binary with only TestSliceCSVHelperProcess
// enabled and returns its combined output.
func runSliceHelper(t *testing.T, requireDataset string) (string, error) {
	t.Helper()

	cmd := exec.Command(os.Args[0], "-test.run=^TestSliceCSVHelperProcess$", "-test.v")
	cmd.Env = append(os.Environ(),
		helperEnv+"=1",
		testutil.RequireDatasetEnv+"="+requireDataset,
	)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// TestSliceCSVHelperProcess is the body the two tests above run in a
// subprocess; it does nothing in an ordinary run.
func TestSliceCSVHelperProcess(t *testing.T) {
	if os.Getenv(helperEnv) != "1" {
		t.Skip("helper process; driven by TestSliceCSVSkipsWhenAbsent")
	}
	testutil.SliceCSV(t, missingSlice)
	t.Fatalf("SliceCSV returned for the absent slice %q", missingSlice)
}
