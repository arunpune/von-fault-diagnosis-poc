// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

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

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// The two health routes of the simulator.
const (
	// HealthPath is 200 when the machine is ready and 503 otherwise.
	HealthPath = "/healthz"
	// StatusPath carries the same body with a 200 whatever the state, so an
	// operator can see which of the three readiness conditions is missing.
	StatusPath = "/status"
)

// healthTimeouts keep a stuck client from holding a connection. The handler
// does no I/O of its own, so the budgets only have to cover the network.
const (
	healthReadHeaderTimeout = 5 * time.Second
	healthWriteTimeout      = 5 * time.Second
	healthShutdownTimeout   = 2 * time.Second
)

// Probes are the readiness conditions and the state the health documents
// report. Every function is called on each request and must not block.
type Probes struct {
	// CSVIndexed reports whether the replay source has been indexed; the boot
	// pass over the CSV holds it false for about a second.
	CSVIndexed func() bool
	// ModbusListening reports whether the register listener is open.
	ModbusListening func() bool
	// MQTTConnected reports whether the broker session is up; the binary wires
	// it to ControlPlane.Connected. Without a control plane the user interface
	// cannot drive the machine, so a simulator that has not reached the broker
	// is not ready.
	MQTTConnected func() bool
	// Snapshot returns the replay state. A nil Snapshot reports the zero one.
	Snapshot func() Snapshot
}

// healthBody is the document both routes return. It carries the replay state
// and nothing about fault injection: the health port is not a ground-truth
// channel.
type healthBody struct {
	OK              bool   `json:"ok"`
	CSVIndexed      bool   `json:"csv_indexed"`
	ModbusListening bool   `json:"modbus_listening"`
	MQTTConnected   bool   `json:"mqtt_connected"`
	State           string `json:"state"`
	Speed           uint16 `json:"speed"`
	SimTs           string `json:"sim_ts"`
	HeadSeq         uint32 `json:"head_seq"`
}

// HealthServer serves /healthz and /status on SIM_HTTP_PORT.
type HealthServer struct {
	probes Probes
	log    *slog.Logger
	srv    *http.Server
	ln     net.Listener
	port   int
}

// NewHealthServer returns the health endpoint for port, which may be zero so
// a test binds an ephemeral one and reads it back from Addr.
func NewHealthServer(port int, probes Probes, log *slog.Logger) (*HealthServer, error) {
	if port < 0 || port > 65535 {
		return nil, fmt.Errorf("sim: health port %d is outside 0..65535", port)
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}

	h := &HealthServer{probes: probes, log: log, port: port}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+HealthPath, h.serveHealthz)
	mux.HandleFunc("GET "+StatusPath, h.serveStatus)
	h.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: healthReadHeaderTimeout,
		WriteTimeout:      healthWriteTimeout,
		ErrorLog:          nil,
	}
	return h, nil
}

// Start binds the listener and serves in the background.
func (h *HealthServer) Start() error {
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(h.port)))
	if err != nil {
		return fmt.Errorf("sim: listening for health requests on port %d: %w", h.port, err)
	}
	h.ln = ln

	go func() {
		if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.log.Error("the health endpoint stopped", slog.String("error", err.Error()))
		}
	}()
	return nil
}

// Addr returns the bound address, empty before Start.
func (h *HealthServer) Addr() string {
	if h.ln == nil {
		return ""
	}
	return h.ln.Addr().String()
}

// Shutdown closes the endpoint.
func (h *HealthServer) Shutdown(ctx context.Context) error {
	if h.ln == nil {
		return nil
	}
	if err := h.srv.Shutdown(ctx); err != nil {
		return fmt.Errorf("sim: shutting down the health endpoint: %w", err)
	}
	return nil
}

// serveHealthz answers 200 when the three readiness conditions hold and 503
// otherwise, with the same body either way.
func (h *HealthServer) serveHealthz(w http.ResponseWriter, _ *http.Request) {
	body := h.body()
	status := http.StatusOK
	if !body.OK {
		status = http.StatusServiceUnavailable
	}
	h.write(w, status, body)
}

// serveStatus answers 200 whatever the readiness is.
func (h *HealthServer) serveStatus(w http.ResponseWriter, _ *http.Request) {
	h.write(w, http.StatusOK, h.body())
}

// body reads the probes once.
func (h *HealthServer) body() healthBody {
	body := healthBody{
		CSVIndexed:      probe(h.probes.CSVIndexed),
		ModbusListening: probe(h.probes.ModbusListening),
		MQTTConnected:   probe(h.probes.MQTTConnected),
	}
	body.OK = body.CSVIndexed && body.ModbusListening && body.MQTTConnected

	var snap Snapshot
	if h.probes.Snapshot != nil {
		snap = h.probes.Snapshot()
	}
	body.State = snap.State.String()
	body.Speed = snap.Speed
	body.SimTs = mqttio.SimTS(snap.SimTsMs)
	body.HeadSeq = snap.HeadSeq
	return body
}

// probe reads one readiness function; a missing one reports false, so a
// half-wired binary is unhealthy rather than silently ready.
func probe(f func() bool) bool { return f != nil && f() }

// write renders the document.
func (h *HealthServer) write(w http.ResponseWriter, status int, body healthBody) {
	payload, err := json.Marshal(body)
	if err != nil {
		h.log.Error("rendering the health body", slog.String("error", err.Error()))
		http.Error(w, `{"ok":false}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(payload); err != nil {
		h.log.Debug("the health client went away", slog.String("error", err.Error()))
	}
}

// ProbeHealth performs the GET that `modbus-sim probe` runs against a local
// instance and reports whether it answered 200 (the distroless image has no
// curl).
func ProbeHealth(ctx context.Context, port int, timeout time.Duration) error {
	url := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + HealthPath

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("sim: building the probe request: %w", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("sim: probing %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("sim: %s answered %s", url, resp.Status)
	}
	return nil
}
