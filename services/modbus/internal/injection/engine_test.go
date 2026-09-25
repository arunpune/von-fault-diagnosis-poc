// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection_test

import (
	"math"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// t0 is the instant the synthetic instances start at, and minute turns a
// count of simulated minutes into the millisecond offsets the engine works
// in.
const t0 uint64 = 1_580_515_200_000

func minute(n uint64) uint64 { return n * 60_000 }

// Slot positions of the generated register map, so an assertion can name the
// tag it means.
const (
	dischargePressure = 0
	linePressure      = 1
	separatorPressure = 2
	dryerPurge        = 3
	reservoirPressure = 4
	oilTemperature    = 5
	motorCurrent      = 6
	ambient           = 7

	dryerTower  = 2
	purgeSwitch = 5
)

// sample is one row of readings a healthy unit could have produced, with the
// synthetic ambient extra appended to the analog slice the way the simulator
// does before it calls Apply.
func sample() *injection.Values {
	return &injection.Values{
		Analog:  []float64{8.5, 8.2, 8.2, 0.05, 8.2, 60.0, 5.0, 18.0},
		Digital: make([]bool, 8),
	}
}

// definition returns a definition carrying transforms, with a magnitude
// parameter and an envelope that is at full magnitude from the first sample.
func definition(id string, transforms ...injection.Transform) injection.Definition {
	return injection.Definition{
		InjectionID:           id,
		FaultID:               "oil_cooler_fouled",
		Label:                 "Synthetic " + id,
		Description:           "A definition built by the engine tests.",
		DefaultDurationSimMin: 120,
		Params: []injection.ParamDef{
			{Name: injection.MagnitudeParam, Default: 1, Min: 0.25, Max: 2},
		},
		Transforms: transforms,
	}
}

// engineWith validates the definitions and returns an engine with a fixed
// boot id, so instance ids are the same on every run.
func engineWith(t *testing.T, defs ...injection.Definition) *injection.Engine {
	t.Helper()

	cat := &injection.Catalog{Schema: injection.CatalogSchema, Injections: defs}
	require.NoError(t, cat.Validate(regmap.Signals))
	return injection.NewEngine(regmap.Signals, cat, injection.WithBootID("a1b2c3"))
}

func TestStartResolvesTheDefaultsAndNamesTheInstance(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	first, err := eng.Start("drift", nil, t0)
	require.NoError(t, err)
	assert.Equal(t, "inj-a1b2c3-1", first.InstanceID)
	assert.Equal(t, "drift", first.InjectionID)
	assert.Equal(t, "oil_cooler_fouled", first.FaultID)
	assert.Equal(t, t0, first.StartedSimTsMs)
	assert.Equal(t, t0+minute(120), first.EndsSimTsMs, "the definition's default duration")
	assert.Equal(t, map[string]float64{"magnitude": 1, "duration_sim_min": 120}, first.Info().Params)

	second, err := eng.Start("drift", map[string]float64{"magnitude": 0.5, "duration_sim_min": 30}, t0)
	require.NoError(t, err)
	assert.Equal(t, "inj-a1b2c3-2", second.InstanceID, "the counter never reuses a number")
	assert.Equal(t, t0+minute(30), second.EndsSimTsMs)
	assert.Equal(t, map[string]float64{"magnitude": 0.5, "duration_sim_min": 30}, second.Info().Params)
}

func TestStartRejectsAnInjectionTheCatalogDoesNotOffer(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	_, err := eng.Start("imaginary_fault", nil, t0)
	require.ErrorIs(t, err, injection.ErrUnknownInjection)
	assert.Contains(t, err.Error(), "imaginary_fault")
	assert.Empty(t, eng.Active())
}

func TestStartRejectsParametersOutsideTheirBounds(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	for name, params := range map[string]map[string]float64{
		"an undeclared parameter":          {"severity": 1},
		"a magnitude below the minimum":    {"magnitude": 0.1},
		"a magnitude above the maximum":    {"magnitude": 2.5},
		"a duration below one minute":      {"duration_sim_min": 0},
		"a duration past ten days":         {"duration_sim_min": 14401},
		"a fractional duration":            {"duration_sim_min": 12.5},
		"a magnitude that is not a number": {"magnitude": math.NaN()},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := eng.Start("drift", params, t0)
			require.ErrorIs(t, err, injection.ErrBadArgs)
			assert.Contains(t, err.Error(), "drift")
		})
	}
	assert.Empty(t, eng.Active(), "a rejected command starts nothing")
}

