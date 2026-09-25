// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Scenario C: an injection changes the telemetry, the ground-truth tree says
// so, and nothing a diagnosing reader can subscribe to ever mentions it
// (ground-truth isolation).
//
// The second test is the alarm half of the same scenario: the oil-temperature
// warning of the manual's registry is looked up in the generated table by its
// trigger rather than by its code, an injection large enough to cross its
// setting is started, and the code has to appear on the wire after the
// trigger's delay and vanish once the injection is cleared.

package e2e

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// offsetTolerance is how far a published value may sit from the recorded one
// plus the overlay. The analog registers hold hundredths of a degree, so two
// of them cover the encoding and its rounding.
const offsetTolerance = 0.02

// alarmBudget bounds the wait for an alarm the recording has to produce: the
// day fixture holds forty running stretches longer than the trigger's delay,
// but they are minutes of simulated time apart.
const alarmBudget = 45 * time.Second

// groundTruthWords are the substrings no message under plant/ and no health
// body may contain while an injection runs.
var groundTruthWords = []string{"inject", "fault_id", "instance_id", "preset", "gt/"}

// injectionEvent is a `gt-injection` start or stop.
type injectionEvent struct {
	Event       string `json:"event"`
	InstanceID  string `json:"instance_id"`
	InjectionID string `json:"injection_id"`
	FaultID     string `json:"fault_id"`
	SimTS       string `json:"sim_ts"`
	EndsSimTS   string `json:"ends_sim_ts"`
	Reason      string `json:"reason"`
	Params      struct {
		Magnitude      float64 `json:"magnitude"`
		DurationSimMin int     `json:"duration_sim_min"`
	} `json:"params"`
}

// activeList is the retained `gt-injection-active` document.
type activeList struct {
	Active []struct {
		InstanceID   string `json:"instance_id"`
		InjectionID  string `json:"injection_id"`
		FaultID      string `json:"fault_id"`
		StartedSimTS string `json:"started_sim_ts"`
	} `json:"active"`
}

// injectionsAfter waits for n more events on gt/<unit>/injection than the
// count taken before a command and returns them, newest last.
func (s *stack) injectionsAfter(t *testing.T, before, n int) []injectionEvent {
	t.Helper()

	got := s.gt.await(t, s.topics.GtInjection(), before+n, budget(t, deliveryBudget))[before:]
	out := make([]injectionEvent, 0, len(got))
	for _, m := range got {
		var ev injectionEvent
		require.NoError(t, json.Unmarshal(m.payload, &ev), "decoding an injection event: %s", m.payload)
		schematest.Validate(t, "gt-injection", m.payload)
		out = append(out, ev)
	}
	return out
}

// activeNow returns the retained active list as it stands, once it holds want
// instances.
func (s *stack) activeNow(t *testing.T, want int) activeList {
	t.Helper()

	var list activeList
	waitFor(t, func() bool {
		messages := s.gt.on(s.topics.GtInjectionActive())
		if len(messages) == 0 {
			return false
		}
		list = activeList{}
		if json.Unmarshal(messages[len(messages)-1].payload, &list) != nil {
			return false
		}
		return len(list.Active) == want
	}, fmt.Sprintf("the retained active list to hold %d instance(s)", want))

	schematest.Validate(t, "gt-injection-active", s.gt.last(t, s.topics.GtInjectionActive()))
	return list
}

// sampleAtOrAfter waits for a published sample whose simulated instant is at
// or after ms and returns it, so an assertion can be made about a point of
// the envelope rather than about a point in wall time.
func (s *stack) sampleAtOrAfter(t *testing.T, ms uint64, within time.Duration, what string) telemetrySample {
	t.Helper()

	var found telemetrySample
	waitUntil(t, within, func() bool {
		for _, sample := range s.samples(t) {
			if sample.SimTsMs >= ms {
				found = sample
				return true
			}
		}
		return false
	}, what)
	return found
}

// definition returns one injection definition of the catalog the machine
// loaded.
func (s *stack) definition(t *testing.T, injectionID string) *injection.Definition {
	t.Helper()

	def, ok := s.catalog.Definition(injectionID)
	require.Truef(t, ok, "the catalog offers no injection %q", injectionID)
	return def
}

