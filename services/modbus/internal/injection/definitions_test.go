// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// This file checks the nine injection types of docs/simulation.md against the
// signal moves its table promises, by replaying a synthetic stream twice —
// once plain and once with the injection running — and reading the difference.
// It is what keeps the numbers in packages/ground-truth/data/injections.json
// honest: a definition whose transforms no longer move the tags the table
// names fails here.

// sampleEveryMs is the source cadence of MetroPT-3, ten seconds.
const sampleEveryMs uint64 = 10_000

// samplesPerMinute is how many rows one simulated minute of the stream holds.
const samplesPerMinute = 6

// frame is one overlaid row of the synthetic stream.
type frame struct {
	simTsMs uint64
	state   machine.State
	values  *injection.Values
}

// play replays minutes simulated minutes from t0, alternating one minute
// loaded and one minute not loaded and toggling the dryer tower every minute,
// and returns the rows after the engine has had them. When injectionID is
// empty no instance runs, which gives the baseline to compare against.
func play(t *testing.T, cat *injection.Catalog, injectionID string, minutes int) []frame {
	t.Helper()

	eng := injection.NewEngine(regmap.Signals, cat, injection.WithBootID("a1b2c3"))
	if injectionID != "" {
		_, err := eng.Start(injectionID, nil, t0)
		require.NoError(t, err)
	}

	frames := make([]frame, 0, minutes*samplesPerMinute)
	for i := range minutes * samplesPerMinute {
		simTsMs := t0 + uint64(i)*sampleEveryMs
		state := machine.StateUnloaded
		if (i/samplesPerMinute)%2 == 0 {
			state = machine.StateLoaded
		}

		values := sample()
		values.Digital[dryerTower] = (i/samplesPerMinute)%2 == 1

		eng.Apply(values, state, simTsMs)
		frames = append(frames, frame{simTsMs: simTsMs, state: state, values: values})
	}
	return frames
}

// holdFrames replays both streams far enough for the envelope to reach its
// hold and returns the last loaded and the last not-loaded row of each. The
// stream runs to ramp_in + 4 minutes, so the chosen rows sit at full
// magnitude, fifty seconds into their state, with the run before them
// watched from its start.
func holdFrames(t *testing.T, cat *injection.Catalog, def injection.Definition) (loaded, notLoaded [2]frame) {
	t.Helper()

	minutes := def.Envelope.RampInMin + 4
	require.Less(t, minutes, def.DefaultDurationSimMin-def.Envelope.RampOutMin,
		"%s: the chosen rows must sit in the hold", def.InjectionID)

	base := play(t, cat, "", minutes)
	with := play(t, cat, def.InjectionID, minutes)

	atLoaded := (def.Envelope.RampInMin+3)*samplesPerMinute - 1
	atNotLoaded := (def.Envelope.RampInMin+4)*samplesPerMinute - 1
	require.Equal(t, machine.StateLoaded, base[atLoaded].state)
	require.Equal(t, machine.StateUnloaded, base[atNotLoaded].state)

	return [2]frame{base[atLoaded], with[atLoaded]}, [2]frame{base[atNotLoaded], with[atNotLoaded]}
}

// analogDelta is how far the injection moved one analog tag.
func analogDelta(f [2]frame, pos int) float64 {
	return f[1].values.Analog[pos] - f[0].values.Analog[pos]
}

