// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"path/filepath"
	"runtime"
	"testing"
)

// moduleDir returns the absolute path of services/modbus. It is derived from
// this file's own location, so it holds whatever directory `go test` runs the
// calling package in.
func moduleDir() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		panic("testutil: runtime.Caller failed; the module directory cannot be resolved")
	}
	// file is <module>/internal/testutil/fixtures.go
	return filepath.Dir(filepath.Dir(filepath.Dir(file)))
}

// repoRoot returns the absolute path of the repository root, the parent of
// services/.
func repoRoot() string {
	return filepath.Dir(filepath.Dir(moduleDir()))
}

// TestdataPath returns the absolute path name would have inside
// services/modbus/testdata, whether or not the file exists. name may contain
// slashes, as in "gt/presets.json".
func TestdataPath(name string) string {
	return filepath.Join(moduleDir(), "testdata", filepath.FromSlash(name))
}

// FixturePath returns the absolute path of name inside
// services/modbus/testdata.
//
// The fixtures are committed, so an absent one is a broken checkout, not a
// reason to skip: the test fails.
func FixturePath(t *testing.T, name string) string {
	t.Helper()

	path := TestdataPath(name)
	if _, err := statFile(path); err != nil {
		t.Fatalf("testutil: fixture %q not found at %s: %v", name, path, err)
	}
	return path
}
