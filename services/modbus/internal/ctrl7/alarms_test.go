// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package ctrl7_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/machine"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// The codes of testdata/alarms/ctrl7-test.json.
const (
	codeThreshold     = "T001" // oil_temperature > 75 °C for 300 s while running, hysteresis 5
	codeDigital       = "T002" // low_pressure_switch == 1, no delay
	codeStateDuration = "T003" // loaded for 600 s
	codeDifferential  = "T004" // |reservoir − line| > 0.5 bar for 60 s, hysteresis 0.1
	codeStarts        = "T005" // motor_starts_per_hour > 2
	codeTowerChange   = "T006" // seconds_since_tower_change > 180 s while loaded
	codeStartMask     = "T007" // motor_current > 7.5 A while loaded, masked 15 s after a start
	codeCompositeAll  = "T008" // load valve open and motor below 1 A for 20 s, manual reset
	codeCompositeAny  = "T009" // line pressure outside [−0.5, 15.5] bar for 10 s, manual reset
	codeUnknownKind   = "T010" // a kind this evaluator does not implement
)

// alarmBit returns the bit an alarm table gives a code.
func alarmBit(t *testing.T, alarms []regmap.Alarm, code string) uint8 {
	t.Helper()

	for _, a := range alarms {
		if a.Code == code {
			return a.Bit
		}
	}
	t.Fatalf("the alarm table declares no %s", code)
	return 0
}

func TestAlarmTableIsValidated(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		alarms []regmap.Alarm
		msg    string
	}{
		{
			name: "duplicate bit",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 3, Trigger: regmap.Trigger{Kind: ctrl7.KindDigital, Signal: tagFlowPulse}},
				{Code: "T002", Bit: 3, Trigger: regmap.Trigger{Kind: ctrl7.KindDigital, Signal: tagPurgeSwitch}},
			},
			msg: "share bit 3",
		},
		{
			name: "bit outside the alarm_bits field",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 32, Trigger: regmap.Trigger{Kind: ctrl7.KindDigital, Signal: tagFlowPulse}},
			},
			msg: "outside 0..31",
		},
		{
			name: "alarm without a code",
			alarms: []regmap.Alarm{
				{Bit: 0, Trigger: regmap.Trigger{Kind: ctrl7.KindDigital, Signal: tagFlowPulse}},
			},
			msg: "has no code",
		},
		{
			name: "unknown tag",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindThreshold, Signal: "condenser_pressure", Op: "gt", Threshold: 1,
				}},
			},
			msg: `unknown signal "condenser_pressure"`,
		},
		{
			name: "analog tag read as a digital",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{Kind: ctrl7.KindDigital, Signal: tagOilTemperature}},
			},
			msg: "is analog, not digital",
		},
		{
			name: "digital tag read as an analog",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindThreshold, Signal: tagFlowPulse, Op: "gt", Threshold: 1,
				}},
			},
			msg: "is digital, not analog",
		},
		{
			name: "unknown comparison operator",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindThreshold, Signal: tagOilTemperature, Op: "ge", Threshold: 1,
				}},
			},
			msg: `unknown comparison operator "ge"`,
		},
		{
			name: "unknown trigger state",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindThreshold, Signal: tagOilTemperature, Op: "gt", Threshold: 1, When: "purging",
				}},
			},
			msg: `unknown trigger state "purging"`,
		},
		{
			name: "unknown machine state",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindStateDuration, State: "idling", DurationS: 10,
				}},
			},
			msg: `unknown machine state "idling"`,
		},
		{
			name: "unknown reset mode",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindDigital, Signal: tagFlowPulse, ResetMode: "latched",
				}},
			},
			msg: `unknown reset mode "latched"`,
		},
		{
			name: "unknown derived quantity",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindDerived, Op: "gt", Threshold: 1, Derived: "purge_cycles_per_hour",
				}},
			},
			msg: `unknown derived quantity "purge_cycles_per_hour"`,
		},
		{
			name: "composite without a branch",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{Kind: ctrl7.KindComposite, DelayS: 5}},
			},
			msg: "declares no branch",
		},
		{
			name: "composite with both branch kinds",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindComposite,
					All:  []regmap.Trigger{{Kind: ctrl7.KindDigital, Signal: tagFlowPulse}},
					Any:  []regmap.Trigger{{Kind: ctrl7.KindDigital, Signal: tagPurgeSwitch}},
				}},
			},
			msg: "declares both all and any",
		},
		{
			name: "composite branch that is itself composite",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindComposite,
					All:  []regmap.Trigger{{Kind: ctrl7.KindComposite}},
				}},
			},
			msg: "cannot be a composite branch",
		},
		{
			name: "negative delay",
			alarms: []regmap.Alarm{
				{Code: "T001", Bit: 0, Trigger: regmap.Trigger{
					Kind: ctrl7.KindDigital, Signal: tagFlowPulse, DelayS: -1,
				}},
			},
			msg: "negative delay_s",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := ctrl7.New(tc.alarms, regmap.Signals)
			require.Error(t, err)
			assert.ErrorContains(t, err, tc.msg)
		})
	}
}

