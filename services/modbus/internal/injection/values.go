// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import "fault-diagnosis-poc/services/modbus/internal/regmap"

// Values are one sample's readings in SI units, the only thing an overlay
// touches.
//
// The slices are indexed the way replay.Row is: Analog in the order the
// analog signals appear in the table passed to NewEngine, Digital in the
// order the digital ones do. The register map ends with the synthetic
// ambient_temperature extra, which the replay source does not produce — the
// simulator computes it and appends it to Analog before calling Apply, so the
// index the engine resolved from the same table lands on it. A caller that
// leaves it off simply has a shorter slice, and a transform on a tag past the
// end is skipped rather than panicking.
type Values struct {
	Analog  []float64
	Digital []bool
}

// tagIndex resolves a tag to its position in Values.
type tagIndex struct {
	analog  map[string]int
	digital map[string]int
}

// newTagIndex numbers the signals the way replay.Row and the simulator do:
// analog and digital each count from zero in table order.
func newTagIndex(signals []regmap.Signal) tagIndex {
	idx := tagIndex{
		analog:  make(map[string]int),
		digital: make(map[string]int),
	}
	for _, sig := range signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			idx.analog[sig.Tag] = len(idx.analog)
		case regmap.KindDigital:
			idx.digital[sig.Tag] = len(idx.digital)
		}
	}
	return idx
}

// lookup returns the slice position of a tag and its kind.
func (t tagIndex) lookup(tag string) (pos int, kind regmap.Kind, ok bool) {
	if i, found := t.analog[tag]; found {
		return i, regmap.KindAnalog, true
	}
	if i, found := t.digital[tag]; found {
		return i, regmap.KindDigital, true
	}
	return 0, 0, false
}
