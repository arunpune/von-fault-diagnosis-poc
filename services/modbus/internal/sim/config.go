// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// The environment of modbus-sim (docs/simulation.md, "Configuration of the
// simulator"). Only METROPT_CSV, REPLAY_SPEED, MODBUS_PORT, MQTT_SIM_PASSWORD
// and LOG_LEVEL are user-facing; compose.yaml sets the rest.
const (
	EnvCSVPath      = "METROPT_CSV"
	EnvSpeed        = "REPLAY_SPEED"
	EnvModbusBind   = "MODBUS_BIND"
	EnvModbusPort   = "MODBUS_PORT"
	EnvHTTPPort     = "SIM_HTTP_PORT"
	EnvAutoplay     = "SIM_AUTOPLAY"
	EnvLoop         = "SIM_LOOP"
	EnvGTDir        = "GT_DIR"
	EnvMQTTURL      = "MQTT_URL"
	EnvMQTTPassword = "MQTT_SIM_PASSWORD"
	EnvUnitID       = "UNIT_ID"
	EnvMaxClients   = "MODBUS_MAX_CLIENTS"
	EnvLogLevel     = "LOG_LEVEL"
)

// The defaults of the same table.
const (
	DefaultCSVPath    = "/data/metropt3/MetroPT3(AirCompressor).csv"
	DefaultSpeed      = 600
	DefaultModbusBind = "0.0.0.0"
	DefaultModbusPort = 5020
	DefaultHTTPPort   = 8081
	DefaultGTDir      = "/gt"
	DefaultMQTTURL    = "mqtt://mqtt:1883"
	DefaultUnitID     = "cau-7"
	DefaultMaxClients = 5
	DefaultLogLevel   = "info"
)

// The names of the ground-truth files GT_DIR holds. The injection catalog and
// the presets are read by the machine; the failure list is forwarded to the
// catalog topic untouched.
const (
	PresetsFile    = "presets.json"
	InjectionsFile = "injections.json"
	FailuresFile   = "metropt3-failures.json"
)

// PresetsSchema is the document schema id presets.json carries.
const PresetsSchema = "urn:fdp:schema:gt-presets:v1"

// msPerMinute is the simulated milliseconds in one minute; a preset's lead-in
// is stated in minutes.
const msPerMinute = 60_000

// Preset is one jump target of GT_DIR/presets.json. Only the four fields the
// machine needs are read; everything else in the document belongs to the UI
// and to the evaluation harness and is forwarded opaquely.
type Preset struct {
	PresetID  string `json:"preset_id"`
	Label     string `json:"label"`
	SimTs     string `json:"sim_ts"`
	LeadInMin int    `json:"lead_in_min"`

	// SimTsMs is SimTs as epoch milliseconds, resolved by LoadPresets.
	SimTsMs uint64 `json:"-"`
}

// LeadInStartMs returns the instant a jump to this preset lands on before the
// dataset start is applied: the preset's instant minus its lead-in.
func (p Preset) LeadInStartMs() uint64 {
	lead := uint64(p.LeadInMin) * msPerMinute
	if lead >= p.SimTsMs {
		return 0
	}
	return p.SimTsMs - lead
}

// Config is the parsed environment of modbus-sim plus the presets the caller
// loads from GT_DIR.
type Config struct {
	CSVPath      string
	Speed        uint16
	ModbusBind   string
	ModbusPort   int
	HTTPPort     int
	Autoplay     bool
	Loop         bool
	GTDir        string
	MQTTURL      string
	MQTTPassword string
	UnitID       string
	MaxClients   uint
	LogLevel     slog.Level

	// Logger is the destination of the engine's own messages; nil discards
	// them. LoadConfig never sets it — the binary builds one from LogLevel.
	Logger *slog.Logger

	// Presets are the jump targets the jump command resolves. LoadConfig
	// leaves them empty; the caller fills them with LoadPresets, which keeps
	// the environment parser free of file access.
	Presets []Preset
}

