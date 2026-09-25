// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package e2e holds the full-stack proof of the simulator and the gateway.
//
// It has no code of its own: every file beside this one carries the
// `integration` build tag and runs the simulator, the gateway and a real
// Mosquitto container together, which is why the package may import both
// halves of the module at once — it is a test, not a binary, so the import
// boundary does not apply to it.
//
// The five scenarios are one test function each:
//
//   - ScenarioA — ordering, discontinuity placement and no loss at 3600×;
//   - ScenarioB — the seven control commands and their acknowledgements;
//   - ScenarioC — injections, the isolation rule and the alarm bits;
//   - ScenarioD — the broker ACL (only with infra/mosquitto in the checkout);
//   - ScenarioE — a broker restart and a simulator restart.
//
// Throughput, rate windows and acknowledgement latency live in timing_test.go
// behind `integration && !race` and scale with FDP_TIMING_SLACK, so a slower
// CI runner does not fail them; everything the race detector must see lives in
// the files above.
package e2e
