// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// startMs is an arbitrary instant inside the recording; the envelope is
// relative, so the value only has to be non-zero to prove that "before the
// start" is handled at all.
const startMs uint64 = 1_580_515_200_000

func TestEnvelopeTrapezoidAtItsBoundaries(t *testing.T) {
	t.Parallel()

	// oil_cooler_fouling: 600 minutes, 180 in, 60 out.
	e := newEnvelope(startMs, startMs+600*msPerMin, Envelope{RampInMin: 180, RampOutMin: 60})

	for _, tc := range []struct {
		name string
		at   uint64
		want float64
	}{
		{"an hour before the start", startMs - 60*msPerMin, 0},
		{"the start", startMs, 0},
		{"halfway up the ramp in", startMs + 90*msPerMin, 0.5},
		{"the end of the ramp in", startMs + 180*msPerMin, 1},
		{"the middle of the hold", startMs + 360*msPerMin, 1},
		{"the start of the ramp out", startMs + 540*msPerMin, 1},
		{"halfway down the ramp out", startMs + 570*msPerMin, 0.5},
		{"the end", startMs + 600*msPerMin, 0},
		{"an hour after the end", startMs + 660*msPerMin, 0},
	} {
		assert.InDelta(t, tc.want, e.at(tc.at), 1e-12, tc.name)
	}
}

func TestEnvelopeWithoutRampsIsFullFromTheFirstSample(t *testing.T) {
	t.Parallel()

	// dryer_tower_switching_failure and oil_temperature_sensor_fault: 0 in,
	// 0 out, so the overlay is at full magnitude on its first sample.
	e := newEnvelope(startMs, startMs+300*msPerMin, Envelope{})

	assert.InDelta(t, 1, e.at(startMs), 1e-12)
	assert.InDelta(t, 1, e.at(startMs+299*msPerMin), 1e-12)
	assert.InDelta(t, 0, e.at(startMs+300*msPerMin), 1e-12)
}

func TestEnvelopeShorterThanItsRampsBecomesATriangle(t *testing.T) {
	t.Parallel()

	// An instance may ask for a shorter duration than the definition's
	// default; the two ramps then no longer fit and are scaled down together.
	// 180 in and 60 out inside 60 minutes become 45 and 15.
	e := newEnvelope(startMs, startMs+60*msPerMin, Envelope{RampInMin: 180, RampOutMin: 60})

	assert.InDelta(t, 0, e.at(startMs), 1e-12)
	assert.InDelta(t, 0.5, e.at(startMs+22*msPerMin+30_000), 1e-12)
	assert.InDelta(t, 1, e.at(startMs+45*msPerMin), 1e-12)
	assert.InDelta(t, 0.5, e.at(startMs+52*msPerMin+30_000), 1e-12)
	assert.InDelta(t, 0, e.at(startMs+60*msPerMin), 1e-12)
}

func TestEnvelopeWindowDecidesWhetherAnInstanceRunsAtAll(t *testing.T) {
	t.Parallel()

	e := newEnvelope(startMs, startMs+120*msPerMin, Envelope{})

	require.False(t, e.active(startMs-1))
	require.True(t, e.active(startMs))
	require.True(t, e.active(startMs+120*msPerMin-1))
	require.False(t, e.active(startMs+120*msPerMin), "the end is exclusive: Expire stops the instance")
}