// Preset returns the preset with this id.
func (c Config) Preset(presetID string) (Preset, bool) {
	i := slices.IndexFunc(c.Presets, func(p Preset) bool { return p.PresetID == presetID })
	if i < 0 {
		return Preset{}, false
	}
	return c.Presets[i], true
}

// PresetsPath returns GT_DIR/presets.json.
func (c Config) PresetsPath() string { return filepath.Join(c.GTDir, PresetsFile) }

// InjectionsPath returns GT_DIR/injections.json.
func (c Config) InjectionsPath() string { return filepath.Join(c.GTDir, InjectionsFile) }

// FailuresPath returns GT_DIR/metropt3-failures.json.
func (c Config) FailuresPath() string { return filepath.Join(c.GTDir, FailuresFile) }

// logger returns the configured logger, or one that discards.
func (c Config) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.New(slog.DiscardHandler)
}

// LogValue renders the configuration for a log line with the broker password
// left out: no secret is ever logged.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("csv_path", c.CSVPath),
		slog.Int("speed", int(c.Speed)),
		slog.String("modbus_bind", c.ModbusBind),
		slog.Int("modbus_port", c.ModbusPort),
		slog.Int("http_port", c.HTTPPort),
		slog.Bool("autoplay", c.Autoplay),
		slog.Bool("loop", c.Loop),
		slog.String("gt_dir", c.GTDir),
		slog.String("mqtt_url", c.MQTTURL),
		slog.String("unit_id", c.UnitID),
		slog.Int("max_clients", int(c.MaxClients)),
		slog.String("log_level", c.LogLevel.String()),
		slog.Int("presets", len(c.Presets)),
	)
}

// Getenv reads one environment variable; os.Getenv satisfies it and a test
// passes a map lookup instead.
type Getenv func(string) string

// LoadConfig parses the environment table of the simulator.
//
// Every variable has a default, so an empty environment yields the Compose
// configuration. A value that is present but unusable — a speed outside
// 1…3600, a port outside 0…65535, a level slog does not know — is an error
// that names the variable; an empty value takes the default.
func LoadConfig(getenv Getenv) (Config, error) {
	cfg := Config{
		CSVPath:      stringOr(getenv, EnvCSVPath, DefaultCSVPath),
		ModbusBind:   stringOr(getenv, EnvModbusBind, DefaultModbusBind),
		GTDir:        stringOr(getenv, EnvGTDir, DefaultGTDir),
		MQTTURL:      stringOr(getenv, EnvMQTTURL, DefaultMQTTURL),
		MQTTPassword: getenv(EnvMQTTPassword),
		UnitID:       stringOr(getenv, EnvUnitID, DefaultUnitID),
	}

	speed, err := intOr(getenv, EnvSpeed, DefaultSpeed)
	if err != nil {
		return Config{}, err
	}
	if speed < int(MinSpeed) || speed > int(MaxSpeed) {
		return Config{}, fmt.Errorf("sim: %s is %d, outside %d..%d",
			EnvSpeed, speed, MinSpeed, MaxSpeed)
	}
	cfg.Speed = uint16(speed)

	if cfg.ModbusPort, err = portOr(getenv, EnvModbusPort, DefaultModbusPort); err != nil {
		return Config{}, err
	}
	if cfg.HTTPPort, err = portOr(getenv, EnvHTTPPort, DefaultHTTPPort); err != nil {
		return Config{}, err
	}
	if cfg.Autoplay, err = boolOr(getenv, EnvAutoplay, false); err != nil {
		return Config{}, err
	}
	if cfg.Loop, err = boolOr(getenv, EnvLoop, true); err != nil {
		return Config{}, err
	}

	clients, err := intOr(getenv, EnvMaxClients, DefaultMaxClients)
	if err != nil {
		return Config{}, err
	}
	if clients < 1 {
		return Config{}, fmt.Errorf("sim: %s is %d; the listener needs at least one client slot",
			EnvMaxClients, clients)
	}
	cfg.MaxClients = uint(clients)

	if cfg.LogLevel, err = levelOr(getenv, EnvLogLevel, DefaultLogLevel); err != nil {
		return Config{}, err
	}
	if cfg.CSVPath == "" {
		return Config{}, fmt.Errorf("sim: %s is empty", EnvCSVPath)
	}
	if cfg.UnitID == "" {
		return Config{}, fmt.Errorf("sim: %s is empty", EnvUnitID)
	}
	return cfg, nil
}

