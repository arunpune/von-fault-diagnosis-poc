// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil_test

import (
	"bytes"
	"encoding/csv"
	"flag"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// update rewrites the committed fixture instead of comparing against it:
//
//	go test ./internal/testutil -run TestSynthCSVFixtureIsReproducible -update
var update = flag.Bool("update", false, "rewrite services/modbus/testdata/synthetic-tiny.csv")

// tinyOpts are the parameters of the committed synthetic-tiny.csv: 120 rows of
// seed 1 with a 5 min and a 1 h hole, both above the 60 s gap threshold.
var tinyOpts = testutil.SynthOpts{
	Seed: 1,
	Rows: 120,
	Gaps: []testutil.SynthGap{
		{AfterRow: 40, Seconds: 300},
		{AfterRow: 80, Seconds: 3600},
	},
}

// tinyFixture is the fixture's path inside testdata.
const tinyFixture = "synthetic-tiny.csv"

func generate(t *testing.T, opts testutil.SynthOpts) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, testutil.SynthCSV(&buf, opts))
	return buf.Bytes()
}

// parse returns the header and the data records of a generated file.
func parse(t *testing.T, raw []byte) (header []string, records [][]string) {
	t.Helper()
	r := csv.NewReader(bytes.NewReader(raw))
	all, err := r.ReadAll()
	require.NoError(t, err)
	require.NotEmpty(t, all)
	return all[0], all[1:]
}

// timestampsOf parses the timestamp column of every record.
func timestampsOf(t *testing.T, records [][]string) []time.Time {
	t.Helper()
	out := make([]time.Time, len(records))
	for i, rec := range records {
		ts, err := time.ParseInLocation(time.DateTime, rec[1], time.UTC)
		require.NoErrorf(t, err, "row %d", i)
		out[i] = ts
	}
	return out
}

func TestSynthCSVFixtureIsReproducible(t *testing.T) {
	t.Parallel()

	got := generate(t, tinyOpts)

	if *update {
		path := testutil.TestdataPath(tinyFixture)
		require.NoError(t, os.WriteFile(path, got, 0o644))
		t.Logf("rewrote %s (%d bytes)", path, len(got))
		return
	}

	want, err := os.ReadFile(testutil.FixturePath(t, tinyFixture))
	require.NoError(t, err)
	assert.Equal(t, string(want), string(got),
		"the committed fixture must be byte-identical to SynthCSV's output; "+
			"re-run with -update after an intentional change")
}

func TestSynthCSVIsDeterministic(t *testing.T) {
	t.Parallel()

	assert.Equal(t, generate(t, tinyOpts), generate(t, tinyOpts))

	other := tinyOpts
	other.Seed = 2
	assert.NotEqual(t, generate(t, tinyOpts), generate(t, other), "the seed selects the noise")
}

func TestSynthCSVHeaderIsTheDatasetHeader(t *testing.T) {
	t.Parallel()

	raw := generate(t, tinyOpts)
	require.True(t, bytes.HasPrefix(raw, []byte(testutil.SynthHeader+"\n")))

	header, _ := parse(t, raw)
	assert.Equal(t, "", header[0], "the index column has no name")
	assert.Equal(t, "timestamp", header[1])
	assert.Contains(t, header, "DV_eletric", "the dataset's misspelling is kept verbatim")
	assert.Len(t, header, 17)

	// Every mapped signal must find its column.
	for _, sig := range regmap.Signals {
		if sig.Column == "" {
			continue
		}
		assert.Containsf(t, header, sig.Column, "signal %q", sig.Tag)
	}
}

func TestSynthCSVRowCountAndIndexColumn(t *testing.T) {
	t.Parallel()

	_, records := parse(t, generate(t, tinyOpts))
	require.Len(t, records, tinyOpts.Rows)

	for i, rec := range records {
		require.Len(t, rec, 17)
		idx, err := strconv.Atoi(rec[0])
		require.NoErrorf(t, err, "row %d", i)
		assert.Equalf(t, i*10, idx, "row %d: the index steps by ten like the decimated dataset", i)
	}
}

func TestSynthCSVGapsAppearWhereRequested(t *testing.T) {
	t.Parallel()

	_, records := parse(t, generate(t, tinyOpts))
	ts := timestampsOf(t, records)

	gapAfter := map[int]time.Duration{
		40: 310 * time.Second,  // 10 s step plus the 300 s hole
		80: 3610 * time.Second, // 10 s step plus the 3600 s hole
	}
	for i := 1; i < len(ts); i++ {
		step := ts[i].Sub(ts[i-1])
		if want, ok := gapAfter[i]; ok {
			assert.Equalf(t, want, step, "the gap after row %d", i)
			continue
		}
		assert.Equalf(t, 10*time.Second, step, "step before row %d", i)
	}

	assert.Equal(t, testutil.SynthStart, ts[0])
}

