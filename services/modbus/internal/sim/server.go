// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/simonvetter/modbus"
)

// UnitID is the only Modbus unit id the machine answers for.
const UnitID uint8 = 1

// DefaultServerTimeout is the idle session timeout of the listener: a client
// that stops polling is dropped rather than held against MaxClients for ever.
const DefaultServerTimeout = 30 * time.Second

// ephemeralBindAttempts is how often Start retries when the operating system
// picks the port. Reserving a free port and handing it to the server library
// leaves a window in which another process can take it; retrying closes it in
// practice, and a test that runs beside dozens of others never sees the race.
const ephemeralBindAttempts = 5

// ServerConfig is what the read-only Modbus listener needs.
type ServerConfig struct {
	// Bind is the interface to listen on, MODBUS_BIND.
	Bind string
	// Port is MODBUS_PORT; zero lets the operating system choose one, which
	// is what tests use, and Addr then reports the bound address.
	Port int
	// MaxClients is MODBUS_MAX_CLIENTS.
	MaxClients uint
	// Timeout is the idle session timeout; zero means DefaultServerTimeout.
	Timeout time.Duration
	// Logger receives the library's own messages; nil discards them, which
	// keeps the library from writing to stdout behind slog's back.
	Logger *slog.Logger
}

// Server is the machine's Modbus TCP face: holding registers only, unit id 1
// only, reads only.
type Server struct {
	cfg     ServerConfig
	handler *handler

	mu      sync.Mutex
	srv     *modbus.ModbusServer
	addr    string
	started bool
}

// NewServer returns a listener over store. It binds nothing; call Start.
func NewServer(cfg ServerConfig, store *Store) (*Server, error) {
	if store == nil {
		return nil, errors.New("sim: the Modbus server needs a register store")
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return nil, fmt.Errorf("sim: Modbus port %d is outside 0..65535", cfg.Port)
	}
	if cfg.Bind == "" {
		cfg.Bind = "0.0.0.0"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultServerTimeout
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Server{cfg: cfg, handler: &handler{store: store, log: logger}}, nil
}

// Start binds the listener and serves in the background.
func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.started {
		return errors.New("sim: the Modbus server is already listening")
	}

	attempts := 1
	if s.cfg.Port == 0 {
		attempts = ephemeralBindAttempts
	}
	var err error
	for range attempts {
		var addr string
		addr, err = resolveBindAddr(s.cfg.Bind, s.cfg.Port)
		if err != nil {
			continue
		}
		var srv *modbus.ModbusServer
		srv, err = modbus.NewServer(&modbus.ServerConfiguration{
			URL:        "tcp://" + addr,
			Timeout:    s.cfg.Timeout,
			MaxClients: s.cfg.MaxClients,
			Logger:     log.New(slogWriter{log: s.handler.log}, "", 0),
		}, s.handler)
		if err != nil {
			continue
		}
		if err = srv.Start(); err != nil {
			continue
		}
		s.srv, s.addr, s.started = srv, addr, true
		return nil
	}
	return fmt.Errorf("sim: listening for Modbus on %s: %w",
		net.JoinHostPort(s.cfg.Bind, strconv.Itoa(s.cfg.Port)), err)
}

// Stop closes the listener and every open session.
func (s *Server) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.started {
		return nil
	}
	s.started = false
	if err := s.srv.Stop(); err != nil {
		return fmt.Errorf("sim: stopping the Modbus server: %w", err)
	}
	return nil
}

// Addr returns the address the listener is bound to, empty before Start. With
// MODBUS_PORT=0 it is the address the operating system chose.
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addr
}

// Listening reports whether the listener is open; the health endpoint reads it.
func (s *Server) Listening() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started
}

// Refusals returns how many requests were refused because they wrote, named
// another unit id or asked for a table the machine does not expose. The
// full-stack tests assert it stays at zero for the read-only gateway.
func (s *Server) Refusals() uint64 { return s.handler.refusals.Load() }

