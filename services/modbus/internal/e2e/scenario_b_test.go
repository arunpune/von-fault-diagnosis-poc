// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Scenario B: the seven control commands over the broker, against the stack
// they drive.
//
// It asserts what the race detector must see — a paused machine is silent,
// `pause` stops the stream, a jump lands where the recording has a row and the
// sample after it carries `discontinuity`, `reset` returns to the first row,
// and an unknown command is refused with `unknown_cmd`. The rate windows and
// the 100 ms acknowledgement budget are in timing_test.go.

package e2e

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// pausedWindow is how long a paused machine is watched for a sample it must
// not publish.
const pausedWindow = time.Second

// marker is a `gt-marker` message.
type marker struct {
	Kind      string `json:"kind"`
	SimTSFrom string `json:"sim_ts_from"`
	SimTSTo   string `json:"sim_ts_to"`
	PresetID  string `json:"preset_id"`
}

// markerAfter waits for one more marker than the count taken before a command
// and returns it.
func (s *stack) markerAfter(t *testing.T, before int) marker {
	t.Helper()

	got := s.gt.await(t, s.topics.GtMarker(), before+1, budget(t, deliveryBudget))[before]
	var m marker
	require.NoError(t, json.Unmarshal(got.payload, &m), "decoding a marker: %s", got.payload)
	schematest.Validate(t, "gt-marker", got.payload)
	return m
}

// quiesce pauses the machine and waits until every sample it had already
// written has reached the subscriber, then reports how many samples that is.
// A command issued afterwards owns every sample that arrives from then on,
// which is what makes "the next sample" an exact statement.
func (s *stack) quiesce(t *testing.T) int {
	t.Helper()

	pause := s.command("pause", `{}`)
	require.True(t, pause.OK, "pause was refused: %s", pause.raw)

	waitFor(t, func() bool {
		return s.service.Snapshot().LastSeq == s.engine.Snapshot().HeadSeq
	}, "the gateway to publish what the paused machine had already written")
	waitFor(t, func() bool {
		published := s.publishedSeq(t)
		return len(published) != 0 && published[len(published)-1] == s.service.Snapshot().LastSeq
	}, "the subscriber to receive what the gateway published")
	return len(s.publishedSeq(t))
}

// nextSample waits for one more published sample than the count quiesce
// reported and returns it. It is how a jump is observed from the outside: the
// command re-anchors the replay, and the next slot the gateway publishes is
// the row it landed on.
func (s *stack) nextSample(t *testing.T, before int) telemetrySample {
	t.Helper()

	var found telemetrySample
	waitFor(t, func() bool {
		samples := s.samples(t)
		if len(samples) <= before {
			return false
		}
		found = samples[before]
		return true
	}, "the first sample published after the command")
	return found
}

// firstRowAtOrAfter returns the instant of the first row of the recording at
// or after ms, which is where a seek to ms lands.
func (f *fixture) firstRowAtOrAfter(t *testing.T, ms uint64) uint64 {
	t.Helper()

	for _, instant := range f.timestamps {
		if instant >= ms {
			return instant
		}
	}
	t.Fatalf("%s has no row at or after %d", f.path, ms)
	return 0
}

