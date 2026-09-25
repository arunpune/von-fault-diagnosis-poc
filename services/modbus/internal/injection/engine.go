// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// ErrUnknownInjection is returned by Start for an injection id the catalog
// does not offer; the control plane turns it into a bad_args acknowledgement.
var ErrUnknownInjection = errors.New("unknown injection id")

// ErrBadArgs is returned by Start for a parameter the definition does not
// declare or a value outside its bounds.
var ErrBadArgs = errors.New("bad arguments")

// Reason is why an instance stopped.
type Reason string

// The four stop reasons.
const (
	// ReasonExpired is the end of the instance's own duration.
	ReasonExpired Reason = "expired"
	// ReasonCleared is the clear_injections command.
	ReasonCleared Reason = "cleared"
	// ReasonJump is a jump to another instant of the recording.
	ReasonJump Reason = "jump"
	// ReasonReset is the reset command.
	ReasonReset Reason = "reset"
)

// InstanceInfo is what the ground-truth topics publish about one instance. It
// is a copy: the engine keeps the running state to itself.
type InstanceInfo struct {
	InstanceID     string
	InjectionID    string
	FaultID        string
	StartedSimTsMs uint64
	EndsSimTsMs    uint64
	Params         map[string]float64
}

// Stopped is one instance that has ended, with the reason to publish.
type Stopped struct {
	Info   InstanceInfo
	Reason Reason
}

// compiled is a transform with its tag already resolved against the signal
// table, so Apply does no map lookup per sample.
type compiled struct {
	Transform
	pos  int
	kind regmap.Kind
}

// Instance is one running copy of a definition. Its fields are set by Start
// and read-only afterwards; the engine owns the bookkeeping behind them.
type Instance struct {
	InstanceID     string
	InjectionID    string
	FaultID        string
	StartedSimTsMs uint64
	EndsSimTsMs    uint64

	magnitude      float64
	durationSimMin int
	env            envelope
	transforms     []compiled

	// duty is the run bookkeeping of the duty_shift transforms, indexed like
	// transforms so a definition may carry several.
	duty []dutyState

	// guard notes, per transform, when its guard last started to hold: the
	// anchor of a guard_entry ramp. It is indexed like transforms because
	// two transforms of one instance may carry different guards.
	guard []guardState

	// stateKnown, lastState and stateEnteredMs track the machine state for
	// the ramps anchored at state_entry. The state is the same for every
	// transform of the instance, so one tracker serves them all; it starts at
	// the instance's first sample, because an injection cannot know when a
	// state that predates it was entered.
	stateKnown     bool
	lastState      machine.State
	stateEnteredMs uint64
}

// Magnitude returns the envelope magnitude at simTsMs multiplied by the
// instance's magnitude parameter: the m of the transform primitives.
func (i *Instance) Magnitude(simTsMs uint64) float64 {
	return i.env.at(simTsMs) * i.magnitude
}

// Info returns the instance's ground-truth description.
func (i *Instance) Info() InstanceInfo {
	return InstanceInfo{
		InstanceID:     i.InstanceID,
		InjectionID:    i.InjectionID,
		FaultID:        i.FaultID,
		StartedSimTsMs: i.StartedSimTsMs,
		EndsSimTsMs:    i.EndsSimTsMs,
		Params: map[string]float64{
			MagnitudeParam: i.magnitude,
			DurationParam:  float64(i.durationSimMin),
		},
	}
}

// Engine runs the active instances over the emitted samples.
type Engine struct {
	catalog *Catalog
	index   tagIndex
	bootID  string
	next    int
	active  []*Instance
}

// Option configures an Engine.
type Option func(*Engine)

// WithBootID fixes the boot id the instance ids are built from. The default
// is derived from the process start; a test that asserts on instance ids
// pins it.
func WithBootID(bootID string) Option {
	return func(e *Engine) { e.bootID = bootID }
}

// NewEngine builds the engine for one signal table and one catalog. The
// catalog must already have been validated against the same table, which
// LoadCatalog does.
func NewEngine(signals []regmap.Signal, cat *Catalog, opts ...Option) *Engine {
	e := &Engine{
		catalog: cat,
		index:   newTagIndex(signals),
		bootID:  defaultBootID(),
	}
	for _, opt := range opts {
		opt(e)
	}
	return e
}

// Catalog returns the catalog the engine runs, for the retained gt catalog
// message.
func (e *Engine) Catalog() *Catalog { return e.catalog }

// BootID returns the six hex characters the instance ids of this process
// carry: restarts never reuse an instance id, so the gt.injections uniqueness
// constraint holds across them.
func (e *Engine) BootID() string { return e.bootID }

// defaultBootID derives six hex characters from the process start.
func defaultBootID() string {
	return fmt.Sprintf("%06x", uint32(time.Now().UnixNano())&0xff_ffff)
}

