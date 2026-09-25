// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package arch holds the architecture tests of the Go module.
//
// Ground-truth isolation keeps the gateway away from ground truth: the gateway
// stamps and forwards samples and must never reach the replay or the
// fault-injection code. docs/architecture.md#import-boundaries states the
// allowed edges — cmd/gateway and internal/gateway may import internal/regmap
// and internal/mqttio, nothing else.
//
// ListDeps and Forbidden turn that rule into a test. `go list -deps` reports
// the transitive closure of a package's imports, so a violation hidden behind
// an intermediate package is caught as well; the depguard rule in
// .golangci.yml mirrors the same edge per file, for faster feedback in the
// editor, but is not the authoritative check.
package arch
