// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7

import (
	"fmt"
	"math"

	"fault-diagnosis-poc/services/modbus/internal/machine"
)

// The derived quantity ids of the `derived:` block of
// manual/spec/signals.yaml. A trigger of kind KindDerived names one of them in
// regmap.Trigger.Derived; the other kinds may name one as provenance.
const (
	// DerivedReservoirLineDelta is abs_delta(reservoir_pressure,
	// line_pressure) in bar.
	DerivedReservoirLineDelta = "reservoir_line_delta"
	// DerivedDischargeLineDelta is delta(discharge_pressure, line_pressure)
	// in bar.
	DerivedDischargeLineDelta = "discharge_line_delta"
	// DerivedContinuousLoadTime is the uninterrupted time in state loaded, in
	// minutes.
	DerivedContinuousLoadTime = "continuous_load_time"
	// DerivedMotorStartsPerHour is the number of start events in the last
	// sliding hour of sim time.
	DerivedMotorStartsPerHour = "motor_starts_per_hour"
	// DerivedSecondsSinceTowerChange is the time since dryer_tower last
	// changed, in seconds, reset when the unit leaves the loaded state.
	DerivedSecondsSinceTowerChange = "seconds_since_tower_change"
	// DerivedRunHours is the cumulative time in unloaded or loaded, in hours.
	DerivedRunHours = "run_hours"
)

// The signals the derived quantities read. They are tag ids of
// manual/spec/signals.yaml, resolved through the signal table New is given, so
// a tag rename reaches this package through the generated map.
const (
	tagReservoirPressure = "reservoir_pressure"
	tagLinePressure      = "line_pressure"
	tagDischargePressure = "discharge_pressure"
	tagDryerTower        = "dryer_tower"
)

// startsWindowMs is the `window_s: 3600` of motor_starts_per_hour, in
// milliseconds of sim time.
const startsWindowMs uint64 = 3_600_000

const (
	msPerSecond = 1_000.0
	msPerMinute = 60_000.0
	msPerHour   = 3_600_000.0
)

// Derived is a snapshot of the controller's derived quantities after the last
// Step, each in the unit signals.yaml declares for it. They are accumulated
// incrementally from the sample stream and start again from zero at a
// discontinuity, so they mean "since the current stretch of continuous
// replay", never "since the process booted".
type Derived struct {
	// ReservoirLineDelta is |reservoir_pressure − line_pressure| in bar.
	ReservoirLineDelta float64
	// DischargeLineDelta is discharge_pressure − line_pressure in bar.
	DischargeLineDelta float64
	// ContinuousLoadTime is the uninterrupted time in state loaded, in
	// minutes.
	ContinuousLoadTime float64
	// MotorStartsPerHour counts the off → running transitions of the last
	// sliding sim hour.
	MotorStartsPerHour float64
	// SecondsSinceTowerChange is the time since dryer_tower last changed, in
	// seconds. It is zero while the unit is not loaded.
	SecondsSinceTowerChange float64
	// RunHours is the cumulative time in unloaded or loaded, in hours.
	RunHours float64
}

// derivedState accumulates Derived across samples.
type derivedState struct {
	reservoir int // index into Values.Analog
	line      int
	discharge int
	tower     int // index into Values.Digital

	loadedMs  uint64
	runMs     uint64
	towerMs   uint64
	haveTower bool
	towerWas  bool
	starts    []uint64

	out Derived
}

// bind resolves the tags the derived quantities read. The quantities belong to
// the controller rather than to one alarm, so a signal table that does not
// declare them all is rejected at New instead of quietly yielding zeros.
func (d *derivedState) bind(e *Evaluator) error {
	targets := []struct {
		tag     string
		digital bool
		into    *int
	}{
		{tag: tagReservoirPressure, into: &d.reservoir},
		{tag: tagLinePressure, into: &d.line},
		{tag: tagDischargePressure, into: &d.discharge},
		{tag: tagDryerTower, digital: true, into: &d.tower},
	}
	for _, t := range targets {
		var (
			idx int
			err error
		)
		if t.digital {
			idx, err = e.digitalIndexOf(t.tag)
		} else {
			idx, err = e.analogIndexOf(t.tag)
		}
		if err != nil {
			return fmt.Errorf("derived quantities: %w", err)
		}
		*t.into = idx
	}
	return nil
}

