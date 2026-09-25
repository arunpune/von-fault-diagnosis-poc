// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"encoding/json"
	"fmt"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// Scalar is a transform's value field: the amount an offset adds, or the
// reading a stuck or a dropped-out tag reports. An analog tag freezes at a
// number and a digital one at a boolean (the stuck_value definition of
// gt-injection-def.schema.json), so one Go field has to carry both shapes and
// remember which one the catalog wrote.
//
// The zero Scalar is unset, which is how a dropout with no value of its own
// falls back to the primitive's defaults — zero on an analog tag, false on a
// digital one.
type Scalar struct {
	num    float64
	truth  bool
	isBool bool
	set    bool
}

// Number returns a numeric Scalar.
func Number(v float64) Scalar { return Scalar{num: v, set: true} }

// Boolean returns a boolean Scalar.
func Boolean(v bool) Scalar { return Scalar{truth: v, isBool: true, set: true} }

// Float returns the number; it is zero for an unset or a boolean Scalar.
func (s Scalar) Float() float64 { return s.num }

// Bool returns the boolean; it is false for an unset or a numeric Scalar.
func (s Scalar) Bool() bool { return s.truth }

// IsBool reports whether the catalog wrote a boolean.
func (s Scalar) IsBool() bool { return s.isBool }

// IsSet reports whether the catalog wrote the field at all.
func (s Scalar) IsSet() bool { return s.set }

// IsZero reports whether the field was left out, which is what makes
// `json:"...,omitzero"` leave it out again on the way back.
func (s Scalar) IsZero() bool { return !s.set }

// UnmarshalJSON accepts a number or a boolean and rejects everything else.
func (s *Scalar) UnmarshalJSON(data []byte) error {
	var truth bool
	if err := json.Unmarshal(data, &truth); err == nil {
		*s = Boolean(truth)
		return nil
	}
	var num float64
	if err := json.Unmarshal(data, &num); err != nil {
		return fmt.Errorf("value %s is neither a number nor a boolean", data)
	}
	*s = Number(num)
	return nil
}

// MarshalJSON writes the shape the catalog had. An unset Scalar has no shape,
// so it writes null; `omitzero` keeps it out of the document in practice.
func (s Scalar) MarshalJSON() ([]byte, error) {
	switch {
	case !s.set:
		return []byte("null"), nil
	case s.isBool:
		return json.Marshal(s.truth)
	default:
		return json.Marshal(s.num)
	}
}

// matches reports whether the Scalar has the shape the tag's kind needs.
func (s Scalar) matches(kind regmap.Kind, tag string) error {
	switch kind {
	case regmap.KindAnalog:
		if s.isBool {
			return fmt.Errorf("value is a boolean but %q is an analog tag", tag)
		}
	case regmap.KindDigital:
		if !s.isBool {
			return fmt.Errorf("value is a number but %q is a digital tag", tag)
		}
	}
	return nil
}
