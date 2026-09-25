// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Reference is one call to a forbidden selector: the file it stands in, the
// line the selector starts on and the expression as it was written, such as
// "client.WriteRegister".
type Reference struct {
	File string
	Line int
	Expr string
}

// String renders a reference the way a failing test prints it.
func (r Reference) String() string {
	return fmt.Sprintf("%s:%d: %s", r.File, r.Line, r.Expr)
}

// Occurrence is one line of one file that carries a forbidden substring.
type Occurrence struct {
	File   string
	Line   int
	Needle string
}

// String renders an occurrence the way a failing test prints it.
func (o Occurrence) String() string {
	return fmt.Sprintf("%s:%d: %q", o.File, o.Line, o.Needle)
}

// ScanSelectors returns every call under root whose selector carries one of
// names: `c.WriteRegister(0, 1)` is a hit for the name "WriteRegister",
// whatever c is.
//
// The files are parsed, not grepped, so a name inside a comment or a string
// literal is not a hit and a call spread over several lines still is; a
// selector that is passed on rather than called — `f := c.WriteRegister` — is
// a hit as well, because the call follows. Type information is deliberately
// not used: the read-only rule bans the vocabulary, so a write against any
// type is reported, and the check needs no build.
//
// Every .go file under root is read, test files included: the connector is
// read-only in its tests too. A root that does not exist yields no references
// and no error, which is how the boundary tests skip a directory that does not
// exist yet.
func ScanSelectors(root string, names []string) ([]Reference, error) {
	forbidden := make(map[string]struct{}, len(names))
	for _, name := range names {
		forbidden[name] = struct{}{}
	}

	var refs []Reference
	err := walkFiles(root, func(path string) error {
		if !strings.HasSuffix(path, ".go") {
			return nil
		}

		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return fmt.Errorf("parsing %s: %w", path, err)
		}

		ast.Inspect(file, func(node ast.Node) bool {
			sel, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if _, bad := forbidden[sel.Sel.Name]; !bad {
				return true
			}
			refs = append(refs, Reference{
				File: filepath.ToSlash(path),
				Line: fset.Position(sel.Sel.Pos()).Line,
				Expr: types.ExprString(sel),
			})
			return true
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return refs, nil
}

// ScanText returns every line of every file under root that keep admits and
// that contains one of needles, compared without case.
//
// This is the blunt half of the isolation check: a grep catches the vocabulary
// wherever it hides — a comment, a topic string, a struct tag, a golden file —
// where the import graph and the AST only see code. keep receives the
// slash-separated path and decides whether the file takes part; a nil keep
// admits everything. A root that does not exist yields no occurrences and no
// error.
func ScanText(root string, needles []string, keep func(path string) bool) ([]Occurrence, error) {
	lowered := make([]string, len(needles))
	for i, needle := range needles {
		lowered[i] = strings.ToLower(needle)
	}

	var hits []Occurrence
	err := walkFiles(root, func(path string) error {
		slashed := filepath.ToSlash(path)
		if keep != nil && !keep(slashed) {
			return nil
		}

		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("reading %s: %w", path, err)
		}
		for i, line := range strings.Split(string(raw), "\n") {
			low := strings.ToLower(line)
			for j, needle := range lowered {
				if strings.Contains(low, needle) {
					hits = append(hits, Occurrence{File: slashed, Line: i + 1, Needle: needles[j]})
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return hits, nil
}

// walkFiles calls visit for every regular file under root, in the order
// filepath.WalkDir reports them, which is lexical and therefore stable.
//
// A root that does not exist is not an error: the caller is a boundary test
// and a directory that does not exist yet has nothing to violate.
func walkFiles(root string, visit func(path string) error) error {
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return nil
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return nil
		}
		return visit(path)
	})
	if err != nil {
		return fmt.Errorf("walking %s: %w", root, err)
	}
	return nil
}
