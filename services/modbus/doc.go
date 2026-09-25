// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package modbus is the root of the Go module that carries the Modbus TCP
// emulator and the MQTT gateway. The binaries live under cmd/ and the
// implementation under internal/.
//
// This file exists only so the module holds at least one package: go 1.27
// exits 1 with "no packages to vet" when ./... matches nothing. It may be
// deleted once cmd/ and internal/ hold real packages.
package modbus
