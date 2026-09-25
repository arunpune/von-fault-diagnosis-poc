// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The environment table of the gateway (docs/simulation.md).

package gateway_test

import (
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
)

// TestLoadConfigDefaults: an empty environment yields exactly the table of
// defaults, so a container starts inside Compose without an .env file.
func TestLoadConfigDefaults(t *testing.T) {
	for _, name := range []string{
		gateway.EnvModbusAddr, gateway.EnvModbusTimeoutMs, gateway.EnvPollIntervalMs,
		gateway.EnvMaxBatch, gateway.EnvStatusIntervalS, gateway.EnvHTTPPort,
		gateway.EnvMQTTURL, gateway.EnvMQTTPassword, gateway.EnvUnitID, gateway.EnvLogLevel,
	} {
		t.Setenv(name, "")
	}

	cfg, err := gateway.LoadConfig()
	require.NoError(t, err)

	assert.Equal(t, "modbus-sim:5020", cfg.ModbusAddr)
	assert.Equal(t, time.Second, cfg.ModbusTimeout)
	assert.Equal(t, 50*time.Millisecond, cfg.PollInterval)
	assert.Equal(t, 25, cfg.MaxBatch)
	assert.Equal(t, 5*time.Second, cfg.StatusInterval)
	assert.Equal(t, 8082, cfg.HTTPPort)
	assert.Equal(t, "mqtt://mqtt:1883", cfg.MQTTURL)
	assert.Equal(t, "cau-7", cfg.UnitID)
	assert.Equal(t, "info", cfg.LogLevel)
	assert.Equal(t, gateway.DefaultConfig(), cfg)
}

// TestLoadConfigReadsTheEnvironment: the millisecond and second variables are
// counted in their own unit, as the environment table writes them.
func TestLoadConfigReadsTheEnvironment(t *testing.T) {
	t.Setenv(gateway.EnvModbusAddr, "127.0.0.1:15020")
	t.Setenv(gateway.EnvModbusTimeoutMs, "250")
	t.Setenv(gateway.EnvPollIntervalMs, "10")
	t.Setenv(gateway.EnvMaxBatch, "5")
	t.Setenv(gateway.EnvStatusIntervalS, "2")
	t.Setenv(gateway.EnvHTTPPort, "19082")
	t.Setenv(gateway.EnvMQTTURL, "mqtt://127.0.0.1:1884")
	t.Setenv(gateway.EnvUnitID, "cau-9")
	t.Setenv(gateway.EnvLogLevel, "debug")

	cfg, err := gateway.LoadConfig()
	require.NoError(t, err)

	assert.Equal(t, "127.0.0.1:15020", cfg.ModbusAddr)
	assert.Equal(t, 250*time.Millisecond, cfg.ModbusTimeout)
	assert.Equal(t, 10*time.Millisecond, cfg.PollInterval)
	assert.Equal(t, 5, cfg.MaxBatch)
	assert.Equal(t, 2*time.Second, cfg.StatusInterval)
	assert.Equal(t, 19082, cfg.HTTPPort)
	assert.Equal(t, "mqtt://127.0.0.1:1884", cfg.MQTTURL)
	assert.Equal(t, "cau-9", cfg.UnitID)

	host, port, err := cfg.ModbusHostPort()
	require.NoError(t, err)
	assert.Equal(t, "127.0.0.1", host)
	assert.Equal(t, 15020, port)
}

// TestLoadConfigRejectsBadValues: a typo in a Compose file is an error at
// startup, not a silently substituted default.
func TestLoadConfigRejectsBadValues(t *testing.T) {
	cases := []struct {
		name  string
		env   string
		value string
	}{
		{"a non-numeric timeout", gateway.EnvModbusTimeoutMs, "one second"},
		{"a zero poll interval", gateway.EnvPollIntervalMs, "0"},
		{"a batch beyond the schema maximum", gateway.EnvMaxBatch, "26"},
		{"an empty batch", gateway.EnvMaxBatch, "0"},
		{"a zero status interval", gateway.EnvStatusIntervalS, "0"},
		{"a port outside the range", gateway.EnvHTTPPort, "70000"},
		{"an address without a port", gateway.EnvModbusAddr, "modbus-sim"},
		{"an address with a named port", gateway.EnvModbusAddr, "modbus-sim:modbus"},
		{"an unknown log level", gateway.EnvLogLevel, "chatty"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.env, tc.value)

			_, err := gateway.LoadConfig()
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.env, "the error names the variable to fix")
		})
	}
}

// TestParseLogLevel covers the levels the environment allows.
func TestParseLogLevel(t *testing.T) {
	t.Parallel()

	cases := map[string]slog.Level{
		"debug":   slog.LevelDebug,
		"info":    slog.LevelInfo,
		"":        slog.LevelInfo,
		"warn":    slog.LevelWarn,
		"WARNING": slog.LevelWarn,
		"error":   slog.LevelError,
	}
	for name, want := range cases {
		level, err := gateway.ParseLogLevel(name)
		require.NoError(t, err, "level %q", name)
		assert.Equal(t, want, level, "level %q", name)
	}

	_, err := gateway.ParseLogLevel("verbose")
	require.Error(t, err)
}