func TestApplyOverlaysOnlyTheTaggedValues(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))
	_, err := eng.Start("drift", nil, t0)
	require.NoError(t, err)

	got, want := sample(), sample()
	eng.Apply(got, machine.StateLoaded, t0)

	want.Analog[oilTemperature] += 14
	assert.Equal(t, want.Analog, got.Analog)
	assert.Equal(t, want.Digital, got.Digital)
	assert.Len(t, got.Analog, 8, "Apply never resizes the slices it is handed")
	assert.Len(t, got.Digital, 8)
}

func TestApplyRespectsTheStateGuard(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("sticking",
		injection.Transform{Tag: "discharge_pressure", Op: injection.OpOffset,
			When: injection.WhenLoaded, Value: injection.Number(-0.22)},
		injection.Transform{Tag: "separator_discharge_pressure", Op: injection.OpOffset,
			When: injection.WhenNotLoaded, Value: injection.Number(-0.8)},
		injection.Transform{Tag: "line_pressure", Op: injection.OpOffset,
			When: injection.WhenOff, Value: injection.Number(-1)}))
	_, err := eng.Start("sticking", nil, t0)
	require.NoError(t, err)

	loaded := sample()
	eng.Apply(loaded, machine.StateLoaded, t0)
	assert.InDelta(t, 8.28, loaded.Analog[dischargePressure], 1e-9)
	assert.InDelta(t, 8.2, loaded.Analog[separatorPressure], 1e-9, "not_loaded does not fire while loaded")
	assert.InDelta(t, 8.2, loaded.Analog[linePressure], 1e-9)

	unloaded := sample()
	eng.Apply(unloaded, machine.StateUnloaded, t0)
	assert.InDelta(t, 8.5, unloaded.Analog[dischargePressure], 1e-9)
	assert.InDelta(t, 7.4, unloaded.Analog[separatorPressure], 1e-9)
	assert.InDelta(t, 8.2, unloaded.Analog[linePressure], 1e-9, "off is narrower than not_loaded")

	off := sample()
	eng.Apply(off, machine.StateOff, t0)
	assert.InDelta(t, 7.4, off.Analog[separatorPressure], 1e-9)
	assert.InDelta(t, 7.2, off.Analog[linePressure], 1e-9)
}

func TestApplyIsInertOutsideTheInstanceWindow(t *testing.T) {
	t.Parallel()

	// stuck ignores the magnitude, so only the window keeps it inside the
	// instance's duration.
	eng := engineWith(t, definition("frozen",
		injection.Transform{Tag: "purge_switch", Op: injection.OpStuck,
			When: injection.WhenAny, Value: injection.Boolean(true)}))
	_, err := eng.Start("frozen", nil, t0)
	require.NoError(t, err)

	before := sample()
	eng.Apply(before, machine.StateLoaded, t0-1)
	assert.False(t, before.Digital[purgeSwitch], "an instance does nothing before its start")

	during := sample()
	eng.Apply(during, machine.StateLoaded, t0+minute(60))
	assert.True(t, during.Digital[purgeSwitch])

	after := sample()
	eng.Apply(after, machine.StateLoaded, t0+minute(120))
	assert.False(t, after.Digital[purgeSwitch], "the end of the window is exclusive")
}

func TestInstancesComposeInCreationOrder(t *testing.T) {
	t.Parallel()

	// The second instance sees what the first wrote: +10 °C then ×2 is 140,
	// not 130.
	eng := engineWith(t,
		definition("warmer", injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(10)}),
		definition("doubled", injection.Transform{Tag: "oil_temperature", Op: injection.OpScale,
			When: injection.WhenAny, Factor: 2}))

	_, err := eng.Start("warmer", nil, t0)
	require.NoError(t, err)
	_, err = eng.Start("doubled", nil, t0)
	require.NoError(t, err)

	v := sample()
	eng.Apply(v, machine.StateLoaded, t0)
	assert.InDelta(t, 140.0, v.Analog[oilTemperature], 1e-9)
}

