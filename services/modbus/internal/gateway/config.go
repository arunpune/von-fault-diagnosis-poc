// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// Environment variables of the gateway (docs/simulation.md). Everything has a
// default, so the binary starts inside Compose without an .env file.
const (
	// EnvModbusAddr is the "host:port" of the simulator's Modbus listener.
	EnvModbusAddr = "MODBUS_ADDR"
	// EnvModbusTimeoutMs bounds one Modbus request.
	EnvModbusTimeoutMs = "MODBUS_TIMEOUT_MS"
	// EnvPollIntervalMs is the idle sleep between two poll cycles.
	EnvPollIntervalMs = "POLL_INTERVAL_MS"
	// EnvMaxBatch is the number of samples in one telemetry message.
	EnvMaxBatch = "GATEWAY_MAX_BATCH"
	// EnvStatusIntervalS is the heartbeat period.
	EnvStatusIntervalS = "GATEWAY_STATUS_INTERVAL_S"
	// EnvHTTPPort is the port /healthz listens on.
	EnvHTTPPort = "GATEWAY_HTTP_PORT"
	// EnvMQTTURL is the broker URL.
	EnvMQTTURL = "MQTT_URL"
	// EnvMQTTPassword is the password of the fixed MQTTUsername credential.
	EnvMQTTPassword = "MQTT_GATEWAY_PASSWORD"
	// EnvUnitID is the topic segment and envelope field of the machine.
	EnvUnitID = "UNIT_ID"
	// EnvLogLevel selects the slog level.
	EnvLogLevel = "LOG_LEVEL"
)

// Defaults of the environment table.
const (
	// DefaultModbusAddr is the Compose service name of the simulator.
	DefaultModbusAddr = "modbus-sim:5020"
	// DefaultModbusTimeout bounds one Modbus request.
	DefaultModbusTimeout = 1000 * time.Millisecond
	// DefaultPollInterval is the idle sleep between two polls.
	DefaultPollInterval = 50 * time.Millisecond
	// DefaultMaxBatch is the schema maximum of telemetry-samples.
	DefaultMaxBatch = 25
	// DefaultStatusInterval is the heartbeat period.
	DefaultStatusInterval = 5 * time.Second
	// DefaultHTTPPort is the health port.
	DefaultHTTPPort = 8082
	// DefaultMQTTURL is the Compose broker.
	DefaultMQTTURL = "mqtt://mqtt:1883"
	// DefaultLogLevel is the slog level used when LOG_LEVEL is unset.
	DefaultLogLevel = "info"
)

// MQTTUsername is the broker credential the gateway always connects with; the
// ACL of infra/mosquitto grants it plant/+/telemetry/# and plant/+/status/
// gateway and no ground-truth topic at all.
const MQTTUsername = "gateway"

// MaxBatchLimit is the largest batch the telemetry-samples schema accepts.
const MaxBatchLimit = 25

// Config is the gateway's runtime configuration.
type Config struct {
	// ModbusAddr is the "host:port" of the simulator.
	ModbusAddr string
	// ModbusTimeout bounds one Modbus request.
	ModbusTimeout time.Duration
	// PollInterval is how long the poll loop sleeps once it has caught up.
	PollInterval time.Duration
	// MaxBatch is the number of samples in one telemetry message, 1..25.
	MaxBatch int
	// StatusInterval is the heartbeat period.
	StatusInterval time.Duration
	// HTTPPort is the port /healthz listens on.
	HTTPPort int
	// MQTTURL is the broker URL.
	MQTTURL string
	// MQTTPassword is the password of MQTTUsername; it is never logged.
	MQTTPassword string
	// UnitID is the machine's topic segment and envelope field.
	UnitID string
	// LogLevel is the slog level: debug, info, warn or error.
	LogLevel string
}

// DefaultConfig returns the configuration an empty environment yields, minus
// the broker password, which has no default in code.
func DefaultConfig() Config {
	return Config{
		ModbusAddr:     DefaultModbusAddr,
		ModbusTimeout:  DefaultModbusTimeout,
		PollInterval:   DefaultPollInterval,
		MaxBatch:       DefaultMaxBatch,
		StatusInterval: DefaultStatusInterval,
		HTTPPort:       DefaultHTTPPort,
		MQTTURL:        DefaultMQTTURL,
		UnitID:         mqttio.DefaultUnitID,
		LogLevel:       DefaultLogLevel,
	}
}

