// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay_test

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// sink keeps the benchmarked reads from being optimised away.
var sink uint64

// benchSlicePath resolves the day slice for a benchmark. testutil.SliceCSV
// takes a *testing.T, so the same skip-or-fail rule is spelled out here for
// *testing.B.
func benchSlicePath(b *testing.B) string {
	b.Helper()

	path := filepath.Join(testutil.SlicesDir(), daySlice+".csv")
	if _, err := os.Stat(path); err != nil {
		msg := "MetroPT-3 slice %q is not cut at %s; run `make fixtures` with the dataset in place (%v)"
		if v := os.Getenv(testutil.RequireDatasetEnv); v != "" && v != "0" {
			b.Fatalf(msg+" ["+testutil.RequireDatasetEnv+"=1]", daySlice, path, err)
		}
		b.Skipf(msg, daySlice, path, err)
	}
	return path
}

// BenchmarkCursor measures the sustained row rate of a sequential read over
// the day slice. The simulator needs about 360 rows/s at the top replay speed
// of 3600×, and the catch-up burst after a jump wants far more than that; the
// target is 200,000 rows/s.
func BenchmarkCursor(b *testing.B) {
	src, err := replay.Open(benchSlicePath(b), regmap.Signals)
	if err != nil {
		b.Fatalf("opening the day slice: %v", err)
	}
	cur, err := src.Cursor()
	if err != nil {
		b.Fatalf("opening a cursor: %v", err)
	}
	defer func() {
		if err := cur.Close(); err != nil {
			b.Fatalf("closing the cursor: %v", err)
		}
	}()

	rows := 0
	b.ReportAllocs()
	for b.Loop() {
		if err := cur.Seek(0); err != nil { // rewind to the first row
			b.Fatalf("rewinding: %v", err)
		}
		for {
			row, err := cur.Peek()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					b.Fatalf("reading: %v", err)
				}
				break
			}
			sink += row.SimTsMs
			cur.Advance()
			rows++
		}
	}
	b.ReportMetric(float64(rows)/b.Elapsed().Seconds(), "rows/s")
}

// BenchmarkOpen measures the index pass, the one-off cost of every simulator
// boot.
func BenchmarkOpen(b *testing.B) {
	path := benchSlicePath(b)

	rows := 0
	b.ReportAllocs()
	for b.Loop() {
		src, err := replay.Open(path, regmap.Signals)
		if err != nil {
			b.Fatalf("opening the day slice: %v", err)
		}
		_, _, n := src.Bounds()
		rows += n
	}
	b.ReportMetric(float64(rows)/b.Elapsed().Seconds(), "rows/s")
}
