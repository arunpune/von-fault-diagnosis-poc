// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The telemetry-samples message the gateway publishes.

package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// updateGolden re-creates the golden message instead of comparing with it. It
// is a deliberate, reviewed act: the file is the contract with
// packages/contracts.
var updateGolden = flag.Bool("update-golden", false,
	"rewrite testdata/telemetry-samples.golden.json from the encoder")

// goldenFile pins the exact bytes one batch serialises to. It is indented for
// review; the test compacts it before comparing, so the comparison is still
// byte for byte.
const goldenFile = "telemetry-samples.golden.json"

// fakeClockAt returns a clock frozen at ms, epoch milliseconds UTC.
func fakeClockAt(ms int64) gateway.Clock {
	return testutil.NewFakeClock(time.UnixMilli(ms).UTC())
}

// newPublisher returns a publisher over a fresh stub broker, frozen at the
// golden wall-clock instant.
func newPublisher(t *testing.T) (*gateway.Publisher, *stubBroker) {
	t.Helper()

	broker := newStubBroker()
	return gateway.NewPublisher(broker, mqttio.DefaultUnitID, fakeClockAt(goldenWallTsMs)), broker
}

// TestPublisherEncodesTheGoldenBatch is the telemetry contract written out:
// one decoded slot, one message, every byte pinned. Re-create the file with
// `go test ./internal/gateway/... -run TestPublisherEncodesTheGoldenBatch -update-golden`
// after a deliberate change to the map or the message.
func TestPublisherEncodesTheGoldenBatch(t *testing.T) {
	t.Parallel()

	publisher, _ := newPublisher(t)
	payload, err := publisher.Encode([]regmap.Slot{slotAt(t, goldenSeq, goldenSimTsMs)})
	require.NoError(t, err)

	path := filepath.Join("testdata", goldenFile)
	if *updateGolden {
		var indented bytes.Buffer
		require.NoError(t, json.Indent(&indented, payload, "", "  "))
		indented.WriteByte('\n')
		require.NoError(t, os.WriteFile(path, indented.Bytes(), 0o644))
	}

	want, err := os.ReadFile(path)
	require.NoError(t, err, "the golden file is missing; re-create it with -update-golden")

	var compact bytes.Buffer
	require.NoError(t, json.Compact(&compact, want))
	assert.Equal(t, compact.String(), string(payload))
}

// TestPublisherStampsSimulatedTimeNotWallTime is the time rule of
// docs/architecture.md (simulated time and wall time): the envelope carries
// wall time, every sample carries the time the simulator wrote into its slot,
// however far apart the two are.
func TestPublisherStampsSimulatedTimeNotWallTime(t *testing.T) {
	t.Parallel()

	broker := newStubBroker()
	// A clock six years past the data, on the wrong side of a leap day.
	publisher := gateway.NewPublisher(broker, mqttio.DefaultUnitID, fakeClockAt(goldenWallTsMs))

	slots := slotSeries(t, 7, 3)
	require.NoError(t, publisher.Publish(context.Background(), slots))

	messages := broker.Messages()
	require.Len(t, messages, 1)

	var msg struct {
		WallTS  string `json:"wall_ts"`
		Samples []struct {
			Seq   uint32 `json:"seq"`
			SimTS string `json:"sim_ts"`
		} `json:"samples"`
	}
	require.NoError(t, json.Unmarshal(messages[0].payload, &msg))

	assert.Equal(t, mqttio.WallTS(time.UnixMilli(goldenWallTsMs)), msg.WallTS)
	require.Len(t, msg.Samples, len(slots))
	for i, sample := range msg.Samples {
		assert.Equal(t, slots[i].Seq, sample.Seq)
		assert.Equal(t, mqttio.SimTS(slots[i].SimTsMs), sample.SimTS,
			"sample %d must carry its own slot time", i)
		assert.NotEqual(t, msg.WallTS, sample.SimTS)
	}
}

// TestPublisherSendsQoS1Unretained holds the telemetry delivery contract.
func TestPublisherSendsQoS1Unretained(t *testing.T) {
	t.Parallel()

	publisher, broker := newPublisher(t)
	require.NoError(t, publisher.Publish(context.Background(), slotSeries(t, 1, 2)))

	messages := broker.Messages()
	require.Len(t, messages, 1)
	assert.Equal(t, "plant/cau-7/telemetry/samples", messages[0].topic)
	assert.Equal(t, byte(1), messages[0].qos)
	assert.False(t, messages[0].retain, "telemetry is a stream, never a retained state")
	assert.Equal(t, messages[0].topic, publisher.Topic())
}

// TestPublisherBatchesOneToTwentyFive walks the whole range the schema allows,
// and refuses the first size beyond it.
func TestPublisherBatchesOneToTwentyFive(t *testing.T) {
	t.Parallel()

	publisher, _ := newPublisher(t)
	for size := 1; size <= gateway.MaxBatchLimit; size++ {
		payload, err := publisher.Encode(slotSeries(t, 1, size))
		require.NoError(t, err, "a batch of %d", size)

		var msg struct {
			Samples []json.RawMessage `json:"samples"`
		}
		require.NoError(t, json.Unmarshal(payload, &msg))
		assert.Len(t, msg.Samples, size)
	}

	_, err := publisher.Encode(slotSeries(t, 1, gateway.MaxBatchLimit+1))
	require.Error(t, err, "26 samples exceed the schema maximum")
}

