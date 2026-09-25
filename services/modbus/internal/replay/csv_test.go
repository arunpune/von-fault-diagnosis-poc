// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay_test

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// tinyFixture is the committed synthetic file: 120 rows of a 10 s cycle with a
// 310 s and a 3,610 s hole (internal/testutil/synthcsv_test.go). No MetroPT-3
// row is committed, so every offline test reads it.
const tinyFixture = "synthetic-tiny.csv"

// The geometry of the tiny fixture, in seconds from its first row.
const (
	tinyRows        = 120
	tinyLastS       = 5090
	tinyGapOneFromS = 390
	tinyGapOneToS   = 700
	tinyGapTwoFromS = 1090
	tinyGapTwoToS   = 4700
)

// tinyStartMs is the first timestamp of the tiny fixture and of the dataset.
var tinyStartMs = uint64(testutil.SynthStart.UnixMilli())

// atS returns the epoch millisecond of s seconds into the tiny fixture.
func atS(s int) uint64 { return tinyStartMs + uint64(s)*1000 }

// msOf returns the epoch millisecond of a dataset timestamp written the way
// the CSV writes it.
func msOf(t *testing.T, stamp string) uint64 {
	t.Helper()
	ts, err := time.Parse(time.DateTime, stamp)
	require.NoError(t, err, "test timestamp %q", stamp)
	return uint64(ts.UTC().UnixMilli())
}

// openTiny opens the committed synthetic fixture against the full signal
// table.
func openTiny(t *testing.T) *replay.Source {
	t.Helper()
	src, err := replay.Open(testutil.FixturePath(t, tinyFixture), regmap.Signals)
	require.NoError(t, err)
	return src
}

// writeCSV writes lines to a file in the test's temporary directory and
// returns its path. It is how the header and parsing cases stay inline.
func writeCSV(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rows.csv")
	require.NoError(t, os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600))
	return path
}

// analogOf pairs the analog values of a row with their tags.
func analogOf(src *replay.Source, row *replay.Row) map[string]float64 {
	tags := src.AnalogTags()
	out := make(map[string]float64, len(tags))
	for i, tag := range tags {
		out[tag] = row.Analog[i]
	}
	return out
}

// digitalOf pairs the digital values of a row with their tags.
func digitalOf(src *replay.Source, row *replay.Row) map[string]bool {
	tags := src.DigitalTags()
	out := make(map[string]bool, len(tags))
	for i, tag := range tags {
		out[tag] = row.Digital[i]
	}
	return out
}

// firstRow opens a cursor, peeks and closes; the row is cloned because the
// cursor reuses it.
func firstRow(t *testing.T, src *replay.Source) replay.Row {
	t.Helper()
	cur, err := src.Cursor()
	require.NoError(t, err)
	defer func() { require.NoError(t, cur.Close()) }()

	row, err := cur.Peek()
	require.NoError(t, err)
	return row.Clone()
}

func TestOpenResolvesTheSignalTable(t *testing.T) {
	t.Parallel()

	src := openTiny(t)

	assert.Equal(t, []string{
		"discharge_pressure", "line_pressure", "separator_discharge_pressure",
		"dryer_purge_pressure", "reservoir_pressure", "oil_temperature", "motor_current",
	}, src.AnalogTags(), "the analog tags keep the signals.yaml order")
	assert.Equal(t, []string{
		"intake_closed", "load_valve", "dryer_tower", "regulator_contact",
		"low_pressure_switch", "purge_switch", "oil_level_ok", "flow_pulse",
	}, src.DigitalTags(), "the digital tags keep the signals.yaml order")

	for _, tag := range src.AnalogTags() {
		assert.NotEqual(t, "ambient_temperature", tag,
			"a signal with no CSV column is synthetic and is never replayed")
	}
}

func TestOpenBuildsTheSparseIndex(t *testing.T) {
	t.Parallel()

	src := openTiny(t)

	first, last, rows := src.Bounds()
	assert.Equal(t, tinyRows, rows)
	assert.Equal(t, atS(0), first)
	assert.Equal(t, atS(tinyLastS), last)
	assert.Equal(t, 1, src.IndexLen(),
		"120 rows fit in one stride of %d", replay.IndexStride)
}

func TestOpenDetectsGaps(t *testing.T) {
	t.Parallel()

	src := openTiny(t)

	assert.Equal(t, []replay.Gap{
		{StartMs: atS(tinyGapOneFromS), EndMs: atS(tinyGapOneToS)},
		{StartMs: atS(tinyGapTwoFromS), EndMs: atS(tinyGapTwoToS)},
	}, src.Gaps(), "only steps wider than the %d ms threshold count", replay.GapThresholdMs)

	for _, gap := range src.Gaps() {
		assert.Greater(t, gap.DurationMs(), uint64(replay.GapThresholdMs))
	}
}

