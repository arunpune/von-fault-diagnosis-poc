// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// env turns a map into a Getenv; an absent key reads as empty, the way the
// process environment does.
func env(vars map[string]string) sim.Getenv {
	return func(name string) string { return vars[name] }
}

func TestLoadConfigDefaultsToTheComposeEnvironment(t *testing.T) {
	t.Parallel()

	cfg, err := sim.LoadConfig(env(nil))
	require.NoError(t, err)

	assert.Equal(t, sim.DefaultCSVPath, cfg.CSVPath)
	assert.Equal(t, uint16(sim.DefaultSpeed), cfg.Speed)
	assert.Equal(t, sim.DefaultModbusBind, cfg.ModbusBind)
	assert.Equal(t, sim.DefaultModbusPort, cfg.ModbusPort)
	assert.Equal(t, sim.DefaultHTTPPort, cfg.HTTPPort)
	assert.False(t, cfg.Autoplay, "the machine boots paused")
	assert.True(t, cfg.Loop, "the replay wraps at the end of data")
	assert.Equal(t, sim.DefaultGTDir, cfg.GTDir)
	assert.Equal(t, sim.DefaultMQTTURL, cfg.MQTTURL)
	assert.Equal(t, sim.DefaultUnitID, cfg.UnitID)
	assert.Equal(t, uint(sim.DefaultMaxClients), cfg.MaxClients)
	assert.Equal(t, slog.LevelInfo, cfg.LogLevel)
	assert.Empty(t, cfg.Presets, "LoadConfig reads no file")
}

func TestLoadConfigReadsTheEnvironmentTable(t *testing.T) {
	t.Parallel()

	cfg, err := sim.LoadConfig(env(map[string]string{
		sim.EnvCSVPath:      "/data/fixtures/metropt3/ci-slice.csv",
		sim.EnvSpeed:        "3600",
		sim.EnvModbusBind:   "127.0.0.1",
		sim.EnvModbusPort:   "0",
		sim.EnvHTTPPort:     "9099",
		sim.EnvAutoplay:     "true",
		sim.EnvLoop:         "false",
		sim.EnvGTDir:        "/gt",
		sim.EnvMQTTURL:      "mqtt://broker:1883",
		sim.EnvMQTTPassword: "a-poc-default",
		sim.EnvUnitID:       "cau-7",
		sim.EnvMaxClients:   "9",
		sim.EnvLogLevel:     "debug",
	}))
	require.NoError(t, err)

	assert.Equal(t, "/data/fixtures/metropt3/ci-slice.csv", cfg.CSVPath)
	assert.Equal(t, uint16(3600), cfg.Speed)
	assert.Equal(t, "127.0.0.1", cfg.ModbusBind)
	assert.Equal(t, 0, cfg.ModbusPort, "port zero is the ephemeral port tests bind")
	assert.Equal(t, 9099, cfg.HTTPPort)
	assert.True(t, cfg.Autoplay)
	assert.False(t, cfg.Loop)
	assert.Equal(t, "mqtt://broker:1883", cfg.MQTTURL)
	assert.Equal(t, uint(9), cfg.MaxClients)
	assert.Equal(t, slog.LevelDebug, cfg.LogLevel)

	assert.Equal(t, filepath.Join("/gt", "presets.json"), cfg.PresetsPath())
	assert.Equal(t, filepath.Join("/gt", "injections.json"), cfg.InjectionsPath())
	assert.Equal(t, filepath.Join("/gt", "metropt3-failures.json"), cfg.FailuresPath())
}

func TestLoadConfigRejectsUnusableValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		vars map[string]string
		want string
	}{
		{"speed below the range", map[string]string{sim.EnvSpeed: "0"}, sim.EnvSpeed},
		{"speed above the range", map[string]string{sim.EnvSpeed: "3601"}, sim.EnvSpeed},
		{"speed is not a number", map[string]string{sim.EnvSpeed: "fast"}, sim.EnvSpeed},
		{"modbus port too large", map[string]string{sim.EnvModbusPort: "70000"}, sim.EnvModbusPort},
		{"negative health port", map[string]string{sim.EnvHTTPPort: "-1"}, sim.EnvHTTPPort},
		{"autoplay is not a boolean", map[string]string{sim.EnvAutoplay: "sometimes"}, sim.EnvAutoplay},
		{"loop is not a boolean", map[string]string{sim.EnvLoop: "maybe"}, sim.EnvLoop},
		{"no client slots", map[string]string{sim.EnvMaxClients: "0"}, sim.EnvMaxClients},
		{"unknown log level", map[string]string{sim.EnvLogLevel: "chatty"}, sim.EnvLogLevel},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := sim.LoadConfig(env(tc.vars))
			require.Error(t, err)
			assert.ErrorContains(t, err, tc.want, "the message names the variable")
		})
	}
}

