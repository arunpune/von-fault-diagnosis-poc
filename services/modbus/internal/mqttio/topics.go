// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio

// DefaultUnitID is the unit the PoC simulates.
const DefaultUnitID = "cau-7"

// Roots of the topic tree: operational traffic under plant/, ground truth
// under gt/. The broker ACL cuts exactly along this line, so nothing but the
// ground-truth publisher and the read-only credentials touch gt/.
const (
	PlantRoot = "plant"
	GtRoot    = "gt"
)

// Topics builds every topic of the tree for one unit. The zero value is not
// usable; construct it with the unit id the services share, in practice
// DefaultUnitID.
type Topics struct {
	UnitID string
}

// plant returns "plant/<unit>/<suffix>".
func (t Topics) plant(suffix string) string {
	return PlantRoot + "/" + t.UnitID + "/" + suffix
}

// gt returns "gt/<unit>/<suffix>".
func (t Topics) gt(suffix string) string {
	return GtRoot + "/" + t.UnitID + "/" + suffix
}

// Telemetry is where the gateway publishes sample batches.
func (t Topics) Telemetry() string { return t.plant("telemetry/samples") }

// ControlCmd carries simulation commands from the backend to the simulator.
func (t Topics) ControlCmd() string { return t.plant("control/cmd") }

// ControlAck carries the simulator's answer to a command.
func (t Topics) ControlAck() string { return t.plant("control/ack") }

// StatusSim is the simulator's retained status.
func (t Topics) StatusSim() string { return t.plant("status/sim") }

// StatusGateway is the gateway's retained heartbeat.
func (t Topics) StatusGateway() string { return t.plant("status/gateway") }

// StatusBackend is the backend's retained status.
func (t Topics) StatusBackend() string { return t.plant("status/backend") }

// EventsSuspect carries the detector's suspect events.
func (t Topics) EventsSuspect() string { return t.plant("events/suspect") }

// Decisions carries one decision per suspect event.
func (t Topics) Decisions() string { return t.plant("decisions") }

// AlertsTicket carries ticket lifecycle messages.
func (t Topics) AlertsTicket() string { return t.plant("alerts/ticket") }

// AlertsSystem carries system alerts such as heartbeat alarms.
func (t Topics) AlertsSystem() string { return t.plant("alerts/system") }

// GtCatalog is the retained ground-truth catalog.
func (t Topics) GtCatalog() string { return t.gt("catalog") }

// GtInjection carries one message per injection start and stop.
func (t Topics) GtInjection() string { return t.gt("injection") }

// GtInjectionActive is the retained list of active injections.
func (t Topics) GtInjectionActive() string { return t.gt("injection/active") }

// GtMarker carries the discontinuities the simulator creates itself.
func (t Topics) GtMarker() string { return t.gt("marker") }
