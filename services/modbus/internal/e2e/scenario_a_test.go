// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Scenario A: one recorded day through the whole stack at 3600×, read back
// from the broker by the subscriber an operator would use.
//
// It asserts ordering and continuity — every sequence number exactly once and
// in order, the recording's own timestamps, `discontinuity` only where the
// file puts it, no drops — and that every message on the wire validates
// against the contract schemas. The throughput bound is in timing_test.go,
// where the race detector is not slowing the machine down.

package e2e

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// dayBudget bounds one pass over the day fixture. The recording spans 23 h
// 20 min with two holes the replay collapses, which is about twenty seconds
// of wall time at 3600×; sixty leaves room for a slow machine without letting
// a stall pass unnoticed.
const dayBudget = 60 * time.Second

// timestampSamples is how many sequence numbers are compared against the
// file's own timestamps. Every sample is checked for order; two hundred spread
// evenly are checked for identity, which proves the mapping without re-parsing
// the slice seven thousand times.
const timestampSamples = 200

func TestScenarioAThroughputAndOrdering(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{})

	require.Equal(t, dayRows, s.fixture.rows(), "the slice is the whole first recorded day")
	require.Len(t, s.fixture.discontinuities, 3,
		"the boot sample and the two holes of 2020-02-01: %v", s.fixture.discontinuities)

	// The machine boots paused so the gateway can adopt an empty ring; the
	// operator's own command starts it.
	started := time.Now()
	play := s.command("play", `{}`)
	require.True(t, play.OK, "play was refused: %s", play.raw)
	require.Equal(t, "playing", play.status(t).State)

	waitUntil(t, budget(t, dayBudget),
		func() bool { return s.engine.Snapshot().State == sim.StateStopped },
		"the recording to run out")
	elapsed := time.Since(started)

	waitFor(t, func() bool { return s.service.Snapshot().LastSeq == uint32(dayRows) },
		"the gateway to publish the last sample of the day")
	waitFor(t, func() bool { return len(s.publishedSeq(t)) == dayRows },
		"every published sample to reach the subscriber")
	waitFor(t, func() bool { return s.simStatusNow(t).State == "stopped" },
		"the retained simulator status to report the end of the recording")

	samples := s.samples(t)
	require.Len(t, samples, dayRows)

	// Every sequence number, once, in order, from one.
	var previous uint64
	var discontinuities []uint32
	for i, sample := range samples {
		require.Equalf(t, uint32(i+1), sample.Seq, "sample %d of the stream", i)
		require.GreaterOrEqualf(t, sample.SimTsMs, previous,
			"sample %d went back in simulated time", sample.Seq)
		previous = sample.SimTsMs
		if sample.Flags.Discontinuity {
			discontinuities = append(discontinuities, sample.Seq)
		}
		require.Falsef(t, sample.Flags.Missing, "sample %d parsed every field", sample.Seq)
	}

	// The instants are the recording's own, checked on a spread of the run.
	for i := 0; i < len(samples); i += max(1, len(samples)/timestampSamples) {
		require.Equalf(t, s.fixture.timestamps[i], samples[i].SimTsMs,
			"sample %d carries the timestamp of row %d of %s", samples[i].Seq, i+1, s.fixture.path)
	}

	assert.Equal(t, s.fixture.discontinuities, discontinuities,
		"the flag is set on the boot sample and on the first row after each collapsed hole, nowhere else")

	// The gateway's own account of the same run.
	counters := s.service.Snapshot().Counters
	assert.Zero(t, counters.Dropped, "a gateway that keeps up drops nothing")
	assert.Zero(t, counters.ReadErrors, "the device answered every poll")
	assert.Equal(t, uint64(dayRows), s.service.Snapshot().SamplesPublished)

	waitFor(t, func() bool {
		return s.gatewayStatusNow(t).SamplesPublishedTotal == uint64(dayRows)
	}, "the retained heartbeat to report the whole day")
	status := s.gatewayStatusNow(t)
	assert.Zero(t, status.DroppedTotal, "the retained heartbeat agrees that nothing was dropped")
	assert.Equal(t, uint32(dayRows), status.LastSeq)
	assert.True(t, status.MQTTConnected)
	assert.True(t, status.Modbus.Connected)

	// Nothing but reads ever reached the machine: the gateway is read-only.
	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")

	rate := float64(dayRows) / elapsed.Seconds()
	t.Logf("scenario A: %d samples in %s (%.0f samples/s sustained), %d batches, %d drops",
		dayRows, elapsed.Round(time.Millisecond), rate,
		s.service.Snapshot().BatchesPublished, counters.Dropped)

	s.validateEverythingSeen(t)
}

// validateEverythingSeen checks every message type this scenario put on the
// wire against the contract schemas. It is the last thing the test does,
// because a checkout without packages/contracts skips here.
func (s *stack) validateEverythingSeen(t *testing.T) {
	t.Helper()

	telemetry := s.plant.on(s.topics.Telemetry())
	require.NotEmpty(t, telemetry, "there is telemetry to validate")
	for _, m := range telemetry {
		schematest.Validate(t, "telemetry-samples", m.payload)
	}
	schematest.Validate(t, "status-sim", s.plant.last(t, s.topics.StatusSim()))
	schematest.Validate(t, "status-gateway", s.plant.last(t, s.topics.StatusGateway()))
	schematest.Validate(t, "control-ack", s.gt.last(t, s.topics.ControlAck()))
	schematest.Validate(t, "gt-injection-active", s.gt.last(t, s.topics.GtInjectionActive()))
	if s.forwardsRealDocuments {
		schematest.Validate(t, "gt-catalog", s.gt.last(t, s.topics.GtCatalog()))
	}
}
