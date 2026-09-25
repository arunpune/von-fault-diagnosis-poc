// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package regmap_test

import (
	"math"
	"math/rand/v2"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// fullSlot returns a slot whose maps hold every signal of the generated map,
// so EncodeSlot accepts it.
func fullSlot() regmap.Slot {
	s := regmap.Slot{
		Seq:     1,
		SimTsMs: 1_580_515_200_000,
		Analog:  make(map[string]float64),
		Digital: make(map[string]bool),
	}
	for _, sig := range regmap.Signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			s.Analog[sig.Tag] = 0
		case regmap.KindDigital:
			s.Digital[sig.Tag] = false
		}
	}
	return s
}

func TestHeaderRoundTrip(t *testing.T) {
	t.Parallel()

	in := regmap.Header{
		HeadSeq: 0xDEADBEEF,
		SimTsMs: 0x0123_4567_89AB_CDEF,
		State:   regmap.ReplayPlaying,
		Speed:   3600,
	}
	regs := regmap.EncodeHeader(in)
	require.Len(t, regs, regmap.HeaderRegs)

	out, err := regmap.DecodeHeader(regs[:])
	require.NoError(t, err)

	assert.Equal(t, in.HeadSeq, out.HeadSeq)
	assert.Equal(t, in.SimTsMs, out.SimTsMs)
	assert.Equal(t, in.State, out.State)
	assert.Equal(t, in.Speed, out.Speed)
	assert.EqualValues(t, regmap.RingSlots, out.RingSlots, "the device advertises its own geometry")
	assert.EqualValues(t, regmap.SlotRegs, out.SlotRegs)
	assert.EqualValues(t, regmap.RingBase, out.RingBase)
	assert.Equal(t, regmap.MapMajor, out.MapMajor)
	assert.Equal(t, regmap.MapMinor, out.MapMinor)
}

func TestHeaderWordOrderIsHighWordFirst(t *testing.T) {
	t.Parallel()

	regs := regmap.EncodeHeader(regmap.Header{
		HeadSeq: 0x1234_5678,
		SimTsMs: 0x0011_2233_4455_6677,
	})
	assert.EqualValues(t, 0x1234, regs[regmap.HdrHeadSeq])
	assert.EqualValues(t, 0x5678, regs[regmap.HdrHeadSeq+1])
	assert.EqualValues(t, 0x0011, regs[regmap.HdrSimTsNow])
	assert.EqualValues(t, 0x2233, regs[regmap.HdrSimTsNow+1])
	assert.EqualValues(t, 0x4455, regs[regmap.HdrSimTsNow+2])
	assert.EqualValues(t, 0x6677, regs[regmap.HdrSimTsNow+3])
}

