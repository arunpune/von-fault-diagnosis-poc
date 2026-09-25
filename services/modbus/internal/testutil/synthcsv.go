// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"time"
)

// SynthHeader is the MetroPT-3 header line, verbatim: the unnamed index column
// first and the misspelt `DV_eletric` kept as it is in the dataset
// (docs/dataset.md). The replay resolves its columns through
// regmap.Signal.Column, so a fixture that renamed one would not be a fixture
// of the real file any more.
const SynthHeader = ",timestamp,TP2,TP3,H1,DV_pressure,Reservoirs,Oil_temperature," +
	"Motor_current,COMP,DV_eletric,Towers,MPG,LPS,Pressure_switch,Oil_level,Caudal_impulses"

// Sampling and cycle geometry of the recording: a 10 s step, a 110 s loaded
// run that raises the line pressure from the 8.05 bar cut-in to the 10.03 bar
// cut-out, a 410 s run-on and an off phase that lasts until the line pressure
// has decayed back to the cut-in point.
const (
	synthStepS   = 10
	synthLoadedS = 110
	synthRunOnS  = 410
	synthOffS    = 1490
	synthCycleS  = synthLoadedS + synthRunOnS + synthOffS

	synthCutInBar  = 8.05
	synthCutOutBar = 10.03
	// Decay of the line pressure while the unit is not loaded, in bar/min.
	synthRunOnDecayPerMin = 0.086
	synthOffDecayPerMin   = 0.056
	// The dryer tower pulse that follows every cut-in, in seconds.
	synthTowerPulseS = 60

	synthVentedBar     = -0.012 // TP2 and H1 when the compressor is vented
	synthPurgeBar      = -0.018 // DV_pressure in every normal state
	synthReservoirBias = -0.002 // Reservoirs against TP3
	synthDischargeRise = 0.32   // TP2 above TP3 during a loaded run

	synthLoadedA   = 6.00
	synthUnloadedA = 3.77
	synthOffA      = 0.038

	synthOilBaseC = 55.0
	synthOilSwing = 2.0
)

// Noise amplitudes. They keep every channel inside the first-month min–max
// range of the recording and are large enough to exercise rounding and sign
// handling in the codec; they are not a model of the real sensor noise, which
// differs per state.
const (
	synthPressureNoise = 0.004
	synthCurrentNoise  = 0.02
	synthOilNoise      = 0.06
)

// SynthStart is the timestamp of the first generated row. It is the dataset's
// own start, so a synthetic fixture and a real slice of the first day line up.
var SynthStart = time.Date(2020, 2, 1, 0, 0, 0, 0, time.UTC)

// SynthGap inserts a hole in the generated timeline: after AfterRow rows have
// been written, the next timestamp jumps Seconds further than the sampling
// step. A gap above 60 s is what the replay collapses into a discontinuity
// (docs/simulation.md, "Gaps and the discontinuity flag").
type SynthGap struct {
	AfterRow int
	Seconds  int
}

// SynthOpts configures SynthCSV.
type SynthOpts struct {
	// Seed selects the noise. The same seed always yields the same bytes.
	Seed uint64
	// Rows is the number of data rows below the header.
	Rows int
	// Gaps are the holes to insert, in any order.
	Gaps []SynthGap
}

// SynthCSV writes a synthetic MetroPT-3 file: the verbatim header and Rows
// data rows of a normal load/unload cycle with seeded noise and the requested
// gaps. No MetroPT-3 row is ever copied — the waveform is built from the
// published statistics — so the result may be committed.
//
// The output is a pure function of opts: the noise comes from a splitmix64
// stream keyed by the seed, the row index and the channel, never from the
// standard library's generator, so it does not move with a toolchain release.
func SynthCSV(w io.Writer, opts SynthOpts) error {
	if opts.Rows <= 0 {
		return fmt.Errorf("testutil: SynthCSV needs at least one row, got %d", opts.Rows)
	}
	offsets, err := gapOffsets(opts)
	if err != nil {
		return err
	}

	bw := bufio.NewWriter(w)
	if _, err := fmt.Fprintf(bw, "%s\n", SynthHeader); err != nil {
		return err
	}
	for i := range opts.Rows {
		elapsed := i*synthStepS + offsets[i]
		if err := writeSynthRow(bw, opts.Seed, i, elapsed); err != nil {
			return err
		}
	}
	return bw.Flush()
}

