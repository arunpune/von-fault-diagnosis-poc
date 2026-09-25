// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/simonvetter/modbus"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// ModbusDevice is a scripted Modbus TCP server: a register image a test writes
// by hand, served read-only over a real TCP socket on 127.0.0.1 with a port
// the kernel picks.
//
// It stands in for the simulator wherever a test needs to script exactly what
// the device shows — a ring that wraps, a head that runs away from the reader,
// a register map from another major version, a process that restarts. The
// engine of internal/sim is a different thing entirely and is exercised by its
// own tests.
//
// Like the real machine it answers every write function code with exception
// 01, illegal function, and serves holding registers only.
type ModbusDevice struct {
	addr string

	mu   sync.RWMutex
	regs []uint16

	lifecycle sync.Mutex
	server    *modbus.ModbusServer
	running   bool
}

// deviceIdleTimeout is the session timeout of the scripted server. It is
// generous: a test that pauses a poller for a second must not have its
// connection closed underneath it.
const deviceIdleTimeout = 2 * time.Minute

// deviceMaxClients is the connection limit of the scripted server, the same
// default the simulator runs with.
const deviceMaxClients = 5

// StartModbusDevice starts a scripted Modbus TCP server with an empty ring, a
// head sequence of 0 and this build's register map version in its header. The
// server stops in t.Cleanup.
func StartModbusDevice(t testing.TB) *ModbusDevice {
	t.Helper()

	d := &ModbusDevice{addr: freeLoopbackAddr(t), regs: make([]uint16, regmap.TotalRegs)}
	d.writeHeader(regmap.Header{MapMajor: regmap.MapMajor, MapMinor: regmap.MapMinor})
	d.Start(t)
	t.Cleanup(d.Stop)
	return d
}

// Addr is the "host:port" the device listens on, which is what
// gateway.NewModbusPoller takes.
func (d *ModbusDevice) Addr() string { return d.addr }

// Start begins accepting connections on Addr. It is idempotent, so a test may
// call it on a device that is already serving.
func (d *ModbusDevice) Start(t testing.TB) {
	t.Helper()

	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()

	if d.running {
		return
	}
	server, err := modbus.NewServer(&modbus.ServerConfiguration{
		URL:        "tcp://" + d.addr,
		Timeout:    deviceIdleTimeout,
		MaxClients: deviceMaxClients,
		Logger:     log.New(io.Discard, "", 0),
	}, (*deviceHandler)(d))
	if err != nil {
		t.Fatalf("testutil: configuring the scripted Modbus server on %s: %v", d.addr, err)
	}
	if err := server.Start(); err != nil {
		t.Fatalf("testutil: starting the scripted Modbus server on %s: %v", d.addr, err)
	}
	d.server, d.running = server, true
}

// Stop closes the listener and every open session, keeping the register image
// and the address so Start brings the same device back. It is idempotent.
func (d *ModbusDevice) Stop() {
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()

	if !d.running {
		return
	}
	d.running = false
	_ = d.server.Stop()
	d.server = nil
}

// WriteSlot writes the 32 registers of one slot into the ring at the address
// of seq, without touching the head.
func (d *ModbusDevice) WriteSlot(seq uint32, slot [regmap.SlotRegs]uint16) {
	base := regmap.SlotAddr(seq)

	d.mu.Lock()
	defer d.mu.Unlock()
	copy(d.regs[base:base+regmap.SlotRegs], slot[:])
}

// WriteSample encodes sample with the generated register map and writes it at
// its own sequence number, without touching the head.
func (d *ModbusDevice) WriteSample(t testing.TB, sample regmap.Slot) {
	t.Helper()

	regs, err := regmap.EncodeSlot(sample)
	if err != nil {
		t.Fatalf("testutil: encoding sample %d: %v", sample.Seq, err)
	}
	d.WriteSlot(sample.Seq, regs)
}

// Publish writes sample and then advertises it, which is the order the
// simulator writes in: a reader never sees a head pointing at a slot that is
// not there yet.
func (d *ModbusDevice) Publish(t testing.TB, sample regmap.Slot) {
	t.Helper()

	d.WriteSample(t, sample)
	d.SetHead(sample.Seq)
	d.SetSimTime(sample.SimTsMs)
}

