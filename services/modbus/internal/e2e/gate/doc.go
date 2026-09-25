// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package gate is the record of the signal-level scenario gate.
//
// The gate itself lives in the parent package, behind the `integration` build
// tag: it replays ten scenarios of known ground truth through the simulator,
// the gateway and a real broker and decides, for each one, whether the fault
// is visible in the telemetry that leaves the gateway.
//
// This package holds only what the run has to say afterwards: one [Scenario]
// per verdict, each carrying the [Evidence] it was reached from, and a
// [Report] that counts them and writes itself as JSON. It carries no build tag
// on purpose — the JSON summary outlives the run, and a record whose types
// only compile behind a tag is awkward to read back.
//
// Nothing here runs a machine, reads a file or knows what a scenario means;
// it is a value type with a threshold rule.
package gate