// Start creates an instance of injectionID at simTsMs.
//
// params carries the tunable values of the inject command; every name the
// definition does not declare — beyond duration_sim_min, which every
// definition accepts — and every value outside its bounds is an ErrBadArgs.
// Whatever the caller leaves out takes the definition's default.
func (e *Engine) Start(injectionID string, params map[string]float64, simTsMs uint64) (*Instance, error) {
	def, ok := e.catalog.Definition(injectionID)
	if !ok {
		return nil, fmt.Errorf("injection: %w: %q", ErrUnknownInjection, injectionID)
	}

	resolved, err := resolveParams(def, params)
	if err != nil {
		return nil, err
	}
	transforms, err := e.compile(def)
	if err != nil {
		return nil, err
	}

	duration := int(resolved[DurationParam])
	endsMs := simTsMs + uint64(duration)*msPerMin

	e.next++
	inst := &Instance{
		InstanceID:     fmt.Sprintf("inj-%s-%d", e.bootID, e.next),
		InjectionID:    def.InjectionID,
		FaultID:        def.FaultID,
		StartedSimTsMs: simTsMs,
		EndsSimTsMs:    endsMs,
		magnitude:      resolved[MagnitudeParam],
		durationSimMin: duration,
		env:            newEnvelope(simTsMs, endsMs, def.Envelope),
		transforms:     transforms,
		duty:           make([]dutyState, len(transforms)),
		guard:          make([]guardState, len(transforms)),
	}
	e.active = append(e.active, inst)
	return inst, nil
}

// resolveParams merges the command's parameters with the definition's
// defaults and checks every bound.
func resolveParams(def *Definition, params map[string]float64) (map[string]float64, error) {
	resolved := make(map[string]float64, len(def.Params)+1)
	for _, p := range def.Params {
		resolved[p.Name] = p.Default
	}
	if _, declared := resolved[DurationParam]; !declared {
		resolved[DurationParam] = float64(def.DefaultDurationSimMin)
	}

	for _, name := range slices.Sorted(maps.Keys(params)) {
		value := params[name]
		if _, known := resolved[name]; !known {
			return nil, fmt.Errorf("injection %s: %w: unknown parameter %q",
				def.InjectionID, ErrBadArgs, name)
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, fmt.Errorf("injection %s: %w: %s is not a finite number",
				def.InjectionID, ErrBadArgs, name)
		}
		lower, upper := paramBounds(def, name)
		if value < lower || value > upper {
			return nil, fmt.Errorf("injection %s: %w: %s is %g, outside %g..%g",
				def.InjectionID, ErrBadArgs, name, value, lower, upper)
		}
		resolved[name] = value
	}

	if duration := resolved[DurationParam]; duration != math.Trunc(duration) {
		return nil, fmt.Errorf("injection %s: %w: %s is %g, not a whole number of minutes",
			def.InjectionID, ErrBadArgs, DurationParam, duration)
	}
	return resolved, nil
}

// paramBounds returns the bounds of a parameter: the definition's own, or the
// fixed 1..14400 minutes for the duration a definition does not declare
// itself.
func paramBounds(def *Definition, name string) (lower, upper float64) {
	if p, ok := def.Param(name); ok {
		return p.Min, p.Max
	}
	return 1, MaxDurationSimMin
}

// compile resolves every transform's tag against the signal table.
func (e *Engine) compile(def *Definition) ([]compiled, error) {
	out := make([]compiled, 0, len(def.Transforms))
	for i, tr := range def.Transforms {
		pos, kind, ok := e.index.lookup(tr.Tag)
		if !ok {
			return nil, fmt.Errorf("injection %s: transforms[%d]: %w: tag %q is not in the "+
				"register map the engine runs with", def.InjectionID, i, ErrBadArgs, tr.Tag)
		}
		out = append(out, compiled{Transform: tr, pos: pos, kind: kind})
	}
	return out, nil
}

// Apply overlays every active instance on v, in creation order, so a later
// instance sees what an earlier one wrote.
//
// state is the load state the caller computed from the untouched source row
// and simTsMs the row's simulated timestamp; neither is modified, and neither
// is v's length. An instance whose window does not contain simTsMs is skipped
// entirely, which is what keeps stuck, duty_shift and dropout — the three
// primitives that ignore the magnitude — inside their instance's duration.
func (e *Engine) Apply(v *Values, state machine.State, simTsMs uint64) {
	for _, inst := range e.active {
		inst.apply(v, state, simTsMs)
	}
}

// apply overlays one instance.
func (i *Instance) apply(v *Values, state machine.State, simTsMs uint64) {
	if !i.env.active(simTsMs) {
		return
	}
	i.trackState(state, simTsMs)

	m := i.Magnitude(simTsMs)
	for n, tr := range i.transforms {
		holds := tr.When.holds(state)
		i.guard[n].track(holds, simTsMs)
		if !holds {
			continue
		}
		switch tr.kind {
		case regmap.KindAnalog:
			if tr.pos < len(v.Analog) {
				v.Analog[tr.pos] = i.analog(v.Analog[tr.pos], tr, m, n, simTsMs)
			}
		case regmap.KindDigital:
			if tr.pos < len(v.Digital) {
				v.Digital[tr.pos] = i.digital(v.Digital[tr.pos], tr, n, simTsMs)
			}
		}
	}
}