// stringOr returns the variable, or fallback when it is unset or empty.
func stringOr(getenv Getenv, name, fallback string) string {
	if v := strings.TrimSpace(getenv(name)); v != "" {
		return v
	}
	return fallback
}

// intOr parses an integer variable.
func intOr(getenv Getenv, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("sim: %s is %q, not a whole number", name, raw)
	}
	return v, nil
}

// portOr parses a TCP port; zero means "let the operating system choose".
func portOr(getenv Getenv, name string, fallback int) (int, error) {
	port, err := intOr(getenv, name, fallback)
	if err != nil {
		return 0, err
	}
	if port < 0 || port > 65535 {
		return 0, fmt.Errorf("sim: %s is %d, outside 0..65535", name, port)
	}
	return port, nil
}

// boolOr parses a boolean variable the way Compose writes them.
func boolOr(getenv Getenv, name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("sim: %s is %q, not a boolean", name, raw)
	}
	return v, nil
}

// levelOr parses a slog level name.
func levelOr(getenv Getenv, name, fallback string) (slog.Level, error) {
	raw := stringOr(getenv, name, fallback)
	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return 0, fmt.Errorf("sim: %s is %q, not one of debug, info, warn or error", name, raw)
	}
	return level, nil
}

// presetDocument is the shape of GT_DIR/presets.json. Unknown fields are kept
// out of the Go types on purpose: packages/ground-truth owns the document and
// adds to it, and the machine only needs the jump targets.
type presetDocument struct {
	Schema  string   `json:"schema"`
	Presets []Preset `json:"presets"`
}

// LoadPresets reads the jump targets of GT_DIR/presets.json and resolves every
// sim_ts into epoch milliseconds.
//
// A document with the wrong schema, a duplicate preset id, an unparsable
// instant or a negative lead-in is an error that names the preset: a jump the
// UI offers must land where the ground truth says it does.
func LoadPresets(path string) ([]Preset, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("sim: opening the presets: %w", err)
	}
	defer func() { _ = file.Close() }()

	dec := json.NewDecoder(file)
	var doc presetDocument
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("sim: reading %s: %w", path, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("sim: %s has trailing content after the document", path)
	}
	if doc.Schema != PresetsSchema {
		return nil, fmt.Errorf("sim: %s declares the schema %q, not %q",
			path, doc.Schema, PresetsSchema)
	}
	if len(doc.Presets) == 0 {
		return nil, fmt.Errorf("sim: %s offers no preset", path)
	}

	seen := make(map[string]struct{}, len(doc.Presets))
	for i := range doc.Presets {
		preset := &doc.Presets[i]
		if preset.PresetID == "" {
			return nil, fmt.Errorf("sim: %s: presets[%d] has no preset_id", path, i)
		}
		if _, dup := seen[preset.PresetID]; dup {
			return nil, fmt.Errorf("sim: %s: the preset %q is declared twice", path, preset.PresetID)
		}
		seen[preset.PresetID] = struct{}{}

		if preset.LeadInMin < 0 {
			return nil, fmt.Errorf("sim: %s: the preset %q has the negative lead_in_min %d",
				path, preset.PresetID, preset.LeadInMin)
		}
		ms, err := mqttio.ParseTS(preset.SimTs)
		if err != nil {
			return nil, fmt.Errorf("sim: %s: the preset %q: %w", path, preset.PresetID, err)
		}
		preset.SimTsMs = ms
	}
	return doc.Presets, nil
}
