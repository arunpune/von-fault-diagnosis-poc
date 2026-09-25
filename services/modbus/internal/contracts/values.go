// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Value is one decoded telemetry reading: a number for an analog tag, a
// boolean for a digital one (common.schema.json sample_value). The two live in
// one type because the gateway forwards a whole row and the schema keys both
// kinds by tag id in the same object.
//
// The zero Value is the number 0.
type Value struct {
	// IsBool selects which of the two fields below carries the reading.
	IsBool bool
	// Bool is the reading of a digital tag; meaningful when IsBool is true.
	Bool bool
	// Num is the reading of an analog tag; meaningful when IsBool is false.
	Num float64
}

// NumberValue is the reading of an analog tag.
func NumberValue(n float64) Value {
	return Value{Num: n}
}

// BoolValue is the reading of a digital tag.
func BoolValue(b bool) Value {
	return Value{IsBool: true, Bool: b}
}

// MarshalJSON writes a JSON boolean or a JSON number, never an object.
func (v Value) MarshalJSON() ([]byte, error) {
	if v.IsBool {
		return json.Marshal(v.Bool)
	}
	return json.Marshal(v.Num)
}

// UnmarshalJSON reads a JSON boolean or a JSON number. Anything else — a
// string, a null, an object — is an error, because the schema's sample_value
// admits the two scalar kinds alone.
func (v *Value) UnmarshalJSON(data []byte) error {
	raw := bytes.TrimSpace(data)
	switch {
	case bytes.Equal(raw, []byte("true")):
		*v = BoolValue(true)
	case bytes.Equal(raw, []byte("false")):
		*v = BoolValue(false)
	default:
		var n float64
		if len(raw) == 0 || raw[0] == 'n' || json.Unmarshal(raw, &n) != nil {
			return fmt.Errorf("contracts: a sample value is a number or a boolean, got %s", raw)
		}
		*v = NumberValue(n)
	}
	return nil
}

// Values is one decoded row: the reading of every tag of the signal registry,
// keyed by tag id (telemetry-samples.schema.json, sample.values).
type Values map[string]Value