func TestRampAnchoredAtTheInjectionStartAccumulates(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("leak",
		injection.Transform{Tag: "line_pressure", Op: injection.OpRamp, When: injection.WhenAny,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorInjectionStart}))
	_, err := eng.Start("leak", nil, t0)
	require.NoError(t, err)

	for _, tc := range []struct {
		afterMin uint64
		want     float64
	}{{0, 8.2}, {2, 7.6}, {4, 7.0}, {60, 5.7}} {
		v := sample()
		eng.Apply(v, machine.StateUnloaded, t0+minute(tc.afterMin))
		assert.InDelta(t, tc.want, v.Analog[linePressure], 1e-9, "%d minutes in", tc.afterMin)
	}
}

func TestRampAnchoredAtStateEntryRestartsOnAStateChange(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("leak",
		injection.Transform{Tag: "line_pressure", Op: injection.OpRamp, When: injection.WhenNotLoaded,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorStateEntry}))
	_, err := eng.Start("leak", nil, t0)
	require.NoError(t, err)

	// Four unloaded minutes: the decay reaches 1.2 bar.
	var v *injection.Values
	for m := range uint64(5) {
		v = sample()
		eng.Apply(v, machine.StateUnloaded, t0+minute(m))
	}
	assert.InDelta(t, 7.0, v.Analog[linePressure], 1e-9)

	// The unit loads: the guard blocks the ramp and the state changes.
	v = sample()
	eng.Apply(v, machine.StateLoaded, t0+minute(5))
	assert.InDelta(t, 8.2, v.Analog[linePressure], 1e-9)

	// It unloads again: the ramp starts over from the new state entry.
	v = sample()
	eng.Apply(v, machine.StateUnloaded, t0+minute(6))
	assert.InDelta(t, 8.2, v.Analog[linePressure], 1e-9, "the anchor moved to this sample")

	v = sample()
	eng.Apply(v, machine.StateUnloaded, t0+minute(8))
	assert.InDelta(t, 7.6, v.Analog[linePressure], 1e-9, "two minutes, not eight")
}

func TestRampAnchoredAtGuardEntryRunsThroughTheStatesInsideItsGuard(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("leak",
		injection.Transform{Tag: "line_pressure", Op: injection.OpRamp, When: injection.WhenNotLoaded,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorGuardEntry}))
	_, err := eng.Start("leak", nil, t0)
	require.NoError(t, err)

	step := func(m uint64, state machine.State) float64 {
		v := sample()
		eng.Apply(v, state, t0+minute(m))
		return v.Analog[linePressure]
	}

	// One idle period: two unloaded minutes, then the motor stops. The
	// guard holds throughout, so the ramp keeps counting from the first
	// not-loaded sample instead of stepping back up at the stop.
	assert.InDelta(t, 8.2, step(0, machine.StateUnloaded), 1e-9, "the first sample is the entry")
	assert.InDelta(t, 7.6, step(2, machine.StateUnloaded), 1e-9)
	assert.InDelta(t, 7.3, step(3, machine.StateOff), 1e-9, "unloaded to off stays inside the guard")
	assert.InDelta(t, 6.7, step(5, machine.StateOff), 1e-9)

	// The unit loads: the guard stops holding and the ramp is not applied.
	assert.InDelta(t, 8.2, step(6, machine.StateLoaded), 1e-9)

	// The next idle period is a new entry into the guard.
	assert.InDelta(t, 8.2, step(7, machine.StateUnloaded), 1e-9, "the anchor moved to this sample")
	assert.InDelta(t, 7.6, step(9, machine.StateOff), 1e-9, "two minutes since the entry, not nine")

	// A long idle period is still capped.
	assert.InDelta(t, 5.7, step(30, machine.StateOff), 1e-9)
}

func TestGuardEntryIsTrackedPerTransform(t *testing.T) {
	t.Parallel()

	// Two ramps of one instance under different guards: the not_loaded one
	// counts from the start of the idle period, the off one from the stop.
	eng := engineWith(t, definition("two_guards",
		injection.Transform{Tag: "line_pressure", Op: injection.OpRamp, When: injection.WhenNotLoaded,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorGuardEntry},
		injection.Transform{Tag: "reservoir_pressure", Op: injection.OpRamp, When: injection.WhenOff,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorGuardEntry}))
	_, err := eng.Start("two_guards", nil, t0)
	require.NoError(t, err)

	var v *injection.Values
	for m, state := range []machine.State{
		machine.StateLoaded, machine.StateUnloaded, machine.StateUnloaded,
		machine.StateOff, machine.StateOff, machine.StateOff,
	} {
		v = sample()
		eng.Apply(v, state, t0+minute(uint64(m)))
	}

	// Minute 5: four minutes into the idle period, two into the stop.
	assert.InDelta(t, 8.2-1.2, v.Analog[linePressure], 1e-9)
	assert.InDelta(t, 8.2-0.6, v.Analog[reservoirPressure], 1e-9)
}

