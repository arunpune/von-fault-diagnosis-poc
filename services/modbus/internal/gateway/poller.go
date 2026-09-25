// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"fmt"
	"io"
	"log"
	"time"

	"github.com/simonvetter/modbus"
)

// MaxReadRegisters is the largest quantity FC03 can carry in one request
// (Modbus application protocol §6.3). Three 32-register slots plus the header
// fit comfortably below it.
const MaxReadRegisters uint16 = 125

// UnitID is the Modbus unit identifier of the simulated machine.
const UnitID uint8 = 1

// Poller is the gateway's whole view of the device: it opens a connection,
// reads holding registers and closes again.
//
// The interface has no write method and no implementation in this module ever
// gains one: the connector is read-only by construction, not by convention,
// and internal/arch fails the build if a Modbus write call ever appears under
// internal/gateway or cmd/gateway. Swapping the client library touches this
// file alone.
type Poller interface {
	// Open connects to the device. Calling it on an open poller is an error.
	Open() error
	// Close drops the connection. It is safe on a poller that is not open.
	Close() error
	// ReadHolding reads quantity consecutive holding registers from addr
	// (FC03). quantity must be between 1 and MaxReadRegisters.
	ReadHolding(addr, quantity uint16) ([]uint16, error)
}

// modbusPoller is the simonvetter/modbus implementation of Poller. A new
// client is built for every Open so a reconnect never reuses a transport the
// library already tore down.
type modbusPoller struct {
	addr    string
	timeout time.Duration
	client  *modbus.ModbusClient
}

// NewModbusPoller returns a Poller that speaks Modbus TCP to addr
// ("host:port"), bounding every request with timeout. Nothing is dialled until
// Open.
func NewModbusPoller(addr string, timeout time.Duration) Poller {
	return &modbusPoller{addr: addr, timeout: timeout}
}

// Open dials the device and selects the unit id of the register model.
func (p *modbusPoller) Open() error {
	if p.client != nil {
		return fmt.Errorf("gateway: the poller for %s is already open", p.addr)
	}

	client, err := modbus.NewClient(&modbus.ClientConfiguration{
		URL:     "tcp://" + p.addr,
		Timeout: p.timeout,
		// The library logs every transport error to stdout through its own
		// logger; the gateway reports them through slog with context, so the
		// duplicate is discarded to keep the logs readable.
		Logger: log.New(io.Discard, "", 0),
	})
	if err != nil {
		return fmt.Errorf("gateway: configuring the Modbus client for %s: %w", p.addr, err)
	}
	if err := client.SetUnitId(UnitID); err != nil {
		return fmt.Errorf("gateway: selecting Modbus unit id %d: %w", UnitID, err)
	}
	if err := client.Open(); err != nil {
		return fmt.Errorf("gateway: connecting to %s: %w", p.addr, err)
	}
	p.client = client
	return nil
}

// Close drops the connection and forgets the client, so the next Open starts
// from a fresh transport.
func (p *modbusPoller) Close() error {
	if p.client == nil {
		return nil
	}
	client := p.client
	p.client = nil
	if err := client.Close(); err != nil {
		return fmt.Errorf("gateway: closing the connection to %s: %w", p.addr, err)
	}
	return nil
}

// ReadHolding issues one FC03 request.
func (p *modbusPoller) ReadHolding(addr, quantity uint16) ([]uint16, error) {
	if p.client == nil {
		return nil, fmt.Errorf("gateway: the poller for %s is not open", p.addr)
	}
	if quantity == 0 || quantity > MaxReadRegisters {
		return nil, fmt.Errorf("gateway: a holding-register read covers 1..%d registers, not %d",
			MaxReadRegisters, quantity)
	}

	regs, err := p.client.ReadRegisters(addr, quantity, modbus.HOLDING_REGISTER)
	if err != nil {
		return nil, fmt.Errorf("gateway: reading %d holding registers at %d from %s: %w",
			quantity, addr, p.addr, err)
	}
	if len(regs) != int(quantity) {
		return nil, fmt.Errorf("gateway: %s answered a read of %d registers at %d with %d",
			p.addr, quantity, addr, len(regs))
	}
	return regs, nil
}
