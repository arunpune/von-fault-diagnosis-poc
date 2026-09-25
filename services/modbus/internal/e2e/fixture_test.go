// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// What the recording itself says, read from the slice rather than remembered:
// the timestamp of every row, the rows that must carry `discontinuity`, and
// the recorded value of a signal at one instant.
//
// Every expectation in this package is derived here, so a re-cut slice moves
// the assertions with it instead of breaking them.

package e2e

import (
	"encoding/csv"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
)

// fixture is one MetroPT-3 slice read straight from disk.
type fixture struct {
	// path is where the slice was read from.
	path string
	// timestamps holds every row's instant in epoch milliseconds UTC, in
	// file order, so index i is sequence number i+1 of a replay from the
	// first row.
	timestamps []uint64
	// discontinuities are the sequence numbers a replay from the first row
	// must set the flag on: the boot sample, and the first row after each
	// source step wider than the gap threshold.
	discontinuities []uint32
	// gaps are the [last row before, first row after] instants of those
	// steps, in file order.
	gaps [][2]uint64
	// analog holds the recorded value of every analog signal of
	// regmap.Signals that the slice carries a column for, by tag and row.
	analog map[string][]float64
	// row indexes the file order by instant.
	row map[uint64]int
}

// readFixture parses the slice at path.
func readFixture(t *testing.T, path string) *fixture {
	t.Helper()

	file, err := os.Open(path)
	require.NoError(t, err)
	defer func() { assert.NoError(t, file.Close()) }()

	reader := csv.NewReader(file)
	reader.ReuseRecord = true

	header, err := reader.Read()
	require.NoErrorf(t, err, "reading the header of %s", path)

	column := map[string]int{}
	for i, name := range header {
		column[strings.TrimSpace(name)] = i
	}
	stamp, ok := column[replay.TimestampColumn]
	require.Truef(t, ok, "%s has no %q column", path, replay.TimestampColumn)

	f := &fixture{
		path:            path,
		discontinuities: []uint32{1},
		analog:          map[string][]float64{},
		row:             map[uint64]int{},
	}
	wanted := map[string]int{}
	for _, signal := range regmap.Signals {
		if signal.Kind != regmap.KindAnalog || signal.Column == "" {
			continue
		}
		index, ok := column[signal.Column]
		if !ok {
			continue
		}
		wanted[signal.Tag] = index
		f.analog[signal.Tag] = nil
	}

	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoErrorf(t, err, "reading %s", path)

		instant, err := time.Parse(time.DateTime, strings.TrimSpace(record[stamp]))
		require.NoErrorf(t, err, "row %d of %s carries %q", len(f.timestamps)+1, path, record[stamp])
		ms := uint64(instant.UnixMilli())

		if n := len(f.timestamps); n > 0 && ms > f.timestamps[n-1]+replay.GapThresholdMs {
			f.discontinuities = append(f.discontinuities, uint32(n)+1)
			f.gaps = append(f.gaps, [2]uint64{f.timestamps[n-1], ms})
		}
		f.row[ms] = len(f.timestamps)
		f.timestamps = append(f.timestamps, ms)

		for tag, index := range wanted {
			value, err := strconv.ParseFloat(strings.TrimSpace(record[index]), 64)
			require.NoErrorf(t, err, "%q of row %d of %s", tag, len(f.timestamps), path)
			f.analog[tag] = append(f.analog[tag], value)
		}
	}
	require.NotEmptyf(t, f.timestamps, "%s has no rows", path)
	return f
}

// rows is how many rows the slice holds.
func (f *fixture) rows() int { return len(f.timestamps) }

// firstMs is the instant of the first row.
func (f *fixture) firstMs() uint64 { return f.timestamps[0] }

// at returns the recorded value of one analog signal at one instant, and
// whether the slice has a row there.
func (f *fixture) at(tag string, simTsMs uint64) (float64, bool) {
	index, ok := f.row[simTsMs]
	if !ok {
		return 0, false
	}
	values, ok := f.analog[tag]
	if !ok || index >= len(values) {
		return 0, false
	}
	return values[index], true
}