func TestGuardEntryRunsThroughARestartInsideTheIdlePeriod(t *testing.T) {
	t.Parallel()

	// The motor may start again and stop without loading: unloaded, off,
	// unloaded, off is still one idle period under not_loaded, so the ramp
	// keeps counting from its first sample. A loaded run ends the period,
	// and the next one is a new entry whichever not-loaded state it starts
	// in, here off straight after the loaded run.
	eng := engineWith(t, definition("leak",
		injection.Transform{Tag: "line_pressure", Op: injection.OpRamp, When: injection.WhenNotLoaded,
			RatePerMin: -0.3, Cap: 2.5, Anchor: injection.AnchorGuardEntry}))
	_, err := eng.Start("leak", nil, t0)
	require.NoError(t, err)

	step := func(m uint64, state machine.State) float64 {
		v := sample()
		eng.Apply(v, state, t0+minute(m))
		return v.Analog[linePressure]
	}

	assert.InDelta(t, 8.2, step(0, machine.StateLoaded), 1e-9)
	assert.InDelta(t, 8.2, step(1, machine.StateUnloaded), 1e-9, "the entry into the guard")
	assert.InDelta(t, 7.9, step(2, machine.StateOff), 1e-9)
	assert.InDelta(t, 7.6, step(3, machine.StateUnloaded), 1e-9,
		"off to unloaded stays inside the guard")
	assert.InDelta(t, 7.3, step(4, machine.StateOff), 1e-9, "and so does the next stop")
	assert.InDelta(t, 8.2, step(5, machine.StateLoaded), 1e-9)
	assert.InDelta(t, 8.2, step(6, machine.StateOff), 1e-9, "loaded to off is an entry too")
	assert.InDelta(t, 7.9, step(7, machine.StateUnloaded), 1e-9, "one minute since that entry")
}

func TestNoiseIsReproducibleAndScalesWithSigma(t *testing.T) {
	t.Parallel()

	deviation := func(sigma float64) float64 {
		eng := engineWith(t, definition("unbalanced",
			injection.Transform{Tag: "motor_current", Op: injection.OpNoise,
				When: injection.WhenLoaded, Sigma: sigma}))
		_, err := eng.Start("unbalanced", nil, t0)
		require.NoError(t, err)

		v := sample()
		eng.Apply(v, machine.StateLoaded, t0+minute(7))
		return v.Analog[motorCurrent] - sample().Analog[motorCurrent]
	}

	first := deviation(0.12)
	require.NotZero(t, first)
	assert.Equal(t, first, deviation(0.12), "the same instance and instant give the same value")
	assert.InDelta(t, 2*first, deviation(0.24), 1e-12, "the deviation scales with sigma")
}

func TestNoiseRedrawsOnEveryInstant(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("unbalanced",
		injection.Transform{Tag: "motor_current", Op: injection.OpNoise,
			When: injection.WhenLoaded, Sigma: 0.12}))
	_, err := eng.Start("unbalanced", nil, t0)
	require.NoError(t, err)

	seen := make([]float64, 0, 10)
	for s := range uint64(10) {
		v := sample()
		eng.Apply(v, machine.StateLoaded, t0+s*10_000)
		seen = append(seen, v.Analog[motorCurrent])
	}
	slices.Sort(seen)
	assert.Len(t, slices.Compact(seen), 10, "ten instants, ten draws")
}

func TestDropoutReportsTheImplausibleReading(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("sensor",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpDropout,
			When: injection.WhenAny, Value: injection.Number(0)},
		injection.Transform{Tag: "dryer_tower", Op: injection.OpDropout,
			When: injection.WhenAny}))
	_, err := eng.Start("sensor", nil, t0)
	require.NoError(t, err)

	v := sample()
	v.Digital[dryerTower] = true
	eng.Apply(v, machine.StateLoaded, t0)
	assert.Zero(t, v.Analog[oilTemperature])
	assert.False(t, v.Digital[dryerTower])
}

