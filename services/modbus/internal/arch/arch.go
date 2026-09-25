// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
)

// ListDeps returns the transitive import paths of pkg, resolved in the Go
// module rooted at dir. dir is a path to a directory holding a go.mod; pkg is
// a package pattern understood by `go list`, such as "./cmd/gateway".
//
// The closure includes the standard library and pkg itself, so the caller
// filters it with Forbidden. The command needs no network as long as the
// module's dependencies are already in the module cache.
func ListDeps(dir, pkg string) ([]string, error) {
	cmd := exec.Command("go", "-C", dir, "list", "-deps", "-f", "{{.ImportPath}}", pkg)
	cmd.Env = append(os.Environ(), "GOFLAGS=-mod=mod")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list -deps %s in %s: %w: %s",
			pkg, dir, err, strings.TrimSpace(stderr.String()))
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	deps := make([]string, 0, len(lines))
	for _, line := range lines {
		if path := strings.TrimSpace(line); path != "" {
			deps = append(deps, path)
		}
	}
	return deps, nil
}

// Forbidden returns the entries of deps that fall under one of prefixes: an
// import path equal to a prefix, or below it as prefix + "/". The result is
// sorted and free of duplicates, and nil when nothing matches, so a caller
// asserts the boundary with len(Forbidden(...)) == 0.
//
// Matching on the path separator keeps a sibling package out of the result:
// "a/b/simulator" does not fall under the prefix "a/b/sim".
func Forbidden(deps []string, prefixes []string) []string {
	hits := make([]string, 0, len(deps))
	seen := make(map[string]struct{}, len(deps))
	for _, dep := range deps {
		if _, done := seen[dep]; done {
			continue
		}
		for _, prefix := range prefixes {
			if dep == prefix || strings.HasPrefix(dep, prefix+"/") {
				seen[dep] = struct{}{}
				hits = append(hits, dep)
				break
			}
		}
	}
	if len(hits) == 0 {
		return nil
	}
	slices.Sort(hits)
	return hits
}
