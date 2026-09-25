// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// probeTimeout is the budget of a loopback health request in these tests.
const probeTimeout = 2 * time.Second

// always returns a readiness function with a fixed answer.
func always(ready bool) func() bool { return func() bool { return ready } }

// startHealth serves the health endpoint on an ephemeral port.
func startHealth(t *testing.T, probes sim.Probes) *sim.HealthServer {
	t.Helper()

	server, err := sim.NewHealthServer(0, probes, nil)
	require.NoError(t, err)
	require.NoError(t, server.Start())
	t.Cleanup(func() {
		// The test's own context is already cancelled by the time a cleanup
		// runs, so the shutdown gets a fresh deadline of its own.
		ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
		defer cancel()
		assert.NoError(t, server.Shutdown(ctx))
	})
	return server
}

// get performs a GET against the endpoint and returns the status and the body.
func get(t *testing.T, server *sim.HealthServer, path string) (int, string) {
	t.Helper()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
		"http://"+server.Addr()+path, nil)
	require.NoError(t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { assert.NoError(t, resp.Body.Close()) }()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, string(body)
}

// readyProbes are the three conditions plus a snapshot of a playing machine.
func readyProbes(snap sim.Snapshot) sim.Probes {
	return sim.Probes{
		CSVIndexed:      always(true),
		ModbusListening: always(true),
		MQTTConnected:   always(true),
		Snapshot:        func() sim.Snapshot { return snap },
	}
}

func TestHealthzIsReadyWhenTheThreeConditionsHold(t *testing.T) {
	t.Parallel()

	server := startHealth(t, readyProbes(sim.Snapshot{
		State:   sim.StatePlaying,
		Speed:   600,
		SimTsMs: 1_580_515_200_000,
		HeadSeq: 4711,
	}))

	status, body := get(t, server, sim.HealthPath)
	assert.Equal(t, http.StatusOK, status)

	var doc map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &doc))
	assert.Equal(t, true, doc["ok"])
	assert.Equal(t, true, doc["csv_indexed"])
	assert.Equal(t, true, doc["modbus_listening"])
	assert.Equal(t, true, doc["mqtt_connected"])
	assert.Equal(t, "playing", doc["state"])
	assert.InDelta(t, 600.0, doc["speed"], 0)
	assert.Equal(t, "2020-02-01T00:00:00.000Z", doc["sim_ts"])
	assert.InDelta(t, 4711.0, doc["head_seq"], 0)
}

func TestHealthzIsUnavailableWhileAnyConditionIsMissing(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		probes sim.Probes
		field  string
	}{
		{
			"the CSV is still being indexed",
			sim.Probes{CSVIndexed: always(false), ModbusListening: always(true), MQTTConnected: always(true)},
			"csv_indexed",
		},
		{
			"the Modbus listener is down",
			sim.Probes{CSVIndexed: always(true), ModbusListening: always(false), MQTTConnected: always(true)},
			"modbus_listening",
		},
		{
			"the broker session is down",
			sim.Probes{CSVIndexed: always(true), ModbusListening: always(true), MQTTConnected: always(false)},
			"mqtt_connected",
		},
		{
			"a probe was never wired",
			sim.Probes{CSVIndexed: always(true), ModbusListening: always(true)},
			"mqtt_connected",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			server := startHealth(t, tc.probes)

			status, body := get(t, server, sim.HealthPath)
			assert.Equal(t, http.StatusServiceUnavailable, status)

			var doc map[string]any
			require.NoError(t, json.Unmarshal([]byte(body), &doc))
			assert.Equal(t, false, doc["ok"])
			assert.Equal(t, false, doc[tc.field], "the body says which condition is missing")

			status, statusBody := get(t, server, sim.StatusPath)
			assert.Equal(t, http.StatusOK, status, "/status answers whatever the readiness is")
			assert.JSONEq(t, body, statusBody)
		})
	}
}

// TestHealthBodiesCarryNoGroundTruth is the no-leak assertion of the health
// routes: the health port is not a ground-truth channel, so neither document
// mentions an injection even while one is running (ground-truth isolation).
func TestHealthBodiesCarryNoGroundTruth(t *testing.T) {
	t.Parallel()

	server := startHealth(t, readyProbes(sim.Snapshot{
		State:   sim.StatePlaying,
		Speed:   3600,
		SimTsMs: 1_580_515_200_000,
		HeadSeq: 1201,
		Injections: []injection.InstanceInfo{{
			InstanceID:     "inj-a1b2c3-1",
			InjectionID:    "oil_cooler_fouling",
			FaultID:        "oil_cooler_fouled",
			StartedSimTsMs: 1_580_515_200_000,
			EndsSimTsMs:    1_580_551_200_000,
			Params:         map[string]float64{"magnitude": 1},
		}},
	}))

	forbidden := []string{"inject", "fault_id", "instance_id", "preset"}
	for _, path := range []string{sim.HealthPath, sim.StatusPath} {
		_, body := get(t, server, path)
		lower := strings.ToLower(body)
		for _, word := range forbidden {
			assert.NotContains(t, lower, word,
				"%s must not mention %q: %s", path, word, body)
		}
		assert.Contains(t, body, `"head_seq":1201`, "it still reports the replay state")
	}
}

func TestHealthServerRejectsAnImpossiblePort(t *testing.T) {
	t.Parallel()

	_, err := sim.NewHealthServer(70000, sim.Probes{}, nil)
	assert.ErrorContains(t, err, "70000")

	server, err := sim.NewHealthServer(0, sim.Probes{}, nil)
	require.NoError(t, err)
	assert.Empty(t, server.Addr(), "nothing is bound before Start")
	assert.NoError(t, server.Shutdown(t.Context()), "shutting down an unstarted server is harmless")
}

// TestProbeHealth is what `modbus-sim probe` runs: exit 0 against a ready
// instance, exit 1 when nothing listens or the instance is not ready.
func TestProbeHealth(t *testing.T) {
	t.Parallel()

	ready := startHealth(t, readyProbes(sim.Snapshot{State: sim.StatePaused}))
	port := portOf(t, ready.Addr())
	assert.NoError(t, sim.ProbeHealth(t.Context(), port, probeTimeout))

	unready := startHealth(t, sim.Probes{
		CSVIndexed: always(false), ModbusListening: always(true), MQTTConnected: always(true),
	})
	err := sim.ProbeHealth(t.Context(), portOf(t, unready.Addr()), probeTimeout)
	assert.ErrorContains(t, err, "503")

	require.NoError(t, ready.Shutdown(t.Context()))
	assert.Error(t, sim.ProbeHealth(t.Context(), port, probeTimeout),
		"the probe fails when nothing listens")
}

// portOf returns the port of a host:port address.
func portOf(t *testing.T, addr string) int {
	t.Helper()

	i := strings.LastIndex(addr, ":")
	require.Positive(t, i, "the address %q carries a port", addr)

	port := 0
	for _, c := range addr[i+1:] {
		require.True(t, c >= '0' && c <= '9', "the port of %q is numeric", addr)
		port = port*10 + int(c-'0')
	}
	return port
}