func TestExpireStopsTheInstancesWhoseDurationRanOut(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	short, err := eng.Start("drift", map[string]float64{"duration_sim_min": 30}, t0)
	require.NoError(t, err)
	long, err := eng.Start("drift", map[string]float64{"duration_sim_min": 90}, t0)
	require.NoError(t, err)

	assert.Empty(t, eng.Expire(t0+minute(29)))

	stopped := eng.Expire(t0 + minute(30))
	require.Len(t, stopped, 1)
	assert.Equal(t, short.InstanceID, stopped[0].Info.InstanceID)
	assert.Equal(t, injection.ReasonExpired, stopped[0].Reason)

	active := eng.Active()
	require.Len(t, active, 1)
	assert.Equal(t, long.InstanceID, active[0].InstanceID)

	require.Len(t, eng.Expire(t0+minute(90)), 1)
	assert.Empty(t, eng.Active())
	assert.Empty(t, eng.Expire(t0+minute(900)), "an empty engine expires nothing")
}

func TestStopAllCarriesTheReasonAndEmptiesTheEngine(t *testing.T) {
	t.Parallel()

	for _, reason := range []injection.Reason{
		injection.ReasonCleared, injection.ReasonJump, injection.ReasonReset,
	} {
		t.Run(string(reason), func(t *testing.T) {
			t.Parallel()

			eng := engineWith(t, definition("drift",
				injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
					When: injection.WhenAny, Value: injection.Number(14)}))
			first, err := eng.Start("drift", nil, t0)
			require.NoError(t, err)
			second, err := eng.Start("drift", nil, t0+minute(1))
			require.NoError(t, err)

			stopped := eng.StopAll(reason)
			require.Len(t, stopped, 2)
			assert.Equal(t, first.InstanceID, stopped[0].Info.InstanceID)
			assert.Equal(t, second.InstanceID, stopped[1].Info.InstanceID)
			for _, s := range stopped {
				assert.Equal(t, reason, s.Reason)
			}
			assert.Empty(t, eng.Active())
			assert.Empty(t, eng.StopAll(reason))

			v := sample()
			eng.Apply(v, machine.StateLoaded, t0)
			assert.Equal(t, sample().Analog, v.Analog, "a stopped instance overlays nothing")
		})
	}
}

func TestActiveIsSortedByStart(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	late, err := eng.Start("drift", nil, t0+minute(10))
	require.NoError(t, err)
	early, err := eng.Start("drift", nil, t0)
	require.NoError(t, err)
	same, err := eng.Start("drift", nil, t0)
	require.NoError(t, err)

	ids := make([]string, 0, 3)
	for _, info := range eng.Active() {
		ids = append(ids, info.InstanceID)
	}
	assert.Equal(t, []string{early.InstanceID, same.InstanceID, late.InstanceID}, ids,
		"oldest start first, creation order within one instant")
}

func TestEngineExposesItsCatalogAndBootId(t *testing.T) {
	t.Parallel()

	eng := engineWith(t, definition("drift",
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)}))

	assert.Equal(t, "a1b2c3", eng.BootID())
	require.Len(t, eng.Catalog().Injections, 1)

	// The default boot id is six hex characters, so restarts never collide.
	fresh := injection.NewEngine(regmap.Signals, eng.Catalog())
	assert.Len(t, fresh.BootID(), 6)
	assert.Regexp(t, "^[0-9a-f]{6}$", fresh.BootID())
}

func TestApplyToleratesASampleWithoutTheSyntheticExtra(t *testing.T) {
	t.Parallel()

	// A caller that has not appended ambient_temperature yet simply has a
	// shorter analog slice; the overlay on that tag is skipped rather than
	// panicking.
	eng := engineWith(t, definition("warm_room",
		injection.Transform{Tag: "ambient_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(14)},
		injection.Transform{Tag: "oil_temperature", Op: injection.OpOffset,
			When: injection.WhenAny, Value: injection.Number(7)}))
	_, err := eng.Start("warm_room", nil, t0)
	require.NoError(t, err)

	v := sample()
	v.Analog = v.Analog[:ambient]
	eng.Apply(v, machine.StateLoaded, t0)
	assert.Len(t, v.Analog, 7)
	assert.InDelta(t, 67.0, v.Analog[oilTemperature], 1e-9)
}
