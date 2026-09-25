// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7

import (
	"fmt"
	"math"

	"fault-diagnosis-poc/services/modbus/internal/machine"
)

// Trigger kinds of regmap.Trigger.Kind. A kind outside this list is accepted
// by New, logged once and never sets its bit.
const (
	KindThreshold     = "threshold"
	KindDigital       = "digital"
	KindStateDuration = "state_duration"
	KindDifferential  = "differential"
	KindDerived       = "derived"
	KindComposite     = "composite"
)

// Trigger states of regmap.Trigger.When. The empty string means WhenAny.
const (
	WhenAny      = "any"
	WhenLoaded   = "loaded"
	WhenUnloaded = "unloaded"
	WhenOff      = "off"
	WhenRunning  = "running"
)

// Reset modes of regmap.Trigger.ResetMode. The empty string means ResetAuto.
const (
	// ResetAuto clears the bit as soon as the condition stops holding.
	ResetAuto = "auto"
	// ResetAutoHysteresis clears the bit once the value is back beyond
	// Threshold ∓ Hysteresis.
	ResetAutoHysteresis = "auto_hysteresis"
	// ResetManual keeps the bit set until Reset or a discontinuity.
	ResetManual = "manual"
	// ResetManualService is ResetManual with a service intervention behind
	// it. The PoC has one reset command, so the two behave alike.
	ResetManualService = "manual_service"
)

// op is a parsed regmap.Trigger.Op.
type op uint8

const (
	// opNone is the op of a trigger that compares nothing, such as digital.
	opNone op = iota
	opGreater
	opLess
)

// parseOp reads the manual's comparison operator.
func parseOp(s string) (op, error) {
	switch s {
	case "gt":
		return opGreater, nil
	case "lt":
		return opLess, nil
	default:
		return opNone, fmt.Errorf("unknown comparison operator %q", s)
	}
}

// compare applies o to value, widening the comparison by hysteresis while the
// alarm is set. That is the controller's reset rule: a bit raised by
// `value > Threshold` clears only once the value is back below
// `Threshold − Hysteresis`, and the mirrored band applies to `lt`. A zero
// hysteresis — every trigger whose reset mode is auto — degenerates to the
// plain comparison.
func compare(value float64, o op, threshold, hysteresis float64, active bool) bool {
	switch o {
	case opGreater:
		if active {
			threshold -= hysteresis
		}
		return value > threshold
	case opLess:
		if active {
			threshold += hysteresis
		}
		return value < threshold
	case opNone:
		return false
	default:
		return false
	}
}

// condition is one compiled trigger. active tells the condition whether the
// alarm it belongs to is currently set, which is what turns the hysteresis
// band on; the branches of a composite are always asked with active false,
// because the message carries the reset band once, at the top.
type condition interface {
	holds(v Values, state machine.State, d *derivedState, active bool) bool
}

// analogCond compares one analog signal with a threshold.
type analogCond struct {
	idx        int
	op         op
	threshold  float64
	hysteresis float64
}

func (c analogCond) holds(v Values, _ machine.State, _ *derivedState, active bool) bool {
	return compare(v.Analog[c.idx], c.op, c.threshold, c.hysteresis, active)
}

// digitalCond holds while one digital signal equals the declared level.
type digitalCond struct {
	idx  int
	want bool
}

func (c digitalCond) holds(v Values, _ machine.State, _ *derivedState, _ bool) bool {
	return v.Digital[c.idx] == c.want
}

// differentialCond compares the difference of two analog signals, optionally
// its absolute value, with a threshold.
type differentialCond struct {
	a, b       int
	abs        bool
	op         op
	threshold  float64
	hysteresis float64
}

func (c differentialCond) holds(v Values, _ machine.State, _ *derivedState, active bool) bool {
	delta := v.Analog[c.a] - v.Analog[c.b]
	if c.abs {
		delta = math.Abs(delta)
	}
	return compare(delta, c.op, c.threshold, c.hysteresis, active)
}

// derivedCond compares one of the derived quantities of signals.yaml with a
// threshold.
type derivedCond struct {
	id         string
	op         op
	threshold  float64
	hysteresis float64
}

func (c derivedCond) holds(_ Values, _ machine.State, d *derivedState, active bool) bool {
	return compare(d.value(c.id), c.op, c.threshold, c.hysteresis, active)
}

// stateCond holds while the machine is in one state; the alarm's DurationS
// supplies the delay that turns it into a state_duration trigger.
type stateCond struct {
	want machine.State
}

func (c stateCond) holds(_ Values, state machine.State, _ *derivedState, _ bool) bool {
	return state == c.want
}

// allCond holds while every branch holds.
type allCond []condition

func (c allCond) holds(v Values, state machine.State, d *derivedState, _ bool) bool {
	for _, sub := range c {
		if !sub.holds(v, state, d, false) {
			return false
		}
	}
	return true
}

// anyCond holds while at least one branch holds.
type anyCond []condition

func (c anyCond) holds(v Values, state machine.State, d *derivedState, _ bool) bool {
	for _, sub := range c {
		if sub.holds(v, state, d, false) {
			return true
		}
	}
	return false
}

// guardOK applies the trigger-state guard: the condition is only looked at
// while the machine is in the declared state, and `running` is the union of
// loaded and unloaded.
func guardOK(when string, state machine.State) bool {
	switch when {
	case WhenLoaded:
		return state == machine.StateLoaded
	case WhenUnloaded:
		return state == machine.StateUnloaded
	case WhenOff:
		return state == machine.StateOff
	case WhenRunning:
		return state == machine.StateLoaded || state == machine.StateUnloaded
	default:
		return true
	}
}

// normaliseWhen validates a trigger state and maps the empty string to
// WhenAny.
func normaliseWhen(when string) (string, error) {
	switch when {
	case "", WhenAny:
		return WhenAny, nil
	case WhenLoaded, WhenUnloaded, WhenOff, WhenRunning:
		return when, nil
	default:
		return "", fmt.Errorf("unknown trigger state %q", when)
	}
}

// manualReset reports whether a reset mode latches the bit until Reset or a
// discontinuity releases it.
func manualReset(mode string) (bool, error) {
	switch mode {
	case "", ResetAuto, ResetAutoHysteresis:
		return false, nil
	case ResetManual, ResetManualService:
		return true, nil
	default:
		return false, fmt.Errorf("unknown reset mode %q", mode)
	}
}

// parseState reads a machine state by the name machine.State.String() prints.
func parseState(name string) (machine.State, error) {
	for _, s := range []machine.State{machine.StateOff, machine.StateUnloaded, machine.StateLoaded} {
		if s.String() == name {
			return s, nil
		}
	}
	return machine.StateOff, fmt.Errorf("unknown machine state %q", name)
}