func TestAlarmTableNeedsTheDerivedInputSignals(t *testing.T) {
	t.Parallel()

	// dryer_tower feeds seconds_since_tower_change, which belongs to the
	// controller rather than to one alarm.
	partial := make([]regmap.Signal, 0, len(regmap.Signals))
	for _, s := range regmap.Signals {
		if s.Tag != tagDryerTower {
			partial = append(partial, s)
		}
	}

	_, err := ctrl7.New(testTable(t), partial)
	require.Error(t, err)
	assert.ErrorContains(t, err, `derived quantities: unknown signal "dryer_tower"`)
}

func TestAlarmUnknownTriggerKindIsAcceptedAndNeverFires(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	// The unknown trigger of the fixture would hold on every sample of this
	// run if it were implemented: line_pressure / discharge_pressure is
	// meaningless, but its threshold comparison is satisfied by the values.
	r.analog(tagLinePressure, 20).analog(tagDischargePressure, 1).boot().hold(30, sampleMs)

	assert.False(t, r.everOn(codeUnknownKind), "an unsupported trigger kind must never set its bit")
}

func TestAlarmThresholdFiresOnTheFirstSampleAfterTheDelay(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagOilTemperature, 80).boot()

	r.hold(29, sampleMs) // sim time 290 s
	assert.False(t, r.on(codeThreshold), "the delay of 300 s has not elapsed at 290 s")

	r.step(sampleMs) // sim time 300 s
	assert.True(t, r.on(codeThreshold), "the delay of 300 s has elapsed at 300 s")
	assert.Equal(t, []ctrl7.Transition{{
		Code: codeThreshold, Bit: alarmBit(t, testTable(t), codeThreshold), Active: true, SimTsMs: r.ts,
	}}, r.changed)
}

func TestAlarmDelayCountsSimTimeNotSamples(t *testing.T) {
	t.Parallel()

	// No test in this file sleeps: sim time is advanced by hand, so the same
	// 300 s delay elapses in two samples or in thirty, and a replay at 3600×
	// raises the alarm at the same row as one at 1×.
	coarse := newRig(t, testTable(t))
	coarse.analog(tagOilTemperature, 80).boot().step(299_000)
	assert.False(t, coarse.on(codeThreshold), "299 s of sim time is not the 300 s delay")
	coarse.step(1_000)
	assert.True(t, coarse.on(codeThreshold), "two samples 300 s apart are enough")

	fine := newRig(t, testTable(t))
	fine.analog(tagOilTemperature, 80).boot().hold(300, 1_000)
	assert.True(t, fine.on(codeThreshold), "three hundred samples 1 s apart are the same 300 s")
	assert.Equal(t, coarse.ts, fine.ts, "both runs stand at the same simulated instant")
}

func TestAlarmThresholdHysteresisHoldsTheBitInsideTheResetBand(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagOilTemperature, 80).boot().hold(30, sampleMs)
	require.True(t, r.on(codeThreshold))

	r.analog(tagOilTemperature, 72).step(sampleMs)
	assert.True(t, r.on(codeThreshold), "72 °C is inside the 75 − 5 reset band")

	r.analog(tagOilTemperature, 69.9).step(sampleMs)
	assert.False(t, r.on(codeThreshold), "69.9 °C is beyond the reset band")

	// Coming back into the band does not re-raise the alarm: the strict
	// comparison applies again once the bit is clear.
	r.analog(tagOilTemperature, 72).hold(40, sampleMs)
	assert.False(t, r.on(codeThreshold), "72 °C is below the 75 °C threshold")
}

func TestAlarmWhenGuardKeepsItQuietInTheWrongState(t *testing.T) {
	t.Parallel()

	// T001 is guarded by `running`, the union of loaded and unloaded.
	off := newRig(t, testTable(t))
	off.analog(tagOilTemperature, 120).stopped().boot().hold(60, sampleMs)
	assert.False(t, off.everOn(codeThreshold), "a running-only alarm must not fire while the motor is off")

	unloaded := newRig(t, testTable(t))
	unloaded.analog(tagOilTemperature, 120).unloadedRun().boot().hold(30, sampleMs)
	assert.True(t, unloaded.on(codeThreshold), "unloaded is part of running")

	// T007 is guarded by `loaded` alone.
	loadedOnly := newRig(t, testTable(t))
	loadedOnly.analog(tagMotorCurrent, 9).unloadedRun().boot().hold(30, sampleMs)
	assert.False(t, loadedOnly.everOn(codeStartMask), "a loaded-only alarm must not fire while unloaded")
}

