// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay_test

import (
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// daySlice is the MetroPT-3 day `make fixtures` cuts for the simulator: 7,144
// rows with the two real holes of 2020-02-01. It is gitignored, so the tests
// that read it skip without it and fail under FDP_REQUIRE_DATASET=1.
const daySlice = "sim-day-2020-02-01"

// The day slice's own geometry.
const (
	dayRows      = 7144
	dayFirst     = "2020-02-01 00:00:00"
	dayLast      = "2020-02-01 23:20:21"
	dayGapOneAt  = "2020-02-01 12:48:40"
	dayGapOneEnd = "2020-02-01 12:53:47"
	dayGapTwoAt  = "2020-02-01 19:40:04"
	dayGapTwoEnd = "2020-02-01 23:15:33"
)

// openCursor opens a source and a cursor over it and closes the cursor when
// the test ends.
func openCursor(t *testing.T, src *replay.Source) *replay.Cursor {
	t.Helper()
	cur, err := src.Cursor()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, cur.Close()) })
	return cur
}

// openSlice opens the day slice, skipping the test when it is not cut.
func openSlice(t *testing.T) *replay.Source {
	t.Helper()
	src, err := replay.Open(testutil.SliceCSV(t, daySlice), regmap.Signals)
	require.NoError(t, err)
	return src
}

// readAll drains a cursor into cloned rows.
func readAll(t *testing.T, cur *replay.Cursor) []replay.Row {
	t.Helper()
	var rows []replay.Row
	for {
		row, err := cur.Peek()
		if err != nil {
			require.ErrorIs(t, err, io.EOF)
			return rows
		}
		rows = append(rows, row.Clone())
		cur.Advance()
	}
}

func TestCursorReadsEveryRowInOrder(t *testing.T) {
	t.Parallel()

	src := openTiny(t)
	rows := readAll(t, openCursor(t, src))

	require.Len(t, rows, tinyRows)
	assert.Equal(t, atS(0), rows[0].SimTsMs)
	assert.Equal(t, atS(tinyLastS), rows[len(rows)-1].SimTsMs)
	for i := 1; i < len(rows); i++ {
		assert.Greater(t, rows[i].SimTsMs, rows[i-1].SimTsMs, "row %d", i)
	}
	for i, row := range rows {
		assert.False(t, row.Missing, "the synthetic fixture has no missing field, row %d", i)
		assert.Len(t, row.Analog, len(src.AnalogTags()))
		assert.Len(t, row.Digital, len(src.DigitalTags()))
	}
}

func TestCursorPeekDoesNotConsume(t *testing.T) {
	t.Parallel()

	cur := openCursor(t, openTiny(t))

	first, err := cur.Peek()
	require.NoError(t, err)
	again, err := cur.Peek()
	require.NoError(t, err)
	assert.Equal(t, first.SimTsMs, again.SimTsMs, "Peek is idempotent")

	at, ok := cur.Position()
	require.True(t, ok)
	assert.Equal(t, first.SimTsMs, at, "Position is the timestamp Peek would return")

	cur.Advance()
	next, err := cur.Peek()
	require.NoError(t, err)
	assert.Equal(t, atS(10), next.SimTsMs, "Advance moves one row on")
}

func TestCursorReportsEOFAtTheEnd(t *testing.T) {
	t.Parallel()

	cur := openCursor(t, openTiny(t))
	readAll(t, cur)

	_, err := cur.Peek()
	assert.ErrorIs(t, err, io.EOF)
	_, ok := cur.Position()
	assert.False(t, ok)

	cur.Advance() // past the end: still EOF, never a panic
	_, err = cur.Peek()
	assert.ErrorIs(t, err, io.EOF)
}

func TestCursorsAreIndependent(t *testing.T) {
	t.Parallel()

	src := openTiny(t)
	a, b := openCursor(t, src), openCursor(t, src)

	for range 10 {
		a.Advance()
	}

	atA, ok := a.Position()
	require.True(t, ok)
	atB, ok := b.Position()
	require.True(t, ok)
	assert.Equal(t, atS(100), atA)
	assert.Equal(t, atS(0), atB, "a second cursor has its own descriptor and position")
}

func TestCursorSeekTargets(t *testing.T) {
	t.Parallel()

	src := openTiny(t)

	for _, tc := range []struct {
		name   string
		target uint64
		want   uint64
		eof    bool
	}{
		{name: "exact hit", target: atS(300), want: atS(300)},
		{name: "between rows", target: atS(300) + 4_000, want: atS(310)},
		{name: "inside a gap", target: atS(2000), want: atS(tinyGapTwoToS)},
		{name: "on the row after a gap", target: atS(tinyGapTwoToS), want: atS(tinyGapTwoToS)},
		{name: "before the first row", target: atS(0) - 60_000, want: atS(0)},
		{name: "the first row", target: atS(0), want: atS(0)},
		{name: "the last row", target: atS(tinyLastS), want: atS(tinyLastS)},
		{name: "after the last row", target: atS(tinyLastS) + 1, eof: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cur := openCursor(t, src)
			require.NoError(t, cur.Seek(tc.target))

			row, err := cur.Peek()
			if tc.eof {
				assert.ErrorIs(t, err, io.EOF, "a target past the last row lands at the end")
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, row.SimTsMs)
			assert.GreaterOrEqual(t, row.SimTsMs, tc.target,
				"Seek lands on the first row at or after the target")
		})
	}
}

func TestCursorSeekBackwards(t *testing.T) {
	t.Parallel()

	cur := openCursor(t, openTiny(t))
	require.NoError(t, cur.Seek(atS(1000)))
	require.NoError(t, cur.Seek(atS(100)))

	at, ok := cur.Position()
	require.True(t, ok)
	assert.Equal(t, atS(100), at, "a cursor seeks backwards as well as forwards")
}

