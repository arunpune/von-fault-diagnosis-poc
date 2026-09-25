// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package regmap

// Register addresses and flag bits of the register model (docs/simulation.md,
// "Register model"). They are hand-written and stable: the generator emits no
// address, so a change here is a change of the wire format and bumps MapMajor
// or MapMinor.
//
// Every value is a holding-register address (FC03), big-endian 16-bit words,
// multi-word values high word first.
const (
	// HeaderBase is the address of the header block. The block itself spans
	// addresses 0..31; only the first HeaderRegs registers carry fields, the
	// rest are reserved and read as zero.
	HeaderBase uint16 = 0
	// HeaderRegs is the number of header registers the codec encodes and the
	// gateway reads in one request.
	HeaderRegs = 14

	// HdrHeadSeq is the uint32 sequence number of the newest complete slot;
	// 0 means no sample has been emitted since boot.
	HdrHeadSeq uint16 = 0
	// HdrSimTsNow is the uint64 simulated clock in epoch milliseconds UTC.
	HdrSimTsNow uint16 = 2
	// HdrReplayState holds one of ReplayStopped, ReplayPlaying, ReplayPaused.
	HdrReplayState uint16 = 6
	// HdrReplaySpeed is the replay speed factor, 1..3600.
	HdrReplaySpeed uint16 = 7
	// HdrRingSlots mirrors RingSlots.
	HdrRingSlots uint16 = 8
	// HdrSlotRegs mirrors SlotRegs.
	HdrSlotRegs uint16 = 9
	// HdrRingBase is the uint32 mirror of RingBase.
	HdrRingBase uint16 = 10
	// HdrMapMajor mirrors MapMajor; a gateway refuses a different major.
	HdrMapMajor uint16 = 12
	// HdrMapMinor mirrors MapMinor.
	HdrMapMinor uint16 = 13
)

// Ring buffer geometry.
const (
	// RingBase is the address of slot 0.
	RingBase uint16 = 1024
	// RingSlots is the number of slots in the ring.
	RingSlots = 256
	// SlotRegs is the number of registers in one slot.
	SlotRegs = 32
	// TotalRegs is the size of the register space the server exposes.
	TotalRegs uint16 = 9216
)

// Register offsets inside a slot. The analog, digital and ambient fields are
// addressed through Signal.Offset, so only the fixed fields need a constant
// here; SlotAnalogBase, SlotDigitalBase and SlotAmbient state the ranges the
// generator must respect.
const (
	// SlotSeq is the uint32 sample sequence number, from 1, never reset while
	// the process lives.
	SlotSeq uint16 = 0
	// SlotSimTs is the uint64 epoch-millisecond timestamp of the source row.
	SlotSimTs uint16 = 2
	// SlotFlags carries FlagDiscontinuity and FlagMissing.
	SlotFlags uint16 = 6
	// SlotAnalogBase is the offset of the first analog signal (7..13).
	SlotAnalogBase uint16 = 7
	// SlotDigitalBase is the offset of the first digital signal (14..21).
	SlotDigitalBase uint16 = 14
	// SlotAmbient is the offset of the synthetic ambient_temperature extra.
	SlotAmbient uint16 = 22
	// SlotAlarmBits is the uint32 alarm bit field (offsets 23..24).
	SlotAlarmBits uint16 = 23
)

// Flag bits of the slot flags register.
const (
	// FlagDiscontinuity marks the first sample after boot, a collapsed source
	// gap, a jump, a reset or a loop wrap.
	FlagDiscontinuity uint16 = 1 << 0
	// FlagMissing marks a row whose numeric fields failed to parse; the
	// affected tags hold their previous value.
	FlagMissing uint16 = 1 << 1
)

// Replay states of the HdrReplayState register.
const (
	// ReplayStopped is reached at end of data when looping is off.
	ReplayStopped uint16 = 0
	// ReplayPlaying means the sim clock advances.
	ReplayPlaying uint16 = 1
	// ReplayPaused means the sim clock is frozen.
	ReplayPaused uint16 = 2
)

// SlotAddr returns the first register address of the slot that holds sample
// seq: RingBase + (seq mod RingSlots) * SlotRegs.
func SlotAddr(seq uint32) uint16 {
	return RingBase + uint16(seq%RingSlots)*SlotRegs
}