func TestAlarmWhenGuardClearsAnActiveBitOnAStateChange(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagOilTemperature, 120).boot().hold(30, sampleMs)
	require.True(t, r.on(codeThreshold))

	r.stopped().step(sampleMs)
	assert.False(t, r.on(codeThreshold), "the guard no longer holds, so the bit clears")
}

func TestAlarmDigitalWithoutDelayFiresOnTheSampleItself(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.digital(tagLowPressure, true).boot()
	assert.True(t, r.on(codeDigital), "a digital trigger with delay 0 fires on the first sample")

	r.digital(tagLowPressure, false).step(sampleMs)
	assert.False(t, r.on(codeDigital), "it clears as soon as the signal changes")
}

func TestAlarmStateDurationFiresAtItsDurationAndClearsOnTheFirstOtherState(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.boot().hold(59, sampleMs) // sim time 590 s of a loaded run
	assert.False(t, r.on(codeStateDuration))

	r.step(sampleMs) // 600 s
	assert.True(t, r.on(codeStateDuration))
	assert.InDelta(t, 10.0, r.eval.Derived().ContinuousLoadTime, 1e-9, "600 s is ten minutes of continuous load")

	r.unloadedRun().step(sampleMs)
	assert.False(t, r.on(codeStateDuration), "the run ended, so the message clears")
	assert.Zero(t, r.eval.Derived().ContinuousLoadTime)
}

func TestAlarmDifferentialUsesTheAbsoluteDifferenceAndItsResetBand(t *testing.T) {
	t.Parallel()

	// The reservoirs are 0.8 bar *below* the line, which the abs form catches.
	r := newRig(t, testTable(t))
	r.analog(tagReservoirPressure, 8.6).boot().hold(5, sampleMs)
	assert.False(t, r.on(codeDifferential), "the delay of 60 s has not elapsed at 50 s")

	r.step(sampleMs)
	assert.True(t, r.on(codeDifferential))
	assert.InDelta(t, 0.8, r.eval.Derived().ReservoirLineDelta, 1e-9)

	r.analog(tagReservoirPressure, 8.95).step(sampleMs) // delta 0.45, inside 0.5 − 0.1
	assert.True(t, r.on(codeDifferential), "0.45 bar is inside the reset band")

	r.analog(tagReservoirPressure, 9.05).step(sampleMs) // delta 0.35
	assert.False(t, r.on(codeDifferential))
}

func TestAlarmStartMaskIgnoresTheConditionAfterAMotorStart(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.stopped().boot()

	// The motor starts with a current well above the threshold of T007.
	r.loadedRun().analog(tagMotorCurrent, 9).step(sampleMs)
	assert.False(t, r.on(codeStartMask), "the condition is masked for 15 s after the start")

	r.step(sampleMs) // 10 s after the start
	assert.False(t, r.on(codeStartMask), "still inside the 15 s mask")

	r.step(sampleMs) // 20 s after the start
	assert.True(t, r.on(codeStartMask), "the mask has expired")
}

func TestAlarmCompositeAllNeedsEveryBranch(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	// The load valve is open but the motor draws its rated current.
	r.boot().hold(4, sampleMs)
	assert.False(t, r.everOn(codeCompositeAll))

	// The motor stalls: both branches now hold.
	r.analog(tagMotorCurrent, 0.4).step(sampleMs)
	assert.False(t, r.on(codeCompositeAll), "the delay of 20 s has not elapsed")
	r.step(sampleMs)
	assert.False(t, r.on(codeCompositeAll), "10 s of the 20 s delay")
	r.step(sampleMs)
	assert.True(t, r.on(codeCompositeAll))
}

func TestAlarmCompositeAnyNeedsOneBranch(t *testing.T) {
	t.Parallel()

	low := newRig(t, testTable(t))
	low.analog(tagLinePressure, -0.7).boot().step(sampleMs)
	assert.True(t, low.on(codeCompositeAny), "the lower branch holds for the 10 s delay")

	high := newRig(t, testTable(t))
	high.analog(tagLinePressure, 16).boot().step(sampleMs)
	assert.True(t, high.on(codeCompositeAny), "the upper branch holds for the 10 s delay")

	inside := newRig(t, testTable(t))
	inside.analog(tagLinePressure, 9.4).boot().hold(10, sampleMs)
	assert.False(t, inside.everOn(codeCompositeAny), "neither branch holds")
}

