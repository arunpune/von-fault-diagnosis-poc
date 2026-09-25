// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package regmap_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

func TestSlotAddr(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		seq  uint32
		want uint16
	}{
		{name: "slot zero is the ring base", seq: 0, want: 1024},
		{name: "first emitted sample", seq: 1, want: 1024 + 32},
		{name: "last slot before the wrap", seq: 255, want: 1024 + 255*32},
		{name: "the ring wraps", seq: 256, want: 1024},
		{name: "one past the wrap", seq: 257, want: 1024 + 32},
		{name: "far into the run", seq: 1_000_003, want: 1024 + (1_000_003%256)*32},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, regmap.SlotAddr(tc.seq))
		})
	}
}

func TestRingFitsTheRegisterSpace(t *testing.T) {
	t.Parallel()

	assert.EqualValues(t, regmap.TotalRegs, uint32(regmap.RingBase)+regmap.RingSlots*regmap.SlotRegs,
		"the ring must end exactly at TotalRegs")
	assert.Less(t, regmap.HeaderRegs, int(regmap.RingBase), "the header block must fit below the ring")
}

func TestSignalsCoverTheSlotLayout(t *testing.T) {
	t.Parallel()

	var analog, digital int
	seen := make(map[uint16]string, len(regmap.Signals))
	tags := make(map[string]struct{}, len(regmap.Signals))
	columns := make(map[string]struct{}, len(regmap.Signals))

	for _, s := range regmap.Signals {
		require.NotContains(t, seen, s.Offset, "offset %d is used twice", s.Offset)
		seen[s.Offset] = s.Tag

		require.NotContains(t, tags, s.Tag, "tag %q is declared twice", s.Tag)
		tags[s.Tag] = struct{}{}

		if s.Column != "" {
			require.NotContains(t, columns, s.Column, "column %q is mapped twice", s.Column)
			columns[s.Column] = struct{}{}
		}

		switch s.Kind {
		case regmap.KindAnalog:
			if s.Offset == regmap.SlotAmbient {
				assert.Empty(t, s.Column, "the ambient extra has no CSV column")
				continue
			}
			analog++
			assert.GreaterOrEqual(t, s.Offset, regmap.SlotAnalogBase)
			assert.Less(t, s.Offset, regmap.SlotDigitalBase)
			assert.NotZero(t, s.Scale, "analog signal %q needs a scale", s.Tag)
		case regmap.KindDigital:
			digital++
			assert.GreaterOrEqual(t, s.Offset, regmap.SlotDigitalBase)
			assert.Less(t, s.Offset, regmap.SlotAmbient)
			assert.EqualValues(t, 1, s.Scale, "digital signal %q is unscaled", s.Tag)
			assert.Empty(t, s.Unit, "digital signal %q carries no unit", s.Tag)
		default:
			t.Fatalf("signal %q has kind %d", s.Tag, s.Kind)
		}
	}

	assert.Equal(t, 7, analog, "seven analog signals occupy offsets 7..13")
	assert.Equal(t, 8, digital, "eight digital signals occupy offsets 14..21")
	assert.Len(t, regmap.Signals, 16, "seven analog, eight digital and the ambient extra")
}

func TestSignalsAreInRegisterOrder(t *testing.T) {
	t.Parallel()

	for i := 1; i < len(regmap.Signals); i++ {
		assert.Less(t, regmap.Signals[i-1].Offset, regmap.Signals[i].Offset,
			"Signals must be sorted by offset: %q before %q",
			regmap.Signals[i-1].Tag, regmap.Signals[i].Tag)
	}
}

func TestAlarmBitsAreUniqueAndInRange(t *testing.T) {
	t.Parallel()

	seen := make(map[uint8]string, len(regmap.Alarms))
	for _, a := range regmap.Alarms {
		require.NotContains(t, seen, a.Bit, "bit %d is used by %q and %q", a.Bit, seen[a.Bit], a.Code)
		seen[a.Bit] = a.Code
		assert.Less(t, a.Bit, uint8(32), "alarm %q must fit in the 32-bit field", a.Code)
		assert.NotEmpty(t, a.Trigger.Kind, "alarm %q needs a trigger kind", a.Code)
	}
	for i := 1; i < len(regmap.Alarms); i++ {
		assert.Less(t, regmap.Alarms[i-1].Bit, regmap.Alarms[i].Bit, "Alarms must be sorted by bit")
	}
}

func TestTriggerSignalsExist(t *testing.T) {
	t.Parallel()

	for _, a := range regmap.Alarms {
		for _, tag := range []string{a.Trigger.Signal, a.Trigger.SignalB} {
			if tag == "" {
				continue
			}
			_, ok := regmap.ByTag(tag)
			assert.True(t, ok, "alarm %q references unknown tag %q", a.Code, tag)
		}
	}
}

func TestSignalLookups(t *testing.T) {
	t.Parallel()

	sig, ok := regmap.ByTag("oil_temperature")
	require.True(t, ok)
	assert.Equal(t, "Oil_temperature", sig.Column)
	assert.EqualValues(t, 12, sig.Offset)

	sig, ok = regmap.ByColumn("DV_eletric")
	require.True(t, ok, "the dataset's misspelt column must be mapped verbatim")
	assert.Equal(t, "load_valve", sig.Tag)
	assert.Equal(t, regmap.KindDigital, sig.Kind)

	_, ok = regmap.ByTag("no_such_tag")
	assert.False(t, ok)

	_, ok = regmap.ByColumn("No_Such_Column")
	assert.False(t, ok)

	_, ok = regmap.ByColumn("")
	assert.False(t, ok, "the synthetic extras must not be reachable by an empty column")
}