// TestConfigNeverLogsTheBrokerPassword: no secret reaches a log line, whatever
// the level.
func TestConfigNeverLogsTheBrokerPassword(t *testing.T) {
	t.Parallel()

	const password = "s1m-pa55word-not-in-any-log"
	cfg, err := sim.LoadConfig(env(map[string]string{sim.EnvMQTTPassword: password}))
	require.NoError(t, err)
	require.Equal(t, password, cfg.MQTTPassword, "the value is still available to the client")

	var out strings.Builder
	slog.New(slog.NewJSONHandler(&out, &slog.HandlerOptions{Level: slog.LevelDebug})).
		Info("configuration", slog.Any("config", cfg))

	line := out.String()
	assert.NotContains(t, line, password)
	assert.NotContains(t, strings.ToLower(line), "password")
	assert.Contains(t, line, sim.DefaultMQTTURL, "the rest of the configuration is logged")
}

// writePresets writes a presets document into the test's own directory.
func writePresets(t *testing.T, body string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), sim.PresetsFile)
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	return path
}

func TestLoadPresetsResolvesTheJumpTargets(t *testing.T) {
	t.Parallel()

	presets, err := sim.LoadPresets(testutil.TestdataPath("gt/" + sim.PresetsFile))
	require.NoError(t, err)
	require.NotEmpty(t, presets)

	for _, preset := range presets {
		assert.NotEmpty(t, preset.PresetID)
		assert.Positive(t, preset.SimTsMs, "preset %s resolved its instant", preset.PresetID)
		assert.GreaterOrEqual(t, preset.LeadInMin, 0)
	}

	start, ok := findPreset(presets, "baseline_feb")
	require.True(t, ok)
	assert.Equal(t, uint64(1_580_515_200_000), start.SimTsMs, "2020-02-01T00:00:00Z")
	assert.Equal(t, start.SimTsMs, start.LeadInStartMs(), "a zero lead-in starts at the instant")

	leak, ok := findPreset(presets, "f3_air_leak_jun05")
	require.True(t, ok)
	assert.Equal(t, leak.SimTsMs-uint64(leak.LeadInMin)*60_000, leak.LeadInStartMs())
}

// findPreset returns the preset with this id.
func findPreset(presets []sim.Preset, id string) (sim.Preset, bool) {
	for _, p := range presets {
		if p.PresetID == id {
			return p, true
		}
	}
	return sim.Preset{}, false
}

func TestLoadPresetsRejectsABrokenDocument(t *testing.T) {
	t.Parallel()

	const good = `{"schema":"urn:fdp:schema:gt-presets:v1","presets":[` +
		`{"preset_id":"one","label":"One","sim_ts":"2020-02-01T00:00:00.000Z","lead_in_min":0}]}`

	tests := []struct {
		name string
		body string
		want string
	}{
		{"wrong schema", `{"schema":"urn:fdp:schema:other:v1","presets":[]}`, "schema"},
		{"no presets", `{"schema":"urn:fdp:schema:gt-presets:v1","presets":[]}`, "no preset"},
		{"not json", `{`, "reading"},
		{
			"trailing content", good + `{"schema":"x"}`, "trailing content",
		},
		{
			"missing preset id",
			`{"schema":"urn:fdp:schema:gt-presets:v1","presets":[{"sim_ts":"2020-02-01T00:00:00.000Z"}]}`,
			"preset_id",
		},
		{
			"duplicate preset id",
			`{"schema":"urn:fdp:schema:gt-presets:v1","presets":[` +
				`{"preset_id":"one","sim_ts":"2020-02-01T00:00:00.000Z"},` +
				`{"preset_id":"one","sim_ts":"2020-02-02T00:00:00.000Z"}]}`,
			"declared twice",
		},
		{
			"unparsable instant",
			`{"schema":"urn:fdp:schema:gt-presets:v1","presets":[` +
				`{"preset_id":"one","sim_ts":"the first of February"}]}`,
			"one",
		},
		{
			"negative lead-in",
			`{"schema":"urn:fdp:schema:gt-presets:v1","presets":[` +
				`{"preset_id":"one","sim_ts":"2020-02-01T00:00:00.000Z","lead_in_min":-5}]}`,
			"lead_in_min",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, err := sim.LoadPresets(writePresets(t, tc.body))
			require.Error(t, err)
			assert.ErrorContains(t, err, tc.want)
		})
	}

	_, err := sim.LoadPresets(filepath.Join(t.TempDir(), "absent.json"))
	assert.ErrorContains(t, err, "opening the presets")
}

func TestConfigPresetLookup(t *testing.T) {
	t.Parallel()

	cfg := sim.Config{Presets: []sim.Preset{
		{PresetID: "one", SimTsMs: 2_000_000, LeadInMin: 10},
	}}

	preset, ok := cfg.Preset("one")
	require.True(t, ok)
	assert.Equal(t, uint64(2_000_000-600_000), preset.LeadInStartMs())

	_, ok = cfg.Preset("two")
	assert.False(t, ok)

	// A lead-in longer than the instant itself cannot go below the epoch; the
	// engine clamps it to the dataset start either way.
	deep := sim.Preset{PresetID: "deep", SimTsMs: 1_000, LeadInMin: 10}
	assert.Equal(t, uint64(0), deep.LeadInStartMs())
}
