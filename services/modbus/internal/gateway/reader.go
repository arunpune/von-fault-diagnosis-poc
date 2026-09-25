// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"fmt"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// MaxSlotsPerRead is how many consecutive slots one request carries: three
// slots are 96 registers, comfortably inside the 125 of FC03.
const MaxSlotsPerRead uint32 = 3

// ringSlots is the ring geometry as an unsigned 32-bit value, which is the
// width every sequence number is counted in.
const ringSlots = uint32(regmap.RingSlots)

// MapMajorError reports a device whose register map has a different major
// version. The gateway refuses to decode its slots: a changed major means a
// changed scale or a removed signal, so every decoded value would be wrong.
// The service marks itself unhealthy and retries.
type MapMajorError struct {
	// Device is the major version the device reports in its header.
	Device uint16
	// Expected is the major version this build's register map carries.
	Expected uint16
}

func (e *MapMajorError) Error() string {
	return fmt.Sprintf("gateway: the device reports register map major %d, this build decodes major %d; "+
		"refusing to decode its slots", e.Device, e.Expected)
}

// Counters are the monotonic totals of the heartbeat, all counted since the
// process started.
type Counters struct {
	// Polls is the number of completed poll cycles.
	Polls uint64
	// ReadErrors is the number of poll cycles that ended in a Modbus error.
	ReadErrors uint64
	// Dropped is the number of samples the ring overwrote before the reader
	// got to them.
	Dropped uint64
	// Resyncs is the number of times a slot carried an unexpected sequence
	// number, which sends the reader back to the header.
	Resyncs uint64
	// SimRestarts is the number of times the device's head sequence went
	// backwards, which only a restarted simulator does.
	SimRestarts uint64
}

// Poll is the outcome of one poll cycle.
type Poll struct {
	// Samples are the slots accepted in this cycle, in ascending sequence
	// order. Empty when the device has nothing new.
	Samples []regmap.Slot
	// More reports that the read returned a full MaxSlotsPerRead slots, so
	// the device very likely has more waiting and the caller should poll
	// again without sleeping.
	More bool
	// Header is the header block this cycle read.
	Header regmap.Header
}

// Reader implements the ring-reading algorithm (docs/simulation.md, "Polling
// the ring") on top of a Poller.
//
// It is not safe for concurrent use: the poll loop owns it and publishes what
// it observes through the service's snapshot.
type Reader struct {
	poller Poller

	// synced is false until the first header read, which adopts the device's
	// head as the starting point. A backlog that predates the gateway is not
	// replayed, and a reconnect keeps the sequence it had.
	synced bool
	// lastSeq is the sequence number of the newest accepted sample.
	lastSeq uint32
	// head is the head sequence of the last header read.
	head uint32

	counters Counters
}

// NewReader returns a Reader over poller. Opening the poller is the caller's
// business: the reader neither connects nor reconnects.
func NewReader(poller Poller) *Reader {
	return &Reader{poller: poller}
}

// Counters returns the totals so far.
func (r *Reader) Counters() Counters { return r.counters }

// LastSeq returns the sequence number of the newest accepted sample, 0 before
// the first one.
func (r *Reader) LastSeq() uint32 { return r.lastSeq }

// Head returns the head sequence of the last header the reader saw.
func (r *Reader) Head() uint32 { return r.head }

// Poll runs one cycle of the ring-reading algorithm: read the header, work out
// which slots are new, read up to MaxSlotsPerRead of them in one request and
// decode them.
//
// A Modbus failure is returned to the caller, which closes and reopens the
// connection and calls again; lastSeq survives that, and the ring rule counts
// whatever the device overwrote in the meantime.
func (r *Reader) Poll() (Poll, error) {
	r.counters.Polls++

	// Two attempts at most: a slot whose sequence number does not match was
	// overwritten while the reader was reading it, which means the header is
	// already stale, so the cycle starts again from a fresh header. The
	// second attempt reads a header the device wrote after the overwrite, so
	// it cannot fail the same way for the same reason.
	for attempt := 0; attempt < 2; attempt++ {
		hdr, err := r.readHeader()
		if err != nil {
			return Poll{}, err
		}

		from, ok := r.nextSeq(hdr)
		if !ok {
			return Poll{Header: hdr}, nil
		}

		samples, resync, err := r.readSlots(from, hdr.HeadSeq)
		if err != nil {
			return Poll{}, err
		}
		if resync {
			r.counters.Resyncs++
		}
		if len(samples) != 0 {
			r.lastSeq = samples[len(samples)-1].Seq
			return Poll{
				Samples: samples,
				More:    !resync && uint32(len(samples)) == MaxSlotsPerRead,
				Header:  hdr,
			}, nil
		}
		if !resync {
			return Poll{Header: hdr}, nil
		}
	}
	// Nothing was accepted twice in a row; the caller polls again, and the
	// ring rule above will have moved the window by then.
	return Poll{}, nil
}

