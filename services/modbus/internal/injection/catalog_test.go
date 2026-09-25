// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// catalogPath is the copy of the catalog the Go tests read. It is a verbatim
// copy of the authoritative packages/ground-truth/data/injections.json, kept
// here so the module's tests stay inside their own testdata; a test below
// asserts the two files are byte-identical.
var catalogPath = filepath.Join("..", "..", "testdata", "gt", "injections.json")

// groundTruthCatalogPath is the authoritative file, four levels up from a
// package directory (the depth of every other cross-package path in this
// module).
var groundTruthCatalogPath = filepath.Join(
	"..", "..", "..", "..", "packages", "ground-truth", "data", "injections.json")

// loadCatalog loads the real catalog against the generated signal table.
func loadCatalog(t *testing.T) *injection.Catalog {
	t.Helper()

	cat, err := injection.LoadCatalog(catalogPath, regmap.Signals)
	require.NoError(t, err)
	return cat
}

func TestTheTestdataCopyIsTheGroundTruthCatalogVerbatim(t *testing.T) {
	t.Parallel()

	mine, err := os.ReadFile(catalogPath)
	require.NoError(t, err)
	theirs, err := os.ReadFile(groundTruthCatalogPath)
	require.NoError(t, err)

	assert.Equal(t, string(theirs), string(mine),
		"services/modbus/testdata/gt/injections.json must stay a verbatim copy of "+
			"packages/ground-truth/data/injections.json")
}

func TestLoadCatalogAcceptsTheNineDefinitions(t *testing.T) {
	t.Parallel()

	cat := loadCatalog(t)

	assert.Equal(t, injection.CatalogSchema, cat.Schema)
	ids := make([]string, 0, len(cat.Injections))
	for _, def := range cat.Injections {
		ids = append(ids, def.InjectionID)
	}
	assert.Equal(t, []string{
		"oil_cooler_fouling",
		"high_ambient_temperature",
		"heavy_air_demand",
		"air_leak_downstream",
		"intake_valve_sticking",
		"dryer_tower_switching_failure",
		"separator_drain_blocked",
		"motor_overload",
		"oil_temperature_sensor_fault",
	}, ids, "the nine injection types of docs/simulation.md, in menu order")
}

func TestEveryDefinitionNamesAManualCauseAndAMagnitude(t *testing.T) {
	t.Parallel()

	// The fault ids each injection names; the ground-truth package checks them
	// against manual/spec/faults.yaml, this test pins the mapping.
	want := map[string]string{
		"oil_cooler_fouling":            "oil_cooler_fouled",
		"high_ambient_temperature":      "high_ambient_temperature",
		"heavy_air_demand":              "high_air_demand",
		"air_leak_downstream":           "downstream_air_leak",
		"intake_valve_sticking":         "intake_valve_not_opening",
		"dryer_tower_switching_failure": "tower_changeover_valve_fault",
		"separator_drain_blocked":       "condensate_drain_blocked",
		"motor_overload":                "airend_bearing_wear",
		"oil_temperature_sensor_fault":  "oil_temperature_sensor_fault",
	}

	for _, def := range loadCatalog(t).Injections {
		assert.Equal(t, want[def.InjectionID], def.FaultID, def.InjectionID)
		assert.NotEmpty(t, def.Label, def.InjectionID)
		assert.NotEmpty(t, def.Description, def.InjectionID)

		magnitude, ok := def.Param(injection.MagnitudeParam)
		require.True(t, ok, "%s declares no magnitude", def.InjectionID)
		assert.Equal(t, 1.0, magnitude.Default, def.InjectionID)
		assert.Equal(t, 0.25, magnitude.Min, def.InjectionID)
		assert.Equal(t, 2.0, magnitude.Max, def.InjectionID)
	}
}

