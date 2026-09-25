// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// Cursor walks the rows of a Source in file order and jumps to any instant in
// it.
//
// It owns a file descriptor and must be closed. It is not safe for concurrent
// use: the simulator's emit loop drives one cursor from one goroutine.
type Cursor struct {
	src  *Source
	file *os.File
	lr   *lineReader

	// row is reused across rows. Holding the previous values in place is what
	// implements the "keep the last value" rule for a missing field.
	row     Row
	pending bool
	err     error
}

// Cursor opens a new cursor positioned at the first row of the source.
func (s *Source) Cursor() (*Cursor, error) {
	file, err := os.Open(s.path)
	if err != nil {
		return nil, fmt.Errorf("replay: opening %s: %w", s.path, err)
	}

	c := &Cursor{
		src:  s,
		file: file,
		lr:   newLineReader(file, 0, 0),
		row: Row{
			Analog:  make([]float64, len(s.schema.analogTags)),
			Digital: make([]bool, len(s.schema.digitalTags)),
		},
	}
	if err := c.reposition(s.dataStart); err != nil {
		_ = file.Close()
		return nil, err
	}
	return c, nil
}

// Close releases the cursor's file descriptor.
func (c *Cursor) Close() error {
	if err := c.file.Close(); err != nil {
		return fmt.Errorf("replay: closing %s: %w", c.src.path, err)
	}
	return nil
}

// Peek returns the next row without consuming it, or io.EOF at the end of the
// file. A parse error is sticky: it is returned by every later call until a
// Seek moves the cursor somewhere else.
//
// The returned pointer addresses a Row the cursor reuses; it stays valid
// until the next Advance or Seek. A caller that keeps the row past that point
// clones it.
func (c *Cursor) Peek() (*Row, error) {
	if c.pending {
		return &c.row, nil
	}
	if c.err != nil {
		return nil, c.err
	}

	line, _, err := c.lr.next()
	if err != nil {
		if errors.Is(err, io.EOF) {
			c.err = io.EOF
		} else {
			c.err = fmt.Errorf("replay: %s: %w", c.src.path, err)
		}
		return nil, c.err
	}
	if err := c.src.schema.parseRow(line, &c.row); err != nil {
		c.err = fmt.Errorf("replay: %s line %d: %w", c.src.path, c.lr.line, err)
		return nil, c.err
	}

	c.pending = true
	return &c.row, nil
}

// Advance consumes the row Peek returns. At the end of the file, and after a
// parse error, it does nothing.
func (c *Cursor) Advance() {
	if _, err := c.Peek(); err != nil {
		return
	}
	c.pending = false
}

// Position returns the timestamp of the row Peek would return, and false at
// the end of the file or after a parse error.
func (c *Cursor) Position() (uint64, bool) {
	row, err := c.Peek()
	if err != nil {
		return 0, false
	}
	return row.SimTsMs, true
}

// Seek positions the cursor on the first row whose timestamp is at or after
// simTsMs: a binary search of the sparse index, one file seek and a forward
// scan of at most IndexStride rows.
//
// A target before the first row lands on the first row; a target after the
// last one leaves the cursor at the end of the file, where Peek reports
// io.EOF.
//
// The scan reads nothing but the timestamp of the rows it passes over, and
// the values a missing field would fall back to are cleared, so where a
// cursor lands and what it reads there depend on the target alone and not on
// where the cursor came from.
func (c *Cursor) Seek(simTsMs uint64) error {
	entry, ok := c.src.locate(simTsMs)
	if !ok {
		// The file has a header and no rows: there is nowhere to go.
		c.pending = false
		c.err = io.EOF
		return nil
	}
	if err := c.reposition(entry); err != nil {
		return err
	}

	for {
		line, _, err := c.lr.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				c.err = io.EOF // past the last row: the cursor sits at the end
				return nil
			}
			c.err = fmt.Errorf("replay: %s: %w", c.src.path, err)
			return c.err
		}

		ms, err := c.src.schema.rowTimestamp(line)
		if err != nil {
			c.err = fmt.Errorf("replay: %s line %d: %w", c.src.path, c.lr.line, err)
			return c.err
		}
		if ms < simTsMs {
			continue
		}

		if err := c.src.schema.parseRow(line, &c.row); err != nil {
			c.err = fmt.Errorf("replay: %s line %d: %w", c.src.path, c.lr.line, err)
			return c.err
		}
		c.pending = true
		return nil
	}
}

// reposition moves the reader to the start of entry and forgets everything
// the cursor held from its previous position.
func (c *Cursor) reposition(entry indexEntry) error {
	if _, err := c.file.Seek(entry.offset, io.SeekStart); err != nil {
		return fmt.Errorf("replay: %s: seeking to byte %d: %w", c.src.path, entry.offset, err)
	}
	c.lr.resetAt(c.file, entry.offset, entry.line-1)

	c.pending = false
	c.err = nil
	c.row.SimTsMs = 0
	c.row.Missing = false
	clear(c.row.Analog)
	clear(c.row.Digital)
	return nil
}
