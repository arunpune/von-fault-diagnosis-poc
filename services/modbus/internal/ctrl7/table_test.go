// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7_test

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// testTableFile is the synthetic alarm table the behaviour tests drive. It is
// deliberately not the generated one: the semantics of a trigger kind must be
// pinned by a table this package owns, so that a change to the manual's alarms
// cannot quietly take a case away.
const testTableFile = "alarms/ctrl7-test.json"

// baseSimTs is 2020-02-01T00:00:00Z, the first timestamp of MetroPT-3.
const baseSimTs uint64 = 1_580_515_200_000

// sampleMs is the source sampling interval of the recording.
const sampleMs uint64 = 10_000

// Tags of the generated signal table the tests drive by name.
const (
	tagDischargePressure = "discharge_pressure"
	tagLinePressure      = "line_pressure"
	tagSeparatorPressure = "separator_discharge_pressure"
	tagPurgePressure     = "dryer_purge_pressure"
	tagReservoirPressure = "reservoir_pressure"
	tagOilTemperature    = "oil_temperature"
	tagMotorCurrent      = "motor_current"
	tagAmbient           = "ambient_temperature"

	tagIntakeClosed  = "intake_closed"
	tagLoadValve     = "load_valve"
	tagDryerTower    = "dryer_tower"
	tagRegulator     = "regulator_contact"
	tagLowPressure   = "low_pressure_switch"
	tagPurgeSwitch   = "purge_switch"
	tagOilLevelOK    = "oil_level_ok"
	tagFlowPulse     = "flow_pulse"
	towerChangeEvery = 12 // samples, i.e. two minutes of a healthy run
)

// jsonTable is packages/contracts/generated/register-map.json's `alarms`
// shape, reduced to what the evaluator reads. The field names are the
// snake_case form of regmap.Alarm and regmap.Trigger, so the fixture and the
// generated Go table describe the same document.
type jsonTable struct {
	Alarms []jsonAlarm `json:"alarms"`
}

type jsonAlarm struct {
	Code    string      `json:"code"`
	Bit     uint8       `json:"bit"`
	Type    string      `json:"type"`
	Trigger jsonTrigger `json:"trigger"`
}

type jsonTrigger struct {
	Kind       string        `json:"kind"`
	Signal     string        `json:"signal"`
	SignalB    string        `json:"signal_b"`
	Op         string        `json:"op"`
	Threshold  float64       `json:"threshold"`
	Value      bool          `json:"value"`
	Hysteresis float64       `json:"hysteresis"`
	DelayS     int           `json:"delay_s"`
	State      string        `json:"state"`
	DurationS  int           `json:"duration_s"`
	When       string        `json:"when"`
	StartMaskS int           `json:"start_mask_s"`
	Abs        bool          `json:"abs"`
	Derived    string        `json:"derived"`
	ResetMode  string        `json:"reset_mode"`
	Note       string        `json:"note"`
	All        []jsonTrigger `json:"all"`
	Any        []jsonTrigger `json:"any"`
}

// toTrigger converts one decoded trigger into the generated shape.
func (t jsonTrigger) toTrigger() regmap.Trigger {
	out := regmap.Trigger{
		Kind: t.Kind, Signal: t.Signal, SignalB: t.SignalB, Op: t.Op,
		Threshold: t.Threshold, Value: t.Value, Hysteresis: t.Hysteresis,
		DelayS: t.DelayS, State: t.State, DurationS: t.DurationS, When: t.When,
		StartMaskS: t.StartMaskS, Abs: t.Abs, Derived: t.Derived,
		ResetMode: t.ResetMode, Note: t.Note,
	}
	for _, b := range t.All {
		out.All = append(out.All, b.toTrigger())
	}
	for _, b := range t.Any {
		out.Any = append(out.Any, b.toTrigger())
	}
	return out
}

// testTable loads services/modbus/testdata/alarms/ctrl7-test.json.
func testTable(t *testing.T) []regmap.Alarm {
	t.Helper()

	raw, err := os.ReadFile(testutil.FixturePath(t, testTableFile))
	require.NoError(t, err, "reading %s", testTableFile)

	var doc jsonTable
	require.NoError(t, json.Unmarshal(raw, &doc), "decoding %s", testTableFile)
	require.NotEmpty(t, doc.Alarms, "%s declares no alarm", testTableFile)

	alarms := make([]regmap.Alarm, 0, len(doc.Alarms))
	for _, a := range doc.Alarms {
		alarms = append(alarms, regmap.Alarm{
			Code: a.Code, Bit: a.Bit, Type: a.Type, Trigger: a.Trigger.toTrigger(),
		})
	}
	return alarms
}

// rig drives an evaluator one sample at a time. It owns the sample, the
// machine state and the simulated clock, and it never touches a wall clock:
// step advances sim time by an explicit number of milliseconds.
type rig struct {
	t      *testing.T
	eval   *ctrl7.Evaluator
	values ctrl7.Values
	state  machine.State
	ts     uint64
	sample int
	before func(*rig)

	bits    uint32
	changed []ctrl7.Transition
	seen    map[string]bool
}

