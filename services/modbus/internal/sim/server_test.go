// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"testing"
	"time"

	"github.com/simonvetter/modbus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// clientTimeout is the per-request budget of the test clients. Every request
// is served from memory over the loopback interface, so a second is four
// orders of magnitude more than the work needs and nothing but a hang trips it.
const clientTimeout = time.Second

// startServer brings up a read-only Modbus listener on an ephemeral loopback
// port over store and returns it with its address.
func startServer(t *testing.T, store *sim.Store) *sim.Server {
	t.Helper()

	server, err := sim.NewServer(sim.ServerConfig{Bind: "127.0.0.1", MaxClients: 4}, store)
	require.NoError(t, err)
	require.NoError(t, server.Start())
	t.Cleanup(func() { assert.NoError(t, server.Stop()) })

	require.NotEmpty(t, server.Addr(), "the bound address is reported for MODBUS_PORT=0")
	assert.True(t, server.Listening())
	return server
}

// dial opens a client against addr for unitID.
func dial(t *testing.T, addr string, unitID uint8) *modbus.ModbusClient {
	t.Helper()

	client, err := modbus.NewClient(&modbus.ClientConfiguration{
		URL:     "tcp://" + addr,
		Timeout: clientTimeout,
	})
	require.NoError(t, err)
	require.NoError(t, client.SetUnitId(unitID))
	require.NoError(t, client.Open())
	t.Cleanup(func() { assert.NoError(t, client.Close()) })
	return client
}

func TestServerNeedsAStore(t *testing.T) {
	t.Parallel()

	_, err := sim.NewServer(sim.ServerConfig{}, nil)
	assert.Error(t, err)

	_, err = sim.NewServer(sim.ServerConfig{Port: 70000}, sim.NewStore())
	assert.ErrorContains(t, err, "70000")
}

func TestServerServesTheHeaderAndTheRing(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteHeader(regmap.Header{
		HeadSeq: 258,
		SimTsMs: 1_580_512_800_000,
		State:   regmap.ReplayPlaying,
		Speed:   600,
	})
	store.WriteSample(markerSlot(258), 258)

	client := dial(t, startServer(t, store).Addr(), sim.UnitID)

	regs, err := client.ReadRegisters(regmap.HeaderBase, regmap.HeaderRegs, modbus.HOLDING_REGISTER)
	require.NoError(t, err)
	header, err := regmap.DecodeHeader(regs)
	require.NoError(t, err)
	assert.Equal(t, uint32(258), header.HeadSeq)
	assert.Equal(t, uint64(1_580_512_800_000), header.SimTsMs)
	assert.Equal(t, regmap.ReplayPlaying, header.State)
	assert.Equal(t, uint16(600), header.Speed)

	slot, err := client.ReadRegisters(regmap.SlotAddr(258), regmap.SlotRegs, modbus.HOLDING_REGISTER)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(258), slot)
}

// TestServerReadsAcrossTheRingWrap reads the three slots either side of the
// wrap the way the gateway does, one request per side (a request never crosses
// the wrap).
func TestServerReadsAcrossTheRingWrap(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	for seq := uint32(254); seq <= 258; seq++ {
		store.WriteSample(markerSlot(seq), seq)
	}
	client := dial(t, startServer(t, store).Addr(), sim.UnitID)

	tail, err := client.ReadRegisters(regmap.SlotAddr(254), 2*regmap.SlotRegs, modbus.HOLDING_REGISTER)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(254), tail[:regmap.SlotRegs])
	assert.Equal(t, markerRegs(255), tail[regmap.SlotRegs:])

	head, err := client.ReadRegisters(regmap.SlotAddr(256), 3*regmap.SlotRegs, modbus.HOLDING_REGISTER)
	require.NoError(t, err)
	for i, seq := range []uint32{256, 257, 258} {
		assert.Equal(t, markerRegs(seq), head[i*regmap.SlotRegs:(i+1)*regmap.SlotRegs],
			"slot %d after the wrap", seq)
	}
}

