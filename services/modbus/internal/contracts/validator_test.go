// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts_test

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// TestSchemaDirPrefersTheEnvironment covers the two ways the validator finds
// the schemas: the variable the compose stack sets, and the path the images
// mount them at.
func TestSchemaDirPrefersTheEnvironment(t *testing.T) {
	staged := t.TempDir()
	t.Setenv(contracts.SchemaDirEnv, staged)
	require.Equal(t, staged, contracts.SchemaDir())

	t.Setenv(contracts.SchemaDirEnv, "")
	require.Equal(t, contracts.DefaultSchemaDir, contracts.SchemaDir())
}

// TestNewValidatorLoadsThePublishedSchemas proves the directory is read as a
// set: every document is registered, so the URN references between them
// resolve.
func TestNewValidatorLoadsThePublishedSchemas(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)
	require.Equal(t, schemaDirPath, validator.Dir())

	names := validator.SchemaNames()
	require.Contains(t, names, "common")
	for _, tc := range fixtureCases {
		require.Contains(t, names, tc.name)
	}
	require.IsIncreasing(t, names, "SchemaNames is sorted")
}

// TestNewValidatorRefusesADirectoryWithoutSchemas keeps a misconfigured mount
// from looking like a validator that accepts everything.
func TestNewValidatorRefusesADirectoryWithoutSchemas(t *testing.T) {
	t.Parallel()

	_, err := contracts.NewValidator(filepath.Join("testdata", "no-such-schema-directory"))
	require.Error(t, err)

	_, err = contracts.NewValidator(t.TempDir())
	require.ErrorContains(t, err, "no *.schema.json file")
}

// TestValidateReportsAnUnknownSchemaDistinctly lets a caller tell a typo apart
// from a message that does not conform.
func TestValidateReportsAnUnknownSchemaDistinctly(t *testing.T) {
	t.Parallel()

	err := newValidator(t).Validate("telemetry-sample", []byte(`{}`))
	require.ErrorIs(t, err, contracts.ErrUnknownSchema)
}

// TestValidateRejectsWhatIsNotJSON separates a broken payload from a payload
// outside the schema.
func TestValidateRejectsWhatIsNotJSON(t *testing.T) {
	t.Parallel()

	err := newValidator(t).Validate("gt-marker", []byte("not json"))
	require.ErrorContains(t, err, "is not JSON")
}

// TestValidateValueMeasuresTheEncodedMessage is the guarantee the publishers
// rely on: ValidateValue checks exactly the bytes that go on the wire, so a
// custom MarshalJSON cannot slip past the schema.
func TestValidateValueMeasuresTheEncodedMessage(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)

	marker := contracts.GtMarker{
		Envelope:  contracts.NewEnvelope(contracts.SchemaGtMarker, unitID),
		Kind:      "jump",
		SimTSFrom: datasetFirstTS,
		SimTSTo:   datasetLastTS,
	}
	require.NoError(t, validator.ValidateValue("gt-marker", marker))

	marker.Kind = "teleport"
	require.ErrorContains(t, validator.ValidateValue("gt-marker", marker), "does not conform to gt-marker")

	marker.Kind = "jump"
	marker.UnitID = "CAU_7"
	require.Error(t, validator.ValidateValue("gt-marker", marker), "the unit_id pattern is asserted")
}
