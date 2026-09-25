// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7_test

import (
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// scenario is a run of the generated alarm table over `steps` samples ten
// seconds apart, starting from a healthy loaded run. drive is applied to every
// sample after the healthy dryer changeover, so a case only states what it
// changes.
type scenario struct {
	steps int
	drive func(*rig)
}

// alarmCase pairs the run that must raise one generated message with a run
// that must not, so every bit of the table is exercised from both sides.
type alarmCase struct {
	code  string
	fire  scenario
	quiet scenario
}

// analogAt returns a drive that pins one analog signal.
func analogAt(tag string, value float64) func(*rig) {
	return func(r *rig) { r.analog(tag, value) }
}

// digitalAt returns a drive that pins one digital signal.
func digitalAt(tag string, level bool) func(*rig) {
	return func(r *rig) { r.digital(tag, level) }
}

// cycleLoad alternates loaded and unloaded runs every period samples, so no
// loaded run reaches the continuous-load timeout.
func cycleLoad(period int) func(*rig) {
	return func(r *rig) {
		if (r.sample/period)%2 == 1 {
			r.unloadedRun()
		} else {
			r.loadedRun()
		}
	}
}

// startEvery stops and restarts the motor on alternate samples for the first
// `starts` restarts, then leaves it loaded. Each restart is an off → running
// transition and therefore one motor start.
func startEvery(starts int) func(*rig) {
	return func(r *rig) {
		if r.sample < 2*starts && r.sample%2 == 0 {
			r.stopped()
		} else {
			r.loadedRun()
		}
	}
}

// generatedCases states, for every message of the generated table, a run that
// raises it and a run that does not. The thresholds come from
// manual/spec/alarms.yaml through packages/contracts; the values below stay
// inside the neighbouring messages' bands wherever the table allows it, so a
// case exercises the bit it names.
func generatedCases() []alarmCase {
	return []alarmCase{
		{
			code:  "W101", // low_pressure_switch == 1 for 10 s
			fire:  scenario{steps: 3, drive: digitalAt(tagLowPressure, true)},
			quiet: scenario{steps: 3, drive: digitalAt(tagLowPressure, false)},
		},
		{
			code:  "W102", // loaded for 600 s without interruption
			fire:  scenario{steps: 62},
			quiet: scenario{steps: 62, drive: cycleLoad(20)},
		},
		{
			code:  "W103", // dryer_purge_pressure > 0.5 bar for 60 s while loaded
			fire:  scenario{steps: 8, drive: analogAt(tagPurgePressure, 0.8)},
			quiet: scenario{steps: 8, drive: analogAt(tagPurgePressure, 0.4)},
		},
		{
			code:  "W104", // oil_temperature > 75 °C for 300 s while running
			fire:  scenario{steps: 32, drive: analogAt(tagOilTemperature, 80)},
			quiet: scenario{steps: 32, drive: analogAt(tagOilTemperature, 70)},
		},
		{
			code:  "W105", // oil_temperature < 5 °C for 60 s
			fire:  scenario{steps: 8, drive: analogAt(tagOilTemperature, 1)},
			quiet: scenario{steps: 8, drive: analogAt(tagOilTemperature, 10)},
		},
		{
			code:  "W106", // motor_current > 7.5 A for 60 s while loaded
			fire:  scenario{steps: 8, drive: analogAt(tagMotorCurrent, 8.0)},
			quiet: scenario{steps: 8, drive: analogAt(tagMotorCurrent, 7.0)},
		},
		{
			code:  "W107", // motor_current < 5 A for 60 s while loaded
			fire:  scenario{steps: 8, drive: analogAt(tagMotorCurrent, 4.0)},
			quiet: scenario{steps: 8, drive: analogAt(tagMotorCurrent, 6.0)},
		},
		{
			code:  "W108", // motor_starts_per_hour > 6
			fire:  scenario{steps: 15, drive: startEvery(7)},
			quiet: scenario{steps: 15, drive: startEvery(3)},
		},
		{
			code:  "W109", // ambient_temperature > 40 °C for 600 s
			fire:  scenario{steps: 62, drive: analogAt(tagAmbient, 45)},
			quiet: scenario{steps: 62, drive: analogAt(tagAmbient, 20)},
		},
		{
			code:  "W110", // ambient_temperature < 2 °C for 600 s
			fire:  scenario{steps: 62, drive: analogAt(tagAmbient, 0)},
			quiet: scenario{steps: 62, drive: analogAt(tagAmbient, 20)},
		},
		{
			code:  "W111", // seconds_since_tower_change > 180 s while loaded
			fire:  scenario{steps: 20, drive: digitalAt(tagDryerTower, false)},
			quiet: scenario{steps: 20},
		},
		{
			code:  "W112", // separator_discharge_pressure > 0.5 bar for 60 s while loaded
			fire:  scenario{steps: 8, drive: analogAt(tagSeparatorPressure, 0.8)},
			quiet: scenario{steps: 8, drive: analogAt(tagSeparatorPressure, 0.2)},
		},
		{
			code:  "W113", // |reservoir − line| > 0.5 bar for 60 s
			fire:  scenario{steps: 8, drive: analogAt(tagReservoirPressure, 10.5)},
			quiet: scenario{steps: 8, drive: analogAt(tagReservoirPressure, 9.6)},
		},
		{
			code:  "W114", // flow_pulse == 0 for 120 s while loaded
			fire:  scenario{steps: 14, drive: digitalAt(tagFlowPulse, false)},
			quiet: scenario{steps: 14, drive: digitalAt(tagFlowPulse, true)},
		},
		{
			code:  "W115", // purge_switch == 0 for 120 s while loaded
			fire:  scenario{steps: 14, drive: digitalAt(tagPurgeSwitch, false)},
			quiet: scenario{steps: 14, drive: digitalAt(tagPurgeSwitch, true)},
		},
		{
			code:  "W116", // oil_level_ok == 0 for 300 s
			fire:  scenario{steps: 32, drive: digitalAt(tagOilLevelOK, false)},
			quiet: scenario{steps: 32, drive: digitalAt(tagOilLevelOK, true)},
		},
		{
			code:  "W117", // discharge − line > 1 bar for 60 s while loaded
			fire:  scenario{steps: 8, drive: analogAt(tagDischargePressure, 10.8)},
			quiet: scenario{steps: 8, drive: analogAt(tagDischargePressure, 9.7)},
		},
		{
			code:  "X201", // oil_temperature > 85 °C for 30 s while running
			fire:  scenario{steps: 5, drive: analogAt(tagOilTemperature, 90)},
			quiet: scenario{steps: 5, drive: analogAt(tagOilTemperature, 80)},
		},
		{
			code:  "X202", // discharge_pressure > 11 bar for 10 s
			fire:  scenario{steps: 3, drive: analogAt(tagDischargePressure, 11.2)},
			quiet: scenario{steps: 3, drive: analogAt(tagDischargePressure, 10.5)},
		},
		{
			code:  "X203", // motor_current > 8.5 A for 30 s while loaded
			fire:  scenario{steps: 5, drive: analogAt(tagMotorCurrent, 9.0)},
			quiet: scenario{steps: 5, drive: analogAt(tagMotorCurrent, 8.0)},
		},
		{
			code:  "X204", // line_pressure > 10.5 bar for 30 s while loaded
			fire:  scenario{steps: 5, drive: analogAt(tagLinePressure, 10.8)},
			quiet: scenario{steps: 5, drive: analogAt(tagLinePressure, 10.0)},
		},
		{
			code:  "S301", // oil_temperature > 95 °C for 5 s while running
			fire:  scenario{steps: 3, drive: analogAt(tagOilTemperature, 100)},
			quiet: scenario{steps: 3, drive: analogAt(tagOilTemperature, 90)},
		},
		{
			code:  "S302", // discharge_pressure > 11.5 bar for 5 s
			fire:  scenario{steps: 3, drive: analogAt(tagDischargePressure, 12)},
			quiet: scenario{steps: 3, drive: analogAt(tagDischargePressure, 11.2)},
		},
		{
			code:  "S303", // motor_current > 9.5 A for 5 s while loaded
			fire:  scenario{steps: 3, drive: analogAt(tagMotorCurrent, 10)},
			quiet: scenario{steps: 3, drive: analogAt(tagMotorCurrent, 9.0)},
		},
		{
			code:  "S304", // load valve open and motor below 1 A for 20 s
			fire:  scenario{steps: 4, drive: analogAt(tagMotorCurrent, 0.5)},
			quiet: scenario{steps: 4, drive: analogAt(tagMotorCurrent, 6.0)},
		},
		{
			code:  "S305", // line_pressure outside [−0.5, 15.5] bar for 10 s
			fire:  scenario{steps: 3, drive: analogAt(tagLinePressure, 16)},
			quiet: scenario{steps: 3, drive: analogAt(tagLinePressure, 9.4)},
		},
		{
			code:  "S306", // oil_temperature outside [−15, 115] °C for 10 s
			fire:  scenario{steps: 3, drive: analogAt(tagOilTemperature, 120)},
			quiet: scenario{steps: 3, drive: analogAt(tagOilTemperature, 60)},
		},
	}
}

// runScenario evaluates one scenario over the generated alarm table.
func runScenario(t *testing.T, s scenario) *rig {
	t.Helper()

	r := newRig(t, regmap.Alarms)
	r.each(func(r *rig) {
		changeover(r)
		if s.drive != nil {
			s.drive(r)
		}
	})
	r.boot()
	return r.hold(s.steps-1, sampleMs)
}

func TestAlarmGeneratedTableCoversEveryBit(t *testing.T) {
	t.Parallel()

	covered := make([]string, 0, len(generatedCases()))
	for _, c := range generatedCases() {
		covered = append(covered, c.code)
	}
	declared := make([]string, 0, len(regmap.Alarms))
	for _, a := range regmap.Alarms {
		declared = append(declared, a.Code)
	}

	assert.ElementsMatch(t, declared, covered,
		"every generated message needs a firing and a non-firing case")
}

func TestAlarmGeneratedTableFiresAndStaysQuiet(t *testing.T) {
	t.Parallel()

	for _, c := range generatedCases() {
		bit := alarmBit(t, regmap.Alarms, c.code)

		t.Run(c.code+"/fires", func(t *testing.T) {
			t.Parallel()

			r := runScenario(t, c.fire)
			assert.NotZerof(t, r.bits&(uint32(1)<<bit), "%s must be set after its firing run; active: %v",
				c.code, r.eval.Active())
		})

		t.Run(c.code+"/quiet", func(t *testing.T) {
			t.Parallel()

			r := runScenario(t, c.quiet)
			assert.Falsef(t, r.everOn(c.code), "%s must stay clear through its quiet run", c.code)
		})
	}
}

func TestAlarmGeneratedTableIsQuietOnAHealthyRun(t *testing.T) {
	t.Parallel()

	// Just under the ten minutes of W102, which is the shortest message a
	// perfectly normal loaded run would eventually raise.
	r := runScenario(t, scenario{steps: 59})
	assert.Empty(t, r.seenCodes(), "a healthy loaded run raises no message")
}

func TestAlarmActiveMatchesRegmapAlarmCodes(t *testing.T) {
	t.Parallel()

	r := newRig(t, regmap.Alarms)
	r.digital(tagLowPressure, true). // W101, bit 0
						analog(tagOilTemperature, 120). // W104, X201, S301 and S306
						analog(tagDischargePressure, 12).
						boot().
						hold(60, sampleMs)

	active := r.eval.Active()
	require.NotEmpty(t, active)
	assert.Equal(t, regmap.AlarmCodes(r.bits), active,
		"Active must pack the bits the way the codec unpacks them")
	assert.True(t, slices.IsSortedFunc(active, func(a, b string) int {
		return int(alarmBit(t, regmap.Alarms, a)) - int(alarmBit(t, regmap.Alarms, b))
	}), "the codes come in ascending bit order")
}
