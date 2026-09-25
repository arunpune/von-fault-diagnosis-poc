// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"encoding/binary"
	"hash/fnv"
	"math"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// timingSlackEnv multiplies the one wall-clock bound below: 1 locally, 3 in
// CI.
const timingSlackEnv = "FDP_TIMING_SLACK"

// The throughput budget of the model. The emit loop calls Ambient once per
// sample and the injection engine may recompute it, so the cost has to be
// negligible next to the 2.78 ms a row gets at the top replay speed.
const (
	throughputCalls  = 1_000_000
	throughputBudget = 200 * time.Millisecond
)

// msPerHour and msPerDay are the conversions the model uses.
const (
	msPerHour uint64 = 3_600_000
	msPerDay  uint64 = 24 * msPerHour
)

// timingSlack returns the multiplier for the wall-clock bound.
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

// at returns the sim timestamp of an instant, written the way the tests read.
func at(t *testing.T, iso string) uint64 {
	t.Helper()

	ts, err := time.Parse(time.RFC3339, iso)
	require.NoError(t, err, "parsing %q", iso)
	require.False(t, ts.Before(time.Unix(0, 0)), "%q predates the epoch", iso)
	return uint64(ts.UnixMilli())
}

// modelNoise is the noise term of the ambient model, written again here with
// the standard library's FNV so the test does not simply read the
// implementation back.
func modelNoise(simTsMs uint64) float64 {
	var key [8]byte
	binary.BigEndian.PutUint64(key[:], simTsMs)
	h := fnv.New64a()
	_, _ = h.Write(key[:])
	unit := float64(h.Sum64()>>11) / float64(uint64(1)<<53)
	return (2*unit - 1) * sim.AmbientNoiseC
}

// modelSeasonalDiurnal is the deterministic part of the same model.
func modelSeasonalDiurnal(simTsMs uint64) float64 {
	doy := float64(time.UnixMilli(int64(simTsMs)).UTC().YearDay())
	hour := float64(simTsMs%msPerDay) / float64(msPerHour)
	return 15 +
		7*math.Sin(2*math.Pi*(doy-105)/365) +
		4*math.Sin(2*math.Pi*(hour-9)/24)
}

func TestAmbientFollowsTheDocumentedModel(t *testing.T) {
	t.Parallel()

	for _, iso := range []string{
		"2020-02-01T00:00:00Z",
		"2020-02-15T12:00:00Z",
		"2020-04-15T09:00:00Z",
		"2020-06-30T23:59:50Z",
		"2020-08-15T12:00:00Z",
		"2020-09-01T03:59:50Z",
	} {
		ts := at(t, iso)
		want := modelSeasonalDiurnal(ts) + modelNoise(ts)
		assert.InDeltaf(t, want, sim.Ambient(ts), 1e-12, "at %s", iso)
	}
}

func TestAmbientMatchesTheCalendarAcrossEightyYears(t *testing.T) {
	t.Parallel()

	// Ambient converts the timestamp to a day of the year itself, so the
	// conversion is compared with the standard library's over every leap
	// year, every century and every turn of a year between 1970 and 2050.
	const stepMs = 6 * 3_600_000
	last := uint64(time.Date(2050, time.January, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	for ts := uint64(0); ts <= last; ts += stepMs {
		want := modelSeasonalDiurnal(ts) + modelNoise(ts)
		if got := sim.Ambient(ts); math.Abs(want-got) > 1e-12 {
			require.InDeltaf(t, want, got, 1e-12, "at %s",
				time.UnixMilli(int64(ts)).UTC().Format(time.RFC3339))
		}
	}
}

func TestAmbientIsDeterministic(t *testing.T) {
	t.Parallel()

	// The same instant yields the same value however often it is recomputed,
	// and neighbouring instants do not share a value: there is no generator
	// state, so a jump, a loop wrap or a replay at another speed reproduces
	// the recording exactly.
	ts := at(t, "2020-05-04T17:23:10Z")
	first := sim.Ambient(ts)
	for range 100 {
		assert.Equal(t, first, sim.Ambient(ts))
	}
	assert.NotEqual(t, first, sim.Ambient(ts+10_000))
}

func TestAmbientSeasonalBands(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		iso       string
		low, high float64
	}{
		{name: "February midday", iso: "2020-02-15T12:00:00Z", low: 9, high: 13},
		{name: "August midday", iso: "2020-08-15T12:00:00Z", low: 18, high: 26},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := sim.Ambient(at(t, tc.iso))
			assert.GreaterOrEqual(t, got, tc.low)
			assert.LessOrEqual(t, got, tc.high)
		})
	}
}

