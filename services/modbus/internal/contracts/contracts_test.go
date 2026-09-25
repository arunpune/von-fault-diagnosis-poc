// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package contracts_test measures the Go structs against the very files the
// TypeScript harness reads: packages/contracts/schemas/v1 and
// packages/contracts/fixtures (packages/contracts/README.md). The tests are
// deterministic — no clock, no randomness, no network — and read nothing
// outside the repository.
package contracts_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// repoRelative paths, seen from this package's directory. `go test` runs a
// package in its own directory, four levels below the repository root.
const (
	schemaDirPath     = "../../../../packages/contracts/schemas/v1"
	fixturesDirPath   = "../../../../packages/contracts/fixtures"
	groundTruthPath   = "../../../../packages/ground-truth/data"
	expectErrorMember = "$expect_error"
)

// sharedValidator is compiled once: loading the schema directory and
// compiling a document is the expensive part of this suite.
var sharedValidator = sync.OnceValues(func() (*contracts.Validator, error) {
	return contracts.NewValidator(schemaDirPath)
})

// newValidator returns the suite's validator, failing the test if the
// published schemas cannot be read.
func newValidator(t *testing.T) *contracts.Validator {
	t.Helper()

	validator, err := sharedValidator()
	require.NoError(t, err, "the published schemas live in %s; run `make contracts`", schemaDirPath)
	return validator
}

// fixtureFiles lists the fixtures of one schema matching pattern, sorted.
func fixtureFiles(t *testing.T, schemaName, pattern string) []string {
	t.Helper()

	files, err := filepath.Glob(filepath.Join(fixturesDirPath, schemaName, pattern))
	require.NoError(t, err)
	require.NotEmpty(t, files, "no %s fixture for %s", pattern, schemaName)
	return files
}

// readCompact reads a fixture and strips its insignificant whitespace, so a
// json.RawMessage taken out of it is byte-comparable with one the encoder
// produced.
func readCompact(t *testing.T, path string) []byte {
	t.Helper()

	raw, err := os.ReadFile(path)
	require.NoError(t, err)

	var compact bytes.Buffer
	require.NoError(t, json.Compact(&compact, raw), "%s is not JSON", path)
	return compact.Bytes()
}

// readWithoutExpectError reads an invalid fixture and removes the
// "$expect_error" member the TypeScript harness uses to pin the Ajv message,
// so the document fails for the reason it was written for and not for that
// extra member.
func readWithoutExpectError(t *testing.T, path string) []byte {
	t.Helper()

	var members map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(readCompact(t, path), &members), "%s is not a JSON object", path)
	require.Contains(t, members, expectErrorMember,
		"%s carries no %s, so the Ajv harness and this one measure different documents", path, expectErrorMember)
	delete(members, expectErrorMember)

	stripped, err := json.Marshal(members)
	require.NoError(t, err)
	return stripped
}

// requireJSONEqual compares two documents as JSON values, so member order and
// number spelling do not matter.
func requireJSONEqual(t *testing.T, want, got []byte, msgAndArgs ...any) {
	t.Helper()

	var wantValue, gotValue any
	require.NoError(t, json.Unmarshal(want, &wantValue))
	require.NoError(t, json.Unmarshal(got, &gotValue))
	require.Equal(t, wantValue, gotValue, msgAndArgs...)
}

// groundTruthFile reads one of the committed ground-truth documents.
func groundTruthFile(t *testing.T, name string) []byte {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join(groundTruthPath, name))
	require.NoError(t, err, "the ground-truth data lives in %s", groundTruthPath)
	return raw
}

// ptr is the shorthand the nullable and optional fields need.
func ptr[T any](v T) *T {
	return &v
}