// TestPublisherIgnoresAnEmptyBatch: a poll that read nothing is not a message.
func TestPublisherIgnoresAnEmptyBatch(t *testing.T) {
	t.Parallel()

	publisher, broker := newPublisher(t)
	require.NoError(t, publisher.Publish(context.Background(), nil))
	assert.Empty(t, broker.Messages())
}

// TestPublisherReportsABrokerRefusal: the batch is lost and the caller is
// told, which is what the publish_errors counter is built on.
func TestPublisherReportsABrokerRefusal(t *testing.T) {
	t.Parallel()

	publisher, broker := newPublisher(t)
	refused := errors.New("not authorized")
	broker.FailWith(refused)

	err := publisher.Publish(context.Background(), slotSeries(t, 1, 3))
	require.ErrorIs(t, err, refused)
	assert.Empty(t, broker.Messages(), "a refused batch is dropped, never queued")
}

// TestPublisherCarriesTheActiveAlarmCodes: the gateway expands the alarm bits
// the simulator wrote and adds nothing of its own.
func TestPublisherCarriesTheActiveAlarmCodes(t *testing.T) {
	t.Parallel()

	require.NotEmpty(t, regmap.Alarms, "the generated map declares no alarm")
	first := regmap.Alarms[0]

	publisher, _ := newPublisher(t)
	slot := slotAt(t, 42, goldenSimTsMs)
	slot.AlarmBits = 1 << first.Bit

	payload, err := publisher.Encode([]regmap.Slot{slot})
	require.NoError(t, err)

	var msg struct {
		Samples []struct {
			Alarms []string `json:"alarms"`
		} `json:"samples"`
	}
	require.NoError(t, json.Unmarshal(payload, &msg))
	require.Len(t, msg.Samples, 1)
	assert.Equal(t, []string{first.Code}, msg.Samples[0].Alarms)
}

// TestTelemetryValidatesAgainstTheContract closes the loop with
// packages/contracts: what the gateway emits is what packages/contracts
// declares. It skips without the generated schemas and fails under
// FDP_REQUIRE_SCHEMAS=1.
func TestTelemetryValidatesAgainstTheContract(t *testing.T) {
	t.Parallel()

	publisher, _ := newPublisher(t)
	for _, size := range []int{1, 2, gateway.MaxBatchLimit} {
		payload, err := publisher.Encode(slotSeries(t, 1, size))
		require.NoError(t, err)
		schematest.Validate(t, "telemetry-samples", payload)
	}

	// A batch that carries an alarm and both flags is the other shape the
	// schema has to accept.
	slot := slotAt(t, 99, goldenSimTsMs)
	slot.Discontinuity, slot.Missing = true, true
	if len(regmap.Alarms) != 0 {
		slot.AlarmBits = 1 << regmap.Alarms[0].Bit
	}
	payload, err := publisher.Encode([]regmap.Slot{slot})
	require.NoError(t, err)
	schematest.Validate(t, "telemetry-samples", payload)
}

// published is one message a stubBroker recorded.
type published struct {
	topic   string
	payload []byte
	qos     byte
	retain  bool
}

// stubBroker records what the gateway publishes and can be made to fail, which
// is how the publish-error accounting is tested without stopping a broker.
type stubBroker struct {
	mu        sync.Mutex
	messages  []published
	connected bool
	failure   error
}

// newStubBroker returns a connected stub that accepts everything.
func newStubBroker() *stubBroker { return &stubBroker{connected: true} }

// Publish records the message, or returns the scripted failure.
func (b *stubBroker) Publish(_ context.Context, topic string, payload []byte, qos byte, retain bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.failure != nil {
		return b.failure
	}
	// The caller reuses its batch slice, so the payload is copied.
	b.messages = append(b.messages, published{
		topic:   topic,
		payload: append([]byte(nil), payload...),
		qos:     qos,
		retain:  retain,
	})
	return nil
}

// Connected reports the stub's link state.
func (b *stubBroker) Connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.connected
}

// SetConnected changes the stub's link state.
func (b *stubBroker) SetConnected(connected bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.connected = connected
}

// FailWith makes every further Publish return err; nil accepts again.
func (b *stubBroker) FailWith(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.failure = err
}

// Messages returns the messages recorded so far.
func (b *stubBroker) Messages() []published {
	b.mu.Lock()
	defer b.mu.Unlock()

	return append([]published(nil), b.messages...)
}

// On returns the messages recorded for one topic.
func (b *stubBroker) On(topic string) []published {
	messages := b.Messages()

	out := make([]published, 0, len(messages))
	for _, m := range messages {
		if m.topic == topic {
			out = append(out, m)
		}
	}
	return out
}