func TestAmbientStaysInsideItsMonthlyBandsAtMidday(t *testing.T) {
	t.Parallel()

	// The seasonal term moves by about 0.1 °C a day, so a whole month at
	// noon is a slightly wider band than the single day above.
	tests := []struct {
		month     time.Month
		days      int
		low, high float64
	}{
		{month: time.February, days: 29, low: 9, high: 14},
		{month: time.August, days: 31, low: 18, high: 26},
	}
	for _, tc := range tests {
		t.Run(tc.month.String(), func(t *testing.T) {
			t.Parallel()

			for day := 1; day <= tc.days; day++ {
				ts := time.Date(2020, tc.month, day, 12, 0, 0, 0, time.UTC)
				got := sim.Ambient(uint64(ts.UnixMilli()))
				assert.GreaterOrEqualf(t, got, tc.low, "%s at noon", ts.Format(time.DateOnly))
				assert.LessOrEqualf(t, got, tc.high, "%s at noon", ts.Format(time.DateOnly))
			}
		})
	}
}

func TestAmbientNightIsBelowDay(t *testing.T) {
	t.Parallel()

	for _, day := range []string{"2020-02-15", "2020-05-15", "2020-08-15", "2020-11-15"} {
		night := sim.Ambient(at(t, day+"T03:00:00Z"))
		noon := sim.Ambient(at(t, day+"T12:00:00Z"))
		peak := sim.Ambient(at(t, day+"T15:00:00Z"))

		assert.Lessf(t, night, noon, "%s: 03:00 must be colder than noon", day)
		assert.Lessf(t, noon, peak, "%s: the diurnal term peaks at 15:00", day)
		// The swing is the full 8 °C between the 03:00 trough and the 15:00
		// peak, less at most one noise width at either end.
		assert.InDeltaf(t, 8.0, peak-night, 2*sim.AmbientNoiseC, "%s: diurnal swing", day)
	}
}

func TestAmbientNoiseIsBoundedAndSpansItsRange(t *testing.T) {
	t.Parallel()

	start := at(t, "2020-02-01T00:00:00Z")
	low, high := math.Inf(1), math.Inf(-1)
	for i := range uint64(100_000) {
		ts := start + i*10_000 // the source sampling interval
		noise := sim.Ambient(ts) - modelSeasonalDiurnal(ts)
		require.LessOrEqualf(t, math.Abs(noise), sim.AmbientNoiseC+1e-12,
			"the noise left its band at sim_ts %d", ts)
		low = math.Min(low, noise)
		high = math.Max(high, noise)
	}
	// A uniform map over the band reaches both ends; anything much narrower
	// would mean the hash is not being spread across the whole interval.
	assert.InDelta(t, -sim.AmbientNoiseC, low, 0.01)
	assert.InDelta(t, sim.AmbientNoiseC, high, 0.01)
}

func TestAmbientThroughput(t *testing.T) {
	// Deliberately not parallel: it is the only wall-clock bound in the
	// package and it measures better with the CPU to itself (FDP_TIMING_SLACK
	// widens the bound in CI).
	start := at(t, "2020-02-01T00:00:00Z")
	budget := throughputBudget * timingSlack(t)

	var sink float64
	began := time.Now()
	for i := range uint64(throughputCalls) {
		sink += sim.Ambient(start + i*10_000)
	}
	elapsed := time.Since(began)

	assert.NotZero(t, sink, "the compiler must not elide the calls")
	assert.LessOrEqualf(t, elapsed, budget, "%d calls took %s, budget %s",
		throughputCalls, elapsed, budget)
}

func BenchmarkAmbient(b *testing.B) {
	start := uint64(1_580_515_200_000) // 2020-02-01T00:00:00Z
	var sink float64
	for i := 0; b.Loop(); i++ {
		sink += sim.Ambient(start + uint64(i)*10_000)
	}
	if sink == 0 {
		b.Fatal("the compiler elided the calls")
	}
}