func TestScenarioBControlCommands(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{speed: controlSpeed})

	t.Run("a machine that was never played publishes nothing", func(t *testing.T) {
		require.Equal(t, "paused", s.simStatusNow(t).State)
		s.plant.expectNothing(t, s.topics.Telemetry(), budget(t, pausedWindow))
	})

	t.Run("play starts the stream and set_speed is accepted", func(t *testing.T) {
		play := s.command("play", `{}`)
		require.True(t, play.OK, "play was refused: %s", play.raw)
		assert.Equal(t, "playing", play.status(t).State)
		assert.Equal(t, uint16(controlSpeed), play.status(t).Speed)

		s.plant.await(t, s.topics.Telemetry(), 1, budget(t, deliveryBudget))

		faster := s.command("set_speed", `{"speed":3600}`)
		require.True(t, faster.OK, "set_speed was refused: %s", faster.raw)
		assert.Equal(t, sim.MaxSpeed, faster.status(t).Speed)
		schematest.Validate(t, "control-ack", faster.raw)
	})

	t.Run("pause stops the stream and the retained status follows", func(t *testing.T) {
		before := s.quiesce(t)
		s.plant.expectNothing(t, s.topics.Telemetry(), budget(t, pausedWindow))
		assert.Len(t, s.samples(t), before, "a paused machine published nothing more")

		waitFor(t, func() bool { return s.simStatusNow(t).State == "paused" },
			"the retained simulator status to report the pause")
	})

	t.Run("a jump to a preset lands on the recording's own row", func(t *testing.T) {
		preset, ok := presetByID(s.presets, "fixture_noon")
		require.True(t, ok, "the fixture presets carry a jump target inside the first day")
		require.Equal(t, 30, preset.LeadInMin, "the fixture preset's lead-in is 30 minutes (testdata/gt/presets.json)")

		want := s.fixture.firstRowAtOrAfter(t, preset.LeadInStartMs())
		markers, before := s.gt.count(s.topics.GtMarker()), s.quiesce(t)

		jump := s.command("jump", `{"preset_id":"`+preset.PresetID+`"}`)
		require.True(t, jump.OK, "jump was refused: %s", jump.raw)

		m := s.markerAfter(t, markers)
		assert.Equal(t, sim.MarkerJump, m.Kind)
		assert.Equal(t, preset.PresetID, m.PresetID)
		assert.Equal(t, mqttio.SimTS(want), m.SimTSTo,
			"the marker reports the first row at or after the lead-in start")

		require.True(t, s.command("play", `{}`).OK)
		sample := s.nextSample(t, before)
		assert.Equal(t, want, sample.SimTsMs, "the replay resumed at the row the marker named")
		assert.True(t, sample.Flags.Discontinuity, "the first sample after a jump is a discontinuity")
	})

	t.Run("a jump into a hole lands on the first row after it", func(t *testing.T) {
		require.NotEmpty(t, s.fixture.gaps, "the slice has a hole to jump into")
		hole := s.fixture.gaps[len(s.fixture.gaps)-1]
		// Halfway into the hole: an instant the recording never covered.
		inside := hole[0] + (hole[1]-hole[0])/2
		markers, before := s.gt.count(s.topics.GtMarker()), s.quiesce(t)

		jump := s.command("jump", `{"sim_ts":"`+mqttio.SimTS(inside)+`"}`)
		require.True(t, jump.OK, "jump was refused: %s", jump.raw)

		m := s.markerAfter(t, markers)
		assert.Equal(t, sim.MarkerJump, m.Kind)
		assert.Equal(t, mqttio.SimTS(hole[1]), m.SimTSTo,
			"a jump inside the hole lands on the first row after it")

		require.True(t, s.command("play", `{}`).OK)
		sample := s.nextSample(t, before)
		assert.Equal(t, hole[1], sample.SimTsMs)
		assert.True(t, sample.Flags.Discontinuity)
	})

	t.Run("reset returns to the first row and pauses", func(t *testing.T) {
		markers, before := s.gt.count(s.topics.GtMarker()), s.quiesce(t)

		reset := s.command("reset", `{}`)
		require.True(t, reset.OK, "reset was refused: %s", reset.raw)
		assert.Equal(t, "paused", reset.status(t).State)
		assert.Equal(t, uint16(controlSpeed), reset.status(t).Speed,
			"reset returns the machine to the speed it booted at")

		m := s.markerAfter(t, markers)
		assert.Equal(t, sim.MarkerReset, m.Kind)
		assert.Equal(t, mqttio.SimTS(s.fixture.firstMs()), m.SimTSTo)

		waitFor(t, func() bool { return s.simStatusNow(t).State == "paused" },
			"the retained simulator status to report the reset")

		require.True(t, s.command("play", `{}`).OK)
		sample := s.nextSample(t, before)
		assert.Equal(t, s.fixture.firstMs(), sample.SimTsMs,
			"the first sample after a reset is the first row of the recording")
		assert.True(t, sample.Flags.Discontinuity)
	})

	t.Run("an unknown command is refused by name", func(t *testing.T) {
		unknown := s.command("rewind", `{}`)
		assert.False(t, unknown.OK)
		require.NotNil(t, unknown.Error, "a refusal carries an error: %s", unknown.raw)
		assert.Equal(t, "unknown_cmd", unknown.Error.Code)
		assert.Equal(t, "rewind", unknown.Cmd,
			"the simulator echoes what it read, so the caller can see it")
	})

	t.Run("a refused argument keeps the machine as it was", func(t *testing.T) {
		speed := s.simStatusNow(t).Speed
		refused := s.command("set_speed", `{"speed":0}`)
		assert.False(t, refused.OK)
		require.NotNil(t, refused.Error, "a refusal carries an error: %s", refused.raw)
		assert.Equal(t, "speed_out_of_range", refused.Error.Code)
		assert.Equal(t, speed, refused.status(t).Speed)
		schematest.Validate(t, "control-ack", refused.raw)
	})

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// TestScenarioBLoopWrapReturnsToTheFirstRow closes the last clause of the
// discontinuity rule: `discontinuity` is also true on the sample after a wrap
// from the end of the recording back to its start, and the wrap announces
// itself on the ground-truth tree.
//
// It needs a machine configured to loop, which is not the one the scenario
// above drives, so it runs on its own.
func TestScenarioBLoopWrapReturnsToTheFirstRow(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{loop: true})

	// The last row of the recording: the wrap is then one sample away.
	last := s.fixture.timestamps[s.fixture.rows()-1]
	markers, before := s.gt.count(s.topics.GtMarker()), len(s.samples(t))

	jump := s.command("jump", `{"sim_ts":"`+mqttio.SimTS(last)+`"}`)
	require.True(t, jump.OK, "jump was refused: %s", jump.raw)
	assert.Equal(t, sim.MarkerJump, s.markerAfter(t, markers).Kind)

	require.True(t, s.command("play", `{}`).OK)

	wrap := s.markerAfter(t, markers+1)
	assert.Equal(t, sim.MarkerLoop, wrap.Kind)
	assert.Equal(t, mqttio.SimTS(last), wrap.SimTSFrom, "the wrap left the last row")
	assert.Equal(t, mqttio.SimTS(s.fixture.firstMs()), wrap.SimTSTo, "and landed on the first")

	landed := s.nextSample(t, before)
	assert.Equal(t, last, landed.SimTsMs, "the jump published the last row first")
	assert.True(t, landed.Flags.Discontinuity)

	wrapped := s.nextSample(t, before+1)
	assert.Equal(t, s.fixture.firstMs(), wrapped.SimTsMs,
		"the sample after the wrap is the first row of the recording again")
	assert.True(t, wrapped.Flags.Discontinuity, "a loop wrap is a discontinuity")

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// presetByID finds one preset by identifier.
func presetByID(presets []sim.Preset, id string) (sim.Preset, bool) {
	for _, preset := range presets {
		if preset.PresetID == id {
			return preset, true
		}
	}
	return sim.Preset{}, false
}
