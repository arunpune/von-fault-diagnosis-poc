// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// TestValueMarshalsAsAScalar holds Value to common.schema.json's sample_value:
// a number or a boolean, never an object and never a string.
func TestValueMarshalsAsAScalar(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		given contracts.Value
		want  string
	}{
		{"an analog reading", contracts.NumberValue(9.67), "9.67"},
		{"a negative analog reading", contracts.NumberValue(-0.018), "-0.018"},
		{"a whole analog reading", contracts.NumberValue(14), "14"},
		{"the zero value is the number zero", contracts.Value{}, "0"},
		{"a digital reading that is on", contracts.BoolValue(true), "true"},
		{"a digital reading that is off", contracts.BoolValue(false), "false"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			encoded, err := json.Marshal(tc.given)
			require.NoError(t, err)
			require.Equal(t, tc.want, string(encoded))

			var decoded contracts.Value
			require.NoError(t, json.Unmarshal(encoded, &decoded))
			require.Equal(t, tc.given, decoded)
		})
	}
}

// TestValueRejectsWhatIsNotAScalar keeps a string or a null out of a reading,
// where a plain float64 field would silently decode a null as zero.
func TestValueRejectsWhatIsNotAScalar(t *testing.T) {
	t.Parallel()

	for _, text := range []string{`"9.67"`, `null`, `{}`, `[]`, `"true"`} {
		t.Run(text, func(t *testing.T) {
			t.Parallel()

			var decoded contracts.Value
			require.Error(t, json.Unmarshal([]byte(text), &decoded))
		})
	}
}

// TestValuesCarryBothKindsOfTag is the shape a decoded row takes: analog tags
// as numbers and digital tags as booleans, in one object keyed by tag id.
func TestValuesCarryBothKindsOfTag(t *testing.T) {
	t.Parallel()

	row := contracts.Values{
		"oil_temperature": contracts.NumberValue(58.4),
		"intake_closed":   contracts.BoolValue(true),
		"load_valve":      contracts.BoolValue(false),
	}

	encoded, err := json.Marshal(row)
	require.NoError(t, err)
	require.JSONEq(t, `{"oil_temperature":58.4,"intake_closed":true,"load_valve":false}`, string(encoded))

	var decoded contracts.Values
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.Equal(t, row, decoded)
}
