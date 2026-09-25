// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration && !race

// The wall-clock half of the full-stack proof: the sustained throughput of
// scenario A, and the rate and acknowledgement bounds of the control plane.
//
// They live here, behind `!race`, because the race detector makes a machine
// several times slower and would turn a timing bound into a coin toss. CI runs
// this file once, in the `go` job, without `-race`, and every bound is
// multiplied by FDP_TIMING_SLACK.

package e2e

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// The throughput bounds: at 3600× the stack has to hold three hundred samples
// a second for a quarter of a minute.
const (
	minSustainedRate = 300.0
	sustainedWindow  = 15 * time.Second
)

// The control-plane bounds.
const (
	// ackDeadline is the wall time one control command may take to be
	// acknowledged.
	ackDeadline = 100 * time.Millisecond
	// statusDeadline is how long the retained simulator status may lag a
	// change: one status tick plus a fifth.
	statusDeadline = 1200 * time.Millisecond
	// rateWindow is how long a replay rate is averaged over.
	rateWindow = 2 * time.Second
	// speedChangeWindow is how long a change of speed may take to show in
	// the rate.
	speedChangeWindow = 500 * time.Millisecond
	// The rate a 600× replay of a ten-second recording produces, sixty
	// samples a second, with a tolerance of twenty either side.
	minControlRate = 40.0
	maxControlRate = 80.0
)

// publishRate returns the samples a second the gateway published over window,
// measured from its own counters rather than from arrival times, so a slow
// subscriber cannot make the machine look slow.
func (s *stack) publishRate(t *testing.T, window time.Duration) float64 {
	t.Helper()

	before := s.service.Snapshot().SamplesPublished
	started := time.Now()
	time.Sleep(window)
	elapsed := time.Since(started)

	return float64(s.service.Snapshot().SamplesPublished-before) / elapsed.Seconds()
}

// TestScenarioATimingSustainedThroughput replays the whole recorded day at
// 3600× and measures what came out of the broker over the last fifteen seconds
// of it.
func TestScenarioATimingSustainedThroughput(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{})

	started := time.Now()
	require.True(t, s.command("play", `{}`).OK)

	waitUntil(t, budget(t, dayBudget),
		func() bool { return s.engine.Snapshot().State == sim.StateStopped },
		"the recording to run out")
	waitFor(t, func() bool { return s.service.Snapshot().LastSeq == uint32(dayRows) },
		"the gateway to publish the last sample of the day")
	waitFor(t, func() bool { return len(s.publishedSeq(t)) == dayRows },
		"every published sample to reach the subscriber")
	elapsed := time.Since(started)

	require.GreaterOrEqual(t, elapsed, sustainedWindow,
		"the run is long enough to sustain a rate for %s", sustainedWindow)
	assert.Zero(t, s.service.Snapshot().Counters.Dropped, "the run that was measured lost nothing")

	overall := float64(dayRows) / elapsed.Seconds()
	window, samples := s.rateOverLastWindow(t, sustainedWindow)
	t.Logf("scenario A at 3600x: %d samples in %s (%.0f samples/s overall); "+
		"%d samples in the last %s (%.0f samples/s sustained)",
		dayRows, elapsed.Round(time.Millisecond), overall,
		samples, window.Round(time.Millisecond), float64(samples)/window.Seconds())

	assert.GreaterOrEqualf(t, float64(samples)/window.Seconds(), minSustainedRate,
		"the stack held %.0f samples/s over the last %s; the bound is %.0f",
		float64(samples)/window.Seconds(), window, minSustainedRate)
	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// rateOverLastWindow counts the samples the subscriber received in the last
// window of the run, using the instant each batch arrived. It returns the
// window it actually covered, which is the span between the first counted
// batch and the last one.
func (s *stack) rateOverLastWindow(t *testing.T, window time.Duration) (time.Duration, int) {
	t.Helper()

	batches := s.plant.on(s.topics.Telemetry())
	require.NotEmpty(t, batches, "there is telemetry to measure")

	last := batches[len(batches)-1].at
	from := last.Add(-window)

	samples, first := 0, last
	for _, batch := range batches {
		if batch.at.Before(from) {
			continue
		}
		if batch.at.Before(first) {
			first = batch.at
		}
		samples += len(decodeBatch(t, batch.payload, 0))
	}
	covered := last.Sub(first)
	require.Positive(t, covered, "the measured window has a length")
	return covered, samples
}

// TestScenarioBTimingRatesAndAckLatency measures the three wall-clock bounds
// the control plane carries.
func TestScenarioBTimingRatesAndAckLatency(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{speed: controlSpeed})

	t.Run("every command is acknowledged inside its budget", func(t *testing.T) {
		for _, command := range []struct{ cmd, args string }{
			{"play", `{}`},
			{"set_speed", `{"speed":900}`},
			{"inject", `{"injection_id":"` + oilInjection + `"}`},
			{"clear_injections", `{}`},
			{"jump", `{"preset_id":"fixture_noon"}`},
			{"pause", `{}`},
			{"reset", `{}`},
			{"set_speed", `{"speed":0}`},
		} {
			ack := s.command(command.cmd, command.args)
			assert.Lessf(t, ack.took, budget(t, ackDeadline),
				"%s was acknowledged in %s; the budget is %s", command.cmd, ack.took, ackDeadline)
		}
	})

	t.Run("the retained status follows a change inside its deadline", func(t *testing.T) {
		before := s.plant.count(s.topics.StatusSim())
		changed := time.Now()
		require.True(t, s.command("set_speed", `{"speed":1200}`).OK)

		waitUntil(t, budget(t, statusDeadline), func() bool {
			return s.plant.count(s.topics.StatusSim()) > before &&
				s.simStatusNow(t).Speed == 1200
		}, "the retained simulator status to follow the change")
		t.Logf("the retained status followed the change in %s", time.Since(changed))
	})

	t.Run("the replay runs at the speed it was given", func(t *testing.T) {
		require.True(t, s.command("set_speed", `{"speed":`+itoa(controlSpeed)+`}`).OK)
		require.True(t, s.command("play", `{}`).OK)
		s.plant.await(t, s.topics.Telemetry(), 1, budget(t, deliveryBudget))

		rate := s.publishRate(t, budget(t, rateWindow))
		t.Logf("at %d× the stack published %.0f samples/s", controlSpeed, rate)
		assert.GreaterOrEqual(t, rate, minControlRate)
		assert.LessOrEqual(t, rate, maxControlRate)
	})

	t.Run("set_speed changes the rate at once", func(t *testing.T) {
		require.True(t, s.command("set_speed", `{"speed":`+itoa(sim.MaxSpeed)+`}`).OK)

		window := budget(t, speedChangeWindow)
		rate := s.publishRate(t, window)
		t.Logf("%s after the command the stack published %.0f samples/s", window, rate)
		assert.Greaterf(t, rate, 2*maxControlRate,
			"the rate did not rise within %s of set_speed", window)
	})

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// itoa renders a replay speed for a command payload.
func itoa(speed uint16) string {
	return strconv.FormatUint(uint64(speed), 10)
}