// resolveBindAddr turns a bind address and a port into a host:port string. A
// zero port is resolved by opening and immediately closing a listener, because
// the server library takes an address and never reports the one it bound.
func resolveBindAddr(bind string, port int) (string, error) {
	hostport := net.JoinHostPort(bind, strconv.Itoa(port))
	if port != 0 {
		return hostport, nil
	}
	ln, err := net.Listen("tcp", hostport)
	if err != nil {
		return "", fmt.Errorf("sim: reserving an ephemeral port on %s: %w", bind, err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		return "", fmt.Errorf("sim: releasing the reserved port %s: %w", addr, err)
	}
	return addr, nil
}

// handler answers the Modbus function codes. Only FC03 on unit id 1 reaches
// the store; everything else is exception 01, illegal function, because the
// machine is read-only in both directions.
type handler struct {
	store    *Store
	log      *slog.Logger
	refusals atomic.Uint64
}

// HandleHoldingRegisters serves FC03 and refuses FC06 and FC16.
func (h *handler) HandleHoldingRegisters(req *modbus.HoldingRegistersRequest) ([]uint16, error) {
	switch {
	case req.IsWrite:
		return nil, h.refuse("write to the holding registers", req.ClientAddr, req.UnitId, req.Addr)
	case req.UnitId != UnitID:
		return nil, h.refuse("read for another unit id", req.ClientAddr, req.UnitId, req.Addr)
	}

	regs, err := h.store.Read(req.Addr, req.Quantity)
	if err != nil {
		h.log.Debug("modbus read refused",
			slog.String("client", req.ClientAddr),
			slog.Int("addr", int(req.Addr)),
			slog.Int("quantity", int(req.Quantity)),
			slog.String("error", err.Error()))
		return nil, mapStoreError(err)
	}
	return regs, nil
}

// HandleCoils refuses FC01, FC05 and FC0F: the machine exposes no coils.
func (h *handler) HandleCoils(req *modbus.CoilsRequest) ([]bool, error) {
	return nil, h.refuse("coil request", req.ClientAddr, req.UnitId, req.Addr)
}

// HandleDiscreteInputs refuses FC02.
func (h *handler) HandleDiscreteInputs(req *modbus.DiscreteInputsRequest) ([]bool, error) {
	return nil, h.refuse("discrete input request", req.ClientAddr, req.UnitId, req.Addr)
}

// HandleInputRegisters refuses FC04: every value lives in the holding
// registers, so a second table would only be a second truth.
func (h *handler) HandleInputRegisters(req *modbus.InputRegistersRequest) ([]uint16, error) {
	return nil, h.refuse("input register request", req.ClientAddr, req.UnitId, req.Addr)
}

// refuse counts and logs one refused request and returns exception 01.
func (h *handler) refuse(what, client string, unitID uint8, addr uint16) error {
	h.refusals.Add(1)
	h.log.Warn("modbus request refused: the machine is read-only on unit id 1",
		slog.String("request", what),
		slog.String("client", client),
		slog.Int("unit_id", int(unitID)),
		slog.Int("addr", int(addr)))
	return modbus.ErrIllegalFunction
}

// mapStoreError turns a store error into the matching Modbus exception.
func mapStoreError(err error) error {
	switch {
	case errors.Is(err, ErrIllegalDataAddress):
		return modbus.ErrIllegalDataAddress
	case errors.Is(err, ErrIllegalDataValue):
		return modbus.ErrIllegalDataValue
	default:
		return modbus.ErrServerDeviceFailure
	}
}

// slogWriter routes the server library's log.Logger output into slog at debug
// level, so its messages follow the process's format instead of going to
// stdout unstructured.
type slogWriter struct{ log *slog.Logger }

// Write forwards one log line.
func (w slogWriter) Write(p []byte) (int, error) {
	w.log.Debug("modbus server", slog.String("message", strings.TrimRight(string(p), "\n")))
	return len(p), nil
}