func TestCursorSeekClearsTheHeldValues(t *testing.T) {
	t.Parallel()

	// Row three has no TP2, so a sequential read holds 9.4 from row one while
	// a read that seeks straight to it has nothing to hold.
	path := writeCSV(t,
		testutil.SynthHeader,
		"0,2020-02-01 00:00:00,9.4,9.1,-0.01,-0.02,9.09,61.25,6.5,0,1,1,0,0,1,1,0",
		"10,2020-02-01 00:00:10,9.5,9.2,-0.01,-0.02,9.19,61.35,6.5,0,1,1,0,0,1,1,0",
		"20,2020-02-01 00:00:20,,9.3,-0.01,-0.02,9.29,61.45,6.5,0,1,1,0,0,1,1,0",
	)
	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	sequential := readAll(t, openCursor(t, src))
	require.Len(t, sequential, 3)
	assert.InDelta(t, 9.5, analogOf(src, &sequential[2])["discharge_pressure"], 0,
		"a sequential read holds the value of the previous row")

	jumped := openCursor(t, src)
	require.NoError(t, jumped.Seek(msOf(t, "2020-02-01 00:00:20")))
	row, err := jumped.Peek()
	require.NoError(t, err)
	assert.True(t, row.Missing)
	assert.InDelta(t, 0.0, analogOf(src, row)["discharge_pressure"], 0,
		"a Seek forgets what the cursor held, so a jump is reproducible")
}

func TestCursorSeekThenReadsMatchASequentialRead(t *testing.T) {
	t.Parallel()

	src := openTiny(t)
	all := readAll(t, openCursor(t, src))
	require.Len(t, all, tinyRows)

	const from = 45
	cur := openCursor(t, src)
	require.NoError(t, cur.Seek(all[from].SimTsMs))

	assert.Equal(t, all[from:], readAll(t, cur),
		"reading on from a Seek is the same as reading through")
}

func TestSourceSliceDayBoundsAndGaps(t *testing.T) {
	t.Parallel()

	src := openSlice(t)

	first, last, rows := src.Bounds()
	assert.Equal(t, dayRows, rows)
	assert.Equal(t, msOf(t, dayFirst), first)
	assert.Equal(t, msOf(t, dayLast), last)

	assert.Equal(t, []replay.Gap{
		{StartMs: msOf(t, dayGapOneAt), EndMs: msOf(t, dayGapOneEnd)},
		{StartMs: msOf(t, dayGapTwoAt), EndMs: msOf(t, dayGapTwoEnd)},
	}, src.Gaps(), "the day has exactly the two holes of the recording")

	gaps := src.Gaps()
	assert.Equal(t, uint64(307_000), gaps[0].DurationMs(), "the 12:48 hole is 307 s")
	assert.Equal(t, uint64(12_929_000), gaps[1].DurationMs(), "the 19:40 hole is 12,929 s")

	assert.Equal(t, (dayRows+replay.IndexStride-1)/replay.IndexStride, src.IndexLen(),
		"one index entry every %d rows", replay.IndexStride)
}

func TestCursorSliceDaySeekTargets(t *testing.T) {
	t.Parallel()

	src := openSlice(t)

	for _, tc := range []struct {
		name   string
		target string
		want   string
		eof    bool
	}{
		{name: "exact hit", target: "2020-02-01 05:59:56", want: "2020-02-01 05:59:56"},
		{name: "between rows", target: "2020-02-01 06:00:00", want: "2020-02-01 06:00:06"},
		{name: "inside the long hole", target: "2020-02-01 21:00:00", want: dayGapTwoEnd},
		{name: "inside the short hole", target: "2020-02-01 12:50:00", want: dayGapOneEnd},
		{name: "before the first row", target: "2020-01-31 23:00:00", want: dayFirst},
		{name: "the last row", target: dayLast, want: dayLast},
		{name: "after the last row", target: "2020-02-02 00:00:00", eof: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cur := openCursor(t, src)
			require.NoError(t, cur.Seek(msOf(t, tc.target)))

			at, ok := cur.Position()
			if tc.eof {
				assert.False(t, ok, "a target past the last row lands at the end")
				return
			}
			require.True(t, ok)
			assert.Equal(t, msOf(t, tc.want), at)
		})
	}
}

func TestCursorSliceDaySeekThenReadsMatchASequentialRead(t *testing.T) {
	t.Parallel()

	src := openSlice(t)
	all := readAll(t, openCursor(t, src))
	require.Len(t, all, dayRows)

	// A row well inside the file, so the seek lands between two index entries
	// and has to scan forward.
	const from = 3001
	const compare = 500

	cur := openCursor(t, src)
	require.NoError(t, cur.Seek(all[from].SimTsMs))

	got := make([]replay.Row, 0, compare)
	for range compare {
		row, err := cur.Peek()
		require.NoError(t, err)
		got = append(got, row.Clone())
		cur.Advance()
	}
	assert.Equal(t, all[from:from+compare], got,
		"500 rows read after a Seek equal the same 500 rows read through")
}

func TestCursorSliceDayReadsEveryRow(t *testing.T) {
	t.Parallel()

	src := openSlice(t)
	rows := readAll(t, openCursor(t, src))

	require.Len(t, rows, dayRows)
	for i, row := range rows {
		assert.False(t, row.Missing, "the recording has no unparsable field, row %d", i)
		if i > 0 {
			assert.Greater(t, row.SimTsMs, rows[i-1].SimTsMs, "row %d", i)
		}
	}
}
