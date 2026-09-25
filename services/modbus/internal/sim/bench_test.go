// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// This is the one file of the package's test suite that lives inside the
// package rather than in sim_test: the pipeline it measures is Engine.emit,
// and the point of the benchmark is the real emit path — the load-state rule,
// the ambient extra, the overlays, the alarm evaluator, the codec and the
// register store, in the order and with the buffers the emit loop uses —
// rather than a reconstruction of it that could drift from the original.
//
// Everything here runs offline on a synthetic waveform and on a fake clock, so
// `go test -bench` needs neither the dataset nor a timer.
package sim

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

const (
	// benchRows is the length of the synthetic recording the benchmarks cycle
	// through. It is long enough to cover a whole load/unload cycle, so the
	// state rule, the alarm delays and the derived quantities all see the
	// transitions they are written for, and short enough to stay in cache.
	benchRows = 1024
	// benchSeed fixes the synthetic waveform.
	benchSeed = 0xB3C4
	// benchInjectionID is the overlay the "one injection" case runs with.
	benchInjectionID = "bench_offset"
	// benchReadRegs is the window the gateway reads in one Modbus request:
	// three slots of 32 registers.
	benchReadRegs = 3 * regmap.SlotRegs
)

// benchEngine is an engine over a synthetic recording, with every row already
// parsed into memory so that the benchmark measures the pipeline and not the
// CSV reader.
type benchEngine struct {
	engine *Engine
	store  *Store
	rows   []replay.Row
}

// newBenchEngine builds the engine and materialises the rows.
func newBenchEngine(b *testing.B) *benchEngine {
	b.Helper()

	path := filepath.Join(b.TempDir(), "synthetic.csv")
	file, err := os.Create(path)
	if err != nil {
		b.Fatalf("creating the synthetic recording: %v", err)
	}
	if err := testutil.SynthCSV(file, testutil.SynthOpts{Seed: benchSeed, Rows: benchRows}); err != nil {
		b.Fatalf("writing the synthetic recording: %v", err)
	}
	if err := file.Close(); err != nil {
		b.Fatalf("closing the synthetic recording: %v", err)
	}

	source, err := replay.Open(path, regmap.Signals)
	if err != nil {
		b.Fatalf("opening the synthetic recording: %v", err)
	}

	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	if err != nil {
		b.Fatalf("building the alarm evaluator: %v", err)
	}

	store := NewStore()
	clock := testutil.NewFakeClock(time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC))
	engine, err := New(Config{Speed: 1}, source,
		injection.NewEngine(regmap.Signals, benchCatalog(b), injection.WithBootID("bench00")),
		alarms, clock, store)
	if err != nil {
		b.Fatalf("building the engine: %v", err)
	}
	b.Cleanup(func() {
		if err := engine.Close(); err != nil {
			b.Errorf("closing the engine: %v", err)
		}
	})

	return &benchEngine{engine: engine, store: store, rows: benchRowsOf(b, source)}
}

// benchCatalog is a one-definition catalogue: a flat offset on the oil
// temperature, long enough that it never expires inside a benchmark run.
func benchCatalog(b *testing.B) *injection.Catalog {
	b.Helper()

	cat := &injection.Catalog{
		Schema: injection.CatalogSchema,
		Injections: []injection.Definition{{
			InjectionID:           benchInjectionID,
			FaultID:               "oil_cooler_fouled",
			Label:                 "Benchmark overlay",
			Description:           "A flat offset the emit benchmark runs with.",
			DefaultDurationSimMin: 10_000,
			Params: []injection.ParamDef{
				{Name: injection.MagnitudeParam, Default: 1, Min: 0, Max: 2},
			},
			Transforms: []injection.Transform{{
				Tag: "oil_temperature", Op: injection.OpOffset,
				When: injection.WhenAny, Value: injection.Number(8),
			}},
		}},
	}
	if err := cat.Validate(regmap.Signals); err != nil {
		b.Fatalf("validating the benchmark catalogue: %v", err)
	}
	return cat
}

// benchRowsOf reads the whole recording into memory, cloned, so the benchmark
// loop hands emit a row without touching the file again.
func benchRowsOf(b *testing.B, source *replay.Source) []replay.Row {
	b.Helper()

	cursor, err := source.Cursor()
	if err != nil {
		b.Fatalf("opening a cursor on the synthetic recording: %v", err)
	}
	defer func() {
		if err := cursor.Close(); err != nil {
			b.Errorf("closing the cursor: %v", err)
		}
	}()

	rows := make([]replay.Row, 0, benchRows)
	for {
		row, err := cursor.Peek()
		if err != nil {
			break
		}
		rows = append(rows, row.Clone())
		cursor.Advance()
	}
	if len(rows) != benchRows {
		b.Fatalf("the synthetic recording holds %d rows, want %d", len(rows), benchRows)
	}
	return rows
}

// BenchmarkEmitRow measures one turn of the emit loop: the load-state rule,
// the ambient extra, the overlays, the alarm evaluation, the slot encoding and
// the store write.
//
// The two cases bracket what a session does: "idle" is the ordinary replay,
// "injected" is the same pipeline while one overlay is active, which is the
// only extra work a fault injection costs per sample.
func BenchmarkEmitRow(b *testing.B) {
	for _, tc := range []struct {
		name    string
		injects bool
	}{
		{name: "idle"},
		{name: "injected", injects: true},
	} {
		b.Run(tc.name, func(b *testing.B) {
			be := newBenchEngine(b)
			if tc.injects {
				if _, err := be.engine.inj.Start(benchInjectionID, nil, be.rows[0].SimTsMs); err != nil {
					b.Fatalf("starting the benchmark overlay: %v", err)
				}
			}

			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				row := &be.rows[i%len(be.rows)]
				if i%len(be.rows) == 0 {
					// Wrapping back to the first row moves sim time
					// backwards, which is a loop wrap: flag it the way the
					// engine does so the evaluator restarts its delays and
					// derived quantities instead of seeing a negative step.
					be.engine.pendingDisc = true
				}
				be.engine.emit(row)
			}
		})
	}
}

// BenchmarkStoreRead measures the read side of the register space: the 96
// registers of a three-slot Modbus request, under the read lock, copied out of
// the ring. It is the work the simulator does per gateway poll, and it runs in
// parallel because that is how the Modbus server calls it.
func BenchmarkStoreRead(b *testing.B) {
	be := newBenchEngine(b)
	for i := range be.rows {
		be.engine.emit(&be.rows[i])
	}

	// A low, fixed slot: the window of three slots then stays well inside the
	// ring whatever the last sequence number was.
	addr := regmap.SlotAddr(1)

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			regs, err := be.store.Read(addr, benchReadRegs)
			if err != nil {
				b.Errorf("reading %d registers at %d: %v", benchReadRegs, addr, err)
				return
			}
			if len(regs) != benchReadRegs {
				b.Errorf("read %d registers, want %d", len(regs), benchReadRegs)
				return
			}
		}
	})
}