func TestAlarmManualResetKeepsTheBitSetUntilReset(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagMotorCurrent, 0.4).boot().hold(2, sampleMs)
	require.True(t, r.on(codeCompositeAll), "the shutdown message is raised after 20 s")

	// The fault clears, but a manual-reset message stays on the panel.
	r.analog(tagMotorCurrent, 6).hold(5, sampleMs)
	assert.True(t, r.on(codeCompositeAll), "a manual reset mode latches the bit")

	bits, changed := r.eval.Reset(r.ts)
	assert.Zero(t, bits&(uint32(1)<<alarmBit(t, testTable(t), codeCompositeAll)))
	assert.Equal(t, []ctrl7.Transition{{
		Code: codeCompositeAll, Bit: alarmBit(t, testTable(t), codeCompositeAll), Active: false, SimTsMs: r.ts,
	}}, changed)
}

func TestAlarmManualResetDoesNotAcknowledgeAFaultThatStillHolds(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagMotorCurrent, 0.4).boot().hold(2, sampleMs)
	require.True(t, r.on(codeCompositeAll))

	bits, changed := r.eval.Reset(r.ts)
	assert.NotZero(t, bits&(uint32(1)<<alarmBit(t, testTable(t), codeCompositeAll)),
		"the condition still holds, so the bit comes straight back")
	assert.Empty(t, changed)
}

func TestAlarmDiscontinuityReleasesAManualLatch(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagMotorCurrent, 0.4).boot().hold(2, sampleMs)
	require.True(t, r.on(codeCompositeAll))

	r.analog(tagMotorCurrent, 6).jump()
	assert.False(t, r.on(codeCompositeAll), "a jump is not a continuation of the run")
	require.Len(t, r.changed, 1)
	assert.False(t, r.changed[0].Active)
}

func TestAlarmDiscontinuityRestartsAHalfElapsedDelay(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagOilTemperature, 80).boot().hold(15, sampleMs) // 150 s of the 300 s delay
	require.False(t, r.on(codeThreshold))

	r.jump() // the source gap collapses; sim time is now 160 s
	restart := r.ts

	r.hold(29, sampleMs)
	assert.False(t, r.on(codeThreshold), "the delay started again at the discontinuity")
	r.step(sampleMs)
	assert.True(t, r.on(codeThreshold))
	assert.Equal(t, restart+300_000, r.ts, "the alarm fires 300 s after the discontinuity")
}

func TestAlarmDiscontinuityKeepsAnActiveBitWhoseConditionStillHolds(t *testing.T) {
	t.Parallel()

	kept := newRig(t, testTable(t))
	kept.each(changeover).analog(tagOilTemperature, 80).boot().hold(30, sampleMs)
	require.True(t, kept.on(codeThreshold))
	kept.jump()
	assert.True(t, kept.on(codeThreshold), "the condition still holds at the sample that carries the flag")
	assert.Empty(t, kept.changed, "no bit changed, so the discontinuity produces no transition")

	dropped := newRig(t, testTable(t))
	dropped.each(changeover).analog(tagOilTemperature, 80).boot().hold(30, sampleMs)
	require.True(t, dropped.on(codeThreshold))
	dropped.analog(tagOilTemperature, 40).jump()
	assert.False(t, dropped.on(codeThreshold), "the condition no longer holds, so the bit goes")
}

func TestAlarmDerivedMotorStartsPerHourSlidesItsWindow(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.stopped().boot()
	for range 3 {
		r.loadedRun().step(sampleMs)
		r.stopped().step(sampleMs)
	}
	assert.InDelta(t, 3.0, r.eval.Derived().MotorStartsPerHour, 1e-9)
	assert.True(t, r.on(codeStarts), "three starts exceed the limit of two")

	// An hour of sim time later the starts have left the window.
	r.step(3_600_000)
	assert.Zero(t, r.eval.Derived().MotorStartsPerHour)
	assert.False(t, r.on(codeStarts))
}

