// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ring-reading algorithm of the gateway, driven register by register over
// an in-memory device.

package gateway_test

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// newReader returns a reader over an open fake poller on a fresh device.
func newReader(t *testing.T) (*gateway.Reader, *testutil.ModbusDevice, *testutil.FakePoller) {
	t.Helper()

	device := testutil.StartModbusDevice(t)
	poller := device.FakePoller()
	require.NoError(t, poller.Open())
	t.Cleanup(func() { require.NoError(t, poller.Close()) })

	return gateway.NewReader(poller), device, poller
}

// syncTo brings the reader to the device's present, which is what the first poll
// does, and returns the reader ready to follow new samples.
func syncTo(t *testing.T, reader *gateway.Reader, device *testutil.ModbusDevice, head uint32) {
	t.Helper()

	device.SetHead(head)
	poll, err := reader.Poll()
	require.NoError(t, err)
	require.Empty(t, poll.Samples, "the first poll adopts the head and replays no backlog")
	require.Equal(t, head, reader.LastSeq())
}

// seqs returns the sequence numbers of the slots, which is what most
// assertions here are about.
func seqs(slots []regmap.Slot) []uint32 {
	out := make([]uint32, len(slots))
	for i, slot := range slots {
		out[i] = slot.Seq
	}
	return out
}

// TestReaderAdoptsTheHeadOnTheFirstPoll holds the first ring-reading rule: a
// ring full of samples from before the gateway connected is not a backlog it
// owes anyone.
func TestReaderAdoptsTheHeadOnTheFirstPoll(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	for _, slot := range slotSeries(t, 1, 100) {
		device.Publish(t, slot)
	}

	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Empty(t, poll.Samples, "the first poll publishes nothing")
	assert.False(t, poll.More)
	assert.Equal(t, uint32(100), reader.LastSeq())
	assert.Zero(t, reader.Counters().Dropped, "adopting the head is not a loss")

	device.Publish(t, slotAt(t, 101, goldenSimTsMs))
	poll, err = reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{101}, seqs(poll.Samples))
}

// TestReaderReadsAtMostThreeSlotsPerRequest holds the read size: three slots
// are 96 registers, and a full read means the caller should poll again at
// once.
func TestReaderReadsAtMostThreeSlotsPerRequest(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 0)
	for _, slot := range slotSeries(t, 1, 10) {
		device.Publish(t, slot)
	}

	want := [][]uint32{{1, 2, 3}, {4, 5, 6}, {7, 8, 9}, {10}}
	wantMore := []bool{true, true, true, false}
	for i, expected := range want {
		poll, err := reader.Poll()
		require.NoError(t, err, "poll %d", i)
		assert.Equal(t, expected, seqs(poll.Samples), "poll %d", i)
		assert.Equal(t, wantMore[i], poll.More, "poll %d reports more work", i)
	}

	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Empty(t, poll.Samples, "a caught-up reader reads nothing")
	assert.Equal(t, uint32(10), reader.LastSeq())
}

// TestReaderNeverCrossesTheRingWrap holds the `256 - from % 256` term of the
// ring-reading algorithm: slots 255, 256 and 257 are not contiguous in the
// register space, so reading them takes two requests.
func TestReaderNeverCrossesTheRingWrap(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 254)
	for _, slot := range slotSeries(t, 255, 3) {
		device.Publish(t, slot)
	}

	first, err := reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{255}, seqs(first.Samples),
		"slot 255 is the last of the ring; the next request starts at its base again")
	assert.False(t, first.More, "a one-slot read is not a full read")

	second, err := reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{256, 257}, seqs(second.Samples))

	// Every sample survived the wrap with its own simulated time.
	assert.Equal(t, goldenSimTsMs, first.Samples[0].SimTsMs)
	assert.Equal(t, goldenSimTsMs+sampleStep, second.Samples[0].SimTsMs)
	assert.Equal(t, goldenSimTsMs+2*sampleStep, second.Samples[1].SimTsMs)
}

