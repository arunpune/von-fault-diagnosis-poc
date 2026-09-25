// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package regmap

import (
	"fmt"
	"math"
	"slices"
	"sync/atomic"
)

// Header is the decoded header block (docs/simulation.md, "Register model").
type Header struct {
	HeadSeq   uint32
	SimTsMs   uint64
	State     uint16
	Speed     uint16
	RingSlots uint16
	SlotRegs  uint16
	RingBase  uint32
	MapMajor  uint16
	MapMinor  uint16
}

// Slot is one decoded sample of the ring buffer. Analog holds the value of
// every analog signal in SI units, Digital the state of every digital signal;
// both are keyed by Signal.Tag.
type Slot struct {
	Seq           uint32
	SimTsMs       uint64
	Discontinuity bool
	Missing       bool
	Analog        map[string]float64
	Digital       map[string]bool
	AlarmBits     uint32
}

// clampCount counts the analog values EncodeSlot had to clamp into the int16
// range since the process started. The simulator reports it in its status so a
// silently saturating scale does not go unnoticed.
var clampCount atomic.Uint64

// ClampCount returns how many analog values EncodeSlot clamped so far.
func ClampCount() uint64 { return clampCount.Load() }

// ResetClampCount sets the clamp counter back to zero. Tests use it to assert
// a single encode; production code never calls it.
func ResetClampCount() { clampCount.Store(0) }

// ByTag returns the signal with the given tag.
func ByTag(tag string) (Signal, bool) {
	for _, s := range Signals {
		if s.Tag == tag {
			return s, true
		}
	}
	return Signal{}, false
}

// ByColumn returns the signal read from the given MetroPT-3 CSV column. The
// synthetic extras have no column and are never returned.
func ByColumn(col string) (Signal, bool) {
	if col == "" {
		return Signal{}, false
	}
	for _, s := range Signals {
		if s.Column == col {
			return s, true
		}
	}
	return Signal{}, false
}

// putU32 writes v at regs[off] and regs[off+1], high word first.
func putU32(regs []uint16, off uint16, v uint32) {
	regs[off] = uint16(v >> 16)
	regs[off+1] = uint16(v)
}

// getU32 reads the two registers at off as one uint32, high word first.
func getU32(regs []uint16, off uint16) uint32 {
	return uint32(regs[off])<<16 | uint32(regs[off+1])
}

// putU64 writes v at regs[off..off+3], high word first.
func putU64(regs []uint16, off uint16, v uint64) {
	regs[off] = uint16(v >> 48)
	regs[off+1] = uint16(v >> 32)
	regs[off+2] = uint16(v >> 16)
	regs[off+3] = uint16(v)
}

// getU64 reads the four registers at off as one uint64, high word first.
func getU64(regs []uint16, off uint16) uint64 {
	return uint64(regs[off])<<48 | uint64(regs[off+1])<<32 |
		uint64(regs[off+2])<<16 | uint64(regs[off+3])
}

// EncodeHeader renders the header block. Ring geometry and map version come
// from the layout and the generated map, not from h, so a caller cannot
// advertise a geometry the device does not have.
func EncodeHeader(h Header) [HeaderRegs]uint16 {
	var regs [HeaderRegs]uint16
	putU32(regs[:], HdrHeadSeq, h.HeadSeq)
	putU64(regs[:], HdrSimTsNow, h.SimTsMs)
	regs[HdrReplayState] = h.State
	regs[HdrReplaySpeed] = h.Speed
	regs[HdrRingSlots] = RingSlots
	regs[HdrSlotRegs] = SlotRegs
	putU32(regs[:], HdrRingBase, uint32(RingBase))
	regs[HdrMapMajor] = MapMajor
	regs[HdrMapMinor] = MapMinor
	return regs
}

// DecodeHeader reads a header block. regs may be longer than HeaderRegs — a
// client that reads the whole reserved block gets the same result — but a
// short read is an error.
func DecodeHeader(regs []uint16) (Header, error) {
	if len(regs) < HeaderRegs {
		return Header{}, fmt.Errorf("regmap: header needs %d registers, got %d", HeaderRegs, len(regs))
	}
	return Header{
		HeadSeq:   getU32(regs, HdrHeadSeq),
		SimTsMs:   getU64(regs, HdrSimTsNow),
		State:     regs[HdrReplayState],
		Speed:     regs[HdrReplaySpeed],
		RingSlots: regs[HdrRingSlots],
		SlotRegs:  regs[HdrSlotRegs],
		RingBase:  getU32(regs, HdrRingBase),
		MapMajor:  regs[HdrMapMajor],
		MapMinor:  regs[HdrMapMinor],
	}, nil
}

