// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package injection overlays fault signatures on the replayed sample values.
//
// The model is the one of docs/simulation.md, "Fault injection": an injection
// type (a Definition, loaded from packages/ground-truth/data/injections.json)
// is a list of per-tag transforms built from seven primitives, each guarded by
// a machine state, under a trapezoid envelope in simulated time. An Instance
// is one running copy of a definition, created by the control plane's inject
// command with its own magnitude and duration.
//
// The package is pure: it reads the catalog file once and afterwards computes
// only over Values. It never sees a timestamp field, a sequence number or a
// register — Apply mutates nothing but the value slices it is handed, and the
// machine state it conditions on is computed by the caller from the untouched
// source row, so an overlay can never change the state that decides whether it
// applies. Timestamps, sequence numbers and the recorded cycle timing stay
// exactly as the recording has them (a known limitation of the model).
//
// It imports internal/regmap for the signal table and internal/machine for the
// load state, and nothing else of the module: the simulator engine, the replay
// source and the gateway are all above it. Ground truth about an injection
// leaves the simulator only on gt/<unit>/#, never on plant/#; this package
// hands the caller the facts to publish and publishes nothing itself.
//
// An Engine is owned by one goroutine — the simulator loop that calls Apply.
// Start, Expire, StopAll and Active mutate the same instance list, so a
// caller that accepts control commands on another goroutine serialises them
// with the loop.
package injection
