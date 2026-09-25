// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// This file carries the same ground-truth vocabulary as writes.go and must
// nevertheless stay out of the substring scan's findings: a no-leak test has
// to name the words it forbids. It is data, not code — testdata/ is invisible
// to the go tool — and it is never run.
package main

import "testing"

// TestTelemetryCarriesNoGroundTruth is the shape of a real no-leak assertion:
// it names "inject", "gt/" and GT_DIR precisely because it forbids them.
func TestTelemetryCarriesNoGroundTruth(t *testing.T) {
	for _, forbidden := range []string{"inject", "gt/cau-7", "GT_DIR"} {
		if forbidden == "" {
			t.Errorf("the no-leak needle is empty")
		}
	}
}
