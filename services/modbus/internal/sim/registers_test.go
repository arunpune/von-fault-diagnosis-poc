// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// markerSlot returns a slot whose every register carries a recognisable value,
// so a read that lands one register off is visible in the failure message.
func markerSlot(seq uint32) [regmap.SlotRegs]uint16 {
	var slot [regmap.SlotRegs]uint16
	for i := range slot {
		slot[i] = uint16(seq)<<8 | uint16(i)
	}
	slot[regmap.SlotSeq] = uint16(seq >> 16)
	slot[regmap.SlotSeq+1] = uint16(seq)
	return slot
}

// markerRegs is markerSlot as the slice a read returns.
func markerRegs(seq uint32) []uint16 {
	slot := markerSlot(seq)
	return slot[:]
}

func TestNewStoreAdvertisesTheGeometry(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()

	regs, err := store.Read(regmap.HeaderBase, regmap.HeaderRegs)
	require.NoError(t, err)

	header, err := regmap.DecodeHeader(regs)
	require.NoError(t, err)

	assert.Equal(t, uint32(0), header.HeadSeq, "no sample has been emitted yet")
	assert.Equal(t, uint16(regmap.RingSlots), header.RingSlots)
	assert.Equal(t, uint16(regmap.SlotRegs), header.SlotRegs)
	assert.Equal(t, uint32(regmap.RingBase), header.RingBase)
	assert.Equal(t, regmap.MapMajor, header.MapMajor)
	assert.Equal(t, regmap.MapMinor, header.MapMinor)
}

func TestWriteHeaderRoundTrips(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteHeader(regmap.Header{
		HeadSeq: 4_000_000_123,
		SimTsMs: 1_580_512_800_000,
		State:   regmap.ReplayPlaying,
		Speed:   3600,
	})

	regs, err := store.Read(regmap.HeaderBase, regmap.HeaderRegs)
	require.NoError(t, err)

	header, err := regmap.DecodeHeader(regs)
	require.NoError(t, err)

	assert.Equal(t, uint32(4_000_000_123), header.HeadSeq)
	assert.Equal(t, uint64(1_580_512_800_000), header.SimTsMs)
	assert.Equal(t, regmap.ReplayPlaying, header.State)
	assert.Equal(t, uint16(3600), header.Speed)
}

func TestWriteSamplePublishesTheSlotAndTheHeadSeq(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	const seq uint32 = 7
	store.WriteSample(markerSlot(seq), seq)

	assert.Equal(t, seq, store.HeadSeq(), "head_seq follows the slot under one lock")

	regs, err := store.Read(regmap.SlotAddr(seq), regmap.SlotRegs)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(seq), regs)
}

func TestReadAcrossTheRingWrap(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	// Sequence 256 lands back on slot 0, so 255 and 256 sit at opposite ends
	// of the register space and a reader that follows the ring has to notice.
	for _, seq := range []uint32{255, 256} {
		store.WriteSample(markerSlot(seq), seq)
	}

	assert.Equal(t, regmap.RingBase+255*regmap.SlotRegs, regmap.SlotAddr(255))
	assert.Equal(t, regmap.RingBase, regmap.SlotAddr(256))

	last, err := store.Read(regmap.SlotAddr(255), regmap.SlotRegs)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(255), last, "the last slot of the ring")

	wrapped, err := store.Read(regmap.SlotAddr(256), regmap.SlotRegs)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(256), wrapped, "sequence 256 overwrote slot 0")
}

func TestReadRejectsWindowsOutsideTheRegisterSpace(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()

	tests := []struct {
		name string
		addr uint16
		qty  uint16
		want error
	}{
		{"past the end by one", regmap.TotalRegs - 1, 2, sim.ErrIllegalDataAddress},
		{"starting past the end", regmap.TotalRegs, 1, sim.ErrIllegalDataAddress},
		{"wrapping the address space", 65000, 100, sim.ErrIllegalDataAddress},
		{"empty read", 0, 0, sim.ErrIllegalDataValue},
		{"above one response", 0, sim.MaxReadRegs + 1, sim.ErrIllegalDataValue},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := store.Read(tc.addr, tc.qty)
			assert.ErrorIs(t, err, tc.want)
		})
	}

	last, err := store.Read(regmap.TotalRegs-1, 1)
	require.NoError(t, err, "the last register is readable")
	assert.Equal(t, []uint16{0}, last)
}

func TestReadServesReservedAreasAsZero(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteHeader(regmap.Header{HeadSeq: 1, SimTsMs: 42, State: regmap.ReplayPaused, Speed: 600})

	reserved, err := store.Read(regmap.HeaderRegs, 32-regmap.HeaderRegs)
	require.NoError(t, err)
	assert.Equal(t, make([]uint16, 32-regmap.HeaderRegs), reserved, "header padding")

	between, err := store.Read(64, 64)
	require.NoError(t, err)
	assert.Equal(t, make([]uint16, 64), between, "the hole between the header and the ring")
}

func TestReadReturnsACopy(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteSample(markerSlot(1), 1)

	regs, err := store.Read(regmap.SlotAddr(1), regmap.SlotRegs)
	require.NoError(t, err)
	regs[0] = 0xdead

	again, err := store.Read(regmap.SlotAddr(1), regmap.SlotRegs)
	require.NoError(t, err)
	assert.NotEqual(t, uint16(0xdead), again[0], "the caller cannot reach into the store")
}

// TestConcurrentReadsNeverSeeAHalfWrittenSlot is the point of the lock: under
// -race it also proves the writer and the readers agree on it.
func TestConcurrentReadsNeverSeeAHalfWrittenSlot(t *testing.T) {
	t.Parallel()

	const samples = 2000
	store := sim.NewStore()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for seq := uint32(1); seq <= samples; seq++ {
			store.WriteSample(markerSlot(seq), seq)
		}
	}()

	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range samples {
				head := store.HeadSeq()
				if head == 0 {
					continue
				}
				regs, err := store.Read(regmap.SlotAddr(head), regmap.SlotRegs)
				if !assert.NoError(t, err) {
					return
				}
				seq := uint32(regs[regmap.SlotSeq])<<16 | uint32(regs[regmap.SlotSeq+1])
				if !assert.Equal(t, markerRegs(seq), regs,
					"slot %d was read while it was being written", seq) {
					return
				}
			}
		}()
	}
	wg.Wait()

	assert.Equal(t, uint32(samples), store.HeadSeq())
}