// SetHead advertises seq as the newest complete slot.
func (d *ModbusDevice) SetHead(seq uint32) {
	d.mu.Lock()
	defer d.mu.Unlock()
	putU32(d.regs, regmap.HeaderBase+regmap.HdrHeadSeq, seq)
}

// Head returns the head sequence the device currently advertises.
func (d *ModbusDevice) Head() uint32 {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return getU32(d.regs, regmap.HeaderBase+regmap.HdrHeadSeq)
}

// SetSimTime sets the header's simulated clock, epoch milliseconds UTC.
func (d *ModbusDevice) SetSimTime(ms uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	putU64(d.regs, regmap.HeaderBase+regmap.HdrSimTsNow, ms)
}

// SetMapMajor changes the register map major version the device reports, which
// is how a test makes a gateway refuse it.
func (d *ModbusDevice) SetMapMajor(major uint16) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.regs[regmap.HeaderBase+regmap.HdrMapMajor] = major
}

// SetMapMinor changes the register map minor version the device reports.
func (d *ModbusDevice) SetMapMinor(minor uint16) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.regs[regmap.HeaderBase+regmap.HdrMapMinor] = minor
}

// Restart is a restarted simulator process: the ring is empty again and the
// head is back at 0, while the TCP connection and the address stay as they
// are. Sequence numbers start from 1 afterwards, below whatever a reader had
// reached, which is exactly how the gateway detects a restart.
func (d *ModbusDevice) Restart() {
	d.mu.Lock()
	defer d.mu.Unlock()

	clear(d.regs)
	putU32(d.regs, regmap.HeaderBase+regmap.HdrHeadSeq, 0)
	d.regs[regmap.HeaderBase+regmap.HdrMapMajor] = regmap.MapMajor
	d.regs[regmap.HeaderBase+regmap.HdrMapMinor] = regmap.MapMinor
	d.regs[regmap.HeaderBase+regmap.HdrRingSlots] = regmap.RingSlots
	d.regs[regmap.HeaderBase+regmap.HdrSlotRegs] = regmap.SlotRegs
	putU32(d.regs, regmap.HeaderBase+regmap.HdrRingBase, uint32(regmap.RingBase))
}

// Read returns a copy of quantity registers from addr, which is what the
// server answers and what a test asserts on directly.
func (d *ModbusDevice) Read(addr, quantity uint16) []uint16 {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if int(addr)+int(quantity) > len(d.regs) {
		return nil
	}
	out := make([]uint16, quantity)
	copy(out, d.regs[addr:addr+quantity])
	return out
}

// writeHeader renders h into the register image. It is only used at
// construction, before the device serves anything.
func (d *ModbusDevice) writeHeader(h regmap.Header) {
	regs := regmap.EncodeHeader(h)
	copy(d.regs[regmap.HeaderBase:regmap.HeaderBase+regmap.HeaderRegs], regs[:])
}

// FakePoller reads a ModbusDevice's register image directly, with no socket in
// between. It has the method set of gateway.Poller, so the ring-reading
// algorithm can be driven register by register without a network, and read
// failures can be scripted exactly.
//
// It is safe for concurrent use.
type FakePoller struct {
	device *ModbusDevice

	mu sync.Mutex
	// open is whether Open was called without a matching Close.
	open bool
	// opens counts successful Opens, which is how a test sees a reconnect.
	opens int
	// failures is how many further reads return failure, -1 for all of them.
	failures int
	// failure is the error those reads return.
	failure error
}

// FakePoller returns a poller over this device's registers.
func (d *ModbusDevice) FakePoller() *FakePoller { return &FakePoller{device: d} }

// Open marks the poller connected.
func (p *FakePoller) Open() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.open {
		return errors.New("testutil: the fake poller is already open")
	}
	p.open, p.opens = true, p.opens+1
	return nil
}

// Close marks the poller disconnected. It is safe on a closed poller.
func (p *FakePoller) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.open = false
	return nil
}

