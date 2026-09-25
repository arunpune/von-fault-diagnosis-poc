// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gate_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/e2e/gate"
)

// scenario builds one verdict of the given kind.
func scenario(id int, kind gate.Kind, subject string, passed bool) gate.Scenario {
	return gate.Scenario{
		ID: id, Name: subject, Kind: kind, Subject: subject, Passed: passed,
		Window:   gate.Window{From: "2020-02-03T00:00:00.000Z", Until: "2020-02-03T06:00:00.000Z"},
		Samples:  2179,
		Evidence: []gate.Evidence{{Kind: gate.EvidenceAlarm, Code: "W102", OK: passed}},
	}
}

// full builds a report of ten scenarios, the first misses of which are
// failures and the last of which is the negative one.
func full(t *testing.T, misses int, negativePassed bool) *gate.Report {
	t.Helper()

	report := gate.NewReport("sim-gate", 3600, "2026-09-21T10:00:00.000Z")
	for i := 1; i < gate.Total; i++ {
		report.Add(scenario(i, gate.KindPreset, "preset-"+string(rune('a'+i-1)), i > misses))
	}
	report.Add(scenario(gate.Total, gate.KindNegative, "baseline", negativePassed))
	report.Summarise()
	return report
}

func TestSummariseCountsAndAppliesTheThreshold(t *testing.T) {
	t.Parallel()

	report := full(t, 0, true)
	assert.Equal(t, gate.Total, report.Passed)
	assert.True(t, report.NegativePassed)
	assert.True(t, report.Pass)
	assert.Empty(t, report.Missed)
}

func TestSummariseFailsBelowTheThreshold(t *testing.T) {
	t.Parallel()

	report := full(t, 3, true)
	assert.Equal(t, gate.Threshold-1, report.Passed)
	assert.False(t, report.Pass, "seven of ten is below the threshold")
	assert.Len(t, report.Missed, 3)
	assert.Contains(t, report.Missed[0], "preset-a")
}

func TestSummarisePassesAtExactlyTheThreshold(t *testing.T) {
	t.Parallel()

	report := full(t, gate.Total-gate.Threshold, true)
	assert.Equal(t, gate.Threshold, report.Passed)
	assert.True(t, report.Pass)
}

func TestSummariseNeedsTheNegativeScenario(t *testing.T) {
	t.Parallel()

	// Nine of ten pass, but the one that missed is the negative: a run that
	// alarms on a clean baseline has shown nothing about the signal.
	report := full(t, 0, false)
	assert.Equal(t, gate.Total-1, report.Passed)
	assert.False(t, report.NegativePassed)
	assert.False(t, report.Pass)
	assert.Contains(t, report.Verdict(), "negative passed: false")
}

func TestSummariseIsIdempotent(t *testing.T) {
	t.Parallel()

	report := full(t, 2, true)
	passed, missed := report.Passed, len(report.Missed)
	report.Summarise()
	report.Summarise()
	assert.Equal(t, passed, report.Passed, "a second count does not accumulate")
	assert.Len(t, report.Missed, missed)
}

func TestWriteRendersTheSummary(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "reports", "sim-gate.json")
	report := full(t, 1, true)
	require.NoError(t, report.Write(path))

	body, err := os.ReadFile(path)
	require.NoError(t, err)

	var back gate.Report
	require.NoError(t, json.Unmarshal(body, &back))
	assert.Equal(t, gate.ReportSchema, back.Schema)
	assert.Equal(t, gate.Task, back.Task)
	assert.Equal(t, "sim-gate", back.Slice)
	assert.Equal(t, uint16(3600), back.Speed)
	assert.Equal(t, gate.Threshold, back.Threshold)
	assert.Len(t, back.Scenarios, gate.Total)
	assert.Equal(t, report.Passed, back.Passed)
	assert.True(t, strings.HasSuffix(string(body), "\n"), "the file ends in a newline")
}

func TestWriteWithoutAPathDoesNothing(t *testing.T) {
	t.Parallel()

	assert.NoError(t, full(t, 0, true).Write(""))
}

func TestWriteReportsAnUnusablePath(t *testing.T) {
	t.Parallel()

	// A directory component that is a file cannot be created.
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	require.NoError(t, os.WriteFile(blocker, []byte("x"), 0o600))

	err := full(t, 0, true).Write(filepath.Join(blocker, "sim-gate.json"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "gate: creating")
}

func TestLineNamesTheVerdictAndTheEvidence(t *testing.T) {
	t.Parallel()

	passing := scenario(1, gate.KindPreset, "f1_air_leak_apr18", true)
	passing.Evidence[0].SimTS = "2020-04-18T00:25:08.000Z"
	assert.Contains(t, passing.Line(), "PASS")
	assert.Contains(t, passing.Line(), "f1_air_leak_apr18")
	assert.Contains(t, passing.Line(), "W102 at 2020-04-18T00:25:08.000Z")

	failing := scenario(5, gate.KindInjection, "motor_overload", false)
	failing.Note = "the current did not move"
	assert.Contains(t, failing.Line(), "FAIL")
	assert.Contains(t, failing.Line(), "the current did not move")
}

func TestEvidenceRendersEachKind(t *testing.T) {
	t.Parallel()

	tag := gate.Evidence{
		Kind: gate.EvidenceTag, Tag: "oil_temperature", Op: "offset", Direction: "up",
		Observed: 14, Required: 7, Samples: 1089,
	}
	assert.Equal(t, "oil_temperature offset up +14 (need +7, 1089 samples)", tag.String())

	quiet := gate.Evidence{
		Kind: gate.EvidenceQuiet, Detail: "W104 stayed up", Observed: 30, Required: 300, Samples: 2179,
	}
	assert.Equal(t, "W104 stayed up (30 s ≤ 300 s over 2179 samples)", quiet.String())

	other := gate.Evidence{Detail: "nothing to say"}
	assert.Equal(t, "nothing to say", other.String())
}
