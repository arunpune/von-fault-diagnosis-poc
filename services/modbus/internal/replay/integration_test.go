// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

package replay_test

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
)

// metroCSVEnv points at the full MetroPT-3 CSV. The file is 218 MB, is never
// committed (MetroPT-3 is obtained by download only) and is not part of a
// checkout, so this pass runs only where it is on disk.
const metroCSVEnv = "FDP_METROPT_CSV"

// timingSlackEnv multiplies every wall-clock bound below: 1 locally, 3 in CI.
const timingSlackEnv = "FDP_TIMING_SLACK"

// The facts of the full file (docs/dataset.md).
const (
	fullRows  = 1_516_948
	fullFirst = "2020-02-01 00:00:00"
	fullLast  = "2020-09-01 03:59:50"
	fullGaps  = 331
	// indexBudget is the wall-clock ceiling of the boot-time index pass over
	// the whole file.
	indexBudget = 5 * time.Second
)

// timingSlack returns the multiplier for a wall-clock bound.
func timingSlack(t *testing.T) time.Duration {
	t.Helper()

	raw := os.Getenv(timingSlackEnv)
	if raw == "" {
		return 1
	}
	slack, err := strconv.Atoi(raw)
	require.NoError(t, err, "%s must be an integer", timingSlackEnv)
	require.Positive(t, slack, "%s must be positive", timingSlackEnv)
	return time.Duration(slack)
}

// fullCSV returns the path of the whole dataset, or skips.
func fullCSV(t *testing.T) string {
	t.Helper()

	path := os.Getenv(metroCSVEnv)
	if path == "" {
		t.Skipf("set %s to the full MetroPT-3 CSV to run this pass", metroCSVEnv)
	}
	require.FileExists(t, path, "%s points at a file that is not there", metroCSVEnv)
	return path
}

// TestIntegrationFullDataset opens the whole 218 MB recording: the index pass
// must see every row, both bounds, all 331 holes, and finish inside its
// budget without the file ever being read into memory.
func TestIntegrationFullDataset(t *testing.T) {
	path := fullCSV(t)

	start := time.Now()
	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)
	elapsed := time.Since(start)

	first, last, rows := src.Bounds()
	assert.Equal(t, fullRows, rows)
	assert.Equal(t, msOf(t, fullFirst), first)
	assert.Equal(t, msOf(t, fullLast), last)
	assert.Len(t, src.Gaps(), fullGaps, "the recording has %d holes wider than %d ms",
		fullGaps, replay.GapThresholdMs)

	for i, gap := range src.Gaps() {
		assert.Greater(t, gap.DurationMs(), uint64(replay.GapThresholdMs), "gap %d", i)
		assert.GreaterOrEqual(t, gap.StartMs, first, "gap %d", i)
		assert.LessOrEqual(t, gap.EndMs, last, "gap %d", i)
	}

	assert.Equal(t, (fullRows+replay.IndexStride-1)/replay.IndexStride, src.IndexLen(),
		"one index entry every %d rows", replay.IndexStride)

	budget := indexBudget * timingSlack(t)
	assert.Less(t, elapsed, budget, "the index pass took %s, budget %s", elapsed, budget)
	t.Logf("indexed %d rows in %s (%d index entries)", rows, elapsed, src.IndexLen())
}

// TestIntegrationSeekAcrossTheWholeFile checks that a jump into the middle of
// the recording lands exactly where a sequential read would have.
func TestIntegrationSeekAcrossTheWholeFile(t *testing.T) {
	src, err := replay.Open(fullCSV(t), regmap.Signals)
	require.NoError(t, err)

	cur, err := src.Cursor()
	require.NoError(t, err)
	defer func() { require.NoError(t, cur.Close()) }()

	const target = "2020-06-05 10:00:00"
	targetMs := msOf(t, target)

	// Where a read that starts ten minutes earlier and walks forward ends up.
	require.NoError(t, cur.Seek(targetMs-10*60_000))
	var want uint64
	for range replay.IndexStride * 4 {
		row, err := cur.Peek()
		require.NoError(t, err)
		if row.SimTsMs >= targetMs {
			want = row.SimTsMs
			break
		}
		cur.Advance()
	}
	require.NotZero(t, want, "the walk never reached %s", target)

	require.NoError(t, cur.Seek(targetMs))
	at, ok := cur.Position()
	require.True(t, ok)
	assert.Equal(t, want, at, "a Seek lands on the first row at or after the target")

	first, last, _ := src.Bounds()
	require.NoError(t, cur.Seek(first-1))
	at, ok = cur.Position()
	require.True(t, ok)
	assert.Equal(t, first, at, "a target before the recording lands on its first row")

	require.NoError(t, cur.Seek(last+1))
	_, ok = cur.Position()
	assert.False(t, ok, "a target after the recording lands at the end of the file")
}
