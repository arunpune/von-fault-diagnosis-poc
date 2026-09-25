// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The poll loop of the gateway: batching, reconnect, refusal of another
// register map, and the heartbeat beside it.

package gateway_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// serviceConfig is a configuration tuned for a test: a poll interval short
// enough that no assertion waits for it and a heartbeat that arrives within a
// test's patience.
func serviceConfig() gateway.Config {
	cfg := testConfig()
	cfg.PollInterval = pollTick
	cfg.StatusInterval = 20 * time.Millisecond
	return cfg
}

// runningService starts a service over device and broker and stops it in
// t.Cleanup. The backoff jitter is the identity, so a reconnect takes exactly
// the documented time.
func runningService(t *testing.T, cfg gateway.Config, device *testutil.ModbusDevice,
	broker gateway.Broker) (*gateway.Service, *testutil.FakePoller) {
	t.Helper()

	poller := device.FakePoller()
	service, err := gateway.New(cfg, poller, broker, gateway.Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Jitter: func(d time.Duration) time.Duration { return d },
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	var done sync.WaitGroup
	done.Add(1)
	go func() {
		defer done.Done()
		assert.NoError(t, service.Run(ctx))
	}()
	t.Cleanup(func() {
		cancel()
		done.Wait()
	})

	// The first poll adopts the device's head and replays no backlog, so a
	// test only feeds samples once it has happened; otherwise what it writes
	// is the backlog the gateway is right to ignore.
	waitFor(t, func() bool { return service.Snapshot().Counters.Polls > 0 }, "the first poll cycle")
	return service, poller
}

// waitFor blocks until cond holds or the budget runs out.
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()

	deadline := time.Now().Add(budget(t, settleBudget))
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// telemetryBatches decodes the sequence numbers of every telemetry message.
func telemetryBatches(t *testing.T, messages []published) [][]uint32 {
	t.Helper()

	batches := make([][]uint32, 0, len(messages))
	for _, m := range messages {
		var msg struct {
			Samples []struct {
				Seq uint32 `json:"seq"`
			} `json:"samples"`
		}
		require.NoError(t, json.Unmarshal(m.payload, &msg))

		batch := make([]uint32, 0, len(msg.Samples))
		for _, s := range msg.Samples {
			batch = append(batch, s.Seq)
		}
		batches = append(batches, batch)
	}
	return batches
}

// flatten concatenates the batches into one sequence.
func flatten(batches [][]uint32) []uint32 {
	out := make([]uint32, 0, len(batches))
	for _, batch := range batches {
		out = append(out, batch...)
	}
	return out
}

// contiguousFrom returns the sequence first..first+count-1.
func contiguousFrom(first uint32, count int) []uint32 {
	out := make([]uint32, count)
	for i := range out {
		out[i] = first + uint32(i)
	}
	return out
}

// feed publishes count samples on the device, one at a time, exactly as the
// simulator's emit loop does.
func feed(t *testing.T, device *testutil.ModbusDevice, first uint32, count int) {
	t.Helper()

	for _, slot := range slotSeries(t, first, count) {
		device.Publish(t, slot)
	}
}

// TestServicePublishesEverySampleInOrder is the whole point of the connector:
// what the simulator wrote is what the broker sees, once each and in order.
func TestServicePublishesEverySampleInOrder(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, serviceConfig(), device, broker)

	const samples = 120
	feed(t, device, 1, samples)

	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= samples },
		"every sample to be published")

	batches := telemetryBatches(t, broker.On(service.TelemetryTopic()))
	assert.Equal(t, contiguousFrom(1, samples), flatten(batches),
		"every sequence number, once, in order")
	for i, batch := range batches {
		assert.NotEmpty(t, batch, "batch %d", i)
		assert.LessOrEqual(t, len(batch), gateway.MaxBatchLimit, "batch %d", i)
	}
	assert.Zero(t, service.Snapshot().Counters.Dropped, "a gateway that keeps up drops nothing")
}

