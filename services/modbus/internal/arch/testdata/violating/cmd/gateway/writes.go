// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// This file is the second half of the intentional violation: a connector that
// writes to the machine it is only supposed to read, and that names the
// ground truth while doing it. It is data, not code — the go tool never looks
// inside testdata/ — and it exists so that the two positive controls of
// internal/arch/isolation_test.go prove their checks can fail.
package main

// GT_DIR is the environment variable the simulator reads its catalogue from;
// a connector has no business naming it.
const gtDirEnv = "GT_DIR"

// activeTopic is the ground-truth topic the simulator retains the running
// instances on.
const activeTopic = "gt/cau-7/injection/active"

// client stands in for a Modbus client: only the name of the method matters,
// because the scan is deliberately untyped.
type client struct{}

// WriteRegister is FC06.
func (client) WriteRegister(addr, value uint16) error { return nil }

// ReadRegisters is FC03, the one call a connector is allowed to make.
func (client) ReadRegisters(addr, qty uint16) ([]uint16, error) {
	return make([]uint16, qty), nil
}

// steer injects a value into the machine: the write the gateway may never do.
func steer(c client) error {
	if _, err := c.ReadRegisters(0, 32); err != nil {
		return err
	}
	return c.WriteRegister(0, 1)
}
