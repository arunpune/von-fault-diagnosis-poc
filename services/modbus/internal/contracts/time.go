// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"bytes"
	"fmt"
	"time"
)

// TimeLayout is the one timestamp format of the contracts: UTC, millisecond
// precision, a literal Z (common.schema.json iso_ts). Go reads the trailing Z
// as a literal because no offset pattern follows it, which is exactly what the
// contract asks for — the instant is always UTC and an offset is never
// accepted.
const TimeLayout = "2006-01-02T15:04:05.000Z"

// timeTextLen is the length of a conforming timestamp, for example
// 2020-04-18T00:00:00.000Z.
const timeTextLen = len("2006-01-02T15:04:05.000Z")

// Time is an instant on the wire. It marshals to TimeLayout and unmarshals
// from that shape alone: an instant without milliseconds, with more than three
// fractional digits, or with a numeric offset is rejected rather than quietly
// reinterpreted, because a consumer that matches the iso_ts pattern would
// reject it too.
type Time struct {
	time.Time
}

// Now is the current wall-clock instant, in UTC and truncated to the
// millisecond the wire carries, so a value survives a marshal and unmarshal
// round trip unchanged.
func Now() Time {
	return Time{time.Now().UTC().Truncate(time.Millisecond)}
}

// FromUnixMilli builds an instant from epoch milliseconds, the form simulated
// time takes inside the Modbus registers.
func FromUnixMilli(ms int64) Time {
	return Time{time.UnixMilli(ms).UTC()}
}

// ParseTime reads a timestamp in the contract format.
func ParseTime(s string) (Time, error) {
	if len(s) != timeTextLen {
		return Time{}, fmt.Errorf("contracts: %q is not an instant of the form %s", s, TimeLayout)
	}
	parsed, err := time.Parse(TimeLayout, s)
	if err != nil {
		return Time{}, fmt.Errorf("contracts: %q is not an instant of the form %s: %w", s, TimeLayout, err)
	}
	return Time{parsed}, nil
}

// String renders the instant the way the wire carries it.
func (t Time) String() string {
	return t.Time.UTC().Format(TimeLayout)
}

// MarshalJSON writes the instant as the contract's iso_ts string. A sub-
// millisecond remainder is truncated, never rounded, so the value matches what
// UnmarshalJSON reads back.
func (t Time) MarshalJSON() ([]byte, error) {
	out := make([]byte, 0, timeTextLen+2)
	out = append(out, '"')
	out = t.Time.UTC().AppendFormat(out, TimeLayout)
	out = append(out, '"')
	return out, nil
}

// UnmarshalJSON reads the contract's iso_ts string and nothing else. A JSON
// null is an error as well: the schemas that allow a null instant declare a
// nullable field, which the structs model as a *Time.
func (t *Time) UnmarshalJSON(data []byte) error {
	raw := bytes.TrimSpace(data)
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return fmt.Errorf("contracts: an instant is a JSON string of the form %s, got %s", TimeLayout, raw)
	}
	parsed, err := ParseTime(string(raw[1 : len(raw)-1]))
	if err != nil {
		return err
	}
	*t = parsed
	return nil
}