func TestTheNineDefinitionsMoveTheDocumentedSignals(t *testing.T) {
	t.Parallel()

	cat := loadCatalog(t)

	// decayPerRun is how far a −rate·min ramp anchored at the entry of its
	// not_loaded guard has drifted fifty seconds into a not-loaded run, which
	// is where holdFrames reads it: the stream alternates loaded and unloaded
	// minutes, so every not-loaded run is a whole idle period.
	decayPerRun := func(ratePerMin float64) float64 { return ratePerMin * 50 / 60 }

	checks := map[string]func(t *testing.T, loaded, notLoaded [2]frame){
		"oil_cooler_fouling": func(t *testing.T, loaded, notLoaded [2]frame) {
			// Oil up by the full offset in every state, nothing else moves —
			// the discriminator against a warm room is that ambient holds.
			assert.InDelta(t, 14, analogDelta(loaded, oilTemperature), 1e-9)
			assert.InDelta(t, 14, analogDelta(notLoaded, oilTemperature), 1e-9)
			assert.Zero(t, analogDelta(loaded, ambient))
		},
		"high_ambient_temperature": func(t *testing.T, loaded, notLoaded [2]frame) {
			// Oil high *with* ambient high: the benign explanation.
			assert.InDelta(t, 14, analogDelta(loaded, ambient), 1e-9)
			assert.InDelta(t, 7, analogDelta(loaded, oilTemperature), 1e-9)
			assert.InDelta(t, 7, analogDelta(notLoaded, oilTemperature), 1e-9)
		},
		"heavy_air_demand": func(t *testing.T, loaded, notLoaded [2]frame) {
			// A faster non-loaded decay on the three pressures, slightly more
			// current while loaded, and no leak-sized drop. The oil is left
			// alone in every state: the manual's high_air_demand warms it only
			// as a consequence of the long loaded runs, which a replay cannot
			// produce.
			for _, pos := range []int{linePressure, separatorPressure, reservoirPressure} {
				assert.InDelta(t, decayPerRun(-0.12), analogDelta(notLoaded, pos), 1e-9)
				assert.Zero(t, analogDelta(loaded, pos), "the decay is a not-loaded move")
			}
			assert.InDelta(t, 5*0.04, analogDelta(loaded, motorCurrent), 1e-9)
			assert.Zero(t, analogDelta(notLoaded, motorCurrent))
			assert.Zero(t, analogDelta(loaded, oilTemperature), "heavy demand has no oil move")
			assert.Zero(t, analogDelta(notLoaded, oilTemperature), "heavy demand has no oil move")
		},
		"air_leak_downstream": func(t *testing.T, loaded, notLoaded [2]frame) {
			// The same shape as heavy demand but two and a half times as
			// steep: the idle decay, the manual's earliest sign of a network
			// leak, is the discriminator. A replay cannot lengthen the loaded
			// runs that would warm the oil, so the definition leaves the oil
			// alone in every state.
			for _, pos := range []int{linePressure, separatorPressure, reservoirPressure} {
				assert.InDelta(t, decayPerRun(-0.3), analogDelta(notLoaded, pos), 1e-9)
				assert.Zero(t, analogDelta(loaded, pos), "the decay is a not-loaded move")
			}
			assert.Less(t, analogDelta(notLoaded, linePressure), decayPerRun(-0.12),
				"a leak decays faster than heavy demand")
			assert.Zero(t, analogDelta(loaded, oilTemperature), "the leak has no oil move")
			assert.Zero(t, analogDelta(notLoaded, oilTemperature), "the leak has no oil move")
			assert.Zero(t, analogDelta(loaded, motorCurrent), "a leak does not load the motor")
		},
		"intake_valve_sticking": func(t *testing.T, loaded, notLoaded [2]frame) {
			// Less delivered while loaded and less current with it; nothing
			// while the unit is not compressing.
			assert.InDelta(t, -0.22, analogDelta(loaded, dischargePressure), 1e-9)
			assert.InDelta(t, -5*0.14, analogDelta(loaded, motorCurrent), 1e-9)
			assert.Zero(t, analogDelta(notLoaded, dischargePressure))
			assert.Zero(t, analogDelta(notLoaded, motorCurrent))
		},
		"dryer_tower_switching_failure": func(t *testing.T, loaded, notLoaded [2]frame) {
			// The minute-long low run of the tower signal disappears, the
			// purge contact is frozen closed and the purge line sits a little
			// higher while loaded — below the 0.5 bar drain-leak rule.
			assert.False(t, loaded[0].values.Digital[dryerTower], "the baseline run is low")
			assert.True(t, loaded[1].values.Digital[dryerTower], "the low run is suppressed")
			assert.True(t, loaded[1].values.Digital[purgeSwitch])
			assert.True(t, notLoaded[1].values.Digital[purgeSwitch])
			assert.InDelta(t, 0.25, analogDelta(loaded, dryerPurge), 1e-9)
			assert.Less(t, loaded[1].values.Analog[dryerPurge], 0.5)
			assert.Zero(t, analogDelta(notLoaded, dryerPurge))
		},
		"separator_drain_blocked": func(t *testing.T, loaded, notLoaded [2]frame) {
			// The separator no longer settles to the line pressure once the
			// unit stops compressing: H1 − TP3 falls below −0.5 bar.
			assert.InDelta(t, -0.8, analogDelta(notLoaded, separatorPressure), 1e-9)
			assert.Zero(t, analogDelta(loaded, separatorPressure))
			delta := notLoaded[1].values.Analog[separatorPressure] - notLoaded[1].values.Analog[linePressure]
			assert.Less(t, delta, -0.5)
			assert.InDelta(t, 2, analogDelta(loaded, oilTemperature), 1e-9)
		},
		"motor_overload": func(t *testing.T, loaded, notLoaded [2]frame) {
			// A clearly raised loaded current — the opposite direction to a
			// sticking intake valve — carrying its own unsteadiness.
			assert.InDelta(t, 5*0.2, analogDelta(loaded, motorCurrent), 0.5)
			assert.Greater(t, analogDelta(loaded, motorCurrent), 0.5)
			assert.Zero(t, analogDelta(notLoaded, motorCurrent))
			assert.InDelta(t, 6, analogDelta(loaded, oilTemperature), 1e-9)
		},
		"oil_temperature_sensor_fault": func(t *testing.T, loaded, notLoaded [2]frame) {
			// An impossible reading while the unit runs: the instrument, not
			// the cooling circuit.
			assert.Zero(t, loaded[1].values.Analog[oilTemperature])
			assert.Zero(t, notLoaded[1].values.Analog[oilTemperature])
		},
	}

	require.Len(t, checks, len(cat.Injections), "every definition needs a check")
	for i := range cat.Injections {
		def := cat.Injections[i]
		t.Run(def.InjectionID, func(t *testing.T) {
			t.Parallel()

			check, ok := checks[def.InjectionID]
			require.True(t, ok, "no check for %s", def.InjectionID)

			loaded, notLoaded := holdFrames(t, cat, def)
			check(t, loaded, notLoaded)
		})
	}
}

