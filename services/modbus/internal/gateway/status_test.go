// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The retained status-gateway heartbeat.

package gateway_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// testConfig is a configuration that passes validation without touching the
// environment.
func testConfig() gateway.Config {
	cfg := gateway.DefaultConfig()
	cfg.ModbusAddr = "127.0.0.1:5020"
	cfg.PollInterval = 50 * time.Millisecond
	cfg.StatusInterval = 20 * time.Millisecond
	return cfg
}

// busySnapshot is a gateway that has been running for a while and has seen
// everything worth reporting.
func busySnapshot() gateway.Snapshot {
	return gateway.Snapshot{
		Counters: gateway.Counters{
			Polls:       1200,
			ReadErrors:  3,
			Dropped:     17,
			Resyncs:     2,
			SimRestarts: 1,
		},
		LastSeq:          3600,
		LastSimTsMs:      goldenSimTsMs,
		HasSample:        true,
		HeadSeq:          3602,
		SamplesPublished: 3580,
		BatchesPublished: 150,
		PublishErrors:    4,
		ModbusConnected:  true,
		MQTTConnected:    true,
		LastHeaderRead:   time.UnixMilli(goldenWallTsMs).UTC(),
		MapMajor:         1,
		MapMinor:         0,
		HasMapVersion:    true,
	}
}

// TestStatusCarriesEveryCounter holds the heartbeat's field list against the
// names the status-gateway schema declares.
func TestStatusCarriesEveryCounter(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	clock := testutil.NewFakeClock(time.UnixMilli(goldenWallTsMs).UTC())
	status, err := gateway.NewStatusPublisher(newStubBroker(), cfg, clock,
		time.UnixMilli(goldenWallTsMs-90_000).UTC())
	require.NoError(t, err)

	payload, err := status.Encode(busySnapshot())
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(payload, &got))

	assert.Equal(t, map[string]any{
		"schema":                  "urn:fdp:schema:status-gateway:v1",
		"unit_id":                 "cau-7",
		"wall_ts":                 "2026-03-20T10:00:00.123Z",
		"last_seq":                float64(3600),
		"dropped_total":           float64(17),
		"polls_total":             float64(1200),
		"poll_errors_total":       float64(3),
		"poll_interval_ms":        float64(50),
		"samples_per_s":           float64(3580) / 90,
		"modbus":                  map[string]any{"host": "127.0.0.1", "port": float64(5020), "connected": true, "map_major": float64(1), "map_minor": float64(0)},
		"last_error":              nil,
		"mqtt_connected":          true,
		"head_seq":                float64(3602),
		"last_sim_ts":             "2020-02-01T03:20:10.000Z",
		"resyncs_total":           float64(2),
		"sim_restarts_total":      float64(1),
		"publish_errors_total":    float64(4),
		"samples_published_total": float64(3580),
		"batches_published_total": float64(150),
		"uptime_s":                float64(90),
	}, got)
}

// TestStatusOfAGatewayThatHasPublishedNothing is the shape a consumer sees
// while the gateway is still coming up.
func TestStatusOfAGatewayThatHasPublishedNothing(t *testing.T) {
	t.Parallel()

	started := time.UnixMilli(goldenWallTsMs).UTC()
	clock := testutil.NewFakeClock(started)
	status, err := gateway.NewStatusPublisher(newStubBroker(), testConfig(), clock, started)
	require.NoError(t, err)

	payload, err := status.Encode(gateway.Snapshot{LastError: "the Modbus connection is down"})
	require.NoError(t, err)

	var got struct {
		LastSeq     uint32  `json:"last_seq"`
		LastSimTS   *string `json:"last_sim_ts"`
		LastError   *string `json:"last_error"`
		SamplesPerS float64 `json:"samples_per_s"`
		Modbus      struct {
			Connected bool    `json:"connected"`
			MapMajor  *uint16 `json:"map_major"`
		} `json:"modbus"`
	}
	require.NoError(t, json.Unmarshal(payload, &got))

	assert.Zero(t, got.LastSeq)
	assert.Nil(t, got.LastSimTS, "no sample, no simulated time")
	assert.Nil(t, got.Modbus.MapMajor, "an unread device has no register map version")
	assert.Zero(t, got.SamplesPerS, "a window of zero length is a rate of zero, not an infinity")
	require.NotNil(t, got.LastError)
	assert.Equal(t, "the Modbus connection is down", *got.LastError)
}

// TestStatusRateCoversTheLastWindowOnly: two heartbeats apart report the
// samples published between them, not the average since boot.
func TestStatusRateCoversTheLastWindowOnly(t *testing.T) {
	t.Parallel()

	started := time.UnixMilli(goldenWallTsMs).UTC()
	clock := testutil.NewFakeClock(started)
	status, err := gateway.NewStatusPublisher(newStubBroker(), testConfig(), clock, started)
	require.NoError(t, err)

	snap := gateway.Snapshot{SamplesPublished: 1000}
	clock.Advance(10 * time.Second)
	first := rateOf(t, status, snap)
	assert.InDelta(t, 100.0, first, 1e-9)

	snap.SamplesPublished = 1050
	clock.Advance(10 * time.Second)
	second := rateOf(t, status, snap)
	assert.InDelta(t, 5.0, second, 1e-9, "the second window saw 50 samples in 10 s")
}

// rateOf encodes one heartbeat and returns its samples_per_s.
func rateOf(t *testing.T, status *gateway.StatusPublisher, snap gateway.Snapshot) float64 {
	t.Helper()

	payload, err := status.Encode(snap)
	require.NoError(t, err)

	var got struct {
		SamplesPerS float64 `json:"samples_per_s"`
	}
	require.NoError(t, json.Unmarshal(payload, &got))
	return got.SamplesPerS
}

// TestStatusIsRetained: a backend that connects later must learn at once
// whether the gateway is alive.
func TestStatusIsRetained(t *testing.T) {
	t.Parallel()

	broker := newStubBroker()
	started := time.UnixMilli(goldenWallTsMs).UTC()
	status, err := gateway.NewStatusPublisher(broker, testConfig(), testutil.NewFakeClock(started), started)
	require.NoError(t, err)

	require.NoError(t, status.Publish(context.Background(), busySnapshot()))

	messages := broker.Messages()
	require.Len(t, messages, 1)
	assert.Equal(t, "plant/cau-7/status/gateway", messages[0].topic)
	assert.Equal(t, messages[0].topic, status.Topic())
	assert.Equal(t, byte(1), messages[0].qos)
	assert.True(t, messages[0].retain)
}

// TestStatusValidatesAgainstTheContract closes the loop with
// packages/contracts for the heartbeat, in both of its shapes.
func TestStatusValidatesAgainstTheContract(t *testing.T) {
	t.Parallel()

	started := time.UnixMilli(goldenWallTsMs).UTC()
	clock := testutil.NewFakeClock(started)
	status, err := gateway.NewStatusPublisher(newStubBroker(), testConfig(), clock, started)
	require.NoError(t, err)

	clock.Advance(5 * time.Second)
	busy, err := status.Encode(busySnapshot())
	require.NoError(t, err)
	schematest.Validate(t, "status-gateway", busy)

	clock.Advance(5 * time.Second)
	cold, err := status.Encode(gateway.Snapshot{LastError: "the Modbus connection is down"})
	require.NoError(t, err)
	schematest.Validate(t, "status-gateway", cold)
}