// TestServiceNeverExceedsTheConfiguredBatch holds GATEWAY_MAX_BATCH: three
// slots arrive per read, and the batch is cut at the limit, never after it.
func TestServiceNeverExceedsTheConfiguredBatch(t *testing.T) {
	t.Parallel()

	cfg := serviceConfig()
	cfg.MaxBatch = 5

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, cfg, device, broker)

	const samples = 47
	feed(t, device, 1, samples)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= samples },
		"every sample to be published")

	batches := telemetryBatches(t, broker.On(service.TelemetryTopic()))
	assert.Equal(t, contiguousFrom(1, samples), flatten(batches))
	for i, batch := range batches {
		assert.LessOrEqual(t, len(batch), cfg.MaxBatch, "batch %d", i)
	}
}

// TestServiceReconnectsAndKeepsItsSequence: a Modbus failure closes and
// reopens the connection, and the reader picks up where it stopped.
func TestServiceReconnectsAndKeepsItsSequence(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, poller := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 6)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 6 }, "the first samples")

	poller.FailReads(2, errors.New("connection reset by peer"))
	waitFor(t, func() bool { return poller.Opens() >= 2 }, "the connection to be reopened")

	feed(t, device, 7, 6)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 12 },
		"the samples after the reconnect")

	batches := telemetryBatches(t, broker.On(service.TelemetryTopic()))
	assert.Equal(t, contiguousFrom(1, 12), flatten(batches),
		"a reconnect keeps lastSeq, so nothing is republished and nothing is skipped")
	assert.Positive(t, service.Snapshot().Counters.ReadErrors)
	assert.Zero(t, service.Snapshot().Counters.Dropped)
}

// TestServiceRefusesAnotherRegisterMapMajor: the gateway stops publishing and
// says why, rather than forwarding values it cannot decode.
func TestServiceRefusesAnotherRegisterMapMajor(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 3)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 3 }, "the first samples")

	device.SetMapMajor(regmap.MapMajor + 1)
	feed(t, device, 4, 3)
	waitFor(t, func() bool { return service.Snapshot().LastError != "" }, "the refusal to be recorded")

	snap := service.Snapshot()
	assert.Contains(t, snap.LastError, "register map major")
	assert.Equal(t, uint64(3), snap.SamplesPublished, "nothing is published from a map it cannot decode")

	healthy, reason := gateway.Healthy(snap, snap.LastHeaderRead.Add(gateway.HeaderFreshness))
	assert.False(t, healthy, "a refused map leaves the gateway unhealthy: %s", reason)
}

// TestServiceDropsBatchesWhileTheBrokerRefuses: telemetry is not queued while
// the broker is down — the ring does not wait, so an outage is data loss,
// counted and reported.
func TestServiceDropsBatchesWhileTheBrokerRefuses(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	broker.FailWith(errors.New("not authorized"))
	service, _ := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 9)
	waitFor(t, func() bool { return service.Snapshot().PublishErrors >= 1 }, "the first refusal")
	feed(t, device, 10, 9)
	waitFor(t, func() bool { return service.Snapshot().PublishErrors >= 2 }, "the second refusal")

	assert.Empty(t, broker.On(service.TelemetryTopic()), "a refused batch never reaches the broker")
	assert.Zero(t, service.Snapshot().SamplesPublished)

	broker.FailWith(nil)
	feed(t, device, 19, 6)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished > 0 },
		"publishing to resume once the broker accepts again")

	published := flatten(telemetryBatches(t, broker.On(service.TelemetryTopic())))
	require.NotEmpty(t, published)
	assert.NotContains(t, published, uint32(1), "the batches lost during the outage are not replayed")
}

// TestServiceHeartbeatReportsTheRun holds the retained heartbeat beside a
// running poll loop.
func TestServiceHeartbeatReportsTheRun(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 12)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 12 }, "the samples")

	var status struct {
		LastSeq         uint32 `json:"last_seq"`
		DroppedTotal    uint64 `json:"dropped_total"`
		PollsTotal      uint64 `json:"polls_total"`
		PollIntervalMs  int64  `json:"poll_interval_ms"`
		ModbusConnected struct {
			Connected bool `json:"connected"`
		} `json:"modbus"`
		MQTTConnected bool `json:"mqtt_connected"`
	}
	waitFor(t, func() bool {
		messages := broker.On(service.StatusTopic())
		if len(messages) == 0 {
			return false
		}
		latest := messages[len(messages)-1]
		if !latest.retain {
			return false
		}
		return json.Unmarshal(latest.payload, &status) == nil && status.LastSeq == 12
	}, "a heartbeat that has caught up with the poll loop")

	assert.Zero(t, status.DroppedTotal)
	assert.Positive(t, status.PollsTotal)
	assert.Equal(t, pollTick.Milliseconds(), status.PollIntervalMs)
	assert.True(t, status.ModbusConnected.Connected)
	assert.True(t, status.MQTTConnected)
}

