// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// fixtureCases pairs every schema this package models with the struct that
// models it; TestEveryModelledSchemaHasFixtures keeps the list honest.
var fixtureCases = []struct {
	name   string
	newDoc func() any
}{
	{"telemetry-samples", func() any { return new(contracts.TelemetrySamples) }},
	{"control-cmd", func() any { return new(contracts.ControlCmd) }},
	{"control-ack", func() any { return new(contracts.ControlAck) }},
	{"status-sim", func() any { return new(contracts.StatusSim) }},
	{"status-gateway", func() any { return new(contracts.StatusGateway) }},
	{"gt-preset-def", func() any { return new(contracts.GtPresetDef) }},
	{"gt-presets", func() any { return new(contracts.GtPresets) }},
	{"gt-injection-def", func() any { return new(contracts.GtInjectionDef) }},
	{"gt-injections", func() any { return new(contracts.GtInjections) }},
	{"gt-failure-table", func() any { return new(contracts.GtFailureTable) }},
	{"gt-catalog", func() any { return new(contracts.GtCatalog) }},
	{"gt-injection", func() any { return new(contracts.GtInjection) }},
	{"gt-injection-active", func() any { return new(contracts.GtInjectionActive) }},
	{"gt-marker", func() any { return new(contracts.GtMarker) }},
}

// TestValidFixturesRoundTrip is the conformance test of the package: every
// valid fixture decodes into its struct, encodes back to a document that still
// validates and that carries exactly what the fixture carried, and decodes a
// second time into the same value. A field the structs forgot loses data at
// the second step; a field they spell wrongly fails the first or the third.
func TestValidFixturesRoundTrip(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)

	for _, tc := range fixtureCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			for _, file := range fixtureFiles(t, tc.name, "valid-*.json") {
				t.Run(filepath.Base(file), func(t *testing.T) {
					t.Parallel()

					fixture := readCompact(t, file)

					decoded := tc.newDoc()
					require.NoError(t, json.Unmarshal(fixture, decoded), "decoding %s", file)

					encoded, err := json.Marshal(decoded)
					require.NoError(t, err, "encoding %s", file)

					require.NoError(t, validator.Validate(tc.name, encoded),
						"the re-encoded %s no longer conforms", file)
					requireJSONEqual(t, fixture, encoded,
						"the structs dropped or invented a member of %s", file)

					again := tc.newDoc()
					require.NoError(t, json.Unmarshal(encoded, again))
					require.Equal(t, decoded, again, "%s does not survive a second round trip", file)
				})
			}
		})
	}
}

// TestInvalidFixturesAreRejected is the other half: the validator refuses
// every document the TypeScript harness refuses.
func TestInvalidFixturesAreRejected(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)

	for _, tc := range fixtureCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			for _, file := range fixtureFiles(t, tc.name, "invalid-*.json") {
				t.Run(filepath.Base(file), func(t *testing.T) {
					t.Parallel()

					require.Error(t, validator.Validate(tc.name, readWithoutExpectError(t, file)),
						"%s is an invalid fixture but the validator accepted it", file)
				})
			}
		})
	}
}

// TestEveryModelledSchemaHasFixtures ties the table above to the schema
// directory: a schema that is renamed, or a struct that is added without a
// fixture directory, shows up here.
func TestEveryModelledSchemaHasFixtures(t *testing.T) {
	t.Parallel()

	published := newValidator(t).SchemaNames()
	for _, tc := range fixtureCases {
		require.Contains(t, published, tc.name, "no %s.schema.json is published", tc.name)
		require.DirExists(t, filepath.Join(fixturesDirPath, tc.name))
	}
}