// idleSchedule is the stream the idle-period test replays, one state per
// simulated minute: loaded through the envelope's ramp in, so the definition
// is at full magnitude when the unit stops compressing, then one idle period
// of two unloaded and three off minutes, then a loaded minute. It is the shape
// of a real idle period of the recording, where the motor runs on unloaded
// before it stops.
func idleSchedule(rampInMin int) []machine.State {
	schedule := make([]machine.State, 0, rampInMin+6)
	for range rampInMin {
		schedule = append(schedule, machine.StateLoaded)
	}
	return append(schedule,
		machine.StateUnloaded, machine.StateUnloaded,
		machine.StateOff, machine.StateOff, machine.StateOff,
		machine.StateLoaded)
}

// playSchedule replays one definition over a schedule of states, six
// samples a minute, and returns the overlaid rows.
func playSchedule(t *testing.T, cat *injection.Catalog, injectionID string,
	schedule []machine.State,
) []*injection.Values {
	t.Helper()

	eng := injection.NewEngine(regmap.Signals, cat, injection.WithBootID("a1b2c3"))
	_, err := eng.Start(injectionID, nil, t0)
	require.NoError(t, err)

	rows := make([]*injection.Values, 0, len(schedule)*samplesPerMinute)
	for i := range len(schedule) * samplesPerMinute {
		values := sample()
		eng.Apply(values, schedule[i/samplesPerMinute], t0+uint64(i)*sampleEveryMs)
		rows = append(rows, values)
	}
	return rows
}