// step folds one sample into the accumulators. dtMs is the sim time since the
// previous sample and is zero on the first sample of a stretch, so nothing
// accumulates across a discontinuity.
func (d *derivedState) step(v Values, state machine.State, simTsMs, dtMs uint64, started bool) {
	d.out.ReservoirLineDelta = math.Abs(v.Analog[d.reservoir] - v.Analog[d.line])
	d.out.DischargeLineDelta = v.Analog[d.discharge] - v.Analog[d.line]

	if state == machine.StateLoaded {
		d.loadedMs += dtMs
	} else {
		d.loadedMs = 0
	}
	d.out.ContinuousLoadTime = float64(d.loadedMs) / msPerMinute

	if state == machine.StateLoaded || state == machine.StateUnloaded {
		d.runMs += dtMs
	}
	d.out.RunHours = float64(d.runMs) / msPerHour

	d.stepTower(v, state, dtMs)
	d.stepStarts(simTsMs, started)
}

// stepTower advances seconds_since_tower_change. `reset_on_state_exit:
// loaded` is read as "the counter is meaningful only during a loaded run": it
// is zero while the unit is not loaded, so the time a stopped unit spends
// waiting never counts towards the changeover timeout of W111.
func (d *derivedState) stepTower(v Values, state machine.State, dtMs uint64) {
	tower := v.Digital[d.tower]
	switch {
	case !d.haveTower:
		d.haveTower, d.towerWas, d.towerMs = true, tower, 0
	case tower != d.towerWas:
		d.towerWas, d.towerMs = tower, 0
	case state != machine.StateLoaded:
		d.towerMs = 0
	default:
		d.towerMs += dtMs
	}
	d.out.SecondsSinceTowerChange = float64(d.towerMs) / msPerSecond
}

// stepStarts advances motor_starts_per_hour over its sliding window.
func (d *derivedState) stepStarts(simTsMs uint64, started bool) {
	if started {
		d.starts = append(d.starts, simTsMs)
	}
	expired := 0
	for expired < len(d.starts) && simTsMs >= d.starts[expired] && simTsMs-d.starts[expired] >= startsWindowMs {
		expired++
	}
	if expired > 0 {
		d.starts = append(d.starts[:0], d.starts[expired:]...)
	}
	d.out.MotorStartsPerHour = float64(len(d.starts))
}

// reset drops every accumulator, which is what a discontinuity does.
func (d *derivedState) reset() {
	d.loadedMs, d.runMs, d.towerMs = 0, 0, 0
	d.haveTower, d.towerWas = false, false
	d.starts = d.starts[:0]
	d.out = Derived{}
}

// value returns the quantity id names. New rejects an unknown id, so the
// fallback is unreachable from a compiled trigger.
func (d *derivedState) value(id string) float64 {
	switch id {
	case DerivedReservoirLineDelta:
		return d.out.ReservoirLineDelta
	case DerivedDischargeLineDelta:
		return d.out.DischargeLineDelta
	case DerivedContinuousLoadTime:
		return d.out.ContinuousLoadTime
	case DerivedMotorStartsPerHour:
		return d.out.MotorStartsPerHour
	case DerivedSecondsSinceTowerChange:
		return d.out.SecondsSinceTowerChange
	case DerivedRunHours:
		return d.out.RunHours
	default:
		return 0
	}
}

// knownDerived reports whether id is one of the quantities of signals.yaml.
func knownDerived(id string) bool {
	switch id {
	case DerivedReservoirLineDelta, DerivedDischargeLineDelta, DerivedContinuousLoadTime,
		DerivedMotorStartsPerHour, DerivedSecondsSinceTowerChange, DerivedRunHours:
		return true
	default:
		return false
	}
}
