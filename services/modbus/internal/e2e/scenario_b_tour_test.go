// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The README tour: the steps of the README's five-minute tour that touch the
// simulator are reachable through control commands alone.
//
// Scenario B proves "Play at 600x" and the shape of a preset jump on the
// first recorded day, and scenario C proves "Inject fault -> Oil cooler
// fouling". The tour's jump target is a June failure, which the February
// slice cannot reach, so it is taken here on the slice that carries it.

package e2e

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// tourSlice is the MetroPT-3 slice around the failure the README's "Jump to"
// step names, and tourPreset is the entry of the ground-truth presets that
// takes an operator there.
const (
	tourSlice  = "f3-jun05"
	tourPreset = "f3_air_leak_jun05"
)

func TestScenarioBReadmeTourStepsThroughCommandsAlone(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{slice: tourSlice, speed: controlSpeed})

	preset, ok := presetByID(s.presets, tourPreset)
	require.Truef(t, ok, "the ground truth offers the preset the README names")
	require.Contains(t, preset.Label, "Air leak", "the preset is the tour's own entry")

	// "Play at 600x from February 2020" is the speed the machine boots at
	// here; the tour's own recording is whichever slice is mounted.
	require.Equal(t, uint16(controlSpeed), s.simStatusNow(t).Speed)

	// "Jump to -> Air leak - 5 Jun 2020": the lead-in puts the operator four
	// hours before the failure, on the first row the recording has there.
	want := s.fixture.firstRowAtOrAfter(t, preset.LeadInStartMs())
	markers, before := s.gt.count(s.topics.GtMarker()), len(s.samples(t))

	jump := s.command("jump", `{"preset_id":"`+preset.PresetID+`"}`)
	require.True(t, jump.OK, "jump was refused: %s", jump.raw)

	m := s.markerAfter(t, markers)
	assert.Equal(t, sim.MarkerJump, m.Kind)
	assert.Equal(t, preset.PresetID, m.PresetID)
	assert.Equal(t, mqttio.SimTS(want), m.SimTSTo)

	require.True(t, s.command("play", `{}`).OK)
	sample := s.nextSample(t, before)
	assert.Equal(t, want, sample.SimTsMs, "the replay resumed at the lead-in row")
	assert.True(t, sample.Flags.Discontinuity)

	// "Inject fault -> Oil cooler fouling", from where the jump left the
	// operator.
	events := s.gt.count(s.topics.GtInjection())
	started := s.command("inject", `{"injection_id":"`+oilInjection+`"}`)
	require.True(t, started.OK, "inject was refused: %s", started.raw)
	require.NotEmpty(t, started.InstanceID)

	event := s.injectionsAfter(t, events, 1)[0]
	assert.Equal(t, "start", event.Event)
	assert.Equal(t, oilInjection, event.InjectionID)
	require.Len(t, s.activeNow(t, 1).Active, 1)

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}
