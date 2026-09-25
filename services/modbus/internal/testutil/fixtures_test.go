// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

func TestTestdataPath(t *testing.T) {
	t.Parallel()

	path := testutil.TestdataPath("gt/presets.json")
	assert.True(t, filepath.IsAbs(path))
	assert.Equal(t, filepath.Join("testdata", "gt", "presets.json"),
		filepath.Join(filepath.Base(filepath.Dir(filepath.Dir(path))),
			filepath.Base(filepath.Dir(path)), filepath.Base(path)))

	// It resolves a path whether or not the file exists.
	assert.NotEmpty(t, testutil.TestdataPath("not-committed.json"))
}

func TestFixturePath(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"synthetic-tiny.csv", "gt/presets.json", "gt/metropt3-failures.json"} {
		require.FileExists(t, testutil.FixturePath(t, name))
	}
}

// presetsDoc is the part of the ground-truth preset fixture the simulator
// reads (it needs preset_id, sim_ts and lead_in_min and forwards the rest
// opaquely).
type presetsDoc struct {
	Schema  string `json:"schema"`
	Presets []struct {
		PresetID  string  `json:"preset_id"`
		Label     string  `json:"label"`
		Kind      string  `json:"kind"`
		SimTS     string  `json:"sim_ts"`
		LeadInMin int     `json:"lead_in_min"`
		FailureID *string `json:"failure_id"`
	} `json:"presets"`
}

func TestPresetsFixture(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile(testutil.FixturePath(t, "gt/presets.json"))
	require.NoError(t, err)

	var doc presetsDoc
	require.NoError(t, json.Unmarshal(raw, &doc))
	assert.Equal(t, "urn:fdp:schema:gt-presets:v1", doc.Schema)
	require.Len(t, doc.Presets, 5)

	kinds := map[string]bool{"baseline": true, "failure": true, "precursor": true, "diagnostic": true}
	seen := make(map[string]struct{}, len(doc.Presets))
	for _, p := range doc.Presets {
		require.NotContains(t, seen, p.PresetID, "duplicate preset id")
		seen[p.PresetID] = struct{}{}

		assert.NotEmptyf(t, p.Label, "preset %q needs a menu label", p.PresetID)
		assert.Containsf(t, kinds, p.Kind, "preset %q has kind %q", p.PresetID, p.Kind)
		assert.GreaterOrEqualf(t, p.LeadInMin, 0, "preset %q", p.PresetID)

		ts, err := time.Parse(time.RFC3339, p.SimTS)
		require.NoErrorf(t, err, "preset %q sim_ts", p.PresetID)
		assert.Equalf(t, time.UTC, ts.Location(), "preset %q sim_ts is UTC", p.PresetID)

		if p.Kind == "failure" {
			require.NotNilf(t, p.FailureID, "failure preset %q names its failure", p.PresetID)
		}
	}

	assert.Contains(t, seen, "fixture_noon")
	assert.Contains(t, seen, "baseline_feb")
	assert.Contains(t, seen, "f3_air_leak_jun05")
	assert.Contains(t, seen, "f4_air_leak_jul15")
	assert.Contains(t, seen, "depot_lps_jul31")
}

// failuresDoc is the failure-table fixture.
type failuresDoc struct {
	Schema   string `json:"schema"`
	Failures []struct {
		ID        string `json:"id"`
		Start     string `json:"start"`
		End       string `json:"end"`
		Label     string `json:"label"`
		Type      string `json:"type"`
		Signature string `json:"signature"`
	} `json:"failures"`
}

func TestFailureTableFixture(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile(testutil.FixturePath(t, "gt/metropt3-failures.json"))
	require.NoError(t, err)

	var doc failuresDoc
	require.NoError(t, json.Unmarshal(raw, &doc))
	assert.Equal(t, "urn:fdp:schema:gt-failure-table:v1", doc.Schema)
	require.Len(t, doc.Failures, 4)

	want := []string{"F1", "F2", "F3", "F4"}
	for i, f := range doc.Failures {
		assert.Equal(t, want[i], f.ID)
		assert.Equal(t, "air_leak", f.Type)
		assert.Containsf(t, []string{"A", "B"}, f.Signature, "failure %q", f.ID)
		assert.NotEmptyf(t, f.Label, "failure %q", f.ID)

		start, err := time.Parse(time.RFC3339, f.Start)
		require.NoErrorf(t, err, "failure %q start", f.ID)
		end, err := time.Parse(time.RFC3339, f.End)
		require.NoErrorf(t, err, "failure %q end", f.ID)
		assert.Truef(t, end.After(start), "failure %q must end after it starts", f.ID)
	}

	// The corrected windows (docs/dataset.md#how-the-windows-were-resolved).
	assert.Equal(t, "2020-04-19T02:00:00.000Z", doc.Failures[0].End,
		"F1's published 23:59 is a placeholder; the stuck-loaded run continues to 02:00")
	assert.Equal(t, "2020-06-05T10:00:00.000Z", doc.Failures[2].Start)
	assert.Equal(t, "B", doc.Failures[3].Signature)
}
