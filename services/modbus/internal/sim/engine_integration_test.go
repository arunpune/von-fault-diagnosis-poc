// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

package sim_test

import (
	"bufio"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/simonvetter/modbus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// The slice the whole test is built around: the first recorded day, which
// carries both of the day's real holes (307 s at 12:48:40 and 12,929 s at
// 19:40:04). It is never committed, so the test skips without it and fails
// under FDP_REQUIRE_DATASET=1.
const (
	daySlice = "sim-day-2020-02-01"
	dayRows  = 7144
)

// The wall-clock bound below is multiplied by FDP_TIMING_SLACK through the
// timingSlack helper ambient_test.go already declares for this package: 1
// locally, 3 in CI.
//
// readBudget is the wall time the whole pass is allowed. One recorded day at
// 3600× is 24 s of wall time, less the collapsed gaps, so 40 s leaves the
// reader room to be slow without letting a stall pass unnoticed.
const readBudget = 40 * time.Second

// pollInterval is how long the reader waits when it has caught up with the
// machine. At 3600× a row is due every 2.78 ms.
const pollInterval = time.Millisecond

// slotsPerRead is the gateway's read width: never more than three slots and
// never across the ring wrap.
const slotsPerRead = 3

// fixtureFacts reads the timestamps of the slice and reports them with the
// sequence numbers that must carry the discontinuity flag: the first sample
// after boot, and the first row after each source step wider than the 60 s
// threshold. Reading them from the file rather than hard-coding them keeps
// the assertion about the recording, not about this test's memory of it.
func fixtureFacts(t *testing.T, path string) (timestamps []uint64, discontinuities []uint32) {
	t.Helper()

	file, err := os.Open(path)
	require.NoError(t, err)
	defer func() { assert.NoError(t, file.Close()) }()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	require.True(t, scanner.Scan(), "the slice has a header line")

	header := strings.Split(scanner.Text(), ",")
	column := -1
	for i, name := range header {
		if strings.TrimSpace(name) == replay.TimestampColumn {
			column = i
		}
	}
	require.GreaterOrEqual(t, column, 0, "the slice has a %q column", replay.TimestampColumn)

	discontinuities = []uint32{1}
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), ",")
		require.Greater(t, len(fields), column)

		instant, err := time.Parse(time.DateTime, strings.TrimSpace(fields[column]))
		require.NoError(t, err)
		ms := uint64(instant.UnixMilli())

		if n := len(timestamps); n > 0 && ms > timestamps[n-1]+replay.GapThresholdMs {
			discontinuities = append(discontinuities, uint32(n)+1)
		}
		timestamps = append(timestamps, ms)
	}
	require.NoError(t, scanner.Err())
	return timestamps, discontinuities
}