// offsetOn returns the amount the definition's offset transform adds to one
// tag at magnitude one, read from the catalog rather than written down here.
func offsetOn(t *testing.T, def *injection.Definition, tag string) float64 {
	t.Helper()

	for _, transform := range def.Transforms {
		if transform.Tag == tag && transform.Op == injection.OpOffset {
			return transform.Value.Float()
		}
	}
	t.Fatalf("%s has no offset on %q", def.InjectionID, tag)
	return 0
}

// rampInMs is the definition's ramp in simulated milliseconds.
func rampInMs(def *injection.Definition) uint64 {
	return uint64(def.Envelope.RampInMin) * 60_000
}

// assertNoGroundTruth fails with the offending word and the payload. allow
// names the words this particular message is permitted to carry — only the
// acknowledgement of a successful `inject` has one, the instance it started.
func assertNoGroundTruth(t *testing.T, what string, payload []byte, allow ...string) {
	t.Helper()

	lower := strings.ToLower(string(payload))
	for _, word := range groundTruthWords {
		if slices.Contains(allow, word) {
			continue
		}
		assert.NotContainsf(t, lower, word,
			"%s carries the ground-truth word %q: %s", what, word, payload)
	}
}

func TestScenarioCInjectionsAndIsolation(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{})

	oil := s.definition(t, oilInjection)
	ambient := s.definition(t, ambientInjection)
	oilOffset := offsetOn(t, oil, "oil_temperature")
	ambientOffset := offsetOn(t, ambient, "ambient_temperature")

	require.True(t, s.command("play", `{}`).OK)
	s.plant.await(t, s.topics.Telemetry(), 1, budget(t, deliveryBudget))

	events := s.gt.count(s.topics.GtInjection())
	started := s.command("inject", `{"injection_id":"`+oilInjection+`"}`)
	require.True(t, started.OK, "inject was refused: %s", started.raw)
	require.NotEmpty(t, started.InstanceID, "a started instance is named in its acknowledgement")

	event := s.injectionsAfter(t, events, 1)[0]
	startedAt, err := mqttio.ParseTS(event.SimTS)
	require.NoError(t, err)

	t.Run("the ground truth reports the instance that started", func(t *testing.T) {
		magnitude, ok := oil.Param(injection.MagnitudeParam)
		require.True(t, ok)

		assert.Equal(t, "start", event.Event)
		assert.Equal(t, oilInjection, event.InjectionID)
		assert.Equal(t, oil.FaultID, event.FaultID)
		assert.Equal(t, started.InstanceID, event.InstanceID)
		assert.Equal(t, magnitude.Default, event.Params.Magnitude, "the default magnitude was used")

		list := s.activeNow(t, 1)
		assert.Equal(t, started.InstanceID, list.Active[0].InstanceID)
		assert.Equal(t, oilInjection, list.Active[0].InjectionID)
	})

	t.Run("the oil temperature rises to the overlay over the ramp", func(t *testing.T) {
		// One sample past the end of the ramp, where the envelope is at one
		// and the published value is the recorded one plus the whole offset.
		full := s.sampleAtOrAfter(t, startedAt+rampInMs(oil), budget(t, alarmBudget),
			"a sample past the end of the oil overlay's ramp")
		recorded, ok := s.fixture.at("oil_temperature", full.SimTsMs)
		require.Truef(t, ok, "the slice has a row at %s", full.SimTS)
		assert.InDeltaf(t, recorded+oilOffset, full.analog(t, "oil_temperature"), offsetTolerance,
			"sample %d at %s: recorded %.3f, overlay +%.1f", full.Seq, full.SimTS, recorded, oilOffset)

		// Halfway through the ramp the overlay is partial, which is what
		// makes it a ramp rather than a step.
		half := s.samples(t)
		var seen bool
		for _, sample := range half {
			if sample.SimTsMs <= startedAt || sample.SimTsMs >= startedAt+rampInMs(oil) {
				continue
			}
			recorded, ok := s.fixture.at("oil_temperature", sample.SimTsMs)
			require.True(t, ok)
			delta := sample.analog(t, "oil_temperature") - recorded
			assert.GreaterOrEqualf(t, delta, -offsetTolerance, "sample %d fell below the recording", sample.Seq)
			assert.LessOrEqualf(t, delta, oilOffset+offsetTolerance,
				"sample %d overshot the overlay", sample.Seq)
			seen = true
		}
		assert.True(t, seen, "the ramp was observed on the wire")
	})

	t.Run("a second injection runs beside the first", func(t *testing.T) {
		events := s.gt.count(s.topics.GtInjection())
		second := s.command("inject", `{"injection_id":"`+ambientInjection+`"}`)
		require.True(t, second.OK, "inject was refused: %s", second.raw)

		event := s.injectionsAfter(t, events, 1)[0]
		assert.Equal(t, "start", event.Event)
		assert.Equal(t, ambientInjection, event.InjectionID)
		require.Len(t, s.activeNow(t, 2).Active, 2)

		at, err := mqttio.ParseTS(event.SimTS)
		require.NoError(t, err)
		full := s.sampleAtOrAfter(t, at+rampInMs(ambient), budget(t, alarmBudget),
			"a sample past the end of the ambient overlay's ramp")
		assert.InDeltaf(t, sim.Ambient(full.SimTsMs)+ambientOffset,
			full.analog(t, "ambient_temperature"), offsetTolerance,
			"sample %d at %s: the room is the model plus +%.1f", full.Seq, full.SimTS, ambientOffset)
	})

	t.Run("clear_injections ends both and empties the list", func(t *testing.T) {
		events := s.gt.count(s.topics.GtInjection())
		cleared := s.command("clear_injections", `{}`)
		require.True(t, cleared.OK, "clear_injections was refused: %s", cleared.raw)

		stops := s.injectionsAfter(t, events, 2)
		ended := map[string]string{}
		for _, event := range stops {
			assert.Equal(t, "stop", event.Event)
			assert.Equal(t, string(injection.ReasonCleared), event.Reason)
			ended[event.InjectionID] = event.Reason
		}
		assert.Len(t, ended, 2, "both instances were reported: %v", ended)
		assert.Empty(t, s.activeNow(t, 0).Active)
	})

	t.Run("nothing a diagnosing reader can subscribe to mentions the overlay", func(t *testing.T) {
		plant := s.plant.under(mqttio.PlantRoot + "/")
		require.NotEmpty(t, plant, "there is something to search")

		telemetry, status := false, false
		for _, m := range plant {
			// The acknowledgement of a successful `inject` is the one message
			// that names an instance, and the committed ACL keeps
			// plant/<unit>/control/# away from this subscriber anyway.
			allow := []string(nil)
			if m.topic == s.topics.ControlAck() {
				allow = []string{"instance_id"}
			}
			assertNoGroundTruth(t, m.topic, m.payload, allow...)
			switch m.topic {
			case s.topics.Telemetry():
				telemetry = true
			case s.topics.StatusSim(), s.topics.StatusGateway():
				status = true
			}
		}
		assert.True(t, telemetry, "telemetry was searched")
		assert.True(t, status, "a status document was searched")

		for _, url := range []string{
			"http://" + s.health.Addr() + sim.HealthPath,
			"http://" + s.health.Addr() + sim.StatusPath,
			s.gatewayURL + gateway.HealthPath,
		} {
			assertNoGroundTruth(t, url, healthBody(t, url))
		}

		// The positive control: the same run did publish the instances, under
		// the root only the ground-truth readers may subscribe to.
		first := s.gt.on(s.topics.GtInjection())
		require.NotEmpty(t, first, "the ground truth was published somewhere")
		assert.Contains(t, string(first[0].payload), "instance_id", "gt/ is where it lives")
		assert.Contains(t, string(first[0].payload), "fault_id")
	})

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// oilTemperatureWarning returns the threshold alarm of the generated table
// whose trigger watches the oil temperature with a reset band: the manual's
// W104, found by what it does rather than by its code, so a renumbered
// registry moves the assertion with it. The two other oil-temperature
// thresholds — the shutdown warning and the shutdown — have no hysteresis.
func oilTemperatureWarning(t *testing.T) regmap.Alarm {
	t.Helper()

	var found []regmap.Alarm
	for _, alarm := range regmap.Alarms {
		trigger := alarm.Trigger
		if trigger.Kind == "threshold" && trigger.Signal == "oil_temperature" &&
			trigger.Op == "gt" && trigger.When == "running" && trigger.Hysteresis > 0 {
			found = append(found, alarm)
		}
	}
	require.Lenf(t, found, 1,
		"exactly one threshold alarm watches the oil temperature with a reset band: %v", found)
	return found[0]
}

