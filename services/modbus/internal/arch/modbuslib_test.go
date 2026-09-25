// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package arch

import (
	"testing"

	"github.com/simonvetter/modbus"
)

// pinnedHandler implements the server-side interface of the pinned Modbus
// library. The simulator's real handler answers HandleHoldingRegisters from
// the register store and refuses everything else with ErrIllegalFunction; this
// one only has to compile.
type pinnedHandler struct{}

func (pinnedHandler) HandleCoils(*modbus.CoilsRequest) ([]bool, error) {
	return nil, modbus.ErrIllegalFunction
}

func (pinnedHandler) HandleDiscreteInputs(*modbus.DiscreteInputsRequest) ([]bool, error) {
	return nil, modbus.ErrIllegalFunction
}

func (pinnedHandler) HandleHoldingRegisters(*modbus.HoldingRegistersRequest) ([]uint16, error) {
	return nil, modbus.ErrIllegalFunction
}

func (pinnedHandler) HandleInputRegisters(*modbus.InputRegistersRequest) ([]uint16, error) {
	return nil, modbus.ErrIllegalFunction
}

// TestPinnedModbusLibraryProvidesServerAndClient holds the library choice to
// its premise: simonvetter/modbus is pinned because it is the only candidate
// that implements a Modbus TCP server as well as a client. A release that
// dropped either role, or renamed the request types the simulator's handler
// answers, fails here instead of in the simulator's handler.
func TestPinnedModbusLibraryProvidesServerAndClient(t *testing.T) {
	t.Parallel()

	var _ modbus.RequestHandler = pinnedHandler{}

	server, err := modbus.NewServer(&modbus.ServerConfiguration{
		URL:        "tcp://127.0.0.1:0",
		MaxClients: 5,
	}, pinnedHandler{})
	if err != nil {
		t.Fatalf("the pinned library refuses a TCP server configuration: %v", err)
	}
	if server == nil {
		t.Fatal("NewServer returned no server")
	}

	client, err := modbus.NewClient(&modbus.ClientConfiguration{URL: "tcp://127.0.0.1:0"})
	if err != nil {
		t.Fatalf("the pinned library refuses a TCP client configuration: %v", err)
	}
	if client == nil {
		t.Fatal("NewClient returned no client")
	}
}
