// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package gateway is the edge connector (docs/simulation.md, "The gateway"):
// it polls the simulator's holding registers over Modbus TCP, decodes the ring
// slots with the generated register map and publishes schema-valid telemetry
// batches and a retained heartbeat over MQTT.
//
// It stamps and forwards. It never computes machine state, never evaluates an
// alarm and knows nothing about the fault overlays the simulator applies
// (ground-truth isolation), so it imports only internal/regmap and
// internal/mqttio besides the standard library and the pinned Modbus client;
// internal/arch holds that boundary.
//
// Every sample carries the simulated time the simulator wrote into its slot.
// Wall-clock time appears only on the message envelope and in the heartbeat
// (the connection is read-only in both directions: the Poller interface below
// exposes reads and nothing else).
package gateway
