// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// TestMatch walks the wildcard rules of MQTT 5 §4.7 with the filters the ACL
// of infra/mosquitto actually uses.
func TestMatch(t *testing.T) {
	t.Parallel()

	cases := []struct {
		filter string
		topic  string
		want   bool
	}{
		// Exact names.
		{"plant/cau-7/decisions", "plant/cau-7/decisions", true},
		{"plant/cau-7/decisions", "plant/cau-7/decision", false},
		{"plant/cau-7/decisions", "plant/cau-7/decisions/extra", false},

		// Single-level wildcard.
		{"plant/+/telemetry/samples", "plant/cau-7/telemetry/samples", true},
		{"plant/+/telemetry/samples", "plant/cau-7/x/telemetry/samples", false},
		{"plant/+", "plant/cau-7", true},
		{"plant/+", "plant/cau-7/status", false},
		{"+/+/decisions", "plant/cau-7/decisions", true},

		// Multi-level wildcard.
		{"plant/cau-7/telemetry/#", "plant/cau-7/telemetry/samples", true},
		{"plant/cau-7/telemetry/#", "plant/cau-7/telemetry/samples/raw", true},
		// "#" also matches the parent level itself.
		{"plant/cau-7/telemetry/#", "plant/cau-7/telemetry", true},
		{"plant/cau-7/telemetry/#", "plant/cau-7/status", false},
		{"gt/#", "gt/cau-7/injection/active", true},
		{"#", "plant/cau-7/decisions", true},

		// A "#" that is not the last level is malformed and matches nothing.
		{"plant/#/samples", "plant/cau-7/samples", false},

		// $SYS is not reachable through a leading wildcard.
		{"#", "$SYS/broker/uptime", false},
		{"+/broker/uptime", "$SYS/broker/uptime", false},
		{"$SYS/#", "$SYS/broker/uptime", true},

		// Empty levels are levels.
		{"plant//decisions", "plant//decisions", true},
		{"plant/+/decisions", "plant//decisions", true},

		// Degenerate input.
		{"", "plant/cau-7/decisions", false},
		{"plant/cau-7/decisions", "", false},
	}

	for _, tc := range cases {
		assert.Equalf(t, tc.want, mqttio.Match(tc.filter, tc.topic),
			"Match(%q, %q)", tc.filter, tc.topic)
	}
}
