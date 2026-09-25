// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// PublishQoS is the delivery guarantee of the machine's one subscription and
// of every message it sends. Nothing on these topics is a stream that can
// afford a hole: a command that is lost is a button that did nothing, and a
// ground-truth event that is lost is a fact the evaluation never learns.
const PublishQoS byte = 1

// PublishTimeout bounds one PUBLISH and its acknowledgement. A broker that
// does not answer within it costs that message and nothing else; the retained
// documents are republished on the next tick or the next change.
const PublishTimeout = 2 * time.Second

// Broker is the part of mqttio.Client this package uses: the control plane
// subscribes and answers through it, and the status and ground-truth
// publishers send through it. It is an interface so a caller can drive them
// with a stub instead of a connection, and so this package does not depend on
// the client's lifecycle.
type Broker interface {
	// Publish sends one message and waits for its acknowledgement.
	Publish(ctx context.Context, topic string, payload []byte, qos byte, retain bool) error
	// Subscribe registers h for filter and sends the SUBSCRIBE.
	Subscribe(ctx context.Context, filter string, qos byte, h mqttio.Handler) error
	// Connected reports whether the link to the broker is currently up.
	Connected() bool
}

// publish sends one message at PublishQoS under PublishTimeout.
func publish(ctx context.Context, broker Broker, topic string, payload []byte, retain bool) error {
	ctx, cancel := context.WithTimeout(ctx, PublishTimeout)
	defer cancel()
	return broker.Publish(ctx, topic, payload, PublishQoS, retain)
}

// StatusInterval is how often the retained status document is refreshed while
// nothing changes.
const StatusInterval = time.Second

// The status document travels at PublishQoS and is retained, so a browser that
// connects later learns where the replay cursor sits without waiting for the
// next tick.

// SimStatus is the status-sim document.
//
// It says where the replay cursor sits and how fast it moves, and nothing
// else: an anonymous subscriber reads plant/<unit>/status/# (infra/mosquitto),
// so a field about fault injection here would hand the diagnosis side its own
// ground truth (docs/architecture.md#ground-truth-isolation). The no-leak test
// of this package enforces that.
type SimStatus struct {
	Schema  string        `json:"schema"`
	UnitID  string        `json:"unit_id"`
	WallTS  string        `json:"wall_ts"`
	State   string        `json:"state"`
	Speed   uint16        `json:"speed"`
	SimTS   string        `json:"sim_ts"`
	HeadSeq uint32        `json:"head_seq"`
	Dataset StatusDataset `json:"dataset"`
	Loop    bool          `json:"loop"`
	UptimeS int64         `json:"uptime_s"`
}

// StatusDataset is the closed "dataset" object of the status schema: the rows
// the cursor moves through.
type StatusDataset struct {
	FirstTS string `json:"first_ts"`
	LastTS  string `json:"last_ts"`
	Rows    int    `json:"rows"`
}

// StatusPublisher renders the status document and sends it retained.
//
// It holds no mutable state, so it is safe for concurrent use: the ticker of
// ControlPlane.Run and the command handler both publish through it.
type StatusPublisher struct {
	topic   string
	unitID  string
	clock   Clock
	started time.Time
}

// NewStatusPublisher returns the publisher for unitID. started is the instant
// the process came up, which uptime_s counts from; clock supplies wall_ts and
// the uptime, so a test with a fake clock gets a deterministic document.
func NewStatusPublisher(unitID string, clock Clock, started time.Time) *StatusPublisher {
	return &StatusPublisher{
		topic:   mqttio.Topics{UnitID: unitID}.StatusSim(),
		unitID:  unitID,
		clock:   clock,
		started: started,
	}
}

// Topic is where the status document is published.
func (s *StatusPublisher) Topic() string { return s.topic }

// Document renders snap as the status-sim message.
func (s *StatusPublisher) Document(snap Snapshot) SimStatus {
	now := s.clock.Now()
	return SimStatus{
		Schema:  mqttio.SchemaID("status-sim"),
		UnitID:  s.unitID,
		WallTS:  mqttio.WallTS(now),
		State:   snap.State.String(),
		Speed:   snap.Speed,
		SimTS:   mqttio.SimTS(snap.SimTsMs),
		HeadSeq: snap.HeadSeq,
		Dataset: StatusDataset{
			FirstTS: mqttio.SimTS(snap.FirstTsMs),
			LastTS:  mqttio.SimTS(snap.LastTsMs),
			Rows:    snap.Rows,
		},
		Loop:    snap.Loop,
		UptimeS: int64(now.Sub(s.started) / time.Second),
	}
}

// Encode renders snap as the JSON payload of the status topic.
func (s *StatusPublisher) Encode(snap Snapshot) ([]byte, error) {
	payload, err := json.Marshal(s.Document(snap))
	if err != nil {
		return nil, fmt.Errorf("sim: encoding the status document: %w", err)
	}
	return payload, nil
}

// Publish sends the status document retained on broker.
func (s *StatusPublisher) Publish(ctx context.Context, broker Broker, snap Snapshot) error {
	payload, err := s.Encode(snap)
	if err != nil {
		return err
	}
	return publish(ctx, broker, s.topic, payload, true)
}