// TestIntegrationRingIsReadWithoutLossAtFullSpeed runs the whole machine —
// engine, register store and a real Modbus TCP listener — over one recorded
// day at 3600× and reads it back over the wire with the algorithm the gateway
// uses. Every sample must arrive exactly once, in order, with the timestamps
// of the recording and the discontinuity flags where the file puts them.
func TestIntegrationRingIsReadWithoutLossAtFullSpeed(t *testing.T) {
	path := testutil.SliceCSV(t, daySlice)
	timestamps, wantDiscontinuities := fixtureFacts(t, path)
	require.Len(t, timestamps, dayRows, "the slice is the whole first recorded day")
	require.Len(t, wantDiscontinuities, 3,
		"the boot sample and the two holes of 2020-02-01: %v", wantDiscontinuities)

	source, err := replay.Open(path, regmap.Signals)
	require.NoError(t, err)
	require.Len(t, source.Gaps(), 2)

	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)

	store := sim.NewStore()
	engine, err := sim.New(sim.Config{
		Speed:    sim.MaxSpeed,
		Autoplay: true,
		// The reader stops when the machine does, rather than racing a wrap.
		Loop: false,
	}, source, injection.NewEngine(regmap.Signals, emptyCatalog(t)),
		alarms, sim.RealClock{}, store)
	require.NoError(t, err)
	defer func() { assert.NoError(t, engine.Close()) }()

	server, err := sim.NewServer(sim.ServerConfig{Bind: "127.0.0.1", MaxClients: 4}, store)
	require.NoError(t, err)
	require.NoError(t, server.Start())
	defer func() { assert.NoError(t, server.Stop()) }()

	budget := readBudget * timingSlack(t)
	ctx, cancel := context.WithTimeout(t.Context(), budget)
	defer cancel()

	clampsBefore := regmap.ClampCount()
	started := time.Now()

	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()

	samples := readRing(ctx, t, server.Addr(), dayRows)
	elapsed := time.Since(started)

	cancel()
	require.NoError(t, <-done)

	require.Len(t, samples, dayRows, "every sample of the day was read back")
	assert.Less(t, elapsed, budget,
		"one recorded day at 3600× took %s, the budget is %s", elapsed, budget)
	assert.Equal(t, clampsBefore, regmap.ClampCount(),
		"no analog value had to be clamped into the int16 range")

	var gotDiscontinuities []uint32
	for i, s := range samples {
		require.Equal(t, uint32(i+1), s.Seq, "the sequence is contiguous from one")
		require.Equal(t, timestamps[i], s.Slot.SimTsMs,
			"sample %d carries the timestamp of row %d of the slice", s.Seq, i+1)
		require.False(t, s.Slot.Missing, "sample %d parsed every field", s.Seq)
		if s.Slot.Discontinuity {
			gotDiscontinuities = append(gotDiscontinuities, s.Seq)
		}
	}
	assert.Equal(t, wantDiscontinuities, gotDiscontinuities,
		"the flag is set on the first sample and on the row after each collapsed gap, nowhere else")

	snap := engine.Snapshot()
	assert.Equal(t, sim.StateStopped, snap.State)
	assert.Equal(t, uint32(dayRows), snap.HeadSeq)
	assert.Equal(t, timestamps[len(timestamps)-1], snap.LastTsMs)
	assert.Zero(t, server.Refusals(), "the reader only ever read")
}

// readRing polls the register space the way the gateway does: read the header,
// then the slots between the last accepted sequence number and head_seq, at
// most three at a time and never across the ring wrap, checking each slot's
// own sequence number so a lagging reader notices loss instead of publishing
// whatever overwrote it.
func readRing(ctx context.Context, t *testing.T, addr string, want int) []sample {
	t.Helper()

	client, err := modbus.NewClient(&modbus.ClientConfiguration{
		URL:     "tcp://" + addr,
		Timeout: clientTimeout,
	})
	require.NoError(t, err)
	require.NoError(t, client.SetUnitId(sim.UnitID))
	require.NoError(t, client.Open())
	defer func() { assert.NoError(t, client.Close()) }()

	samples := make([]sample, 0, want)
	var lastSeq uint32

	for len(samples) < want {
		if ctx.Err() != nil {
			t.Fatalf("read %d of %d samples before the budget ran out", len(samples), want)
		}

		regs, err := client.ReadRegisters(regmap.HeaderBase, regmap.HeaderRegs, modbus.HOLDING_REGISTER)
		require.NoError(t, err)
		header, err := regmap.DecodeHeader(regs)
		require.NoError(t, err)
		require.Equal(t, regmap.MapMajor, header.MapMajor)

		if header.HeadSeq <= lastSeq {
			time.Sleep(pollInterval)
			continue
		}

		from := lastSeq + 1
		require.LessOrEqual(t, header.HeadSeq-from+1, uint32(regmap.RingSlots),
			"the reader fell a whole ring behind at sample %d", from)

		n := min(header.HeadSeq-from+1, slotsPerRead)
		// A request never crosses the wrap, so it stops at the end of the ring.
		if room := uint32(regmap.RingSlots) - from%uint32(regmap.RingSlots); n > room {
			n = room
		}

		regs, err = client.ReadRegisters(regmap.SlotAddr(from), uint16(n)*regmap.SlotRegs,
			modbus.HOLDING_REGISTER)
		require.NoError(t, err)

		for i := range n {
			slot, err := regmap.DecodeSlot(regs[i*regmap.SlotRegs : (i+1)*regmap.SlotRegs])
			require.NoError(t, err)
			require.Equal(t, from+i, slot.Seq,
				"slot %d held sample %d: the reader was overtaken", from+i, slot.Seq)
			samples = append(samples, sample{Seq: slot.Seq, Slot: slot})
		}
		lastSeq = from + n - 1
	}
	return samples
}
