// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"slices"
	"testing"
)

func TestForbidden(t *testing.T) {
	t.Parallel()

	const (
		sim       = "example.com/m/internal/sim"
		injection = "example.com/m/internal/injection"
	)
	denied := []string{sim, injection}

	tests := []struct {
		name     string
		deps     []string
		prefixes []string
		want     []string
	}{
		{
			name:     "exact match",
			deps:     []string{"fmt", sim},
			prefixes: denied,
			want:     []string{sim},
		},
		{
			name:     "sub-package",
			deps:     []string{"fmt", sim + "/replay"},
			prefixes: denied,
			want:     []string{sim + "/replay"},
		},
		{
			name:     "unrelated package",
			deps:     []string{"fmt", "example.com/m/internal/regmap", "example.com/m/internal/simulacrum"},
			prefixes: denied,
			want:     nil,
		},
		{
			name:     "every prefix reported once and sorted",
			deps:     []string{sim, injection, sim, sim + "/replay"},
			prefixes: denied,
			want:     []string{injection, sim, sim + "/replay"},
		},
		{
			name:     "no dependencies",
			deps:     nil,
			prefixes: denied,
			want:     nil,
		},
		{
			name:     "no prefixes",
			deps:     []string{sim, injection},
			prefixes: nil,
			want:     nil,
		},
		{
			name:     "no dependencies and no prefixes",
			deps:     nil,
			prefixes: nil,
			want:     nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := Forbidden(tc.deps, tc.prefixes)
			if !slices.Equal(got, tc.want) {
				t.Errorf("Forbidden(%q, %q) = %q, want %q", tc.deps, tc.prefixes, got, tc.want)
			}
		})
	}
}
