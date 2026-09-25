// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The /healthz endpoint and the probe subcommand of the gateway.

package gateway_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// healthyAt is a snapshot of a gateway that is working, read at now.
func healthyAt(now time.Time) gateway.Snapshot {
	return gateway.Snapshot{
		ModbusConnected: true,
		MQTTConnected:   true,
		LastHeaderRead:  now.Add(-time.Second),
	}
}

// TestHealthyNeedsBothLinksAndAFreshHeader is the health rule, one row per way
// of being unhealthy.
func TestHealthyNeedsBothLinksAndAFreshHeader(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(goldenWallTsMs).UTC()
	cases := []struct {
		name string
		snap gateway.Snapshot
		want bool
	}{
		{"both links up and a header a second old", healthyAt(now), true},
		{
			"a header just inside the window",
			gateway.Snapshot{ModbusConnected: true, MQTTConnected: true,
				LastHeaderRead: now.Add(-gateway.HeaderFreshness + time.Millisecond)},
			true,
		},
		{
			"a header exactly at the window",
			gateway.Snapshot{ModbusConnected: true, MQTTConnected: true,
				LastHeaderRead: now.Add(-gateway.HeaderFreshness)},
			false,
		},
		{
			"the Modbus link down",
			gateway.Snapshot{MQTTConnected: true, LastHeaderRead: now},
			false,
		},
		{
			"the MQTT link down",
			gateway.Snapshot{ModbusConnected: true, LastHeaderRead: now},
			false,
		},
		{
			"nothing read yet",
			gateway.Snapshot{ModbusConnected: true, MQTTConnected: true},
			false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			ok, reason := gateway.Healthy(tc.snap, now)
			assert.Equal(t, tc.want, ok)
			if tc.want {
				assert.Empty(t, reason)
			} else {
				assert.NotEmpty(t, reason, "an unhealthy gateway says why")
			}
		})
	}
}

// snapshotHolder hands the same snapshot to the HTTP goroutine that the test
// writes, without a race between them.
type snapshotHolder struct {
	mu   sync.Mutex
	snap gateway.Snapshot
}

// Get is the snapshot function the handler is built with.
func (h *snapshotHolder) Get() gateway.Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.snap
}

// Set replaces the snapshot the handler reads.
func (h *snapshotHolder) Set(snap gateway.Snapshot) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.snap = snap
}

// TestHealthEndpointAnswers200AndThen503 walks the endpoint through the states
// the Compose healthcheck reads.
func TestHealthEndpointAnswers200AndThen503(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(goldenWallTsMs).UTC()
	clock := testutil.NewFakeClock(now)
	holder := &snapshotHolder{snap: healthyAt(now)}

	server := httptest.NewServer(gateway.HealthHandler(holder.Get, clock))
	t.Cleanup(server.Close)

	body := getHealth(t, server.URL, http.StatusOK)
	assert.Equal(t, "ok", body.Status)
	assert.True(t, body.ModbusConnected)
	assert.True(t, body.MQTTConnected)
	assert.Equal(t, int64(1000), body.LastHeaderAgeMs)
	assert.Empty(t, body.Reason)

	// The device goes quiet: five seconds later the last header is stale.
	clock.Advance(gateway.HeaderFreshness)
	body = getHealth(t, server.URL, http.StatusServiceUnavailable)
	assert.Equal(t, "unhealthy", body.Status)
	assert.Contains(t, body.Reason, "header")

	// A dropped Modbus connection is unhealthy however fresh the header is.
	stale := healthyAt(clock.Now())
	stale.ModbusConnected = false
	holder.Set(stale)
	body = getHealth(t, server.URL, http.StatusServiceUnavailable)
	assert.Contains(t, body.Reason, "Modbus")
}

// healthBody mirrors the JSON /healthz answers with.
type healthBody struct {
	Status          string `json:"status"`
	ModbusConnected bool   `json:"modbus_connected"`
	MQTTConnected   bool   `json:"mqtt_connected"`
	LastHeaderAgeMs int64  `json:"last_header_age_ms"`
	Reason          string `json:"reason"`
}

// getHealth requests /healthz and asserts the status code.
func getHealth(t *testing.T, base string, wantStatus int) healthBody {
	t.Helper()

	resp, err := http.Get(base + gateway.HealthPath) //nolint:noctx // the test server is in-process
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, wantStatus, resp.StatusCode, "body: %s", raw)

	var body healthBody
	require.NoError(t, json.Unmarshal(raw, &body))
	return body
}

// TestProbeFollowsTheEndpoint is the `gateway probe` subcommand: exit 0 while
// the endpoint answers 200, non-zero as soon as it does not.
func TestProbeFollowsTheEndpoint(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(goldenWallTsMs).UTC()
	clock := testutil.NewFakeClock(now)
	holder := &snapshotHolder{snap: healthyAt(now)}

	server, err := gateway.StartHealthServer("127.0.0.1:0", gateway.HealthHandler(holder.Get, clock))
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer cancel()
		require.NoError(t, server.Close(ctx))
	})

	port := portOf(t, server.Addr())

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()
	require.NoError(t, gateway.Probe(ctx, port), "a healthy gateway probes clean")

	offline := healthyAt(now)
	offline.MQTTConnected = false
	holder.Set(offline)
	require.Error(t, gateway.Probe(ctx, port), "an unhealthy gateway fails the probe")
}

// TestProbeFailsWithoutAGateway: nothing listening is not healthy either, which
// is what the healthcheck sees while the container is starting.
func TestProbeFailsWithoutAGateway(t *testing.T) {
	t.Parallel()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := portOf(t, listener.Addr().String())
	require.NoError(t, listener.Close())

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()
	require.Error(t, gateway.Probe(ctx, port))
}

// portOf returns the port of a "host:port" address.
func portOf(t *testing.T, addr string) int {
	t.Helper()

	_, raw, err := net.SplitHostPort(addr)
	require.NoError(t, err)
	port, err := strconv.Atoi(raw)
	require.NoError(t, err)
	return port
}