func TestGapsIsACopy(t *testing.T) {
	t.Parallel()

	src := openTiny(t)
	gaps := src.Gaps()
	require.NotEmpty(t, gaps)
	gaps[0] = replay.Gap{}

	assert.NotEqual(t, replay.Gap{}, src.Gaps()[0], "a caller cannot edit the source's gap list")
}

func TestOpenAcceptsAnyColumnOrder(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		"Motor_current,timestamp,TP3,TP2,H1,DV_pressure,Reservoirs,Oil_temperature,"+
			"COMP,DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses,note",
		"6.5,2020-02-01 00:00:00,9.1,9.4,-0.01,-0.02,9.09,61.25,"+
			"0,1,1,0,0,1,1,0,ignored",
	)

	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	row := firstRow(t, src)
	assert.False(t, row.Missing)
	assert.Equal(t, msOf(t, "2020-02-01 00:00:00"), row.SimTsMs)
	assert.Equal(t, map[string]float64{
		"discharge_pressure":           9.4,
		"line_pressure":                9.1,
		"separator_discharge_pressure": -0.01,
		"dryer_purge_pressure":         -0.02,
		"reservoir_pressure":           9.09,
		"oil_temperature":              61.25,
		"motor_current":                6.5,
	}, analogOf(src, &row), "columns are resolved by name, not by position")
	assert.Equal(t, map[string]bool{
		"intake_closed":       false,
		"load_valve":          true,
		"dryer_tower":         true,
		"regulator_contact":   false,
		"low_pressure_switch": false,
		"purge_switch":        true,
		"oil_level_ok":        true,
		"flow_pulse":          false,
	}, digitalOf(src, &row))
}

func TestOpenReportsAMissingColumnByName(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		"timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Motor_current,"+
			"COMP,DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses",
		"2020-02-01 00:00:00,9.4,9.1,-0.01,-0.02,9.09,6.5,0,1,1,0,0,1,1,0",
	)

	_, err := replay.Open(path, regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"Oil_temperature"`, "the error names the CSV column")
	assert.Contains(t, err.Error(), `"oil_temperature"`, "and the signal that wanted it")
}

func TestOpenRequiresTheTimestampColumn(t *testing.T) {
	t.Parallel()

	path := writeCSV(t, "TP2,TP3", "9.4,9.1")

	_, err := replay.Open(path, regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"`+replay.TimestampColumn+`"`)
}

func TestOpenRejectsADuplicateColumn(t *testing.T) {
	t.Parallel()

	path := writeCSV(t, testutil.SynthHeader+",TP2", strings.Repeat("0,", 17)+"0")

	_, err := replay.Open(path, regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `"TP2"`)
}

func TestOpenRejectsANonIncreasingTimestamp(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		testutil.SynthHeader,
		"0,2020-02-01 00:00:10,"+strings.Repeat("0,", 14)+"0",
		"10,2020-02-01 00:00:10,"+strings.Repeat("0,", 14)+"0",
	)

	_, err := replay.Open(path, regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "line 3", "the error names the file line")
	assert.Contains(t, err.Error(), "increase")
}

func TestOpenRejectsAnUnparsableTimestamp(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct{ name, stamp string }{
		{"not a layout", "01/02/2020 00:00:00"},
		{"not a digit", "2020-02-01 00:00:0x"},
		{"no such day", "2020-02-30 00:00:00"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			path := writeCSV(t,
				testutil.SynthHeader,
				"0,"+tc.stamp+","+strings.Repeat("0,", 14)+"0",
			)

			_, err := replay.Open(path, regmap.Signals)
			require.Error(t, err)
			assert.Contains(t, err.Error(), "line 2", "the error names the file line")
		})
	}
}

func TestOpenReportsAnAbsentFile(t *testing.T) {
	t.Parallel()

	_, err := replay.Open(filepath.Join(t.TempDir(), "absent.csv"), regmap.Signals)
	require.Error(t, err)
	assert.ErrorIs(t, err, os.ErrNotExist)
}

func TestOpenAcceptsAHeaderWithoutRows(t *testing.T) {
	t.Parallel()

	path := writeCSV(t, testutil.SynthHeader)
	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	first, last, rows := src.Bounds()
	assert.Zero(t, rows)
	assert.Zero(t, first)
	assert.Zero(t, last)
	assert.Zero(t, src.IndexLen())
	assert.Empty(t, src.Gaps())

	cur, err := src.Cursor()
	require.NoError(t, err)
	defer func() { require.NoError(t, cur.Close()) }()

	_, err = cur.Peek()
	assert.ErrorIs(t, err, io.EOF)
	_, ok := cur.Position()
	assert.False(t, ok)
	require.NoError(t, cur.Seek(tinyStartMs), "seeking an empty file is not an error")
	_, err = cur.Peek()
	assert.ErrorIs(t, err, io.EOF)
}

