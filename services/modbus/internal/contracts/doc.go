// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package contracts is the Go view of the v1 message schemas that
// packages/contracts publishes (docs/architecture.md#contracts).
//
// It holds three things and nothing else:
//
//   - Time, the ISO-8601 instant every envelope field carries — UTC, exactly
//     three fractional digits, a literal Z — so a Go publisher and a Node or
//     Python consumer can never disagree about a timestamp.
//   - The hand-written message structs. They mirror the schemas field by
//     field: a field the schema requires has no "omitempty", a required field
//     the schema allows to be null is a pointer so it is written as null
//     rather than dropped, and an optional field is a pointer or carries
//     "omitempty".
//   - Validator, which checks a message against the published schema at run
//     time, so a shape that drifts is caught where it is produced.
//
// The package imports the standard library and the JSON Schema validator and
// nothing else. In particular it never reaches internal/sim or
// internal/injection, so both binaries may import it and the import boundary
// of docs/architecture.md#import-boundaries stays intact: the gateway still
// stamps and forwards and holds no opinion about the machine (ground-truth
// isolation).
//
// The structs are deliberately not generated. They are few, they change with
// a major version at most, and the fixture conformance tests of this package
// measure them against the same packages/contracts/fixtures the TypeScript
// harness reads, which is a stronger guarantee than generation.
package contracts
