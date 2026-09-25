// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"
)

// HealthPath is the only route the gateway serves.
const HealthPath = "/healthz"

// HeaderFreshness is how old the last successful header read may be before the
// gateway calls itself unhealthy. It is six poll intervals at the default 50
// ms, so a single slow cycle never flips the probe.
const HeaderFreshness = 5 * time.Second

// healthTimeout bounds reading and writing one probe request.
const healthTimeout = 5 * time.Second

// healthBody is what /healthz answers. It carries connectivity and freshness
// and nothing about the data: the gateway has no opinion about the machine
// (ground-truth isolation).
type healthBody struct {
	Status          string `json:"status"`
	ModbusConnected bool   `json:"modbus_connected"`
	MQTTConnected   bool   `json:"mqtt_connected"`
	LastHeaderAgeMs int64  `json:"last_header_age_ms"`
	Reason          string `json:"reason,omitempty"`
}

// Healthy reports whether snap describes a working gateway at now: both links
// are up and the last header read is younger than HeaderFreshness. The second
// return value is the English reason it is not, empty when it is.
func Healthy(snap Snapshot, now time.Time) (bool, string) {
	switch {
	case !snap.ModbusConnected:
		return false, "the Modbus connection is down"
	case !snap.MQTTConnected:
		return false, "the MQTT connection is down"
	case snap.LastHeaderRead.IsZero():
		return false, "no header has been read yet"
	case now.Sub(snap.LastHeaderRead) >= HeaderFreshness:
		return false, fmt.Sprintf("the last header read is %s old, more than the %s a healthy gateway allows",
			now.Sub(snap.LastHeaderRead).Round(time.Millisecond), HeaderFreshness)
	}
	return true, ""
}

// HealthHandler serves HealthPath from the snapshot function, answering 200
// when Healthy and 503 otherwise.
func HealthHandler(snapshot func() Snapshot, clock Clock) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+HealthPath, func(w http.ResponseWriter, _ *http.Request) {
		snap := snapshot()
		now := clock.Now()
		ok, reason := Healthy(snap, now)

		body := healthBody{
			Status:          "ok",
			ModbusConnected: snap.ModbusConnected,
			MQTTConnected:   snap.MQTTConnected,
			Reason:          reason,
		}
		if !snap.LastHeaderRead.IsZero() {
			body.LastHeaderAgeMs = now.Sub(snap.LastHeaderRead).Milliseconds()
		}
		status := http.StatusOK
		if !ok {
			body.Status, status = "unhealthy", http.StatusServiceUnavailable
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if err := json.NewEncoder(w).Encode(body); err != nil {
			slog.Default().Warn("writing the health response failed", slog.Any("error", err))
		}
	})
	return mux
}

// HealthServer is the HTTP server of HealthPath, already listening.
type HealthServer struct {
	listener net.Listener
	server   *http.Server
	done     chan struct{}
}

// StartHealthServer listens on 127.0.0.1-agnostic addr (":"+port) and serves
// the handler until Close. Binding happens here rather than in the goroutine,
// so a port already in use is an error the caller sees at startup.
func StartHealthServer(addr string, handler http.Handler) (*HealthServer, error) {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("gateway: listening for health probes on %s: %w", addr, err)
	}

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: healthTimeout,
		WriteTimeout:      healthTimeout,
	}
	h := &HealthServer{listener: listener, server: server, done: make(chan struct{})}

	go func() {
		defer close(h.done)
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Default().Error("the health server stopped", slog.Any("error", err))
		}
	}()
	return h, nil
}

// Addr is the address the server listens on, with the port the kernel picked
// when addr named port 0.
func (h *HealthServer) Addr() string { return h.listener.Addr().String() }

// Close shuts the server down and waits for it to stop serving.
func (h *HealthServer) Close(ctx context.Context) error {
	err := h.server.Shutdown(ctx)
	<-h.done
	if err != nil {
		return fmt.Errorf("gateway: shutting the health server down: %w", err)
	}
	return nil
}

// Probe performs the readiness check of the `gateway probe` subcommand: a GET
// of HealthPath on the loopback interface. It returns nil only on 200.
func Probe(ctx context.Context, port int) error {
	url := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + HealthPath

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("gateway: building the probe request for %s: %w", url, err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("gateway: probing %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway: %s answered %s", url, resp.Status)
	}
	return nil
}