func TestOpenRejectsAnEmptyFile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "empty.csv")
	require.NoError(t, os.WriteFile(path, nil, 0o600))

	_, err := replay.Open(path, regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "header")
}

func TestParseHoldsTheLastValueOfAMissingField(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		testutil.SynthHeader,
		"0,2020-02-01 00:00:00,9.4,9.1,-0.01,-0.02,9.09,61.25,6.5,0,1,1,0,0,1,1,0",
		// TP2 empty, Oil_temperature NaN, Motor_current unparsable, COMP unparsable.
		"10,2020-02-01 00:00:10,,9.2,-0.01,-0.02,9.19,nan,oops,x,1,1,0,0,1,1,0",
		// TP3 infinite; everything else parses.
		"20,2020-02-01 00:00:20,9.5,inf,-0.01,-0.02,9.29,62.0,6.6,1,0,1,0,0,1,1,0",
	)

	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	cur, err := src.Cursor()
	require.NoError(t, err)
	defer func() { require.NoError(t, cur.Close()) }()

	rows := make([]replay.Row, 0, 3)
	for range 3 {
		row, err := cur.Peek()
		require.NoError(t, err)
		rows = append(rows, row.Clone())
		cur.Advance()
	}

	assert.False(t, rows[0].Missing)

	assert.True(t, rows[1].Missing, "an empty, NaN or unparsable field flags the row")
	held := analogOf(src, &rows[1])
	assert.InDelta(t, 9.4, held["discharge_pressure"], 0, "the empty TP2 keeps its last value")
	assert.InDelta(t, 61.25, held["oil_temperature"], 0, "a NaN keeps its last value")
	assert.InDelta(t, 6.5, held["motor_current"], 0, "an unparsable value keeps its last value")
	assert.InDelta(t, 9.2, held["line_pressure"], 0, "the fields that parse are still read")
	assert.False(t, digitalOf(src, &rows[1])["intake_closed"], "an unparsable digital holds too")

	assert.True(t, rows[2].Missing, "an infinite value is missing as well")
	assert.InDelta(t, 9.2, analogOf(src, &rows[2])["line_pressure"], 0)
	assert.True(t, digitalOf(src, &rows[2])["intake_closed"], "the digital that parses is read")
}

func TestParseHoldsZeroBeforeAnyValue(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		testutil.SynthHeader,
		"0,2020-02-01 00:00:00,,9.1,-0.01,-0.02,9.09,61.25,6.5,,1,1,0,0,1,1,0",
	)

	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	row := firstRow(t, src)
	assert.True(t, row.Missing)
	assert.InDelta(t, 0.0, analogOf(src, &row)["discharge_pressure"], 0,
		"a tag with no value yet holds zero")
	assert.False(t, digitalOf(src, &row)["intake_closed"])
}

func TestParseFlagsAShortLine(t *testing.T) {
	t.Parallel()

	path := writeCSV(t,
		testutil.SynthHeader,
		"0,2020-02-01 00:00:00,9.4,9.1,-0.01,-0.02,9.09,61.25,6.5,0,1,1,0,0,1,1,0",
		"10,2020-02-01 00:00:10,9.5", // the line stops after TP2
	)

	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	cur, err := src.Cursor()
	require.NoError(t, err)
	defer func() { require.NoError(t, cur.Close()) }()

	cur.Advance()
	row, err := cur.Peek()
	require.NoError(t, err)
	assert.True(t, row.Missing)
	assert.InDelta(t, 9.5, analogOf(src, row)["discharge_pressure"], 0, "the fields present are read")
	assert.InDelta(t, 9.1, analogOf(src, row)["line_pressure"], 0, "the rest holds its last value")
}

func TestParseReadsACRLFFile(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "crlf.csv")
	body := testutil.SynthHeader + "\r\n" +
		"0,2020-02-01 00:00:00,9.4,9.1,-0.01,-0.02,9.09,61.25,6.5,0,1,1,0,0,1,1,0\r\n"
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))

	src, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)

	_, _, rows := src.Bounds()
	assert.Equal(t, 1, rows)
	row := firstRow(t, src)
	assert.False(t, row.Missing)
	assert.False(t, digitalOf(src, &row)["flow_pulse"], "the terminator never reaches the last field")
}