// trackState notes when the current machine state was entered, which is the
// anchor of a state_entry ramp. The first sample the instance sees counts as
// an entry: the state may have been held for hours before the injection
// started, and a ramp may not credit itself with that time.
func (i *Instance) trackState(state machine.State, simTsMs uint64) {
	if !i.stateKnown || state != i.lastState {
		i.stateKnown, i.lastState, i.stateEnteredMs = true, state, simTsMs
	}
}

// guardState is one transform's view of its own guard: whether it held on
// the previous sample the instance saw, and since when it has held.
type guardState struct {
	held      bool
	enteredMs uint64
}

// track notes the sample at which the guard starts to hold, which is the
// anchor of a guard_entry ramp. Like trackState, the instance's first sample
// counts as an entry when the guard holds there, and a change of machine
// state that keeps the guard holding (unloaded to off under not_loaded) is
// not one.
func (g *guardState) track(holds bool, simTsMs uint64) {
	if holds && !g.held {
		g.enteredMs = simTsMs
	}
	g.held = holds
}

// analog applies one transform to an analog value.
func (i *Instance) analog(v float64, tr compiled, m float64, n int, simTsMs uint64) float64 {
	switch tr.Op {
	case OpOffset:
		return applyOffset(v, tr.Value.Float(), m)
	case OpScale:
		return applyScale(v, tr.Factor, m)
	case OpRamp:
		return applyRamp(v, tr.RatePerMin, tr.Cap, m, i.minutesSince(tr.Anchor, n, simTsMs))
	case OpNoise:
		return applyNoise(v, tr.Sigma, m, noiseDraw(i.InstanceID, simTsMs, n))
	case OpStuck, OpDropout:
		return tr.Value.Float()
	default:
		return v
	}
}

// digital applies one transform to a digital value.
func (i *Instance) digital(v bool, tr compiled, n int, simTsMs uint64) bool {
	switch tr.Op {
	case OpStuck:
		return tr.Value.Bool()
	case OpDropout:
		return false
	case OpDutyShift:
		return i.duty[n].applyDutyShift(v, tr.RunValue, tr.ExtendS, simTsMs)
	default:
		return v
	}
}

// minutesSince returns the simulated minutes the ramp of transform n has run
// for.
func (i *Instance) minutesSince(anchor Anchor, n int, simTsMs uint64) float64 {
	from := i.StartedSimTsMs
	switch anchor {
	case AnchorStateEntry:
		from = i.stateEnteredMs
	case AnchorGuardEntry:
		from = i.guard[n].enteredMs
	case AnchorInjectionStart:
		// The instance start, as set above.
	}
	if simTsMs <= from {
		return 0
	}
	return float64(simTsMs-from) / msPerMin
}

// holds reports whether the guard admits the state.
func (w When) holds(s machine.State) bool {
	switch w {
	case WhenAny:
		return true
	case WhenLoaded:
		return s == machine.StateLoaded
	case WhenNotLoaded:
		return s != machine.StateLoaded
	case WhenUnloaded:
		return s == machine.StateUnloaded
	case WhenOff:
		return s == machine.StateOff
	default:
		return false
	}
}

// Expire removes the instances whose duration has run out and returns them in
// creation order, for the stop messages the caller publishes.
func (e *Engine) Expire(simTsMs uint64) []Stopped {
	var stopped []Stopped
	kept := e.active[:0]
	for _, inst := range e.active {
		if simTsMs >= inst.EndsSimTsMs {
			stopped = append(stopped, Stopped{Info: inst.Info(), Reason: ReasonExpired})
			continue
		}
		kept = append(kept, inst)
	}
	clear(e.active[len(kept):])
	e.active = kept
	return stopped
}

// StopAll removes every instance and returns them in creation order with the
// reason the caller publishes: cleared, jump or reset.
func (e *Engine) StopAll(reason Reason) []Stopped {
	stopped := make([]Stopped, 0, len(e.active))
	for _, inst := range e.active {
		stopped = append(stopped, Stopped{Info: inst.Info(), Reason: reason})
	}
	clear(e.active)
	e.active = e.active[:0]
	if len(stopped) == 0 {
		return nil
	}
	return stopped
}

// Active returns the running instances, oldest start first, for the retained
// active list. Instances that started at the same instant keep their creation
// order.
func (e *Engine) Active() []InstanceInfo {
	out := make([]InstanceInfo, 0, len(e.active))
	for _, inst := range e.active {
		out = append(out, inst.Info())
	}
	slices.SortStableFunc(out, func(a, b InstanceInfo) int {
		switch {
		case a.StartedSimTsMs < b.StartedSimTsMs:
			return -1
		case a.StartedSimTsMs > b.StartedSimTsMs:
			return 1
		default:
			return 0
		}
	})
	if len(out) == 0 {
		return nil
	}
	return out
}