func TestServerRefusesReadsOutsideTheRegisterSpace(t *testing.T) {
	t.Parallel()

	client := dial(t, startServer(t, sim.NewStore()).Addr(), sim.UnitID)

	_, err := client.ReadRegisters(regmap.TotalRegs-1, 2, modbus.HOLDING_REGISTER)
	assert.ErrorIs(t, err, modbus.ErrIllegalDataAddress)

	_, err = client.ReadRegisters(regmap.TotalRegs, 1, modbus.HOLDING_REGISTER)
	assert.ErrorIs(t, err, modbus.ErrIllegalDataAddress)

	_, err = client.ReadRegisters(regmap.TotalRegs-1, 1, modbus.HOLDING_REGISTER)
	assert.NoError(t, err, "the last register is still served")
}

// TestServerRefusesEveryWrite covers FC06 and FC16: the machine is read-only
// in both directions.
func TestServerRefusesEveryWrite(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteSample(markerSlot(1), 1)
	server := startServer(t, store)
	client := dial(t, server.Addr(), sim.UnitID)

	assert.ErrorIs(t, client.WriteRegister(regmap.HdrReplaySpeed, 1),
		modbus.ErrIllegalFunction, "FC06")
	assert.ErrorIs(t, client.WriteRegisters(regmap.SlotAddr(1), []uint16{0, 0, 0, 0}),
		modbus.ErrIllegalFunction, "FC16")
	assert.ErrorIs(t, client.WriteCoil(0, true), modbus.ErrIllegalFunction, "FC05")
	assert.ErrorIs(t, client.WriteCoils(0, []bool{true, false}), modbus.ErrIllegalFunction, "FC0F")

	assert.Equal(t, uint64(4), server.Refusals())

	regs, err := client.ReadRegisters(regmap.SlotAddr(1), regmap.SlotRegs, modbus.HOLDING_REGISTER)
	require.NoError(t, err)
	assert.Equal(t, markerRegs(1), regs, "a refused write changes nothing")
}

// TestServerRefusesEveryOtherTable covers FC01, FC02 and FC04: everything the
// machine publishes lives in the holding registers.
func TestServerRefusesEveryOtherTable(t *testing.T) {
	t.Parallel()

	server := startServer(t, sim.NewStore())
	client := dial(t, server.Addr(), sim.UnitID)

	_, err := client.ReadCoils(0, 8)
	assert.ErrorIs(t, err, modbus.ErrIllegalFunction, "FC01")

	_, err = client.ReadDiscreteInputs(0, 8)
	assert.ErrorIs(t, err, modbus.ErrIllegalFunction, "FC02")

	_, err = client.ReadRegisters(0, regmap.HeaderRegs, modbus.INPUT_REGISTER)
	assert.ErrorIs(t, err, modbus.ErrIllegalFunction, "FC04")

	assert.Equal(t, uint64(3), server.Refusals())
}

// TestServerAnswersUnitIDOneOnly keeps the machine on its single unit id:
// another id is refused even for a read the store could serve.
func TestServerAnswersUnitIDOneOnly(t *testing.T) {
	t.Parallel()

	store := sim.NewStore()
	store.WriteSample(markerSlot(1), 1)
	server := startServer(t, store)

	_, err := dial(t, server.Addr(), 2).
		ReadRegisters(regmap.HeaderBase, regmap.HeaderRegs, modbus.HOLDING_REGISTER)
	assert.ErrorIs(t, err, modbus.ErrIllegalFunction)
	assert.Equal(t, uint64(1), server.Refusals())

	_, err = dial(t, server.Addr(), sim.UnitID).
		ReadRegisters(regmap.HeaderBase, regmap.HeaderRegs, modbus.HOLDING_REGISTER)
	assert.NoError(t, err, "unit id 1 is still served")
}

func TestServerStartIsIdempotentlyGuardedAndStopIsNot(t *testing.T) {
	t.Parallel()

	server, err := sim.NewServer(sim.ServerConfig{Bind: "127.0.0.1"}, sim.NewStore())
	require.NoError(t, err)
	assert.Empty(t, server.Addr(), "nothing is bound before Start")
	assert.False(t, server.Listening())

	require.NoError(t, server.Start())
	assert.Error(t, server.Start(), "a second Start is a programming error")

	require.NoError(t, server.Stop())
	assert.False(t, server.Listening())
	assert.NoError(t, server.Stop(), "stopping twice is harmless")
}
