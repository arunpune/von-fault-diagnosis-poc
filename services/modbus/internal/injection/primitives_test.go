// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The expectations below are hand-computed from the primitives' formulas, at
// three magnitudes: off, half and full.

func TestOffsetAtThreeMagnitudes(t *testing.T) {
	t.Parallel()

	// oil_cooler_fouling: +14 °C on a 50 °C reading.
	assert.InDelta(t, 50.0, applyOffset(50, 14, 0), 1e-12)
	assert.InDelta(t, 57.0, applyOffset(50, 14, 0.5), 1e-12)
	assert.InDelta(t, 64.0, applyOffset(50, 14, 1), 1e-12)

	// intake_valve_sticking: −0.22 bar on an 8.0 bar reading.
	assert.InDelta(t, 8.0, applyOffset(8, -0.22, 0), 1e-12)
	assert.InDelta(t, 7.89, applyOffset(8, -0.22, 0.5), 1e-12)
	assert.InDelta(t, 7.78, applyOffset(8, -0.22, 1), 1e-12)
}

func TestScaleInterpolatesFromOne(t *testing.T) {
	t.Parallel()

	// motor_overload: ×1.20 on 5.0 A.
	assert.InDelta(t, 5.0, applyScale(5, 1.2, 0), 1e-12)
	assert.InDelta(t, 5.5, applyScale(5, 1.2, 0.5), 1e-12)
	assert.InDelta(t, 6.0, applyScale(5, 1.2, 1), 1e-12)

	// intake_valve_sticking: ×0.86 on 5.0 A.
	assert.InDelta(t, 5.0, applyScale(5, 0.86, 0), 1e-12)
	assert.InDelta(t, 4.65, applyScale(5, 0.86, 0.5), 1e-12)
	assert.InDelta(t, 4.3, applyScale(5, 0.86, 1), 1e-12)
}

func TestRampScalesWithTimeAndClampsAtTheCap(t *testing.T) {
	t.Parallel()

	// air_leak_downstream: −0.30 bar/min capped at 2.5 bar, four minutes in.
	assert.InDelta(t, 8.0, applyRamp(8, -0.3, 2.5, 0, 4), 1e-12)
	assert.InDelta(t, 7.4, applyRamp(8, -0.3, 2.5, 0.5, 4), 1e-12)
	assert.InDelta(t, 6.8, applyRamp(8, -0.3, 2.5, 1, 4), 1e-12)

	// Twenty minutes in the drift would be 6 bar; the cap holds it at 2.5.
	assert.InDelta(t, 5.5, applyRamp(8, -0.3, 2.5, 1, 20), 1e-12)
	// The cap is symmetric.
	assert.InDelta(t, 10.5, applyRamp(8, 0.3, 2.5, 1, 20), 1e-12)
}

func TestNoiseScalesTheDrawWithSigmaAndMagnitude(t *testing.T) {
	t.Parallel()

	const draw = 1.5
	assert.InDelta(t, 5.0, applyNoise(5, 0.12, 0, draw), 1e-12)
	assert.InDelta(t, 5.09, applyNoise(5, 0.12, 0.5, draw), 1e-12)
	assert.InDelta(t, 5.18, applyNoise(5, 0.12, 1, draw), 1e-12)
	// Twice the deviation is twice the deviation from the source value.
	assert.InDelta(t, 5.36, applyNoise(5, 0.24, 1, draw), 1e-12)
}

func TestNoiseDrawIsAFunctionOfInstanceTimestampAndTransform(t *testing.T) {
	t.Parallel()

	const id = "inj-a1b2c3-1"
	const ts uint64 = 1_580_515_200_000

	first := noiseDraw(id, ts, 0)
	require.InDelta(t, first, noiseDraw(id, ts, 0), 0,
		"the same instance, instant and transform must give the same draw")

	assert.NotEqual(t, first, noiseDraw(id, ts+1000, 0), "a later sample draws again")
	assert.NotEqual(t, first, noiseDraw("inj-a1b2c3-2", ts, 0), "another instance draws its own")
	assert.NotEqual(t, first, noiseDraw(id, ts, 1), "a second noise transform draws its own")
}

