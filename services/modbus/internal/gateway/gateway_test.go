// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The sample every gateway test is built from: one recorded row, rendered
// through the generated register map so that what the tests feed a device is
// exactly what a reader decodes.

package gateway_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// The sample the golden file pins: one recorded row, mapped onto the tag ids
// the generated register map carries.
const (
	goldenSeq      uint32 = 1201
	goldenSimTsMs  uint64 = 1580527210000 // 2020-02-01T03:20:10.000Z
	goldenWallTsMs int64  = 1774000800123 // 2026-03-20T10:00:00.123Z
)

// goldenAnalog and goldenDigital are the readings of that row, by MetroPT-3
// column rather than by tag id: the tags come from the generated map, so a
// renamed tag changes the golden file and nothing else.
var goldenAnalog = map[string]float64{
	"TP2":             -0.012,
	"TP3":             9.358,
	"H1":              9.34,
	"DV_pressure":     -0.024,
	"Reservoirs":      9.358,
	"Oil_temperature": 53.6,
	"Motor_current":   0.04,
	"":                9.4, // the synthetic ambient extra has no column
}

var goldenDigital = map[string]bool{
	"COMP":            true,
	"DV_eletric":      false,
	"Towers":          true,
	"MPG":             true,
	"LPS":             false,
	"Pressure_switch": true,
	"Oil_level":       true,
	"Caudal_impulses": true,
}

// slotAt builds the golden reading under another sequence number and
// simulated time, already round-tripped through the register encoding so it is
// exactly what a reader would decode.
func slotAt(t *testing.T, seq uint32, simTsMs uint64) regmap.Slot {
	t.Helper()

	slot := regmap.Slot{
		Seq:     seq,
		SimTsMs: simTsMs,
		Analog:  make(map[string]float64, len(regmap.Signals)),
		Digital: make(map[string]bool, len(regmap.Signals)),
	}
	for _, sig := range regmap.Signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			v, ok := goldenAnalog[sig.Column]
			require.True(t, ok, "the golden row has no value for the analog column %q (tag %q)",
				sig.Column, sig.Tag)
			slot.Analog[sig.Tag] = v
		case regmap.KindDigital:
			v, ok := goldenDigital[sig.Column]
			require.True(t, ok, "the golden row has no value for the digital column %q (tag %q)",
				sig.Column, sig.Tag)
			slot.Digital[sig.Tag] = v
		default:
			t.Fatalf("signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}

	regs, err := regmap.EncodeSlot(slot)
	require.NoError(t, err, "encoding the golden slot")
	decoded, err := regmap.DecodeSlot(regs[:])
	require.NoError(t, err, "decoding the golden slot")
	return decoded
}

// sampleStep is the simulated distance between two consecutive test samples,
// the MetroPT-3 sampling period (docs/dataset.md).
const sampleStep = 10_000

// slotSeries builds count consecutive samples starting at seq, ten simulated
// seconds apart.
func slotSeries(t *testing.T, seq uint32, count int) []regmap.Slot {
	t.Helper()

	slots := make([]regmap.Slot, 0, count)
	for i := range count {
		slots = append(slots, slotAt(t, seq+uint32(i), goldenSimTsMs+uint64(i)*sampleStep))
	}
	return slots
}