// gapOffsets turns the gap list into the extra seconds each row carries.
func gapOffsets(opts SynthOpts) ([]int, error) {
	offsets := make([]int, opts.Rows)
	for _, g := range opts.Gaps {
		if g.AfterRow < 1 || g.AfterRow >= opts.Rows {
			return nil, fmt.Errorf("testutil: gap after row %d is outside 1..%d", g.AfterRow, opts.Rows-1)
		}
		if g.Seconds <= 0 {
			return nil, fmt.Errorf("testutil: gap after row %d must add time, got %d s", g.AfterRow, g.Seconds)
		}
		for i := g.AfterRow; i < opts.Rows; i++ {
			offsets[i] += g.Seconds
		}
	}
	return offsets, nil
}

// writeSynthRow renders one data row.
func writeSynthRow(bw *bufio.Writer, seed uint64, row, elapsed int) error {
	phase := elapsed % synthCycleS
	ts := SynthStart.Add(time.Duration(elapsed) * time.Second)

	linePressure, current, loaded := synthCycle(phase)
	linePressure += synthNoise(seed, row, 1, synthPressureNoise)
	current += synthNoise(seed, row, 2, synthCurrentNoise)

	dischargePressure := synthVentedBar
	separatorPressure := linePressure
	tower := 1.0
	if loaded {
		dischargePressure = linePressure + synthDischargeRise
		separatorPressure = synthVentedBar
		if phase < synthTowerPulseS {
			tower = 0.0
		}
	}
	dischargePressure += synthNoise(seed, row, 3, synthPressureNoise)
	separatorPressure += synthNoise(seed, row, 4, synthPressureNoise)

	purgePressure := synthPurgeBar + synthNoise(seed, row, 5, synthPressureNoise)
	reservoirPressure := linePressure + synthReservoirBias + synthNoise(seed, row, 6, synthPressureNoise)
	oil := synthOilBaseC +
		synthOilSwing*math.Sin(2*math.Pi*float64(phase)/synthCycleS) +
		synthNoise(seed, row, 7, synthOilNoise)

	intakeClosed, loadValve, regulator := 1.0, 0.0, 1.0
	if loaded {
		intakeClosed, loadValve, regulator = 0.0, 1.0, 0.0
	}

	_, err := fmt.Fprintf(bw,
		"%d,%s,%.3f,%.3f,%.3f,%.3f,%.3f,%.2f,%.3f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f,%.1f\n",
		row*synthStepS, ts.Format(time.DateTime),
		dischargePressure, linePressure, separatorPressure, purgePressure, reservoirPressure,
		oil, current,
		intakeClosed, loadValve, tower, regulator,
		0.0, // LPS: the synthetic cycle never drops below the switch setting
		1.0, // Pressure_switch
		1.0, // Oil_level (1 = normal on this unit)
		1.0, // Caudal_impulses
	)
	return err
}

// synthCycle returns the line pressure, the motor current and the load state
// at phase seconds into a cycle.
func synthCycle(phase int) (linePressure, current float64, loaded bool) {
	switch {
	case phase < synthLoadedS:
		frac := float64(phase) / synthLoadedS
		return synthCutInBar + frac*(synthCutOutBar-synthCutInBar), synthLoadedA, true
	case phase < synthLoadedS+synthRunOnS:
		minutes := float64(phase-synthLoadedS) / 60
		return synthCutOutBar - synthRunOnDecayPerMin*minutes, synthUnloadedA, false
	default:
		atRunOnEnd := synthCutOutBar - synthRunOnDecayPerMin*float64(synthRunOnS)/60
		minutes := float64(phase-synthLoadedS-synthRunOnS) / 60
		return atRunOnEnd - synthOffDecayPerMin*minutes, synthOffA, false
	}
}

// synthNoise returns a deterministic value in [-amp, amp) for one row and
// channel.
func synthNoise(seed uint64, row, channel int, amp float64) float64 {
	h := splitmix64(seed ^ uint64(row)*0x100000001b3 ^ uint64(channel)*0x9e3779b97f4a7c15)
	unit := float64(h>>11) / float64(uint64(1)<<53) // [0, 1)
	return (unit*2 - 1) * amp
}

// splitmix64 is the finalising mix of the SplitMix64 generator. It is written
// out here so the fixture bytes depend on nothing but this file.
func splitmix64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}
