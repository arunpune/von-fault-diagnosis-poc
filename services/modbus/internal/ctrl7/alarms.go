// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7

import (
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// maxBit is the highest alarm bit the uint32 alarm_bits field can carry.
const maxBit = 31

// Values is one sample in the evaluator's own index order: Analog holds the
// value of every analog signal of the table New was given, in table order and
// in SI units, and Digital the level of every digital signal. The ambient
// temperature is the last analog entry, because the generated signal table
// puts the synthetic extra after the recorded tags.
//
// The indexes come from the same regmap.Signals the codec places into
// registers, so the caller builds one Values per sample and fills it by index;
// AnalogIndex and DigitalIndex resolve a tag once at start-up.
type Values struct {
	Analog  []float64
	Digital []bool
}

// Transition is one change of one alarm bit, reported by Step and Reset in
// ascending bit order. SimTsMs is the sim timestamp of the sample that caused
// it, which is what the ground-truth and alarm.native messages carry.
type Transition struct {
	Code    string
	Bit     uint8
	Active  bool
	SimTsMs uint64
}

// compiled is one alarm with its trigger resolved against the signal table.
// A nil cond marks a trigger kind this evaluator does not know: it is kept in
// the table, reported once by New and never sets its bit.
type compiled struct {
	alarm       regmap.Alarm
	cond        condition
	when        string
	delayMs     uint64
	startMaskMs uint64
	manual      bool

	// holding is true while the condition held at the previous sample, since
	// is the sim timestamp at which it started to hold, active is true once
	// it has held for delayMs, and latched keeps a manual-reset bit set after
	// its condition released.
	holding bool
	since   uint64
	active  bool
	latched bool
}

// Evaluator turns a stream of samples into the alarm_bits field. It is not
// safe for concurrent use: the simulator's emit loop owns one and calls Step
// once per emitted sample.
type Evaluator struct {
	alarms     []compiled
	analogIdx  map[string]int
	digitalIdx map[string]int
	analogN    int
	digitalN   int

	derived derivedState

	prevSimTs uint64
	havePrev  bool
	prevState machine.State
	haveState bool
	lastStart uint64
	haveStart bool

	bits uint32
}

// New compiles an alarm table against a signal table.
//
// It rejects a duplicate or out-of-range bit, a trigger that names a signal
// the table does not declare or names it with the wrong kind, an unknown
// comparison operator, trigger state, machine state, reset mode or derived
// quantity, and a composite that declares no branch or both kinds of branch.
// An unknown trigger *kind* is not an error: the contracts generator may emit
// a kind a deployed simulator predates, so the alarm is kept, reported once
// through log/slog and never fires.
func New(alarms []regmap.Alarm, signals []regmap.Signal) (*Evaluator, error) {
	e := &Evaluator{
		analogIdx:  make(map[string]int, len(signals)),
		digitalIdx: make(map[string]int, len(signals)),
	}
	if err := e.indexSignals(signals); err != nil {
		return nil, err
	}
	if err := e.derived.bind(e); err != nil {
		return nil, fmt.Errorf("ctrl7: %w", err)
	}

	byBit := make(map[uint8]string, len(alarms))
	unsupported := make(map[string][]string)
	e.alarms = make([]compiled, 0, len(alarms))
	for _, a := range alarms {
		if a.Code == "" {
			return nil, fmt.Errorf("ctrl7: the alarm on bit %d has no code", a.Bit)
		}
		if a.Bit > maxBit {
			return nil, fmt.Errorf("ctrl7: alarm %s has bit %d outside 0..%d", a.Code, a.Bit, maxBit)
		}
		if other, dup := byBit[a.Bit]; dup {
			return nil, fmt.Errorf("ctrl7: alarms %s and %s share bit %d", other, a.Code, a.Bit)
		}
		byBit[a.Bit] = a.Code

		c, err := e.compile(a)
		if err != nil {
			return nil, fmt.Errorf("ctrl7: alarm %s: %w", a.Code, err)
		}
		if c.cond == nil {
			unsupported[a.Trigger.Kind] = append(unsupported[a.Trigger.Kind], a.Code)
		}
		e.alarms = append(e.alarms, c)
	}
	slices.SortFunc(e.alarms, func(a, b compiled) int { return int(a.alarm.Bit) - int(b.alarm.Bit) })

	kinds := make([]string, 0, len(unsupported))
	for kind := range unsupported {
		kinds = append(kinds, kind)
	}
	slices.Sort(kinds)
	for _, kind := range kinds {
		slog.Warn("ctrl7: unsupported alarm trigger kind, the bit is never set",
			"kind", kind, "alarms", unsupported[kind])
	}
	return e, nil
}

// indexSignals assigns every signal its position in Values.
func (e *Evaluator) indexSignals(signals []regmap.Signal) error {
	for _, s := range signals {
		if s.Tag == "" {
			return errors.New("ctrl7: the signal table has an entry without a tag")
		}
		if _, dup := e.analogIdx[s.Tag]; dup {
			return fmt.Errorf("ctrl7: signal %q is declared twice", s.Tag)
		}
		if _, dup := e.digitalIdx[s.Tag]; dup {
			return fmt.Errorf("ctrl7: signal %q is declared twice", s.Tag)
		}
		switch s.Kind {
		case regmap.KindAnalog:
			e.analogIdx[s.Tag] = e.analogN
			e.analogN++
		case regmap.KindDigital:
			e.digitalIdx[s.Tag] = e.digitalN
			e.digitalN++
		default:
			return fmt.Errorf("ctrl7: signal %q has unknown kind %d", s.Tag, s.Kind)
		}
	}
	return nil
}

// compile resolves one alarm's trigger.
func (e *Evaluator) compile(a regmap.Alarm) (compiled, error) {
	t := a.Trigger
	when, err := normaliseWhen(t.When)
	if err != nil {
		return compiled{}, err
	}
	manual, err := manualReset(t.ResetMode)
	if err != nil {
		return compiled{}, err
	}
	if t.DelayS < 0 || t.DurationS < 0 || t.StartMaskS < 0 {
		return compiled{}, fmt.Errorf("negative delay_s %d, duration_s %d or start_mask_s %d",
			t.DelayS, t.DurationS, t.StartMaskS)
	}

	c := compiled{
		alarm:       a,
		when:        when,
		manual:      manual,
		delayMs:     uint64(t.DelayS) * 1000,
		startMaskMs: uint64(t.StartMaskS) * 1000,
	}

	switch t.Kind {
	case KindStateDuration:
		state, err := parseState(t.State)
		if err != nil {
			return compiled{}, err
		}
		c.cond = stateCond{want: state}
		c.delayMs = uint64(t.DurationS) * 1000
	case KindComposite:
		cond, err := e.compileComposite(t)
		if err != nil {
			return compiled{}, err
		}
		c.cond = cond
	case KindThreshold, KindDigital, KindDifferential, KindDerived:
		cond, err := e.compileLeaf(t)
		if err != nil {
			return compiled{}, err
		}
		c.cond = cond
	default:
		// An unknown kind keeps a nil condition and never fires.
	}
	return c, nil
}

// compileComposite resolves a one-level all/any trigger. Its branches are
// leaves: the reset band, the delay, the start mask and the trigger state
// belong to the message, not to a branch.
func (e *Evaluator) compileComposite(t regmap.Trigger) (condition, error) {
	switch {
	case len(t.All) > 0 && len(t.Any) > 0:
		return nil, errors.New("a composite trigger declares both all and any")
	case len(t.All) > 0:
		subs, err := e.compileBranches(t.All)
		if err != nil {
			return nil, err
		}
		return allCond(subs), nil
	case len(t.Any) > 0:
		subs, err := e.compileBranches(t.Any)
		if err != nil {
			return nil, err
		}
		return anyCond(subs), nil
	default:
		return nil, errors.New("a composite trigger declares no branch")
	}
}

// compileBranches resolves the leaves of a composite.
func (e *Evaluator) compileBranches(branches []regmap.Trigger) ([]condition, error) {
	subs := make([]condition, 0, len(branches))
	for i, b := range branches {
		cond, err := e.compileLeaf(b)
		if err != nil {
			return nil, fmt.Errorf("branch %d: %w", i, err)
		}
		subs = append(subs, cond)
	}
	return subs, nil
}

// compileLeaf resolves a trigger that compares one quantity. A composite
// branch may only be one of these kinds.
func (e *Evaluator) compileLeaf(t regmap.Trigger) (condition, error) {
	switch t.Kind {
	case KindThreshold:
		idx, err := e.analogIndexOf(t.Signal)
		if err != nil {
			return nil, err
		}
		o, err := parseOp(t.Op)
		if err != nil {
			return nil, err
		}
		return analogCond{idx: idx, op: o, threshold: t.Threshold, hysteresis: t.Hysteresis}, nil
	case KindDigital:
		idx, err := e.digitalIndexOf(t.Signal)
		if err != nil {
			return nil, err
		}
		return digitalCond{idx: idx, want: t.Value}, nil
	case KindDifferential:
		a, err := e.analogIndexOf(t.Signal)
		if err != nil {
			return nil, err
		}
		b, err := e.analogIndexOf(t.SignalB)
		if err != nil {
			return nil, err
		}
		o, err := parseOp(t.Op)
		if err != nil {
			return nil, err
		}
		return differentialCond{a: a, b: b, abs: t.Abs, op: o, threshold: t.Threshold, hysteresis: t.Hysteresis}, nil
	case KindDerived:
		if !knownDerived(t.Derived) {
			return nil, fmt.Errorf("unknown derived quantity %q", t.Derived)
		}
		o, err := parseOp(t.Op)
		if err != nil {
			return nil, err
		}
		return derivedCond{id: t.Derived, op: o, threshold: t.Threshold, hysteresis: t.Hysteresis}, nil
	default:
		return nil, fmt.Errorf("trigger kind %q cannot be a composite branch", t.Kind)
	}
}

// analogIndexOf returns the Values.Analog index of tag.
func (e *Evaluator) analogIndexOf(tag string) (int, error) {
	if tag == "" {
		return 0, errors.New("the trigger names no signal")
	}
	idx, ok := e.analogIdx[tag]
	if !ok {
		if _, digital := e.digitalIdx[tag]; digital {
			return 0, fmt.Errorf("signal %q is digital, not analog", tag)
		}
		return 0, fmt.Errorf("unknown signal %q", tag)
	}
	return idx, nil
}

// digitalIndexOf returns the Values.Digital index of tag.
func (e *Evaluator) digitalIndexOf(tag string) (int, error) {
	if tag == "" {
		return 0, errors.New("the trigger names no signal")
	}
	idx, ok := e.digitalIdx[tag]
	if !ok {
		if _, analog := e.analogIdx[tag]; analog {
			return 0, fmt.Errorf("signal %q is analog, not digital", tag)
		}
		return 0, fmt.Errorf("unknown signal %q", tag)
	}
	return idx, nil
}

// AnalogIndex returns the Values.Analog index of tag, so a caller resolves it
// once instead of once per sample.
func (e *Evaluator) AnalogIndex(tag string) (int, bool) {
	idx, ok := e.analogIdx[tag]
	return idx, ok
}

// DigitalIndex returns the Values.Digital index of tag.
func (e *Evaluator) DigitalIndex(tag string) (int, bool) {
	idx, ok := e.digitalIdx[tag]
	return idx, ok
}

// NewValues returns a zeroed Values sized for the signal table, ready to be
// filled by index.
func (e *Evaluator) NewValues() Values {
	return Values{Analog: make([]float64, e.analogN), Digital: make([]bool, e.digitalN)}
}

// Step evaluates one sample and returns the new alarm bit field together with
// the bits that changed, in ascending bit order.
//
// simTsMs is the sample's simulated timestamp and is the only clock the
// evaluator has: every delay, the start mask and the derived quantities
// advance by the difference between consecutive calls, so a replay at 3600×
// raises the same alarms at the same samples as one at 1×.
//
// discontinuity marks a sample that does not continue the previous one (boot,
// a collapsed source gap, a jump, a reset or a loop wrap). Pending delays
// start over, the derived quantities start from zero and manual latches are
// released; a bit that is already set stays set only while its condition still
// holds at this sample.
//
// Step panics when v does not match the signal table the evaluator was built
// with — that is a wiring mistake in the caller, not a condition of the run.
func (e *Evaluator) Step(v Values, state machine.State, simTsMs uint64, discontinuity bool) (uint32, []Transition) {
	if len(v.Analog) != e.analogN || len(v.Digital) != e.digitalN {
		panic(fmt.Sprintf("ctrl7: Step wants %d analog and %d digital values, got %d and %d",
			e.analogN, e.digitalN, len(v.Analog), len(v.Digital)))
	}
	if discontinuity {
		e.restart()
	}

	var dtMs uint64
	if e.havePrev && simTsMs > e.prevSimTs {
		dtMs = simTsMs - e.prevSimTs
	}
	started := e.haveState && e.prevState == machine.StateOff && state != machine.StateOff
	if started {
		e.lastStart, e.haveStart = simTsMs, true
	}
	e.derived.step(v, state, simTsMs, dtMs, started)

	var (
		bits    uint32
		changed []Transition
	)
	for i := range e.alarms {
		a := &e.alarms[i]
		before := e.bits&(uint32(1)<<a.alarm.Bit) != 0

		hold := a.cond != nil &&
			guardOK(a.when, state) &&
			!e.masked(a, simTsMs) &&
			a.cond.holds(v, state, &e.derived, a.active)
		if hold {
			if !a.holding {
				a.holding, a.since = true, simTsMs
			}
			if simTsMs >= a.since && simTsMs-a.since >= a.delayMs {
				a.active = true
			}
		} else {
			a.holding, a.since, a.active = false, 0, false
		}
		if a.active && a.manual {
			a.latched = true
		}

		now := a.active || a.latched
		if now {
			bits |= uint32(1) << a.alarm.Bit
		}
		if now != before {
			changed = append(changed, Transition{
				Code: a.alarm.Code, Bit: a.alarm.Bit, Active: now, SimTsMs: simTsMs,
			})
		}
	}

	e.prevSimTs, e.havePrev = simTsMs, true
	e.prevState, e.haveState = state, true
	e.bits = bits
	return bits, changed
}

// Reset releases every manual latch, which is what the `reset` control command
// does at the controller panel. A latched bit whose condition still holds stays
// set, because a fault that is still present cannot be acknowledged away.
func (e *Evaluator) Reset(simTsMs uint64) (uint32, []Transition) {
	var (
		bits    uint32
		changed []Transition
	)
	for i := range e.alarms {
		a := &e.alarms[i]
		before := e.bits&(uint32(1)<<a.alarm.Bit) != 0
		a.latched = false

		now := a.active
		if now {
			bits |= uint32(1) << a.alarm.Bit
		}
		if now != before {
			changed = append(changed, Transition{
				Code: a.alarm.Code, Bit: a.alarm.Bit, Active: now, SimTsMs: simTsMs,
			})
		}
	}
	e.bits = bits
	return bits, changed
}

// restart drops everything the evaluator carries between samples except the
// bits themselves, which Step re-derives from the conditions of the sample
// that carries the discontinuity.
func (e *Evaluator) restart() {
	for i := range e.alarms {
		e.alarms[i].holding = false
		e.alarms[i].since = 0
		e.alarms[i].latched = false
	}
	e.derived.reset()
	e.havePrev, e.haveState, e.haveStart = false, false, false
	e.prevSimTs, e.lastStart = 0, 0
	e.prevState = machine.StateOff
}

// masked reports whether the motor-start mask still hides the condition. The
// mask counts from the last off → running transition the evaluator saw; after
// a discontinuity there is no such reference and nothing is masked.
func (e *Evaluator) masked(a *compiled, simTsMs uint64) bool {
	if a.startMaskMs == 0 || !e.haveStart || simTsMs < e.lastStart {
		return false
	}
	return simTsMs-e.lastStart < a.startMaskMs
}

// Bits returns the alarm bit field of the last Step or Reset.
func (e *Evaluator) Bits() uint32 { return e.bits }

// Active returns the codes of the currently set alarms in ascending bit
// order, the same order regmap.AlarmCodes produces for the same bit field.
func (e *Evaluator) Active() []string {
	codes := make([]string, 0, len(e.alarms))
	for i := range e.alarms {
		if e.bits&(uint32(1)<<e.alarms[i].alarm.Bit) != 0 {
			codes = append(codes, e.alarms[i].alarm.Code)
		}
	}
	return codes
}

// Derived returns the derived quantities after the last Step.
func (e *Evaluator) Derived() Derived { return e.derived.out }
