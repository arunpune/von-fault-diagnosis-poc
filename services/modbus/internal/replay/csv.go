// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// TimestampColumn is the CSV column that carries the dataset clock. It is the
// one column the replay requires by name; every other column is found through
// regmap.Signal.Column.
const TimestampColumn = "timestamp"

// GapThresholdMs is the source step above which two consecutive rows count as
// a discontinuity rather than a sample interval (docs/simulation.md, "Gaps and
// the discontinuity flag"). It is a constant, not configuration: detection and
// the evaluation harness guard on the same 60 s.
const GapThresholdMs = 60_000

// IndexStride is the number of rows between two entries of the sparse time
// index. A Seek therefore scans at most this many rows after the file seek.
const IndexStride = 256

// readBufferBytes is the size of the bufio buffer of the index pass and of
// every cursor.
const readBufferBytes = 1 << 20

// bindKind says what a CSV column feeds.
type bindKind uint8

const (
	// bindIgnore is the unnamed index column and every column no signal asked
	// for; the zero value, so an unresolved column is ignored by default.
	bindIgnore bindKind = iota
	bindTimestamp
	bindAnalog
	bindDigital
)

// binding is what one CSV column feeds: the timestamp, or the slot-th entry
// of Row.Analog or Row.Digital.
type binding struct {
	kind bindKind
	slot int
}

// schema is the resolved header: the column layout of one file against one
// signal table. bindings is indexed by column index and trimmed after the
// last bound column, so a file with trailing unknown columns costs nothing.
type schema struct {
	bindings    []binding
	timestampAt int
	analogTags  []string
	digitalTags []string
}

// Gap is a source step wider than GapThresholdMs: the machine logged nothing
// between the row at StartMs and the row at EndMs (the full file has 331 of
// them, docs/dataset.md#gaps).
type Gap struct {
	StartMs uint64
	EndMs   uint64
}

// DurationMs returns the width of the gap.
func (g Gap) DurationMs() uint64 { return g.EndMs - g.StartMs }

// Source is one opened CSV: its resolved header, its sparse time index and
// the facts the simulator publishes about the dataset.
//
// Open reads the file once and keeps no descriptor open; every Cursor opens
// its own, so several cursors may walk the same source independently and a
// Source needs no Close. A Source is immutable after Open and safe for
// concurrent use; a Cursor is not.
type Source struct {
	path   string
	schema *schema
	index  []indexEntry
	// dataStart is where the rows begin, just past the header line; a cursor
	// starts there instead of reading the header again.
	dataStart indexEntry

	rows    int
	firstMs uint64
	lastMs  uint64
	gaps    []Gap
}

// Open resolves the header of the CSV at path against signals and builds the
// sparse time index in one sequential pass.
//
// Signals with an empty Column — the synthetic extras — are skipped and never
// appear in a Row. A column a signal names but the header does not have is an
// error that names the column, as is a non-increasing or unparsable timestamp
// anywhere in the file.
func Open(path string, signals []regmap.Signal) (*Source, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("replay: opening %s: %w", path, err)
	}
	defer func() { _ = file.Close() }()

	lr := newLineReader(file, 0, 0)
	header, _, err := lr.next()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("replay: %s has no header line", path)
		}
		return nil, fmt.Errorf("replay: reading the header of %s: %w", path, err)
	}

	sc, err := resolveSchema(header, signals)
	if err != nil {
		return nil, fmt.Errorf("replay: %s: %w", path, err)
	}

	src := &Source{
		path:      path,
		schema:    sc,
		dataStart: indexEntry{offset: lr.offset, line: lr.line + 1},
	}
	if err := src.buildIndex(lr); err != nil {
		return nil, fmt.Errorf("replay: %s: %w", path, err)
	}
	return src, nil
}

// resolveSchema maps the header line onto the signal table.
func resolveSchema(header []byte, signals []regmap.Signal) (*schema, error) {
	names := splitHeader(header)
	columns := make(map[string]int, len(names))
	for i, name := range names {
		if name == "" {
			continue // the dataset's unnamed integer index column
		}
		if first, dup := columns[name]; dup {
			return nil, fmt.Errorf("column %q appears twice in the header, at %d and %d",
				name, first, i)
		}
		columns[name] = i
	}

	tsAt, ok := columns[TimestampColumn]
	if !ok {
		return nil, fmt.Errorf("the required column %q is missing from the header", TimestampColumn)
	}

	sc := &schema{
		bindings:    make([]binding, len(names)),
		timestampAt: tsAt,
	}
	sc.bindings[tsAt] = binding{kind: bindTimestamp}

	for _, sig := range signals {
		if sig.Column == "" {
			continue // a synthetic extra: the sim computes it, the file has no column
		}
		col, found := columns[sig.Column]
		if !found {
			return nil, fmt.Errorf("column %q of signal %q is missing from the header",
				sig.Column, sig.Tag)
		}
		if sc.bindings[col].kind != bindIgnore {
			return nil, fmt.Errorf("column %q is claimed by more than one signal", sig.Column)
		}
		switch sig.Kind {
		case regmap.KindAnalog:
			sc.bindings[col] = binding{kind: bindAnalog, slot: len(sc.analogTags)}
			sc.analogTags = append(sc.analogTags, sig.Tag)
		case regmap.KindDigital:
			sc.bindings[col] = binding{kind: bindDigital, slot: len(sc.digitalTags)}
			sc.digitalTags = append(sc.digitalTags, sig.Tag)
		default:
			return nil, fmt.Errorf("signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}

	sc.trimBindings()
	return sc, nil
}

// trimBindings drops the ignored columns after the last bound one, so a row
// parse stops as soon as it has everything it needs.
func (sc *schema) trimBindings() {
	last := -1
	for i, b := range sc.bindings {
		if b.kind != bindIgnore {
			last = i
		}
	}
	sc.bindings = sc.bindings[:last+1]
}

// splitHeader returns the column names of the header line, stripped of a
// UTF-8 byte-order mark and of surrounding blanks.
func splitHeader(header []byte) []string {
	header = bytes.TrimPrefix(header, []byte("\xef\xbb\xbf"))
	fields := strings.Split(string(header), ",")
	for i, f := range fields {
		fields[i] = strings.TrimSpace(f)
	}
	return fields
}

// Bounds returns the timestamp of the first and of the last row and the
// number of data rows. An empty file reports (0, 0, 0).
func (s *Source) Bounds() (firstMs, lastMs uint64, rows int) {
	return s.firstMs, s.lastMs, s.rows
}

// Gaps returns every source step wider than GapThresholdMs, in file order.
func (s *Source) Gaps() []Gap { return slices.Clone(s.gaps) }

// IndexLen returns the number of entries in the sparse time index.
func (s *Source) IndexLen() int { return len(s.index) }

// AnalogTags names the entries of Row.Analog, in their order.
func (s *Source) AnalogTags() []string { return slices.Clone(s.schema.analogTags) }

// DigitalTags names the entries of Row.Digital, in their order.
func (s *Source) DigitalTags() []string { return slices.Clone(s.schema.digitalTags) }

// newLineReader returns a reader over r whose first line starts at byte
// offset and carries the file line number prevLine + 1.
func newLineReader(r io.Reader, offset int64, prevLine int) *lineReader {
	return &lineReader{
		br:     bufio.NewReaderSize(r, readBufferBytes),
		offset: offset,
		line:   prevLine,
	}
}
