// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package mqttio is the one MQTT client both binaries use: the simulator
// subscribes to control commands and publishes acks, status and ground truth,
// the gateway publishes telemetry batches and a heartbeat
// (services/modbus/README.md, "The MQTT wrapper in one paragraph").
//
// It wraps github.com/eclipse/paho.golang (autopaho + paho, MQTT 5) — used
// under the EDL-1.0 (BSD-3-Clause) half of its EPL-2.0 OR EDL-1.0 dual licence,
// the election the project records in REUSE.toml and NOTICE. MQTT 5 is what
// makes the broker's answer readable: a denied publish comes back as a PUBACK
// reason code, which this package turns into a *ReasonError so the isolation
// tests can assert the boundary instead of guessing at silence.
//
// The wrapper keeps three promises the callers rely on:
//
//   - Subscriptions survive a reconnect. Every filter passed to Subscribe is
//     remembered and re-sent when the connection comes back up, before the
//     caller's OnConnectionUp callback runs.
//   - A slow handler never blocks the paho reader. Received publications go on
//     an unbounded in-order queue that one goroutine per client drains, so
//     handlers see messages in the order the broker sent them without any
//     back-pressure on the network loop.
//   - No credential reaches a log line. The password is never logged, and the
//     broker URL is logged through url.URL.Redacted.
package mqttio
