// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The gateway over a real MQTT 5 client and broker, without Docker: the
// embedded broker of internal/testutil stands in for Mosquitto, which the
// integration test beside this one uses instead.

package gateway_test

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// collector records what a subscriber received, by topic and in order.
type collector struct {
	mu       sync.Mutex
	payloads map[string][][]byte
}

// newCollector returns an empty collector.
func newCollector() *collector { return &collector{payloads: map[string][][]byte{}} }

// Handle is the mqttio.Handler the subscriptions are made with.
func (c *collector) Handle(topic string, payload []byte, _ bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.payloads[topic] = append(c.payloads[topic], append([]byte(nil), payload...))
}

// On returns the payloads received on one topic.
func (c *collector) On(topic string) [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()

	return append([][]byte(nil), c.payloads[topic]...)
}

// connectClient dials the broker and closes the client in t.Cleanup.
func connectClient(t *testing.T, url, clientID string) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{URL: url, ClientID: clientID}, nil)
	require.NoError(t, err)
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// rawBatches decodes the sequence numbers of raw telemetry payloads.
func rawBatches(t *testing.T, payloads [][]byte) [][]uint32 {
	t.Helper()

	messages := make([]published, 0, len(payloads))
	for _, payload := range payloads {
		messages = append(messages, published{payload: payload})
	}
	return telemetryBatches(t, messages)
}

// TestServiceOverAnEmbeddedBroker runs the whole connector through
// mqttio.Client: what the device wrote reaches a second client contiguously,
// the heartbeat is there, and every message on the wire validates against the
// contracts.
func TestServiceOverAnEmbeddedBroker(t *testing.T) {
	t.Parallel()

	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}
	received := newCollector()

	subscriber := connectClient(t, url, "gateway-test-subscriber")
	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()
	require.NoError(t, subscriber.Subscribe(ctx, topics.Telemetry(), 1, received.Handle))
	require.NoError(t, subscriber.Subscribe(ctx, topics.StatusGateway(), 1, received.Handle))

	publisher := connectClient(t, url, "gateway-test-publisher")
	device := testutil.StartModbusDevice(t)
	service, _ := runningService(t, serviceConfig(), device, publisher)

	const samples = 40
	feed(t, device, 1, samples)
	waitFor(t, func() bool {
		return len(flatten(rawBatches(t, received.On(topics.Telemetry())))) >= samples
	}, "every sample to arrive at the broker")

	assert.Equal(t, contiguousFrom(1, samples), flatten(rawBatches(t, received.On(topics.Telemetry()))))

	waitFor(t, func() bool { return len(received.On(topics.StatusGateway())) > 0 }, "a heartbeat")
	schematest.Validate(t, "status-gateway", received.On(topics.StatusGateway())[0])
	for i, payload := range received.On(topics.Telemetry()) {
		schematest.Validate(t, "telemetry-samples", payload)
		require.NotContains(t, string(payload), "inject",
			"message %d: the gateway knows nothing about injections (ground-truth isolation)", i)
	}
	assert.Zero(t, service.Snapshot().PublishErrors)
}