func TestDecodeHeaderBufferLengths(t *testing.T) {
	t.Parallel()

	_, err := regmap.DecodeHeader(make([]uint16, regmap.HeaderRegs-1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "header needs 14 registers")

	_, err = regmap.DecodeHeader(nil)
	require.Error(t, err)

	// A client that reads the whole reserved header block gets the same result.
	regs := regmap.EncodeHeader(regmap.Header{HeadSeq: 7})
	wide := make([]uint16, 32)
	copy(wide, regs[:])
	out, err := regmap.DecodeHeader(wide)
	require.NoError(t, err)
	assert.EqualValues(t, 7, out.HeadSeq)
}

func TestSlotRoundTripRandom(t *testing.T) {
	t.Parallel()

	// A fixed seed keeps the property test deterministic.
	rng := rand.New(rand.NewPCG(0x5150, 0xC0FFEE))

	for i := range 1000 {
		s := fullSlot()
		s.Seq = rng.Uint32()
		s.SimTsMs = rng.Uint64() % 4_000_000_000_000
		s.Discontinuity = rng.IntN(2) == 0
		s.Missing = rng.IntN(2) == 0
		s.AlarmBits = rng.Uint32()

		for _, sig := range regmap.Signals {
			switch sig.Kind {
			case regmap.KindAnalog:
				// Stay inside the int16 range so the round trip is exact.
				limit := math.MaxInt16 / sig.Scale
				s.Analog[sig.Tag] = math.Round((rng.Float64()*2-1)*limit*sig.Scale) / sig.Scale
			case regmap.KindDigital:
				s.Digital[sig.Tag] = rng.IntN(2) == 0
			}
		}

		regs, err := regmap.EncodeSlot(s)
		require.NoErrorf(t, err, "case %d", i)

		out, err := regmap.DecodeSlot(regs[:])
		require.NoErrorf(t, err, "case %d", i)

		assert.Equalf(t, s.Seq, out.Seq, "case %d", i)
		assert.Equalf(t, s.SimTsMs, out.SimTsMs, "case %d", i)
		assert.Equalf(t, s.Discontinuity, out.Discontinuity, "case %d", i)
		assert.Equalf(t, s.Missing, out.Missing, "case %d", i)
		assert.Equalf(t, s.AlarmBits, out.AlarmBits, "case %d", i)
		assert.Equalf(t, s.Digital, out.Digital, "case %d", i)
		for tag, want := range s.Analog {
			assert.InDeltaf(t, want, out.Analog[tag], 1e-9, "case %d, tag %s", i, tag)
		}
	}
}

func TestEncodeSlotScalingAndNegativeValues(t *testing.T) {
	t.Parallel()

	s := fullSlot()
	s.Analog["discharge_pressure"] = -0.012 // the vented TP2 of the recording
	s.Analog["line_pressure"] = 9.358
	s.Analog["oil_temperature"] = 53.6
	s.Analog["motor_current"] = 0.04
	s.Analog["ambient_temperature"] = -3.25

	regs, err := regmap.EncodeSlot(s)
	require.NoError(t, err)

	assert.EqualValues(t, -12, int16(regs[7]), "pressures scale by 1000")
	assert.EqualValues(t, 9358, int16(regs[8]))
	assert.EqualValues(t, 5360, int16(regs[12]), "temperatures scale by 100")
	assert.EqualValues(t, 4, int16(regs[13]), "currents scale by 100")
	assert.EqualValues(t, -325, int16(regs[22]))

	out, err := regmap.DecodeSlot(regs[:])
	require.NoError(t, err)
	assert.InDelta(t, -0.012, out.Analog["discharge_pressure"], 1e-9)
	assert.InDelta(t, 9.358, out.Analog["line_pressure"], 1e-9)
	assert.InDelta(t, 53.6, out.Analog["oil_temperature"], 1e-9)
	assert.InDelta(t, -3.25, out.Analog["ambient_temperature"], 1e-9)
}

// TestEncodeSlotClampsAndCounts reads the package-level clamp counter, so it
// deliberately does not call t.Parallel(): Go runs the sequential tests of a
// package to completion before it resumes the parallel ones.
func TestEncodeSlotClampsAndCounts(t *testing.T) {
	before := regmap.ClampCount()

	s := fullSlot()
	s.Analog["line_pressure"] = 40000     // 40000 bar x 1000 is far beyond int16
	s.Analog["discharge_pressure"] = -100 // -100 bar x 1000 as well

	regs, err := regmap.EncodeSlot(s)
	require.NoError(t, err)

	assert.EqualValues(t, math.MaxInt16, int16(regs[8]))
	assert.EqualValues(t, math.MinInt16, int16(regs[7]))
	assert.Equal(t, before+2, regmap.ClampCount(), "every clamped value is counted")

	// A value inside the range does not count.
	s = fullSlot()
	s.Analog["line_pressure"] = 10.03
	_, err = regmap.EncodeSlot(s)
	require.NoError(t, err)
	assert.Equal(t, before+2, regmap.ClampCount())
}

func TestEncodeSlotNonFiniteEncodesZero(t *testing.T) {
	t.Parallel()

	for name, v := range map[string]float64{
		"NaN":               math.NaN(),
		"positive infinity": math.Inf(1),
		"negative infinity": math.Inf(-1),
	} {
		s := fullSlot()
		s.Missing = true
		s.Analog["oil_temperature"] = v

		regs, err := regmap.EncodeSlot(s)
		require.NoErrorf(t, err, "%s", name)
		assert.EqualValuesf(t, 0, regs[12], "%s encodes as zero and the row is flagged missing", name)
		assert.NotZerof(t, regs[regmap.SlotFlags]&regmap.FlagMissing, "%s", name)
	}
}

func TestEncodeSlotFlags(t *testing.T) {
	t.Parallel()

	s := fullSlot()
	s.Discontinuity = true
	regs, err := regmap.EncodeSlot(s)
	require.NoError(t, err)
	assert.EqualValues(t, regmap.FlagDiscontinuity, regs[regmap.SlotFlags])

	s.Missing = true
	regs, err = regmap.EncodeSlot(s)
	require.NoError(t, err)
	assert.EqualValues(t, regmap.FlagDiscontinuity|regmap.FlagMissing, regs[regmap.SlotFlags])
}

func TestEncodeSlotRejectsUnknownAndMissingTags(t *testing.T) {
	t.Parallel()

	s := fullSlot()
	s.Analog["no_such_tag"] = 1
	_, err := regmap.EncodeSlot(s)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `unknown analog tag "no_such_tag"`)

	s = fullSlot()
	s.Digital["oil_temperature"] = true // an analog tag in the digital map
	_, err = regmap.EncodeSlot(s)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `unknown digital tag "oil_temperature"`)

	s = fullSlot()
	delete(s.Analog, "motor_current")
	_, err = regmap.EncodeSlot(s)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `no value for analog tag "motor_current"`)

	s = fullSlot()
	delete(s.Digital, "load_valve")
	_, err = regmap.EncodeSlot(s)
	require.Error(t, err)
	assert.Contains(t, err.Error(), `no value for digital tag "load_valve"`)
}

