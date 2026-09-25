// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package ctrl7 emulates the alarm logic of the CTRL-7 controller.
//
// The simulator is the machine and its controller (docs/simulation.md,
// "Controller alarms"): for every emitted sample it evaluates the generated
// regmap.Alarms triggers over the sample's values and the machine state, and
// packs the result into the slot's alarm_bits field. This package is that
// evaluation and nothing else — it holds no clock, no registers and no
// transport, so it is a pure function of the samples it is fed.
//
// The trigger grammar is the manual's machine-evaluable one, translated by the
// contracts generator into regmap.Trigger and implemented here in full: the
// kinds threshold, digital, state_duration, differential, derived and
// composite, the trigger-state guard When (with running = loaded ∪ unloaded),
// the motor-start mask StartMaskS, the hysteresis reset band and the reset
// modes auto, auto_hysteresis, manual and manual_service. The six derived
// quantities of manual/spec/signals.yaml are accumulated incrementally here as
// well, because the controller — not the backend — is what owns them.
//
// Two rules bind every timer in this package. The first is that delays run on
// simulated time: Step is given the sim timestamp of the sample and never
// reads a wall clock, so an alarm fires at the same sample whether the replay
// runs at 1× or at 3600×. The second is that a discontinuity (boot, a jump, a
// reset, a collapsed source gap or a loop wrap) is not a continuation: pending
// delays start over, the derived quantities start from zero, manual latches
// are released, and a bit that is already set survives only while its
// condition still holds at that sample.
//
// This package is the owner of the trigger semantics: the TypeScript port used
// by the evaluation harness must produce the same alarm list for the same
// samples, and a difference between the two is fixed here.
//
// It imports only internal/regmap and internal/machine, so the injection
// engine and the simulator engine can both depend on it without a cycle.
package ctrl7