// readHeader reads and decodes the header block, refusing a device whose
// register map major differs from this build's.
func (r *Reader) readHeader() (regmap.Header, error) {
	regs, err := r.poller.ReadHolding(regmap.HeaderBase, regmap.HeaderRegs)
	if err != nil {
		r.counters.ReadErrors++
		return regmap.Header{}, err
	}
	hdr, err := regmap.DecodeHeader(regs)
	if err != nil {
		r.counters.ReadErrors++
		return regmap.Header{}, fmt.Errorf("gateway: decoding the device header: %w", err)
	}
	if hdr.MapMajor != regmap.MapMajor {
		return regmap.Header{}, &MapMajorError{Device: hdr.MapMajor, Expected: regmap.MapMajor}
	}
	r.head = hdr.HeadSeq
	return hdr, nil
}

// nextSeq applies the three header rules — adopt the head on the first
// connect, follow a restarted simulator backwards, and count what the ring
// overwrote while the reader was behind — and returns the sequence number to
// read from. ok is false when there is nothing new to read.
func (r *Reader) nextSeq(hdr regmap.Header) (from uint32, ok bool) {
	if !r.synced {
		// The gateway starts at the device's present: a ring full of samples
		// from before it connected is not a backlog it owes anyone.
		r.synced = true
		r.lastSeq = hdr.HeadSeq
		return 0, false
	}
	if hdr.HeadSeq < r.lastSeq {
		// Sequence numbers only ever grow inside one simulator process, so a
		// head that went backwards is a restarted device. Nothing was
		// dropped: the samples the gateway is waiting for no longer exist.
		r.counters.SimRestarts++
		r.lastSeq = hdr.HeadSeq
		return 0, false
	}
	if hdr.HeadSeq == r.lastSeq {
		return 0, false
	}

	from = r.lastSeq + 1
	if hdr.HeadSeq-from+1 > ringSlots {
		// The reader is further behind than the ring is deep, so the oldest
		// slots it still wants have been overwritten. It resumes at the
		// oldest slot the ring still holds and counts the rest as lost.
		oldest := hdr.HeadSeq - (ringSlots - 1)
		r.counters.Dropped += uint64(oldest - from)
		from = oldest
	}
	return from, true
}

// readSlots reads the slots from..from+n-1 in one request and decodes them,
// stopping at the first slot whose sequence number is not the expected one.
// resync reports that such a slot was found.
func (r *Reader) readSlots(from, head uint32) (samples []regmap.Slot, resync bool, err error) {
	n := min(MaxSlotsPerRead, head-from+1, ringSlots-from%ringSlots)

	regs, err := r.poller.ReadHolding(regmap.SlotAddr(from), uint16(n)*regmap.SlotRegs)
	if err != nil {
		r.counters.ReadErrors++
		return nil, false, err
	}

	samples = make([]regmap.Slot, 0, n)
	for i := uint32(0); i < n; i++ {
		slot, err := regmap.DecodeSlot(regs[i*regmap.SlotRegs : (i+1)*regmap.SlotRegs])
		if err != nil {
			r.counters.ReadErrors++
			return nil, false, fmt.Errorf("gateway: decoding slot %d: %w", from+i, err)
		}
		if slot.Seq != from+i {
			// The device overwrote this slot between the header read and the
			// slot read. Whatever came before it is still good; the drop is
			// counted by the ring rule on the next header, which is the one
			// place that knows how far behind the reader now is.
			return samples, true, nil
		}
		samples = append(samples, slot)
	}
	return samples, false, nil
}