// Opens returns how many times the poller was opened, so a test can assert
// that the service reconnected rather than merely kept going.
func (p *FakePoller) Opens() int {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.opens
}

// FailReads makes the next count reads return err; a negative count makes
// every read fail until FailReads is called again with zero.
func (p *FakePoller) FailReads(count int, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.failures, p.failure = count, err
}

// ReadHolding answers from the device's register image, honouring the request
// limits of the real client so a test cannot pass a request the wire would
// refuse.
func (p *FakePoller) ReadHolding(addr, quantity uint16) ([]uint16, error) {
	p.mu.Lock()
	if !p.open {
		p.mu.Unlock()
		return nil, errors.New("testutil: the fake poller is not open")
	}
	if p.failures != 0 {
		err := p.failure
		if p.failures > 0 {
			p.failures--
		}
		p.mu.Unlock()
		if err == nil {
			err = errors.New("testutil: scripted read failure")
		}
		return nil, err
	}
	p.mu.Unlock()

	if quantity == 0 || quantity > maxReadRegisters {
		return nil, fmt.Errorf("testutil: a holding-register read covers 1..%d registers, not %d",
			maxReadRegisters, quantity)
	}
	regs := p.device.Read(addr, quantity)
	if regs == nil {
		return nil, fmt.Errorf("testutil: the register image has no address %d..%d",
			addr, int(addr)+int(quantity)-1)
	}
	return regs, nil
}

// maxReadRegisters is the FC03 limit the fake poller enforces, the same one
// gateway.MaxReadRegisters states for the real client.
const maxReadRegisters uint16 = 125

// deviceHandler is the simonvetter RequestHandler of a ModbusDevice. It is the
// device itself under another name, so the handler cannot be used to reach
// anything the device does not expose.
type deviceHandler ModbusDevice

var _ modbus.RequestHandler = (*deviceHandler)(nil)

// HandleHoldingRegisters serves FC03 and refuses every write function code,
// which is what makes the emulated machine read-only.
func (h *deviceHandler) HandleHoldingRegisters(req *modbus.HoldingRegistersRequest) ([]uint16, error) {
	if req.IsWrite {
		return nil, modbus.ErrIllegalFunction
	}
	regs := (*ModbusDevice)(h).Read(req.Addr, req.Quantity)
	if regs == nil {
		return nil, modbus.ErrIllegalDataAddress
	}
	return regs, nil
}

// HandleCoils refuses FC01, FC05 and FC0F: the device has no coils.
func (h *deviceHandler) HandleCoils(*modbus.CoilsRequest) ([]bool, error) {
	return nil, modbus.ErrIllegalFunction
}

// HandleDiscreteInputs refuses FC02.
func (h *deviceHandler) HandleDiscreteInputs(*modbus.DiscreteInputsRequest) ([]bool, error) {
	return nil, modbus.ErrIllegalFunction
}

// HandleInputRegisters refuses FC04: the register model is holding registers
// only.
func (h *deviceHandler) HandleInputRegisters(*modbus.InputRegistersRequest) ([]uint16, error) {
	return nil, modbus.ErrIllegalFunction
}

// freeLoopbackAddr returns a loopback address whose port the kernel has just
// handed out and released again. The pinned Modbus server does not report the
// port it bound to, so the port is chosen here instead of with ":0"; parallel
// test binaries therefore never share one.
func freeLoopbackAddr(t testing.TB) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("testutil: reserving a loopback port: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("testutil: releasing the reserved port %s: %v", addr, err)
	}
	return addr
}

// putU32 and getU32 place a 32-bit header field high word first, the word
// order of the register model.
func putU32(regs []uint16, off uint16, v uint32) {
	regs[off] = uint16(v >> 16)
	regs[off+1] = uint16(v)
}

func getU32(regs []uint16, off uint16) uint32 {
	return uint32(regs[off])<<16 | uint32(regs[off+1])
}

// putU64 places a 64-bit header field high word first.
func putU64(regs []uint16, off uint16, v uint64) {
	regs[off] = uint16(v >> 48)
	regs[off+1] = uint16(v >> 32)
	regs[off+2] = uint16(v >> 16)
	regs[off+3] = uint16(v)
}
