// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio

import (
	"fmt"
	"math"
	"time"
)

// TSLayout is the timestamp format of every envelope field: ISO-8601 UTC with
// milliseconds and a literal Z. Go reads the trailing "Z" as a literal because
// it is not followed by an offset pattern, which is exactly what the contract
// asks for — the timestamp is always UTC, never an offset.
const TSLayout = "2006-01-02T15:04:05.000Z"

// SchemaVersion is the major version every v1 schema id carries.
const SchemaVersion = "v1"

// SchemaID returns the $id of a contract schema, for example
// SchemaID("telemetry-samples") == "urn:fdp:schema:telemetry-samples:v1". It
// is the value of the envelope's "schema" field.
func SchemaID(name string) string {
	return "urn:fdp:schema:" + name + ":" + SchemaVersion
}

// WallTS formats a wall-clock instant for the envelope. The instant is
// converted to UTC first, so a local time never leaks an offset into a
// message.
func WallTS(t time.Time) string {
	return t.UTC().Format(TSLayout)
}

// SimTS formats simulated time, held everywhere else as epoch milliseconds
// (the register model carries milliseconds; only the envelope carries text).
//
// Values above math.MaxInt64 milliseconds cannot be represented as a Go
// instant; they are clamped, which no dataset instant ever reaches.
func SimTS(ms uint64) string {
	if ms > math.MaxInt64 {
		ms = math.MaxInt64
	}
	return WallTS(time.UnixMilli(int64(ms)))
}

// ParseTS reads an envelope timestamp back into epoch milliseconds. It accepts
// any RFC 3339 instant, with or without a fractional second and with any
// offset, so a message from another language's formatter still parses.
func ParseTS(s string) (uint64, error) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0, fmt.Errorf("mqttio: parsing the timestamp %q: %w", s, err)
	}
	ms := t.UTC().UnixMilli()
	if ms < 0 {
		return 0, fmt.Errorf("mqttio: the timestamp %q is before the Unix epoch", s)
	}
	return uint64(ms), nil
}