func TestAlarmDerivedSecondsSinceTowerChange(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.boot().hold(18, sampleMs) // 180 s without a changeover
	assert.False(t, r.on(codeTowerChange), "180 s is not yet beyond the timeout")

	r.step(sampleMs)
	assert.InDelta(t, 190.0, r.eval.Derived().SecondsSinceTowerChange, 1e-9)
	assert.True(t, r.on(codeTowerChange))

	// The dryer changes over: the counter and the message clear.
	r.digital(tagDryerTower, true).step(sampleMs)
	assert.Zero(t, r.eval.Derived().SecondsSinceTowerChange)
	assert.False(t, r.on(codeTowerChange))

	// The counter is meaningless while the unit is not loaded, so a long stop
	// cannot raise the message on the next loaded run.
	r.unloadedRun().hold(60, sampleMs)
	assert.Zero(t, r.eval.Derived().SecondsSinceTowerChange)
	r.loadedRun().step(sampleMs)
	assert.False(t, r.on(codeTowerChange))
}

func TestAlarmDerivedQuantitiesAccumulateAndResetOnDiscontinuity(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.analog(tagReservoirPressure, 10.0).analog(tagDischargePressure, 10.4).boot()
	r.hold(6, sampleMs) // 60 s of a loaded run

	got := r.eval.Derived()
	assert.InDelta(t, 0.6, got.ReservoirLineDelta, 1e-9, "|10.0 − 9.4|")
	assert.InDelta(t, 1.0, got.DischargeLineDelta, 1e-9, "10.4 − 9.4")
	assert.InDelta(t, 1.0, got.ContinuousLoadTime, 1e-9, "60 s is one minute")
	assert.InDelta(t, 60.0/3600.0, got.RunHours, 1e-9)
	assert.InDelta(t, 60.0, got.SecondsSinceTowerChange, 1e-9)

	// The motor runs on unloaded: run_hours keeps counting, the load time does
	// not.
	r.unloadedRun().hold(6, sampleMs)
	got = r.eval.Derived()
	assert.Zero(t, got.ContinuousLoadTime)
	assert.InDelta(t, 120.0/3600.0, got.RunHours, 1e-9)

	r.jump()
	got = r.eval.Derived()
	assert.Zero(t, got.RunHours, "a discontinuity starts the accumulators again")
	assert.Zero(t, got.ContinuousLoadTime)
	assert.Zero(t, got.SecondsSinceTowerChange)
	assert.Zero(t, got.MotorStartsPerHour)
	assert.InDelta(t, 0.6, got.ReservoirLineDelta, 1e-9, "an instantaneous quantity survives")
}

func TestAlarmTransitionsReportBothEdgesInBitOrder(t *testing.T) {
	t.Parallel()

	r := newRig(t, testTable(t))
	r.digital(tagLowPressure, true).analog(tagLinePressure, 16).boot()
	require.Equal(t, []ctrl7.Transition{{
		Code: codeDigital, Bit: alarmBit(t, testTable(t), codeDigital), Active: true, SimTsMs: r.ts,
	}}, r.changed, "only the undelayed alarm fires on the first sample")

	r.step(sampleMs)
	require.Len(t, r.changed, 1)
	assert.Equal(t, codeCompositeAny, r.changed[0].Code, "the 10 s composite follows")

	r.digital(tagLowPressure, false).analog(tagLinePressure, 9.4).jump()
	require.Len(t, r.changed, 2)
	assert.Equal(t, []string{codeDigital, codeCompositeAny},
		[]string{r.changed[0].Code, r.changed[1].Code}, "clearing edges come in bit order")
	assert.False(t, r.changed[0].Active)
	assert.False(t, r.changed[1].Active)
	assert.Zero(t, r.bits)
	assert.Empty(t, r.eval.Active())
}

func TestAlarmStepPanicsOnASampleThatDoesNotMatchTheSignalTable(t *testing.T) {
	t.Parallel()

	eval, err := ctrl7.New(testTable(t), regmap.Signals)
	require.NoError(t, err)

	assert.PanicsWithValue(t,
		"ctrl7: Step wants 8 analog and 8 digital values, got 2 and 8",
		func() {
			eval.Step(ctrl7.Values{Analog: make([]float64, 2), Digital: make([]bool, 8)},
				machine.StateLoaded, baseSimTs, true)
		})
}

func TestAlarmValuesMatchTheSignalTable(t *testing.T) {
	t.Parallel()

	eval, err := ctrl7.New(testTable(t), regmap.Signals)
	require.NoError(t, err)

	v := eval.NewValues()
	var analog, digital int
	for _, s := range regmap.Signals {
		switch s.Kind {
		case regmap.KindAnalog:
			analog++
		case regmap.KindDigital:
			digital++
		}
	}
	assert.Len(t, v.Analog, analog)
	assert.Len(t, v.Digital, digital)

	// The synthetic extra is the last analog entry, which is what the emit
	// loop relies on when it writes the ambient temperature.
	idx, ok := eval.AnalogIndex(tagAmbient)
	require.True(t, ok)
	assert.Equal(t, analog-1, idx)
}