// TestServiceHealthEndpointFollowsTheRun: the probe the Compose healthcheck
// runs answers from the same snapshot the heartbeat does.
func TestServiceHealthEndpointFollowsTheRun(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 3)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 3 }, "the first samples")

	server := httptest.NewServer(service.HealthHandler())
	t.Cleanup(server.Close)

	body := getHealth(t, server.URL, http.StatusOK)
	assert.Equal(t, "ok", body.Status)
	assert.True(t, body.ModbusConnected)
	assert.True(t, body.MQTTConnected)

	// A broker that drops takes the gateway down with it: telemetry that
	// nobody receives is not a healthy gateway.
	broker.SetConnected(false)
	body = getHealth(t, server.URL, http.StatusServiceUnavailable)
	assert.Contains(t, body.Reason, "MQTT")
}

// TestServiceFollowsASimRestart: the simulator comes back with sequence
// numbers from 1, and the gateway follows it instead of waiting for numbers
// that will never come.
func TestServiceFollowsASimRestart(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, _ := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 30)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 30 }, "the first run")

	device.Restart()
	waitFor(t, func() bool { return service.Snapshot().Counters.SimRestarts >= 1 },
		"the restart to be noticed")

	feed(t, device, 1, 6)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 36 }, "the second run")

	published := flatten(telemetryBatches(t, broker.On(service.TelemetryTopic())))
	assert.Equal(t, append(contiguousFrom(1, 30), contiguousFrom(1, 6)...), published)
	assert.Zero(t, service.Snapshot().Counters.Dropped, "a restart loses nothing that ever existed")
}

// TestServiceCountsWhatTheRingOverwrote is the drop accounting of the ring
// reader seen from the outside: a gateway whose reads fail for long enough
// comes back to a ring that has moved on, and reports exactly what it missed.
func TestServiceCountsWhatTheRingOverwrote(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	broker := newStubBroker()
	service, poller := runningService(t, serviceConfig(), device, broker)

	feed(t, device, 1, 10)
	waitFor(t, func() bool { return service.Snapshot().SamplesPublished >= 10 }, "the first samples")

	// Nothing can be read while the simulator races ahead by 390 samples; the
	// ring keeps 145..400, so 11..144 are gone: 134 samples.
	poller.FailReads(-1, errors.New("connection reset by peer"))
	waitFor(t, func() bool { return service.Snapshot().Counters.ReadErrors > 0 }, "the read to fail")
	feed(t, device, 11, 390)
	poller.FailReads(0, nil)

	waitFor(t, func() bool { return service.Snapshot().Counters.Dropped > 0 }, "the drop to be counted")
	waitFor(t, func() bool { return service.Snapshot().LastSeq >= 400 }, "the gateway to catch up")

	assert.Equal(t, uint64(134), service.Snapshot().Counters.Dropped)
	published := flatten(telemetryBatches(t, broker.On(service.TelemetryTopic())))
	assert.Equal(t, append(contiguousFrom(1, 10), contiguousFrom(145, 256)...), published)
}

// TestServiceStopsOnContextCancel: a cancelled context is how the gateway is
// asked to stop, and is not a failure.
func TestServiceStopsOnContextCancel(t *testing.T) {
	t.Parallel()

	device := testutil.StartModbusDevice(t)
	poller := device.FakePoller()
	service, err := gateway.New(serviceConfig(), poller, newStubBroker(), gateway.Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan error, 1)
	go func() { stopped <- service.Run(ctx) }()

	waitFor(t, func() bool { return service.Snapshot().ModbusConnected }, "the device connection")
	cancel()

	select {
	case err := <-stopped:
		require.NoError(t, err)
	case <-time.After(budget(t, settleBudget)):
		t.Fatal("Run did not return after its context was cancelled")
	}
	assert.False(t, service.Snapshot().ModbusConnected, "the connection is closed on the way out")
}
