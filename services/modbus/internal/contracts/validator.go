// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	// SchemaDirEnv names the directory the schemas are read from when
	// NewValidator is called without one.
	SchemaDirEnv = "CONTRACTS_SCHEMA_DIR"
	// DefaultSchemaDir is where the images mount
	// packages/contracts/schemas/v1.
	DefaultSchemaDir = "/contracts/schemas/v1"
	// schemaSuffix is the file-name suffix of every schema document.
	schemaSuffix = ".schema.json"
)

// ErrUnknownSchema is returned for a schema name the loaded directory does not
// hold, so a caller can tell a typo apart from a message that does not conform.
var ErrUnknownSchema = errors.New("contracts: unknown schema")

// Validator checks a message against the JSON Schema that
// packages/contracts publishes, so a shape that drifts is caught where it is
// produced rather than by a consumer in another language.
//
// A Validator is safe for concurrent use. Compilation is the expensive part
// and happens once per schema, the first time that schema is asked for; the
// whole directory is registered as a resource set up front, because the
// documents reference each other by URN and only compile together.
type Validator struct {
	dir   string
	names []string

	mu       sync.Mutex
	compiler *jsonschema.Compiler
	ids      map[string]string
	compiled map[string]*jsonschema.Schema
}

// SchemaDir is the directory NewValidator reads when it is given none:
// SchemaDirEnv when that is set, DefaultSchemaDir otherwise.
func SchemaDir() string {
	if dir := os.Getenv(SchemaDirEnv); dir != "" {
		return dir
	}
	return DefaultSchemaDir
}

// NewValidator loads every *.schema.json of dir, registering each document
// under its "$id" so the URN references between them resolve. An empty dir
// means SchemaDir().
func NewValidator(dir string) (*Validator, error) {
	if dir == "" {
		dir = SchemaDir()
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("contracts: reading the schema directory: %w", err)
	}

	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	// The TypeScript validators run Ajv with ajv-formats, so "format" is an
	// assertion on both sides.
	compiler.AssertFormat()

	loaded := &Validator{
		dir:      dir,
		compiler: compiler,
		ids:      map[string]string{},
		compiled: map[string]*jsonschema.Schema{},
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), schemaSuffix) {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		name := strings.TrimSuffix(entry.Name(), schemaSuffix)

		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("contracts: reading %s: %w", entry.Name(), err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("contracts: %s is not JSON: %w", entry.Name(), err)
		}
		id, err := schemaID(raw, path)
		if err != nil {
			return nil, err
		}
		if err := compiler.AddResource(id, doc); err != nil {
			return nil, fmt.Errorf("contracts: registering %s as %s: %w", entry.Name(), id, err)
		}
		loaded.ids[name] = id
		loaded.names = append(loaded.names, name)
	}

	if len(loaded.names) == 0 {
		return nil, fmt.Errorf("contracts: no *%s file in %s", schemaSuffix, dir)
	}
	slices.Sort(loaded.names)
	return loaded, nil
}

// Dir is the directory the schemas were read from.
func (v *Validator) Dir() string {
	return v.dir
}

// SchemaNames are the schema names the validator holds, sorted; a name is a
// file stem such as "telemetry-samples".
func (v *Validator) SchemaNames() []string {
	return slices.Clone(v.names)
}

// Validate checks an encoded message against <schemaName>.schema.json.
func (v *Validator) Validate(schemaName string, doc []byte) error {
	schema, err := v.schema(schemaName)
	if err != nil {
		return err
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(doc))
	if err != nil {
		return fmt.Errorf("contracts: the payload for %s is not JSON: %w", schemaName, err)
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("contracts: the payload does not conform to %s: %w", schemaName, err)
	}
	return nil
}

// ValidateValue encodes val and checks the result against
// <schemaName>.schema.json, so a message is measured exactly as it goes on the
// wire.
func (v *Validator) ValidateValue(schemaName string, val any) error {
	doc, err := json.Marshal(val)
	if err != nil {
		return fmt.Errorf("contracts: encoding a %s message: %w", schemaName, err)
	}
	return v.Validate(schemaName, doc)
}

// schema compiles schemaName on first use and caches the result.
func (v *Validator) schema(schemaName string) (*jsonschema.Schema, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if schema, ok := v.compiled[schemaName]; ok {
		return schema, nil
	}
	id, ok := v.ids[schemaName]
	if !ok {
		return nil, fmt.Errorf("%w %q in %s; it holds %s",
			ErrUnknownSchema, schemaName, v.dir, strings.Join(v.names, ", "))
	}
	schema, err := v.compiler.Compile(id)
	if err != nil {
		return nil, fmt.Errorf("contracts: compiling %s (%s): %w", schemaName, id, err)
	}
	v.compiled[schemaName] = schema
	return schema, nil
}

// schemaID reads the "$id" of a schema document, falling back to its file URL
// for a document that declares none.
func schemaID(raw []byte, path string) (string, error) {
	var head struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return "", fmt.Errorf("contracts: reading $id from %s: %w", filepath.Base(path), err)
	}
	if head.ID != "" {
		return head.ID, nil
	}
	return "file://" + filepath.ToSlash(path), nil
}