func TestDecodeSlotBufferLengths(t *testing.T) {
	t.Parallel()

	for _, n := range []int{0, 1, regmap.SlotRegs - 1, regmap.SlotRegs + 1, 3 * regmap.SlotRegs} {
		_, err := regmap.DecodeSlot(make([]uint16, n))
		require.Errorf(t, err, "a %d-register buffer is not one slot", n)
		assert.Contains(t, err.Error(), "slot needs exactly 32 registers")
	}
}

func TestDecodeSlotReadsOneSlotOutOfAMultiSlotRead(t *testing.T) {
	t.Parallel()

	// The gateway reads up to three slots in one request and slices them.
	const slots = 3
	regs := make([]uint16, 0, slots*regmap.SlotRegs)
	for i := range slots {
		s := fullSlot()
		s.Seq = uint32(i) + 10
		enc, err := regmap.EncodeSlot(s)
		require.NoError(t, err)
		regs = append(regs, enc[:]...)
	}

	for i := range slots {
		out, err := regmap.DecodeSlot(regs[i*regmap.SlotRegs : (i+1)*regmap.SlotRegs])
		require.NoError(t, err)
		assert.EqualValues(t, i+10, out.Seq)
	}
}

func TestAlarmCodes(t *testing.T) {
	t.Parallel()

	require.NotEmpty(t, regmap.Alarms, "the generated map must declare at least one alarm")

	assert.Empty(t, regmap.AlarmCodes(0))

	var all uint32
	want := make([]string, 0, len(regmap.Alarms))
	for _, a := range regmap.Alarms {
		all |= 1 << a.Bit
		want = append(want, a.Code)
	}
	assert.Equal(t, want, regmap.AlarmCodes(all), "codes come back in ascending bit order")

	first := regmap.Alarms[0]
	assert.Equal(t, []string{first.Code}, regmap.AlarmCodes(1<<first.Bit))

	// Bits without an alarm are ignored: a newer minor map may set one.
	unused := ^all
	require.NotZero(t, unused, "the placeholder map does not fill all 32 bits")
	assert.Empty(t, regmap.AlarmCodes(unused))
}

func TestSlotAlarmBitsRoundTrip(t *testing.T) {
	t.Parallel()

	s := fullSlot()
	s.AlarmBits = 1<<0 | 1<<12

	regs, err := regmap.EncodeSlot(s)
	require.NoError(t, err)
	assert.EqualValues(t, 0x0000, regs[regmap.SlotAlarmBits], "high word first")
	assert.EqualValues(t, 0x1001, regs[regmap.SlotAlarmBits+1])

	out, err := regmap.DecodeSlot(regs[:])
	require.NoError(t, err)
	assert.Equal(t, s.AlarmBits, out.AlarmBits)
	assert.Equal(t, []string{"W101", "W113"}, regmap.AlarmCodes(out.AlarmBits))
}

func TestReservedSlotRegistersStayZero(t *testing.T) {
	t.Parallel()

	s := fullSlot()
	s.Seq = 42
	s.AlarmBits = math.MaxUint32
	regs, err := regmap.EncodeSlot(s)
	require.NoError(t, err)

	for i := regmap.SlotAlarmBits + 2; i < regmap.SlotRegs; i++ {
		assert.Zerof(t, regs[i], "register %d is reserved", i)
	}
}