func TestTheBenignDefinitionsAreTheOnesTheDemoNeeds(t *testing.T) {
	t.Parallel()

	// The project wants benign causes with alarming symptoms: a warm room and
	// a dead sensor both raise an oil alarm without a defect, and heavy demand
	// looks like a leak.
	benign := map[string]bool{}
	for _, def := range loadCatalog(t).Injections {
		benign[def.InjectionID] = def.Benign
	}
	assert.Equal(t, map[string]bool{
		"oil_cooler_fouling":            false,
		"high_ambient_temperature":      true,
		"heavy_air_demand":              true,
		"air_leak_downstream":           false,
		"intake_valve_sticking":         false,
		"dryer_tower_switching_failure": false,
		"separator_drain_blocked":       false,
		"motor_overload":                false,
		"oil_temperature_sensor_fault":  true,
	}, benign)
}

func TestLoadCatalogRejectsEveryInvalidFixture(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		file    string
		wantAll []string
	}{
		{"catalog-invalid-schema.json", []string{"schema", injection.CatalogSchema}},
		{"catalog-invalid-no-injections.json", []string{"injections is empty"}},
		{"catalog-invalid-duplicate-id.json", []string{"test_injection", "declared twice"}},
		{"catalog-invalid-unknown-tag.json", []string{"test_injection", "transforms[0]", "sump_pressure"}},
		{"catalog-invalid-unknown-op.json", []string{"test_injection", "transforms[0]", "warp"}},
		{"catalog-invalid-unknown-when.json", []string{"test_injection", "transforms[0]", "sometimes"}},
		{"catalog-invalid-unknown-anchor.json", []string{"test_injection", "transforms[0]", "power_on"}},
		{"catalog-invalid-analog-op-on-digital.json", []string{"test_injection", "offset", "dryer_tower"}},
		{"catalog-invalid-digital-op-on-analog.json", []string{"test_injection", "duty_shift", "oil_temperature"}},
		{"catalog-invalid-stuck-value-kind.json", []string{"test_injection", "purge_switch", "number"}},
		{"catalog-invalid-envelope-longer-than-duration.json", []string{"test_injection", "ramp_in_min"}},
		{"catalog-invalid-missing-magnitude.json", []string{"test_injection", "magnitude"}},
		{"catalog-invalid-magnitude-bounds.json", []string{"test_injection", "params[0]", "magnitude"}},
		{"catalog-invalid-unknown-field.json", []string{"severity"}},
		{"catalog-invalid-extraneous-field.json", []string{"test_injection", "factor"}},
		{"catalog-invalid-no-transforms.json", []string{"test_injection", "transforms is empty"}},
		{"catalog-invalid-injection-id.json", []string{"injection_id", "not an identifier"}},
	} {
		t.Run(tc.file, func(t *testing.T) {
			t.Parallel()

			cat, err := injection.LoadCatalog(filepath.Join("testdata", tc.file), regmap.Signals)
			require.Error(t, err, "the fixture must not load")
			assert.Nil(t, cat)
			for _, want := range tc.wantAll {
				assert.Contains(t, err.Error(), want)
			}
		})
	}
}

func TestLoadCatalogReportsAMissingFile(t *testing.T) {
	t.Parallel()

	_, err := injection.LoadCatalog(filepath.Join("testdata", "absent.json"), regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "opening the catalog")
}

func TestValidateRejectsACatalogBuiltInMemory(t *testing.T) {
	t.Parallel()

	// Validate is the same gate as the loader's, so a caller that assembles a
	// catalog itself cannot slip past the rules.
	cat := injection.Catalog{
		Schema: injection.CatalogSchema,
		Injections: []injection.Definition{{
			InjectionID:           "in_memory",
			FaultID:               "oil_cooler_fouled",
			Label:                 "In memory",
			Description:           "Built by a test.",
			DefaultDurationSimMin: 10,
			Params: []injection.ParamDef{
				{Name: injection.MagnitudeParam, Default: 1, Min: 0.25, Max: 2},
			},
			Transforms: []injection.Transform{
				{Tag: "oil_temperature", Op: injection.OpScale, When: injection.WhenAny},
			},
		}},
	}

	err := cat.Validate(regmap.Signals)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "scale needs a positive factor")
}