func TestSynthCSVRejectsBadOptions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		opts testutil.SynthOpts
		msg  string
	}{
		{name: "no rows", opts: testutil.SynthOpts{Rows: 0}, msg: "at least one row"},
		{name: "negative rows", opts: testutil.SynthOpts{Rows: -1}, msg: "at least one row"},
		{
			name: "gap before the first row",
			opts: testutil.SynthOpts{Rows: 10, Gaps: []testutil.SynthGap{{AfterRow: 0, Seconds: 100}}},
			msg:  "outside 1..9",
		},
		{
			name: "gap past the last row",
			opts: testutil.SynthOpts{Rows: 10, Gaps: []testutil.SynthGap{{AfterRow: 10, Seconds: 100}}},
			msg:  "outside 1..9",
		},
		{
			name: "gap that adds no time",
			opts: testutil.SynthOpts{Rows: 10, Gaps: []testutil.SynthGap{{AfterRow: 5, Seconds: 0}}},
			msg:  "must add time",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var buf bytes.Buffer
			err := testutil.SynthCSV(&buf, tc.opts)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.msg)
			assert.Empty(t, buf.String(), "nothing is written when the options are rejected")
		})
	}
}

// TestSynthCSVWaveformIsPlausible checks the generated rows against the
// first-month bands of the recording, so a fixture that drifts out of the real
// machine's envelope fails here rather than in a rules test.
func TestSynthCSVWaveformIsPlausible(t *testing.T) {
	t.Parallel()

	// One full cycle plus a little, without gaps.
	header, records := parse(t, generate(t, testutil.SynthOpts{Seed: 7, Rows: 250}))

	col := func(name string) int {
		for i, h := range header {
			if h == name {
				return i
			}
		}
		t.Fatalf("no column %q", name)
		return -1
	}
	num := func(rec []string, name string) float64 {
		v, err := strconv.ParseFloat(rec[col(name)], 64)
		require.NoError(t, err)
		return v
	}

	seen := map[machine.State]int{}
	for i, rec := range records {
		tp2 := num(rec, "TP2")
		tp3 := num(rec, "TP3")
		h1 := num(rec, "H1")
		oil := num(rec, "Oil_temperature")
		current := num(rec, "Motor_current")
		comp := num(rec, "COMP") != 0
		dv := num(rec, "DV_eletric") != 0

		state := machine.Classify(comp, dv, current)
		seen[state]++

		assert.Greaterf(t, tp3, 7.9, "row %d: the line pressure stays above the cut-in band", i)
		assert.Lessf(t, tp3, 10.1, "row %d: the line pressure stays below the cut-out band", i)
		assert.Greaterf(t, oil, 50.0, "row %d", i)
		assert.Lessf(t, oil, 62.0, "row %d", i)

		switch state {
		case machine.StateLoaded:
			assert.InDeltaf(t, tp3+0.32, tp2, 0.02, "row %d: the discharge pressure rides above the line", i)
			assert.Lessf(t, h1, 0.0, "row %d: the separator pressure drops while loaded", i)
			assert.InDeltaf(t, 6.0, current, 0.1, "row %d", i)
		case machine.StateUnloaded:
			assert.InDeltaf(t, 3.77, current, 0.1, "row %d", i)
			assert.InDeltaf(t, tp3, h1, 0.02, "row %d: the separator pressure follows the line", i)
			assert.Lessf(t, tp2, 0.0, "row %d: the compressor is vented", i)
		case machine.StateOff:
			assert.Lessf(t, current, 0.1, "row %d", i)
			assert.InDeltaf(t, tp3, h1, 0.02, "row %d", i)
		}
	}

	for _, state := range []machine.State{machine.StateLoaded, machine.StateUnloaded, machine.StateOff} {
		assert.NotZerof(t, seen[state], "a full cycle must visit %s", state)
	}
}

// TestSynthCSVFeedsTheCodec proves the fixture can be replayed: every column
// resolves through regmap.Signals and the row encodes into a slot.
func TestSynthCSVFeedsTheCodec(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile(testutil.FixturePath(t, tinyFixture))
	require.NoError(t, err)
	header, records := parse(t, raw)

	index := make(map[string]int, len(header))
	for i, name := range header {
		index[strings.TrimSpace(name)] = i
	}

	for i, rec := range records {
		slot := regmap.Slot{
			Seq:     uint32(i) + 1,
			Analog:  make(map[string]float64),
			Digital: make(map[string]bool),
		}
		for _, sig := range regmap.Signals {
			if sig.Column == "" {
				slot.Analog[sig.Tag] = 12.5 // the synthetic ambient extra
				continue
			}
			pos, ok := index[sig.Column]
			require.Truef(t, ok, "column %q is missing", sig.Column)
			v, err := strconv.ParseFloat(rec[pos], 64)
			require.NoErrorf(t, err, "row %d, column %q", i, sig.Column)
			switch sig.Kind {
			case regmap.KindAnalog:
				slot.Analog[sig.Tag] = v
			case regmap.KindDigital:
				slot.Digital[sig.Tag] = v != 0
			}
		}

		regs, err := regmap.EncodeSlot(slot)
		require.NoErrorf(t, err, "row %d", i)
		out, err := regmap.DecodeSlot(regs[:])
		require.NoErrorf(t, err, "row %d", i)
		assert.InDeltaf(t, slot.Analog["line_pressure"], out.Analog["line_pressure"], 0.001, "row %d", i)
	}
}