// TestReaderCountsWhatTheRingOverwrote holds the lag rule: a reader more than
// a ring behind resumes at the oldest slot that still exists and counts
// exactly the samples in between.
func TestReaderCountsWhatTheRingOverwrote(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 10)

	// The simulator ran on to 400 while the reader was busy; the ring now
	// holds 145..400, so 11..144 are gone: 134 samples.
	for _, slot := range slotSeries(t, 11, 390) {
		device.Publish(t, slot)
	}

	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{145, 146, 147}, seqs(poll.Samples),
		"the reader resumes at head - 255")
	assert.Equal(t, uint64(134), reader.Counters().Dropped)
	assert.Zero(t, reader.Counters().Resyncs, "a clean lag needs no resync")
}

// TestReaderReadsAFullRingWithoutDropping is the boundary of the rule above:
// exactly 256 outstanding samples still all fit in the ring.
func TestReaderReadsAFullRingWithoutDropping(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 0)
	for _, slot := range slotSeries(t, 1, 256) {
		device.Publish(t, slot)
	}

	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{1, 2, 3}, seqs(poll.Samples))
	assert.Zero(t, reader.Counters().Dropped)
}

// TestReaderResyncsOnASlotSequenceMismatch holds the verification step: a slot
// that does not carry the sequence number it was read for was overwritten
// under the reader, and nothing after it in that request is trusted.
func TestReaderResyncsOnASlotSequenceMismatch(t *testing.T) {
	t.Parallel()

	t.Run("keeps the slots read before the mismatch", func(t *testing.T) {
		t.Parallel()

		reader, device, _ := newReader(t)
		syncTo(t, reader, device, 2)
		for _, slot := range slotSeries(t, 3, 3) {
			device.Publish(t, slot)
		}
		// Slot 5 is overwritten by a much later sample, as a simulator that
		// wrapped the ring would.
		device.WriteSample(t, slotAt(t, 261, goldenSimTsMs))
		device.SetHead(5)

		poll, err := reader.Poll()
		require.NoError(t, err)
		assert.Equal(t, []uint32{3, 4}, seqs(poll.Samples))
		assert.False(t, poll.More, "a truncated read is not a full read")
		assert.Equal(t, uint64(1), reader.Counters().Resyncs)
		assert.Equal(t, uint32(4), reader.LastSeq())
	})

	t.Run("publishes nothing when the first slot already mismatches", func(t *testing.T) {
		t.Parallel()

		reader, device, _ := newReader(t)
		syncTo(t, reader, device, 2)
		for _, slot := range slotSeries(t, 4, 2) {
			device.Publish(t, slot)
		}
		device.WriteSample(t, slotAt(t, 259, goldenSimTsMs))
		device.SetHead(5)

		poll, err := reader.Poll()
		require.NoError(t, err)
		assert.Empty(t, poll.Samples, "a mismatching slot is never published")
		assert.Equal(t, uint64(2), reader.Counters().Resyncs,
			"the cycle reads the header again and gives up after the second attempt")
		assert.Equal(t, uint32(2), reader.LastSeq(), "nothing was accepted, so nothing moved")
	})
}

// TestReaderCountsADropExactlyOnce is what makes the integration test's exact
// drop count possible: a resync and the lag rule that follows it never both
// count the same lost sample, because only the lag rule counts at all.
func TestReaderCountsADropExactlyOnce(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 2)

	// Slots 3 and 4 are still the reader's; slot 5 has already been taken by
	// sample 261, which shares its ring position.
	for _, slot := range slotSeries(t, 3, 3) {
		device.Publish(t, slot)
	}
	device.WriteSample(t, slotAt(t, 261, goldenSimTsMs))
	device.SetHead(5)

	poll, err := reader.Poll()
	require.NoError(t, err)
	require.Equal(t, []uint32{3, 4}, seqs(poll.Samples))
	require.Equal(t, uint64(1), reader.Counters().Resyncs)
	assert.Zero(t, reader.Counters().Dropped, "the resync itself counts nothing")

	// The device now admits where it really is: the ring holds 6..261, so
	// sample 5 is the only one the reader will never see.
	for _, slot := range slotSeries(t, 6, 256) {
		device.Publish(t, slot)
	}

	poll, err = reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{6, 7, 8}, seqs(poll.Samples))
	assert.Equal(t, uint64(1), reader.Counters().Dropped, "exactly sample 5 was lost")
}

