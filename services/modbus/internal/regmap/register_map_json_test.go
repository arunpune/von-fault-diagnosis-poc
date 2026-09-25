// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package regmap_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// contractsDirEnv overrides where the generated contracts live.
const contractsDirEnv = "FDP_CONTRACTS_DIR"

// defaultContractsDir is packages/contracts seen from this package.
const defaultContractsDir = "../../../../packages/contracts"

// registerMapDoc is the part of packages/contracts/generated/register-map.json
// this test compares with the hand-written layout. Everything else in the
// document belongs to packages/contracts.
type registerMapDoc struct {
	Version struct {
		Major uint16 `json:"major"`
		Minor uint16 `json:"minor"`
	} `json:"version"`
	Header struct {
		Base   uint16          `json:"base"`
		Fields []registerField `json:"fields"`
	} `json:"header"`
	Ring struct {
		Base     uint16 `json:"base"`
		Slots    uint32 `json:"slots"`
		SlotRegs uint16 `json:"slot_regs"`
	} `json:"ring"`
	Slot struct {
		Fields []registerField `json:"fields"`
	} `json:"slot"`
	Signals []struct {
		Tag           string  `json:"tag"`
		MetroPTColumn string  `json:"metropt_column"`
		Scale         float64 `json:"scale"`
		Offset        uint16  `json:"offset"`
	} `json:"signals"`
}

// registerField is one entry of the header or slot layout view.
type registerField struct {
	Name   string `json:"name"`
	Offset uint16 `json:"offset"`
}

// offsetOf returns the offset of the named field.
func offsetOf(t *testing.T, fields []registerField, name string) uint16 {
	t.Helper()
	for _, f := range fields {
		if f.Name == name {
			return f.Offset
		}
	}
	t.Fatalf("register-map.json declares no field %q", name)
	return 0
}

// TestRegisterMapJSON compares layout.go and the generated Signals with
// packages/contracts/generated/register-map.json. The file is written by
// `pnpm --filter @fdp/contracts generate`, so it is absent until the generator
// has run and the test skips with the reason.
func TestRegisterMapJSON(t *testing.T) {
	t.Parallel()

	dir := os.Getenv(contractsDirEnv)
	if dir == "" {
		dir = defaultContractsDir
	}
	path := filepath.Join(dir, "generated", "register-map.json")

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("generated register map not found at %s (the contracts generator writes it; set %s to point elsewhere): %v",
			path, contractsDirEnv, err)
	}

	var doc registerMapDoc
	require.NoError(t, json.Unmarshal(raw, &doc), "parsing %s", path)

	assert.Equal(t, regmap.MapMajor, doc.Version.Major, "map major")
	assert.Equal(t, regmap.MapMinor, doc.Version.Minor, "map minor")

	// Header block: the JSON's `regs` is the reserved block size (32), the
	// layout's HeaderRegs is the number of registers the codec encodes, so
	// only the field offsets are comparable.
	assert.Equal(t, regmap.HeaderBase, doc.Header.Base, "header base")
	assert.Equal(t, regmap.HdrHeadSeq, offsetOf(t, doc.Header.Fields, "head_seq"))
	assert.Equal(t, regmap.HdrSimTsNow, offsetOf(t, doc.Header.Fields, "sim_ts_now"))
	assert.Equal(t, regmap.HdrReplayState, offsetOf(t, doc.Header.Fields, "replay_state"))
	assert.Equal(t, regmap.HdrReplaySpeed, offsetOf(t, doc.Header.Fields, "replay_speed"))
	assert.Equal(t, regmap.HdrRingSlots, offsetOf(t, doc.Header.Fields, "ring_slots"))
	assert.Equal(t, regmap.HdrSlotRegs, offsetOf(t, doc.Header.Fields, "slot_regs"))
	assert.Equal(t, regmap.HdrRingBase, offsetOf(t, doc.Header.Fields, "ring_base"))
	assert.Equal(t, regmap.HdrMapMajor, offsetOf(t, doc.Header.Fields, "map_major"))
	assert.Equal(t, regmap.HdrMapMinor, offsetOf(t, doc.Header.Fields, "map_minor"))

	// Ring geometry.
	assert.Equal(t, regmap.RingBase, doc.Ring.Base, "ring base")
	assert.EqualValues(t, regmap.RingSlots, doc.Ring.Slots, "ring slots")
	assert.EqualValues(t, regmap.SlotRegs, doc.Ring.SlotRegs, "slot registers")

	// Fixed slot fields.
	assert.Equal(t, regmap.SlotSeq, offsetOf(t, doc.Slot.Fields, "seq"))
	assert.Equal(t, regmap.SlotSimTs, offsetOf(t, doc.Slot.Fields, "sim_ts"))
	assert.Equal(t, regmap.SlotFlags, offsetOf(t, doc.Slot.Fields, "flags"))
	assert.Equal(t, regmap.SlotAlarmBits, offsetOf(t, doc.Slot.Fields, "alarm_bits"))

	// Per-signal offsets, in both views.
	byTag := make(map[string]uint16, len(doc.Signals))
	for _, s := range doc.Signals {
		byTag[s.Tag] = s.Offset
	}
	require.Len(t, doc.Signals, len(regmap.Signals), "signal count")
	for _, sig := range regmap.Signals {
		offset, ok := byTag[sig.Tag]
		require.Truef(t, ok, "register-map.json has no signal %q", sig.Tag)
		assert.Equalf(t, sig.Offset, offset, "signal %q offset", sig.Tag)
		assert.Equalf(t, sig.Offset, offsetOf(t, doc.Slot.Fields, sig.Tag),
			"signal %q offset in the slot view", sig.Tag)
	}
	for _, s := range doc.Signals {
		sig, ok := regmap.ByTag(s.Tag)
		require.Truef(t, ok, "the generated map has no signal %q", s.Tag)
		assert.Equalf(t, sig.Column, s.MetroPTColumn, "signal %q column", s.Tag)
		assert.Equalf(t, sig.Scale, s.Scale, "signal %q scale", s.Tag)
	}
}
