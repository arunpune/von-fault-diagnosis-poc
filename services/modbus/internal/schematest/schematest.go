// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package schematest validates a message against the JSON Schema the
// TypeScript side publishes, so a Go publisher and a Node consumer cannot
// drift apart unnoticed (docs/architecture.md#contracts).
//
// It is test-only: internal/arch/imports_test.go fails the build if either
// binary reaches it. Every function takes a testing.TB and reports through it,
// so call them from the test goroutine — a t.Fatalf from a handler goroutine
// would not stop the test.
//
// The schemas live outside the Go module, in packages/contracts/schemas/v1,
// and are generated there. A checkout without them is possible, so the helpers
// skip; CI sets FDP_REQUIRE_SCHEMAS=1 and the same case fails instead.
package schematest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	// SchemaDirEnv overrides where the generated schemas live.
	SchemaDirEnv = "FDP_SCHEMAS_DIR"
	// RequireSchemasEnv turns an absent schema directory from a skip into a
	// failure. CI sets it to 1 once the contracts are built.
	RequireSchemasEnv = "FDP_REQUIRE_SCHEMAS"
	// DefaultSchemaDir is packages/contracts/schemas/v1 seen from a package
	// under services/modbus/internal, which is where every caller lives:
	// `go test` runs a package in its own directory, four levels below the
	// repository root.
	DefaultSchemaDir = "../../../../packages/contracts/schemas/v1"
	// schemaSuffix is the file name suffix of every schema document.
	schemaSuffix = ".schema.json"
)

// cache holds one compiler per schema directory plus the schemas already
// compiled from it. Compiling is the expensive part, and a package's tests
// validate the same handful of schemas over and over.
var cache = struct {
	mu        sync.Mutex
	compilers map[string]*compiledDir
}{compilers: map[string]*compiledDir{}}

// compiledDir is one schema directory: the compiler that holds every document
// of the directory as a resource, the id of each document by file name, and
// the schemas compiled so far.
type compiledDir struct {
	compiler *jsonschema.Compiler
	ids      map[string]string
	schemas  map[string]*jsonschema.Schema
	names    []string
}

// MustSchemaDir returns the absolute path of the generated schema directory.
// It skips the test when the directory is absent, unless RequireSchemasEnv is
// set to a non-empty value, in which case it fails.
func MustSchemaDir(t testing.TB) string {
	t.Helper()

	dir := os.Getenv(SchemaDirEnv)
	source := SchemaDirEnv
	if dir == "" {
		dir, source = DefaultSchemaDir, "the default"
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatalf("schematest: resolving the schema directory %q (%s): %v", dir, source, err)
	}

	info, err := os.Stat(abs)
	switch {
	case err == nil && info.IsDir():
		return abs
	case err == nil:
		t.Fatalf("schematest: %s (%s) is not a directory", abs, source)
	case os.Getenv(RequireSchemasEnv) != "":
		t.Fatalf("schematest: the generated schemas are required (%s is set) but %s (%s) does not exist: "+
			"run `make contracts` to generate packages/contracts/schemas/v1",
			RequireSchemasEnv, abs, source)
	default:
		t.Skipf("schematest: no generated schemas at %s (%s); run `make contracts`, "+
			"or set %s=1 to make this a failure", abs, source, RequireSchemasEnv)
	}
	return ""
}

// Validate checks payload against <schema dir>/<schemaName>.schema.json and
// fails the test with the validation error when it does not conform. It skips
// when the schema directory is absent, as MustSchemaDir describes.
func Validate(t testing.TB, schemaName string, payload []byte) {
	t.Helper()

	dir := MustSchemaDir(t)
	schema := schemaFor(t, dir, schemaName)

	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("schematest: the payload for %q is not JSON: %v", schemaName, err)
	}
	if err := schema.Validate(doc); err != nil {
		t.Fatalf("schematest: the payload does not conform to %s:\n%v\npayload: %s", schemaName, err, payload)
	}
}

// schemaFor compiles schemaName from dir, reusing the compiler and any earlier
// result.
func schemaFor(t testing.TB, dir, schemaName string) *jsonschema.Schema {
	t.Helper()

	cache.mu.Lock()
	defer cache.mu.Unlock()

	entry, ok := cache.compilers[dir]
	if !ok {
		var err error
		if entry, err = loadDir(dir); err != nil {
			t.Fatalf("schematest: loading the schemas from %s: %v", dir, err)
		}
		cache.compilers[dir] = entry
	}

	if schema, ok := entry.schemas[schemaName]; ok {
		return schema
	}
	id, ok := entry.ids[schemaName]
	if !ok {
		t.Fatalf("schematest: no schema %q in %s; it holds %s", schemaName, dir, strings.Join(entry.names, ", "))
	}
	schema, err := entry.compiler.Compile(id)
	if err != nil {
		t.Fatalf("schematest: compiling %s (%s): %v", schemaName, id, err)
	}
	entry.schemas[schemaName] = schema
	return schema
}

// loadDir reads every *.schema.json of dir into one compiler, keyed by the
// "$id" of the document. The schemas reference each other by URN — a payload
// schema pulls the shared envelope out of common.schema.json — so they only
// compile as a set.
func loadDir(dir string) (*compiledDir, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	// The TypeScript validators run ajv with ajv-formats, so "format" is an
	// assertion on both sides (packages/contracts/src/generated/validators.ts).
	compiler.AssertFormat()

	loaded := &compiledDir{
		compiler: compiler,
		ids:      map[string]string{},
		schemas:  map[string]*jsonschema.Schema{},
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), schemaSuffix) {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), schemaSuffix)
		path := filepath.Join(dir, entry.Name())

		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("%s is not JSON: %w", entry.Name(), err)
		}
		id, err := schemaID(raw, path)
		if err != nil {
			return nil, err
		}
		if err := compiler.AddResource(id, doc); err != nil {
			return nil, fmt.Errorf("adding %s as %s: %w", entry.Name(), id, err)
		}
		loaded.ids[name] = id
		loaded.names = append(loaded.names, name)
	}

	if len(loaded.names) == 0 {
		return nil, fmt.Errorf("no *%s file in %s", schemaSuffix, dir)
	}
	sort.Strings(loaded.names)
	return loaded, nil
}

// schemaID returns the "$id" of a schema document, falling back to its file
// URL for a document that declares none.
func schemaID(raw []byte, path string) (string, error) {
	var head struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return "", fmt.Errorf("reading $id from %s: %w", filepath.Base(path), err)
	}
	if head.ID != "" {
		return head.ID, nil
	}
	return "file://" + filepath.ToSlash(path), nil
}