// LoadConfig reads the configuration from the process environment, falling
// back to DefaultConfig for every variable that is unset or empty. An
// unparsable or out-of-range value is an error: starting with a silently
// substituted default would hide a typo in a Compose file.
func LoadConfig() (Config, error) {
	cfg := DefaultConfig()
	var err error

	cfg.ModbusAddr = envString(EnvModbusAddr, cfg.ModbusAddr)
	if cfg.ModbusTimeout, err = envDuration(EnvModbusTimeoutMs, time.Millisecond, cfg.ModbusTimeout); err != nil {
		return Config{}, err
	}
	if cfg.PollInterval, err = envDuration(EnvPollIntervalMs, time.Millisecond, cfg.PollInterval); err != nil {
		return Config{}, err
	}
	if cfg.MaxBatch, err = envInt(EnvMaxBatch, cfg.MaxBatch); err != nil {
		return Config{}, err
	}
	if cfg.StatusInterval, err = envDuration(EnvStatusIntervalS, time.Second, cfg.StatusInterval); err != nil {
		return Config{}, err
	}
	if cfg.HTTPPort, err = envInt(EnvHTTPPort, cfg.HTTPPort); err != nil {
		return Config{}, err
	}
	cfg.MQTTURL = envString(EnvMQTTURL, cfg.MQTTURL)
	cfg.MQTTPassword = envString(EnvMQTTPassword, cfg.MQTTPassword)
	cfg.UnitID = envString(EnvUnitID, cfg.UnitID)
	cfg.LogLevel = envString(EnvLogLevel, cfg.LogLevel)

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate reports the first configuration value that cannot work.
func (c Config) Validate() error {
	switch {
	case c.ModbusAddr == "":
		return fmt.Errorf("gateway: %s must not be empty", EnvModbusAddr)
	case c.ModbusTimeout <= 0:
		return fmt.Errorf("gateway: %s must be positive", EnvModbusTimeoutMs)
	case c.PollInterval <= 0:
		return fmt.Errorf("gateway: %s must be positive", EnvPollIntervalMs)
	case c.MaxBatch < 1 || c.MaxBatch > MaxBatchLimit:
		return fmt.Errorf("gateway: %s must be between 1 and %d, the maximum of the telemetry-samples schema",
			EnvMaxBatch, MaxBatchLimit)
	case c.StatusInterval <= 0:
		return fmt.Errorf("gateway: %s must be positive", EnvStatusIntervalS)
	case c.HTTPPort < 0 || c.HTTPPort > 65535:
		return fmt.Errorf("gateway: %s must be a TCP port", EnvHTTPPort)
	case c.MQTTURL == "":
		return fmt.Errorf("gateway: %s must not be empty", EnvMQTTURL)
	case c.UnitID == "":
		return fmt.Errorf("gateway: %s must not be empty", EnvUnitID)
	}
	if _, err := ParseLogLevel(c.LogLevel); err != nil {
		return err
	}
	if _, _, err := c.ModbusHostPort(); err != nil {
		return err
	}
	return nil
}

// ModbusHostPort splits ModbusAddr into the host and port the status message
// reports separately (the status-gateway schema keeps them apart).
func (c Config) ModbusHostPort() (string, int, error) {
	host, rawPort, err := net.SplitHostPort(c.ModbusAddr)
	if err != nil {
		return "", 0, fmt.Errorf("gateway: %s must be \"host:port\", not %q", EnvModbusAddr, c.ModbusAddr)
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("gateway: the port in %s must be a TCP port, not %q", EnvModbusAddr, rawPort)
	}
	if host == "" {
		return "", 0, fmt.Errorf("gateway: %s must name a host, not %q", EnvModbusAddr, c.ModbusAddr)
	}
	return host, port, nil
}

// ParseLogLevel maps LOG_LEVEL onto a slog level.
func ParseLogLevel(name string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		return slog.LevelDebug, nil
	case "", "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("gateway: %s must be debug, info, warn or error, not %q", EnvLogLevel, name)
	}
}

// envString returns the variable's value, or fallback when it is unset or
// empty.
func envString(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

// envInt reads an integer variable.
func envInt(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("gateway: %s must be an integer, not %q", name, raw)
	}
	return v, nil
}

// envDuration reads an integer variable counted in unit, so
// MODBUS_TIMEOUT_MS=1000 becomes a second.
func envDuration(name string, unit, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("gateway: %s must be an integer, not %q", name, raw)
	}
	return time.Duration(v) * unit, nil
}
