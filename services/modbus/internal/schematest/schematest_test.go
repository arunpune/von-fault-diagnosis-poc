// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package schematest_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/schematest"
)

// helperEnv turns TestSchemaHelperProcess from a no-op into the probe the
// subprocess cases below run; its value picks which probe.
const helperEnv = "FDP_SCHEMATEST_HELPER"

// missingDir is a path no checkout has.
const missingDir = "testdata/no-such-schema-directory"

// A ground-truth marker is the smallest message that exercises the envelope,
// a cross-file $ref and a format assertion at once (gt-marker.schema.json).
const validMarker = `{
  "schema": "urn:fdp:schema:gt-marker:v1",
  "unit_id": "cau-7",
  "wall_ts": "2026-09-20T10:00:00.000Z",
  "kind": "jump",
  "sim_ts_from": "2020-02-01T00:00:00.000Z",
  "sim_ts_to": "2020-03-01T00:00:00.000Z"
}`

// The same message with a kind the schema's enum does not list.
const invalidMarker = `{
  "schema": "urn:fdp:schema:gt-marker:v1",
  "unit_id": "cau-7",
  "wall_ts": "2026-09-20T10:00:00.000Z",
  "kind": "teleport",
  "sim_ts_from": "2020-02-01T00:00:00.000Z",
  "sim_ts_to": "2020-03-01T00:00:00.000Z"
}`

func TestMustSchemaDirResolves(t *testing.T) {
	dir := schematest.MustSchemaDir(t) // skips when the contracts are not built

	assert.True(t, filepath.IsAbs(dir), "the helper returns an absolute path, got %s", dir)
	assert.True(t, strings.HasSuffix(dir, filepath.Join("packages", "contracts", "schemas", "v1")),
		"the schemas live in packages/contracts/schemas/v1, got %s", dir)
	require.FileExists(t, filepath.Join(dir, "common.schema.json"))
}

// TestMustSchemaDirHonoursTheOverride keeps the env variable meaningful: a
// test suite can point the helper at a staging copy of the contracts.
func TestMustSchemaDirHonoursTheOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(schematest.SchemaDirEnv, dir)

	assert.Equal(t, dir, schematest.MustSchemaDir(t))
}

// TestValidateAcceptsAConformingMessage also proves the cross-file $ref
// resolves: gt-marker pulls its envelope out of common.schema.json.
func TestValidateAcceptsAConformingMessage(t *testing.T) {
	schematest.Validate(t, "gt-marker", []byte(validMarker))
	// Twice, because the compiler and the compiled schema are cached.
	schematest.Validate(t, "gt-marker", []byte(validMarker))
}

// TestValidateRejectsAMessageOutsideTheSchema runs the helper in a subprocess
// so the failure is observed instead of ending this test.
func TestValidateRejectsAMessageOutsideTheSchema(t *testing.T) {
	requireSchemas(t)

	out, err := runHelper(t, "invalid", "")
	require.Error(t, err, "a payload outside the schema must fail the test:\n%s", out)
	assert.Contains(t, out, "FAIL")
	assert.Contains(t, out, "gt-marker")
}

// TestHelperSkipsWithoutSchemas is the default in a checkout where the
// contracts have not been generated yet.
func TestHelperSkipsWithoutSchemas(t *testing.T) {
	out, err := runHelper(t, "missing", "")
	require.NoError(t, err, "an absent schema directory must not fail the suite:\n%s", out)
	assert.Contains(t, out, "SKIP")
	assert.Contains(t, out, schematest.RequireSchemasEnv)
	assert.NotContains(t, out, "FAIL")
}

// TestHelperFailsWithoutSchemas is the other half: CI sets
// FDP_REQUIRE_SCHEMAS=1 once the contracts are built, and a missing directory
// is then a failure rather than a silent skip.
func TestHelperFailsWithoutSchemas(t *testing.T) {
	out, err := runHelper(t, "missing", "1")
	require.Error(t, err, "an absent schema directory must fail under %s=1:\n%s", schematest.RequireSchemasEnv, out)
	assert.Contains(t, out, "FAIL")
	assert.Contains(t, out, schematest.RequireSchemasEnv)
	assert.NotContains(t, out, "SKIP")
}

// runHelper re-runs this test binary with only TestSchemaHelperProcess
// enabled, in the given mode, and returns its combined output.
func runHelper(t *testing.T, mode, requireSchemas string) (string, error) {
	t.Helper()

	cmd := exec.Command(os.Args[0], "-test.run=^TestSchemaHelperProcess$", "-test.v")
	env := append(os.Environ(),
		helperEnv+"="+mode,
		schematest.RequireSchemasEnv+"="+requireSchemas,
	)
	if mode == "missing" {
		env = append(env, schematest.SchemaDirEnv+"="+missingDir)
	}
	cmd.Env = env

	out, err := cmd.CombinedOutput()
	return string(out), err
}

// TestSchemaHelperProcess is the body the subprocess cases run; it does
// nothing in an ordinary run.
func TestSchemaHelperProcess(t *testing.T) {
	switch os.Getenv(helperEnv) {
	case "invalid":
		schematest.Validate(t, "gt-marker", []byte(invalidMarker))
		t.Fatalf("Validate accepted a payload the schema rejects")
	case "missing":
		dir := schematest.MustSchemaDir(t)
		t.Fatalf("MustSchemaDir returned %q for a directory that does not exist", dir)
	default:
		t.Skip("helper process; driven by the subprocess cases of this package")
	}
}

// requireSchemas skips when the generated contracts are not in the checkout,
// for the cases that need a real schema to reject something.
func requireSchemas(t *testing.T) {
	t.Helper()

	dir := os.Getenv(schematest.SchemaDirEnv)
	if dir == "" {
		dir = schematest.DefaultSchemaDir
	}
	if _, err := os.Stat(dir); err != nil {
		if os.Getenv(schematest.RequireSchemasEnv) != "" {
			t.Fatalf("the generated schemas are required (%s is set) but %s is missing: %v",
				schematest.RequireSchemasEnv, dir, err)
		}
		t.Skipf("no generated schemas at %s; run `make contracts`", dir)
	}
}
