// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Command gateway is the edge connector: it polls the simulator's holding
// registers, decodes the slots with the generated register map, stamps every
// sample with simulated time and publishes schema-valid telemetry batches.
//
// It computes nothing and knows nothing about the fault overlays (ground-truth
// isolation); internal/arch/imports_test.go holds that boundary.
//
// Subcommands (docs/simulation.md, "The gateway"):
//
//	gateway run     poll and publish until SIGINT or SIGTERM (the default)
//	gateway probe   GET /healthz on the loopback interface; exit 0 when healthy
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// exitFailure is the status of a run that ended in an error and of a probe
// that found the gateway unhealthy; the Compose healthcheck reads it.
const exitFailure = 1

// connectTimeout bounds the first connection to the broker. A broker that is
// still starting is not a reason to exit: the gateway retries.
const connectTimeout = 30 * time.Second

// probeTimeout bounds the health request of the probe subcommand.
const probeTimeout = 5 * time.Second

// shutdownTimeout bounds the orderly shutdown after a signal.
const shutdownTimeout = 10 * time.Second

func main() {
	// Every error of this binary already names the gateway, so it is printed
	// as it is rather than prefixed a second time.
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(exitFailure)
	}
}

// run dispatches the subcommand.
func run(args []string) error {
	command := "run"
	if len(args) != 0 {
		command = args[0]
	}
	switch command {
	case "run":
		return runGateway()
	case "probe":
		return runProbe()
	default:
		return fmt.Errorf("gateway: unknown subcommand %q; use run or probe", command)
	}
}

// runGateway is the long-running mode: configure, connect, serve health and
// poll until a signal arrives.
func runGateway() error {
	cfg, err := gateway.LoadConfig()
	if err != nil {
		return err
	}
	logger, err := newLogger(cfg.LogLevel)
	if err != nil {
		return err
	}
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	connectCtx, cancelConnect := context.WithTimeout(ctx, connectTimeout)
	defer cancelConnect()

	client, err := mqttio.Connect(connectCtx, mqttio.Config{
		URL:      cfg.MQTTURL,
		ClientID: clientID(),
		Username: gateway.MQTTUsername,
		Password: cfg.MQTTPassword,
	}, nil)
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelClose()
		if err := client.Close(closeCtx); err != nil {
			logger.Warn("closing the MQTT connection failed", slog.Any("error", err))
		}
	}()

	service, err := gateway.New(cfg, gateway.NewModbusPoller(cfg.ModbusAddr, cfg.ModbusTimeout), client,
		gateway.Options{Logger: logger})
	if err != nil {
		return err
	}

	health, err := gateway.StartHealthServer(net.JoinHostPort("", strconv.Itoa(cfg.HTTPPort)), service.HealthHandler())
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelClose()
		if err := health.Close(closeCtx); err != nil {
			logger.Warn("closing the health server failed", slog.Any("error", err))
		}
	}()

	logger.Info("gateway started",
		slog.String("modbus_addr", cfg.ModbusAddr),
		slog.String("unit_id", cfg.UnitID),
		slog.String("telemetry_topic", service.TelemetryTopic()),
		slog.String("status_topic", service.StatusTopic()),
		slog.Int("http_port", cfg.HTTPPort))

	if err := service.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	logger.Info("gateway stopped")
	return nil
}

// runProbe is the healthcheck mode of the Compose service.
func runProbe() error {
	cfg, err := gateway.LoadConfig()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	return gateway.Probe(ctx, cfg.HTTPPort)
}

// clientID is the MQTT client identifier, "<service>-<hostname>". A host
// without a name falls back to the process id, which is still unique inside
// one broker.
func clientID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = strconv.Itoa(os.Getpid())
	}
	return "gateway-" + host
}

// newLogger builds the JSON slog handler. Any attribute named "password" is
// replaced before it reaches the output, so a credential cannot be logged by
// accident: secrets come from the environment and never reach a log.
func newLogger(levelName string) (*slog.Logger, error) {
	level, err := gateway.ParseLogLevel(levelName)
	if err != nil {
		return nil, err
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == "password" {
				return slog.String("password", "[redacted]")
			}
			return a
		},
	})), nil
}
