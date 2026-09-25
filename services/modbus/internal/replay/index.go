// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"sort"
)

// lineReader walks a CSV line by line and keeps track of where each line
// starts, so the index can record byte offsets and every error can name the
// file line it came from.
//
// A returned line points into the bufio buffer and is only valid until the
// next call; the parsers consume it immediately.
type lineReader struct {
	br     *bufio.Reader
	offset int64 // byte offset of the next line
	line   int   // file line number of the line last returned, 1-based
}

// resetAt points the reader at a new position in the same file: it keeps the
// 1 MiB buffer, so a Seek allocates nothing.
func (lr *lineReader) resetAt(r io.Reader, offset int64, prevLine int) {
	lr.br.Reset(r)
	lr.offset = offset
	lr.line = prevLine
}

// next returns the next non-empty line without its terminator, the byte
// offset the line starts at, and io.EOF once the file is exhausted. Blank
// lines are skipped, which is what makes a file that ends in a newline, and
// one written with CRLF, parse the same.
func (lr *lineReader) next() ([]byte, int64, error) {
	for {
		start := lr.offset
		chunk, err := lr.br.ReadSlice('\n')
		lr.offset += int64(len(chunk))
		if len(chunk) > 0 {
			lr.line++
		}

		switch {
		case err == nil:
		case errors.Is(err, bufio.ErrBufferFull):
			return nil, 0, fmt.Errorf("line %d is longer than the %d-byte read buffer",
				lr.line, readBufferBytes)
		case errors.Is(err, io.EOF):
			if line := trimLine(chunk); len(line) > 0 {
				return line, start, nil
			}
			return nil, 0, io.EOF
		default:
			return nil, 0, fmt.Errorf("reading line %d: %w", lr.line, err)
		}

		if line := trimLine(chunk); len(line) > 0 {
			return line, start, nil
		}
	}
}

// trimLine strips the line terminator, in either of its two spellings.
func trimLine(chunk []byte) []byte {
	return bytes.TrimRight(chunk, "\r\n")
}

// indexEntry anchors one row of the sparse time index: where the row starts,
// which file line it is and what it is stamped with.
type indexEntry struct {
	offset  int64
	line    int
	simTsMs uint64
}

// buildIndex makes the single sequential boot-time pass over the rows lr is
// positioned at. It parses nothing but the timestamp column, which is what
// keeps the pass at about a second for the full 218 MB file.
//
// Timestamps must be strictly increasing: the index is binary searched and
// the pacing loop assumes a monotonic clock, so an out-of-order row is a file
// error, not a row to skip.
func (s *Source) buildIndex(lr *lineReader) error {
	var gaps []Gap
	index := make([]indexEntry, 0, 1024)

	rows := 0
	var first, last uint64
	for {
		line, offset, err := lr.next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}

		ms, err := s.schema.rowTimestamp(line)
		if err != nil {
			return fmt.Errorf("line %d: %w", lr.line, err)
		}

		if rows == 0 {
			first = ms
		} else {
			if ms <= last {
				return fmt.Errorf("line %d: the timestamp does not increase on the previous row",
					lr.line)
			}
			if ms-last > GapThresholdMs {
				gaps = append(gaps, Gap{StartMs: last, EndMs: ms})
			}
		}

		if rows%IndexStride == 0 {
			index = append(index, indexEntry{offset: offset, line: lr.line, simTsMs: ms})
		}
		last = ms
		rows++
	}

	s.index = index
	s.rows = rows
	s.firstMs = first
	s.lastMs = last
	s.gaps = gaps
	return nil
}

// locate returns the index entry to start a forward scan for simTsMs from:
// the last entry at or before the target, or the first entry when the target
// is before the start of the file. It reports false when the file has no rows.
func (s *Source) locate(simTsMs uint64) (indexEntry, bool) {
	if len(s.index) == 0 {
		return indexEntry{}, false
	}
	// The first entry whose row is already past the target; the one before it
	// is the anchor.
	after := sort.Search(len(s.index), func(i int) bool {
		return s.index[i].simTsMs > simTsMs
	})
	if after == 0 {
		return s.index[0], true
	}
	return s.index[after-1], true
}
