// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package regmap holds the Modbus register model of the CAU-7 emulator: the
// hand-written address layout, the generated signal and alarm tables, and the
// codec that turns a sample into registers and back.
//
// The split is the contract with the contracts package (docs/simulation.md,
// "The register map from signals.yaml"): everything with an address lives in
// the hand-written layout.go, and register_map_gen.go — generated from
// manual/spec/signals.yaml and alarms.yaml — carries only signal order,
// scales, units and alarm bits. Simulator code therefore never hard-codes a
// tag id: the replay maps CSV columns to tags through Signal.Column, the codec
// places values through Signal.Offset, and the gateway emits
// values[Signal.Tag].
//
// The layout itself: a 14-register header at address 0 and a ring of 256 slots
// of 32 registers at address 1024, written slot-then-header under one lock so
// a reader never sees a half-written sample.
package regmap
