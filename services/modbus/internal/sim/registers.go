// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"errors"
	"sync"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// The two conditions a read can fail with. They carry no Modbus vocabulary so
// that the store stays independent of the server library; server.go maps them
// onto the matching exception codes.
var (
	// ErrIllegalDataAddress is returned when the requested window reaches past
	// the end of the register space.
	ErrIllegalDataAddress = errors.New("sim: illegal data address")
	// ErrIllegalDataValue is returned for a quantity outside 1..MaxReadRegs.
	ErrIllegalDataValue = errors.New("sim: illegal data value")
)

// MaxReadRegs is the largest number of registers one FC03 response can carry
// (253 payload bytes minus the byte count).
const MaxReadRegs uint16 = 125

// Store is the simulator's register space: the header block, the ring buffer
// and the reserved areas in between, which read as zero (docs/simulation.md,
// "Register model").
//
// A sample is written slot-first and then head_seq, under one write lock, and
// every read takes the read lock, so a Modbus request never observes a
// half-written slot. The writer never waits for a reader: a client that lags
// by a whole ring sees a slot whose seq is not the one it expected, which is
// how the gateway detects loss. The zero value is not usable; construct one
// with NewStore.
type Store struct {
	mu   sync.RWMutex
	regs [regmap.TotalRegs]uint16
}

// NewStore returns an empty register space whose header already advertises the
// ring geometry and the map version, so a client that connects before the
// first sample still reads a valid header.
func NewStore() *Store {
	s := &Store{}
	s.WriteHeader(regmap.Header{})
	return s
}

// WriteHeader renders h into the header block. The ring geometry and the map
// version come from the layout, not from h (regmap.EncodeHeader enforces it).
func (s *Store) WriteHeader(h regmap.Header) {
	regs := regmap.EncodeHeader(h)

	s.mu.Lock()
	defer s.mu.Unlock()
	copy(s.regs[regmap.HeaderBase:], regs[:])
}

// WriteSample publishes one sample: the 32 slot registers of headSeq followed
// by head_seq itself, both under the same write lock, which is the ordering
// the ring buffer requires.
//
// The rest of the header is not touched; the emit loop refreshes sim_ts_now,
// the state and the speed on its own schedule.
func (s *Store) WriteSample(slot [regmap.SlotRegs]uint16, headSeq uint32) {
	base := regmap.SlotAddr(headSeq)

	s.mu.Lock()
	defer s.mu.Unlock()
	copy(s.regs[base:base+regmap.SlotRegs], slot[:])
	s.regs[regmap.HdrHeadSeq] = uint16(headSeq >> 16)
	s.regs[regmap.HdrHeadSeq+1] = uint16(headSeq)
}

// Read returns a copy of qty registers from addr.
//
// A quantity outside 1..MaxReadRegs is an ErrIllegalDataValue and a window
// that reaches past regmap.TotalRegs an ErrIllegalDataAddress; everything in
// between is served, reserved and never-written areas included, as the zeros
// they hold.
func (s *Store) Read(addr, qty uint16) ([]uint16, error) {
	if qty == 0 || qty > MaxReadRegs {
		return nil, ErrIllegalDataValue
	}
	if uint32(addr)+uint32(qty) > uint32(regmap.TotalRegs) {
		return nil, ErrIllegalDataAddress
	}

	out := make([]uint16, qty)

	s.mu.RLock()
	defer s.mu.RUnlock()
	copy(out, s.regs[addr:addr+qty])
	return out, nil
}

// HeadSeq returns the sequence number of the newest complete slot, or zero
// when no sample has been emitted since boot.
func (s *Store) HeadSeq() uint32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return uint32(s.regs[regmap.HdrHeadSeq])<<16 | uint32(s.regs[regmap.HdrHeadSeq+1])
}