// newRig compiles alarms against the generated signal table and sets the
// sample to a healthy loaded run.
func newRig(t *testing.T, alarms []regmap.Alarm) *rig {
	t.Helper()

	eval, err := ctrl7.New(alarms, regmap.Signals)
	require.NoError(t, err, "compiling the alarm table")

	r := &rig{t: t, eval: eval, values: eval.NewValues(), ts: baseSimTs, seen: map[string]bool{}}
	return r.healthy()
}

// healthy sets a normal loaded run: the unit delivers air at 9.4 bar, the oil
// is warm but well inside its band, the motor draws its rated current and
// every switch rests in its normal position. No alarm of either table fires on
// it (see TestGeneratedTableIsQuietOnAHealthyRun).
func (r *rig) healthy() *rig {
	r.t.Helper()

	r.analog(tagDischargePressure, 9.7)
	r.analog(tagLinePressure, 9.4)
	r.analog(tagSeparatorPressure, 0.0)
	r.analog(tagPurgePressure, 0.0)
	r.analog(tagReservoirPressure, 9.4)
	r.analog(tagOilTemperature, 60.0)
	r.analog(tagMotorCurrent, 6.0)
	r.analog(tagAmbient, 20.0)

	r.digital(tagIntakeClosed, false)
	r.digital(tagLoadValve, true)
	r.digital(tagDryerTower, false)
	r.digital(tagRegulator, true)
	r.digital(tagLowPressure, false)
	r.digital(tagPurgeSwitch, true)
	r.digital(tagOilLevelOK, true)
	r.digital(tagFlowPulse, true)

	r.state = machine.StateLoaded
	return r
}

// loadedRun puts the unit back into a loaded run without touching the other
// signals.
func (r *rig) loadedRun() *rig {
	r.digital(tagIntakeClosed, false)
	r.digital(tagLoadValve, true)
	r.analog(tagMotorCurrent, 6.0)
	r.state = machine.StateLoaded
	return r
}

// unloadedRun leaves the motor running with the intake closed.
func (r *rig) unloadedRun() *rig {
	r.digital(tagIntakeClosed, true)
	r.digital(tagLoadValve, false)
	r.analog(tagMotorCurrent, 3.8)
	r.state = machine.StateUnloaded
	return r
}

// stopped stops the motor.
func (r *rig) stopped() *rig {
	r.digital(tagIntakeClosed, true)
	r.digital(tagLoadValve, false)
	r.analog(tagMotorCurrent, 0.0)
	r.state = machine.StateOff
	return r
}

// analog sets one analog signal of the sample.
func (r *rig) analog(tag string, value float64) *rig {
	r.t.Helper()

	idx, ok := r.eval.AnalogIndex(tag)
	require.Truef(r.t, ok, "the signal table declares no analog tag %q", tag)
	r.values.Analog[idx] = value
	return r
}

// digital sets one digital signal of the sample.
func (r *rig) digital(tag string, level bool) *rig {
	r.t.Helper()

	idx, ok := r.eval.DigitalIndex(tag)
	require.Truef(r.t, ok, "the signal table declares no digital tag %q", tag)
	r.values.Digital[idx] = level
	return r
}

// each registers a hook run at the start of every sample. It is how a test
// keeps a signal moving — the dryer changeover of a healthy run, a load cycle
// — without writing the loop out.
func (r *rig) each(hook func(*rig)) *rig {
	r.before = hook
	return r
}

// changeover is the hook of a healthy dryer: the towers swap every two
// minutes, so seconds_since_tower_change never reaches its timeout.
func changeover(r *rig) {
	r.digital(tagDryerTower, (r.sample/towerChangeEvery)%2 == 1)
}

// boot evaluates the first sample of the run, which carries a discontinuity.
func (r *rig) boot() *rig {
	r.t.Helper()
	return r.evaluate(true)
}

// step advances sim time by dtMs and evaluates the next sample.
func (r *rig) step(dtMs uint64) {
	r.t.Helper()

	r.ts += dtMs
	r.sample++
	r.evaluate(false)
}

// jump evaluates the next sample carrying a discontinuity, the way the sample
// after a jump, a reset or a collapsed source gap arrives. The spacing does
// not change: what the flag says is that the sample does not continue the
// previous one.
func (r *rig) jump() {
	r.t.Helper()

	r.ts += sampleMs
	r.sample++
	r.evaluate(true)
}

// hold evaluates n further samples dtMs apart.
func (r *rig) hold(n int, dtMs uint64) *rig {
	r.t.Helper()

	for range n {
		r.step(dtMs)
	}
	return r
}

// evaluate runs the hook and one Step.
func (r *rig) evaluate(discontinuity bool) *rig {
	r.t.Helper()

	if r.before != nil {
		r.before(r)
	}
	r.bits, r.changed = r.eval.Step(r.values, r.state, r.ts, discontinuity)
	for _, code := range r.eval.Active() {
		r.seen[code] = true
	}
	return r
}

// on reports whether the alarm is set after the last sample.
func (r *rig) on(code string) bool {
	r.t.Helper()
	return slices.Contains(r.eval.Active(), code)
}

// everOn reports whether the alarm was set after any sample of the run.
func (r *rig) everOn(code string) bool {
	return r.seen[code]
}

// seenCodes returns every alarm the run raised, sorted, so a failure names
// them.
func (r *rig) seenCodes() []string {
	codes := make([]string, 0, len(r.seen))
	for code := range r.seen {
		codes = append(codes, code)
	}
	slices.Sort(codes)
	return codes
}