// TestReaderFollowsASimRestart holds the restart rule: sequence numbers only
// grow inside one simulator process, so a head that went backwards is a new
// process and not a loss.
func TestReaderFollowsASimRestart(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 500)

	device.Restart()
	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Empty(t, poll.Samples)
	assert.Equal(t, uint64(1), reader.Counters().SimRestarts)
	assert.Zero(t, reader.Counters().Dropped, "a restart loses nothing that ever existed")
	assert.Equal(t, uint32(0), reader.LastSeq())

	device.Publish(t, slotAt(t, 1, goldenSimTsMs))
	poll, err = reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{1}, seqs(poll.Samples), "the reader follows the new process from its first sample")
}

// TestReaderRefusesAnotherRegisterMapMajor holds the register-map refusal: a
// different major means a different scale or a missing signal, so every
// decoded value would be wrong.
func TestReaderRefusesAnotherRegisterMapMajor(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 0)
	device.Publish(t, slotAt(t, 1, goldenSimTsMs))
	device.SetMapMajor(regmap.MapMajor + 1)

	_, err := reader.Poll()
	var mapErr *gateway.MapMajorError
	require.ErrorAs(t, err, &mapErr)
	assert.Equal(t, regmap.MapMajor+1, mapErr.Device)
	assert.Equal(t, regmap.MapMajor, mapErr.Expected)
	assert.Zero(t, reader.Counters().ReadErrors, "a refused map is not a read error")

	device.SetMapMajor(regmap.MapMajor)
	poll, err := reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{1}, seqs(poll.Samples), "a device that comes back on the right major is read again")
}

// TestReaderReportsReadErrorsAndKeepsItsSequence: the connection is the
// caller's business, and the sequence number survives it.
func TestReaderReportsReadErrorsAndKeepsItsSequence(t *testing.T) {
	t.Parallel()

	reader, device, poller := newReader(t)
	syncTo(t, reader, device, 0)
	for _, slot := range slotSeries(t, 1, 2) {
		device.Publish(t, slot)
	}

	poll, err := reader.Poll()
	require.NoError(t, err)
	require.Equal(t, []uint32{1, 2}, seqs(poll.Samples))

	wire := errors.New("connection reset by peer")
	poller.FailReads(1, wire)
	_, err = reader.Poll()
	require.ErrorIs(t, err, wire)
	assert.Equal(t, uint64(1), reader.Counters().ReadErrors)

	// A reconnect keeps lastSeq, so the samples written meanwhile are read.
	require.NoError(t, poller.Close())
	require.NoError(t, poller.Open())
	for _, slot := range slotSeries(t, 3, 2) {
		device.Publish(t, slot)
	}

	poll, err = reader.Poll()
	require.NoError(t, err)
	assert.Equal(t, []uint32{3, 4}, seqs(poll.Samples), "the reader resumes where it left off")
	assert.Equal(t, 2, poller.Opens())
}

// TestReaderCountsEveryCycle holds the polls counter.
func TestReaderCountsEveryCycle(t *testing.T) {
	t.Parallel()

	reader, device, _ := newReader(t)
	syncTo(t, reader, device, 0)
	for range 4 {
		_, err := reader.Poll()
		require.NoError(t, err)
	}
	assert.Equal(t, uint64(5), reader.Counters().Polls, "the synchronising poll counts too")
	assert.Equal(t, uint32(0), reader.Head())
}
