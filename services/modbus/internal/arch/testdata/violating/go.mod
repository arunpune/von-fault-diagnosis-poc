// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// A self-contained fixture module for TestForbiddenDetectsViolation. It has no
// dependencies, so `go list` resolves it offline and no go.sum is needed. Go
// tooling ignores testdata, so this module is never built or linted with the
// rest of the tree.
module example.com/violating

go 1.27