// analogPos returns the slot of an analog tag in the generated signal table.
func analogPos(t *testing.T, tag string) int {
	t.Helper()

	pos := 0
	for _, sig := range regmap.Signals {
		if sig.Kind != regmap.KindAnalog {
			continue
		}
		if sig.Tag == tag {
			return pos
		}
		pos++
	}
	t.Fatalf("%s is not an analog tag of the register map", tag)
	return -1
}

func TestEveryNotLoadedRampRunsThroughTheWholeIdlePeriod(t *testing.T) {
	t.Parallel()

	// A ramp guarded by not_loaded stands for air drawn from the network while
	// the unit is not compressing. The motor running on unloaded and then
	// stopping changes nothing about that, so the drift has to keep going when
	// the unit goes from unloaded to off: restarting it there stepped the
	// pressure back up without any compression. Every such ramp of the catalog
	// is therefore anchored at the entry of its guard.
	cat := loadCatalog(t)
	checked := map[string]int{}
	for i := range cat.Injections {
		def := cat.Injections[i]
		for _, tr := range def.Transforms {
			if tr.Op != injection.OpRamp || tr.When != injection.WhenNotLoaded {
				continue
			}
			checked[def.InjectionID]++
			assert.Equal(t, injection.AnchorGuardEntry, tr.Anchor,
				"%s ramps %s under not_loaded", def.InjectionID, tr.Tag)

			rows := playSchedule(t, cat, def.InjectionID, idleSchedule(def.Envelope.RampInMin))
			pos := analogPos(t, tr.Tag)
			idle := def.Envelope.RampInMin * samplesPerMinute
			delta := func(at int) float64 { return rows[at].Analog[pos] - sample().Analog[pos] }
			drift := func(seconds float64) float64 {
				return max(-tr.Cap, min(tr.Cap, tr.RatePerMin*seconds/60))
			}

			assert.InDelta(t, drift(110), delta(idle+11), 1e-9,
				"%s %s: the last unloaded sample", def.InjectionID, tr.Tag)
			assert.InDelta(t, drift(120), delta(idle+12), 1e-9,
				"%s %s: the stop inside the idle period does not restart the ramp",
				def.InjectionID, tr.Tag)
			assert.InDelta(t, drift(290), delta(idle+29), 1e-9,
				"%s %s: the last off sample", def.InjectionID, tr.Tag)
			assert.Zero(t, delta(idle+30), "%s %s: nothing while loaded", def.InjectionID, tr.Tag)
		}
	}

	assert.Equal(t, map[string]int{"heavy_air_demand": 3, "air_leak_downstream": 3}, checked,
		"the ramps under not_loaded are heavy demand's and the leak's three pressures")
}

func TestNoDefinitionTouchesATagItDoesNotName(t *testing.T) {
	t.Parallel()

	cat := loadCatalog(t)
	positions := map[string]struct {
		pos     int
		digital bool
	}{}
	analog, digital := 0, 0
	for _, sig := range regmap.Signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			positions[sig.Tag] = struct {
				pos     int
				digital bool
			}{analog, false}
			analog++
		case regmap.KindDigital:
			positions[sig.Tag] = struct {
				pos     int
				digital bool
			}{digital, true}
			digital++
		}
	}

	for i := range cat.Injections {
		def := cat.Injections[i]
		t.Run(def.InjectionID, func(t *testing.T) {
			t.Parallel()

			named := map[string]bool{}
			for _, tr := range def.Transforms {
				named[tr.Tag] = true
			}

			loaded, notLoaded := holdFrames(t, cat, def)
			for _, f := range [][2]frame{loaded, notLoaded} {
				for tag, at := range positions {
					if named[tag] {
						continue
					}
					if at.digital {
						assert.Equal(t, f[0].values.Digital[at.pos], f[1].values.Digital[at.pos],
							"%s changed although %s does not name it", tag, def.InjectionID)
						continue
					}
					assert.Equal(t, f[0].values.Analog[at.pos], f[1].values.Analog[at.pos],
						"%s changed although %s does not name it", tag, def.InjectionID)
				}
			}
		})
	}
}
