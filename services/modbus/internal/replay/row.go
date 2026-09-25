// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package replay

import (
	"bytes"
	"fmt"
	"math"
	"slices"
	"strconv"
	"time"
)

// Row is one source sample in SI units. Scaling to registers happens in the
// codec, never here.
//
// Analog and Digital are indexed in the order the analog and the digital
// signals appear in the slice passed to Open; Source.AnalogTags and
// Source.DigitalTags name them. Missing is true when at least one field of
// the row was empty, NaN, infinite or unparsable; the affected entries then
// hold the value the previous row had (zero before any value).
type Row struct {
	SimTsMs uint64
	Analog  []float64
	Digital []bool
	Missing bool
}

// Clone returns a deep copy. Cursor.Peek returns a pointer to a Row it reuses
// and overwrites on the next Advance or Seek, so a caller that keeps a row
// past that point clones it first.
func (r *Row) Clone() Row {
	return Row{
		SimTsMs: r.SimTsMs,
		Analog:  slices.Clone(r.Analog),
		Digital: slices.Clone(r.Digital),
		Missing: r.Missing,
	}
}

// tsLayoutLen is the length of the dataset's timestamp format, "2006-01-02
// 15:04:05".
const tsLayoutLen = 19

// parseTimestampMs reads a dataset timestamp as epoch milliseconds UTC.
//
// The layout is fixed, so the field is decoded in place instead of through
// time.Parse: the separators must sit where the layout puts them, every other
// byte must be a digit, and the calendar date must exist — time.Date would
// otherwise silently normalise 2020-02-30 into 2020-03-01.
func parseTimestampMs(f []byte) (uint64, error) {
	if len(f) != tsLayoutLen ||
		f[4] != '-' || f[7] != '-' || f[10] != ' ' || f[13] != ':' || f[16] != ':' {
		return 0, fmt.Errorf("timestamp %q is not in the %q layout", f, time.DateTime)
	}

	year, okYear := digits(f[0:4])
	month, okMonth := digits(f[5:7])
	day, okDay := digits(f[8:10])
	hour, okHour := digits(f[11:13])
	minute, okMinute := digits(f[14:16])
	second, okSecond := digits(f[17:19])
	if !okYear || !okMonth || !okDay || !okHour || !okMinute || !okSecond {
		return 0, fmt.Errorf("timestamp %q is not in the %q layout", f, time.DateTime)
	}

	t := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	if t.Year() != year || int(t.Month()) != month || t.Day() != day ||
		t.Hour() != hour || t.Minute() != minute || t.Second() != second {
		return 0, fmt.Errorf("timestamp %q is not a valid instant", f)
	}
	ms := t.UnixMilli()
	if ms < 0 {
		return 0, fmt.Errorf("timestamp %q is before the epoch", f)
	}
	return uint64(ms), nil
}

// digits reads f as a decimal number. It reports false on any non-digit, so a
// field such as "20x0" is rejected rather than half read.
func digits(f []byte) (int, bool) {
	n := 0
	for _, b := range f {
		if b < '0' || b > '9' {
			return 0, false
		}
		n = n*10 + int(b-'0')
	}
	return n, true
}

// parseAnalog reads an analog field. It reports false for an empty, NaN,
// infinite or unparsable value; the caller then holds the previous value and
// flags the row.
func parseAnalog(f []byte) (float64, bool) {
	if len(f) == 0 {
		return 0, false
	}
	// strconv.ParseFloat does not retain its argument, so the conversion
	// stays on the stack and the parse allocates nothing.
	v, err := strconv.ParseFloat(string(f), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// parseDigital reads a digital field, which the dataset stores as a float:
// anything other than zero is true.
func parseDigital(f []byte) (bool, bool) {
	v, ok := parseAnalog(f)
	if !ok {
		return false, false
	}
	return v != 0, true
}

// parseRow fills row from one CSV line. row keeps the values of the previous
// line, which is how a missing field holds its last value; SimTsMs and
// Missing are always overwritten.
//
// A line with fewer fields than the header has is not an error: every bound
// column past its end holds its previous value and the row is flagged. Only a
// missing or unparsable timestamp is fatal, because it would break the index
// and the pacing.
func (sc *schema) parseRow(line []byte, row *Row) error {
	row.Missing = false

	col := 0
	rest := line
	for ; col < len(sc.bindings) && rest != nil; col++ {
		var f []byte
		if i := bytes.IndexByte(rest, ','); i >= 0 {
			f, rest = rest[:i], rest[i+1:]
		} else {
			f, rest = rest, nil
		}

		b := sc.bindings[col]
		switch b.kind {
		case bindTimestamp:
			ms, err := parseTimestampMs(f)
			if err != nil {
				return err
			}
			row.SimTsMs = ms
		case bindAnalog:
			if v, ok := parseAnalog(f); ok {
				row.Analog[b.slot] = v
			} else {
				row.Missing = true
			}
		case bindDigital:
			if v, ok := parseDigital(f); ok {
				row.Digital[b.slot] = v
			} else {
				row.Missing = true
			}
		case bindIgnore:
		}
	}

	// Columns the line stopped short of. The timestamp is the one that cannot
	// be held over from the previous row.
	for ; col < len(sc.bindings); col++ {
		switch sc.bindings[col].kind {
		case bindTimestamp:
			return fmt.Errorf("the line has %d fields and no %q column",
				countFields(line), TimestampColumn)
		case bindAnalog, bindDigital:
			row.Missing = true
		case bindIgnore:
		}
	}
	return nil
}

// rowTimestamp reads the timestamp of a line and nothing else. The index pass
// and the forward scan of a Seek go through it, which is what keeps both at a
// single field parse per row.
func (sc *schema) rowTimestamp(line []byte) (uint64, error) {
	f, ok := field(line, sc.timestampAt)
	if !ok {
		return 0, fmt.Errorf("the line has %d fields and no %q column",
			countFields(line), TimestampColumn)
	}
	return parseTimestampMs(f)
}

// countFields returns the number of comma-separated fields of a line. It runs
// only on the error path of parseRow.
func countFields(line []byte) int { return bytes.Count(line, []byte{','}) + 1 }

// field returns the idx-th comma-separated field of line. It is the one-field
// counterpart of parseRow, used by the index pass, which reads nothing but
// the timestamp.
func field(line []byte, idx int) ([]byte, bool) {
	rest := line
	for i := 0; ; i++ {
		comma := bytes.IndexByte(rest, ',')
		if comma < 0 {
			if i == idx {
				return rest, true
			}
			return nil, false
		}
		if i == idx {
			return rest[:comma], true
		}
		rest = rest[comma+1:]
	}
}
