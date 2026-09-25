// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package machine holds the load state of the CAU-7 unit.
//
// It is a leaf package on purpose: the injection engine and the CTRL-7 alarm
// evaluator both condition on the state, and neither may import the simulator.
// The state never leaves the simulator — the backend recomputes it from the
// published telemetry.
package machine

import "fmt"

// State is the load state of the unit.
type State uint8

// The three load states of the compressor.
const (
	// StateOff means the motor is not running.
	StateOff State = iota
	// StateUnloaded means the motor runs with the intake closed, either
	// during the run-on after cut-out or while starting.
	StateUnloaded
	// StateLoaded means the unit is compressing.
	StateLoaded
)

// RunningThresholdA is the motor current above which the motor counts as
// running (only 140 of 1,516,948 rows fall in the 0.5–1.0 A band, so the
// boundary is safe).
const RunningThresholdA = 1.0

// String returns the lower-case name used in ground-truth payloads and in the
// alarm trigger guards.
func (s State) String() string {
	switch s {
	case StateOff:
		return "off"
	case StateUnloaded:
		return "unloaded"
	case StateLoaded:
		return "loaded"
	default:
		return fmt.Sprintf("State(%d)", uint8(s))
	}
}

// Classify applies the primary load-state rule:
//
//	loaded   := COMP == 0 and DV_eletric == 1
//	unloaded := not loaded and Motor_current >= 1.0 A
//	off      := not loaded and Motor_current <  1.0 A
//
// comp is the intake-valve signal (true while there is no air intake, i.e.
// COMP == 1) and dvElectric the outlet-valve command; callers resolve both
// through regmap.Signals by column so the rule survives a tag rename.
func Classify(comp, dvElectric bool, motorCurrentA float64) State {
	if !comp && dvElectric {
		return StateLoaded
	}
	if motorCurrentA >= RunningThresholdA {
		return StateUnloaded
	}
	return StateOff
}