func TestNoiseDrawIsStandardNormal(t *testing.T) {
	t.Parallel()

	// A loose sanity bound: over ten thousand instants the mean stays near
	// zero and the deviation near one. The test is deterministic — the draws
	// are a pure function of the timestamps.
	const samples = 10_000
	var sum, sumSquares float64
	for i := range samples {
		d := noiseDraw("inj-a1b2c3-1", uint64(i)*1000, 0)
		sum += d
		sumSquares += d * d
	}
	mean := sum / samples
	variance := sumSquares/samples - mean*mean
	assert.InDelta(t, 0, mean, 0.05)
	assert.InDelta(t, 1, variance, 0.1)
}

// pulseTrain is the synthetic Towers signal of the duty_shift tests: runs of
// false and true of pulseS seconds each, sampled every sampleS seconds.
func pulseTrain(t *testing.T, runValue bool, extendS, pulseS, sampleS, pulses int) []bool {
	t.Helper()

	var state dutyState
	out := make([]bool, 0, pulses*pulseS/sampleS)
	var ts uint64
	for p := range pulses {
		level := p%2 == 1
		for s := 0; s < pulseS; s += sampleS {
			out = append(out, state.applyDutyShift(level, runValue, extendS, ts))
			ts += uint64(sampleS) * 1000
		}
	}
	return out
}

func TestDutyShiftSuppressesTheStartOfEveryRun(t *testing.T) {
	t.Parallel()

	// dryer_tower_switching_failure: sixty-second runs of false, suppressed
	// for their first sixty seconds, so every run of false vanishes. The
	// first run is not tracked — the instance did not watch it begin — so it
	// survives; from the second on the level never goes low again.
	got := pulseTrain(t, false, -60, 60, 10, 6)
	want := []bool{
		false, false, false, false, false, false, // run 0: false, untracked
		true, true, true, true, true, true, // run 1: true
		true, true, true, true, true, true, // run 2: false, suppressed
		true, true, true, true, true, true, // run 3: true
		true, true, true, true, true, true, // run 4: false, suppressed
		true, true, true, true, true, true, // run 5: true
	}
	assert.Equal(t, want, got)
}

func TestDutyShiftKeepsShorterRunsThatExceedTheSuppression(t *testing.T) {
	t.Parallel()

	// A run of false that lasts ninety seconds loses its first sixty and
	// keeps the remaining thirty.
	got := pulseTrain(t, false, -60, 90, 10, 4)
	want := []bool{
		false, false, false, false, false, false, false, false, false, // untracked
		true, true, true, true, true, true, true, true, true,
		true, true, true, true, true, true, false, false, false, // 60 s suppressed, 30 s kept
		true, true, true, true, true, true, true, true, true,
	}
	assert.Equal(t, want, got)
}

func TestDutyShiftExtendsEveryRunItWatchedEnd(t *testing.T) {
	t.Parallel()

	// The mirror case: runs of true held for thirty seconds past their end.
	got := pulseTrain(t, true, 30, 60, 10, 4)
	want := []bool{
		false, false, false, false, false, false, // run 0: false
		true, true, true, true, true, true, // run 1: true
		true, true, true, false, false, false, // run 2: first 30 s held true
		true, true, true, true, true, true, // run 3: true
	}
	assert.Equal(t, want, got)
}

func TestDutyShiftWithoutAnExtensionChangesNothing(t *testing.T) {
	t.Parallel()

	var state dutyState
	for i, level := range []bool{false, true, true, false, false, true} {
		got := state.applyDutyShift(level, false, 0, uint64(i)*10_000)
		assert.Equal(t, level, got, "sample %d", i)
	}
}