func TestScenarioCAlarmBitsFollowTheOilTemperatureInjection(t *testing.T) {
	url, committed := startBroker(t)
	s := newStack(t, url, committed, stackOpts{})

	alarm := oilTemperatureWarning(t)
	trigger := alarm.Trigger
	t.Logf("the oil-temperature warning of the generated table is %s (bit %d): %s > %.1f for %d s while %s",
		alarm.Code, alarm.Bit, trigger.Signal, trigger.Threshold, trigger.DelayS, trigger.When)

	oil := s.definition(t, oilInjection)
	magnitude, ok := oil.Param(injection.MagnitudeParam)
	require.True(t, ok, "%s is tunable", oilInjection)
	require.Greaterf(t, magnitude.Max*offsetOn(t, oil, "oil_temperature"),
		trigger.Threshold-highestRecordedOil(t, s.fixture),
		"the strongest overlay the catalog allows can carry the recording over the alarm's setting")

	require.True(t, s.command("play", `{}`).OK)
	events := s.gt.count(s.topics.GtInjection())
	started := s.command("inject",
		fmt.Sprintf(`{"injection_id":"%s","params":{"magnitude":%g}}`, oilInjection, magnitude.Max))
	require.True(t, started.OK, "inject was refused: %s", started.raw)

	// The instant the engine applied the command at, which is where the
	// trigger's delay starts counting from.
	startedAt, err := mqttio.ParseTS(s.injectionsAfter(t, events, 1)[0].SimTS)
	require.NoError(t, err)

	var raised telemetrySample
	waitUntil(t, budget(t, alarmBudget), func() bool {
		for _, sample := range s.samples(t) {
			if slices.Contains(sample.Alarms, alarm.Code) {
				raised = sample
				return true
			}
		}
		return false
	}, "the oil-temperature warning to reach the wire")

	t.Logf("%s was raised on sample %d at %s", alarm.Code, raised.Seq, raised.SimTS)
	assert.GreaterOrEqualf(t, raised.SimTsMs, startedAt+uint64(trigger.DelayS)*1000,
		"%s was raised before its %d s delay had run", alarm.Code, trigger.DelayS)

	cleared := s.command("clear_injections", `{}`)
	require.True(t, cleared.OK, "clear_injections was refused: %s", cleared.raw)
	clearedAt, err := mqttio.ParseTS(cleared.status(t).SimTS)
	require.NoError(t, err)

	// Every sample the machine emitted after the command was evaluated
	// without the overlay, and the recording alone never reaches the setting.
	waitFor(t, func() bool { return len(s.samplesAfter(t, clearedAt)) >= 30 },
		"the machine to emit again without the overlay")
	after := s.samplesAfter(t, clearedAt)
	for _, sample := range after {
		require.NotContainsf(t, sample.Alarms, alarm.Code,
			"sample %d at %s still carries %s after the injection was cleared",
			sample.Seq, sample.SimTS, alarm.Code)
	}
	t.Logf("%s was gone from the %d samples emitted after the clear", alarm.Code, len(after))

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// samplesAfter returns the published samples whose simulated instant is
// strictly after ms.
func (s *stack) samplesAfter(t *testing.T, ms uint64) []telemetrySample {
	t.Helper()

	var out []telemetrySample
	for _, sample := range s.samples(t) {
		if sample.SimTsMs > ms {
			out = append(out, sample)
		}
	}
	return out
}

// highestRecordedOil returns the warmest oil temperature in the slice, which
// is what an overlay has to lift over the alarm's setting.
func highestRecordedOil(t *testing.T, f *fixture) float64 {
	t.Helper()

	values, ok := f.analog["oil_temperature"]
	require.Truef(t, ok, "%s carries an oil temperature column", f.path)

	highest := values[0]
	for _, value := range values {
		highest = max(highest, value)
	}
	return highest
}