// encodeAnalog scales v by scale, rounds to the nearest integer and clamps the
// result into the int16 range, counting every clamp. A NaN or infinite value
// encodes as 0: the caller marks such a row with FlagMissing.
func encodeAnalog(v, scale float64) uint16 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	scaled := math.Round(v * scale)
	switch {
	case scaled > math.MaxInt16:
		clampCount.Add(1)
		scaled = math.MaxInt16
	case scaled < math.MinInt16:
		clampCount.Add(1)
		scaled = math.MinInt16
	}
	return uint16(int16(scaled))
}

// decodeAnalog is the inverse of encodeAnalog for a value that was not
// clamped: the register is read as a signed 16-bit integer and divided by the
// signal's scale.
func decodeAnalog(reg uint16, scale float64) float64 {
	return float64(int16(reg)) / scale
}

// EncodeSlot renders one sample into its 32 registers. Every signal of the
// generated map must be present in the matching map of s, and s may not carry
// a tag the map does not know: a mismatch is a programming error, not a
// recoverable condition, so it is reported instead of silently encoding zero.
func EncodeSlot(s Slot) ([SlotRegs]uint16, error) {
	var regs [SlotRegs]uint16

	for tag := range s.Analog {
		sig, ok := ByTag(tag)
		if !ok || sig.Kind != KindAnalog {
			return regs, fmt.Errorf("regmap: unknown analog tag %q", tag)
		}
	}
	for tag := range s.Digital {
		sig, ok := ByTag(tag)
		if !ok || sig.Kind != KindDigital {
			return regs, fmt.Errorf("regmap: unknown digital tag %q", tag)
		}
	}

	putU32(regs[:], SlotSeq, s.Seq)
	putU64(regs[:], SlotSimTs, s.SimTsMs)
	var flags uint16
	if s.Discontinuity {
		flags |= FlagDiscontinuity
	}
	if s.Missing {
		flags |= FlagMissing
	}
	regs[SlotFlags] = flags

	for _, sig := range Signals {
		switch sig.Kind {
		case KindAnalog:
			v, ok := s.Analog[sig.Tag]
			if !ok {
				return regs, fmt.Errorf("regmap: no value for analog tag %q", sig.Tag)
			}
			regs[sig.Offset] = encodeAnalog(v, sig.Scale)
		case KindDigital:
			v, ok := s.Digital[sig.Tag]
			if !ok {
				return regs, fmt.Errorf("regmap: no value for digital tag %q", sig.Tag)
			}
			if v {
				regs[sig.Offset] = 1
			}
		default:
			return regs, fmt.Errorf("regmap: signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}

	putU32(regs[:], SlotAlarmBits, s.AlarmBits)
	return regs, nil
}

// DecodeSlot reads exactly one slot. The caller slices a multi-slot read into
// SlotRegs-register windows, regs[i*SlotRegs : (i+1)*SlotRegs], so a length
// other than SlotRegs is an off-by-one in the reader and is reported.
func DecodeSlot(regs []uint16) (Slot, error) {
	if len(regs) != SlotRegs {
		return Slot{}, fmt.Errorf("regmap: slot needs exactly %d registers, got %d", SlotRegs, len(regs))
	}

	s := Slot{
		Seq:           getU32(regs, SlotSeq),
		SimTsMs:       getU64(regs, SlotSimTs),
		Discontinuity: regs[SlotFlags]&FlagDiscontinuity != 0,
		Missing:       regs[SlotFlags]&FlagMissing != 0,
		Analog:        make(map[string]float64),
		Digital:       make(map[string]bool),
		AlarmBits:     getU32(regs, SlotAlarmBits),
	}
	for _, sig := range Signals {
		switch sig.Kind {
		case KindAnalog:
			s.Analog[sig.Tag] = decodeAnalog(regs[sig.Offset], sig.Scale)
		case KindDigital:
			s.Digital[sig.Tag] = regs[sig.Offset] != 0
		default:
			return Slot{}, fmt.Errorf("regmap: signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}
	return s, nil
}

// AlarmCodes returns the codes of the alarms whose bit is set in bits, in
// ascending bit order. A bit without an alarm in the generated map is ignored:
// a device with a newer minor map version may set one.
func AlarmCodes(bits uint32) []string {
	active := make([]Alarm, 0, len(Alarms))
	for _, a := range Alarms {
		if a.Bit < 32 && bits&(1<<a.Bit) != 0 {
			active = append(active, a)
		}
	}
	slices.SortFunc(active, func(a, b Alarm) int { return int(a.Bit) - int(b.Bit) })

	codes := make([]string, len(active))
	for i, a := range active {
		codes[i] = a.Code
	}
	return codes
}
