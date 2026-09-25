// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// PublishTimeout bounds one PUBLISH and its acknowledgement. A broker that
// does not answer within it costs the batch, not the poll loop: the ring holds
// roughly 710 ms at the highest replay speed and the simulator never waits for
// a reader, so telemetry is dropped rather than queued.
const PublishTimeout = 2 * time.Second

// TelemetryQoS is the delivery guarantee of a telemetry batch.
const TelemetryQoS byte = 1

// Broker is the part of mqttio.Client the gateway uses. It exists so the
// publisher can be driven by a stub in unit tests without a broker at all.
type Broker interface {
	// Publish sends one message and waits for its acknowledgement.
	Publish(ctx context.Context, topic string, payload []byte, qos byte, retain bool) error
	// Connected reports whether the link to the broker is currently up.
	Connected() bool
}

// telemetryMessage is the telemetry-samples envelope. The field order is the
// schema's; encoding/json writes struct fields in declaration order and map
// keys sorted, so a batch always serialises identically.
type telemetryMessage struct {
	Schema  string            `json:"schema"`
	UnitID  string            `json:"unit_id"`
	WallTS  string            `json:"wall_ts"`
	Samples []telemetrySample `json:"samples"`
}

// telemetrySample is one decoded ring slot.
type telemetrySample struct {
	Seq    uint32         `json:"seq"`
	SimTS  string         `json:"sim_ts"`
	Flags  telemetryFlags `json:"flags"`
	Values map[string]any `json:"values"`
	Alarms []string       `json:"alarms"`
}

// telemetryFlags mirrors the two slot flag bits.
type telemetryFlags struct {
	Discontinuity bool `json:"discontinuity"`
	Missing       bool `json:"missing"`
}

// Publisher turns decoded slots into telemetry-samples messages and sends
// them. It holds no state beyond its configuration; the counters live in the
// service.
type Publisher struct {
	broker Broker
	topic  string
	unitID string
	clock  Clock
}

// NewPublisher returns a Publisher for unitID that sends to broker. clock
// supplies the envelope's wall_ts and nothing else: every sample's sim_ts
// comes from the slot the simulator wrote.
func NewPublisher(broker Broker, unitID string, clock Clock) *Publisher {
	return &Publisher{
		broker: broker,
		topic:  mqttio.Topics{UnitID: unitID}.Telemetry(),
		unitID: unitID,
		clock:  clock,
	}
}

// Topic is where the publisher sends telemetry.
func (p *Publisher) Topic() string { return p.topic }

// Publish sends one batch of decoded slots, QoS 1 and not retained. An empty
// batch is not a message and is silently ignored; a batch larger than
// MaxBatchLimit is a programming error in the caller and is reported.
func (p *Publisher) Publish(ctx context.Context, slots []regmap.Slot) error {
	if len(slots) == 0 {
		return nil
	}
	payload, err := p.Encode(slots)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, PublishTimeout)
	defer cancel()
	return p.broker.Publish(ctx, p.topic, payload, TelemetryQoS, false)
}

// Encode renders one batch as the telemetry-samples JSON.
func (p *Publisher) Encode(slots []regmap.Slot) ([]byte, error) {
	if len(slots) > MaxBatchLimit {
		return nil, fmt.Errorf("gateway: a telemetry batch carries at most %d samples, not %d",
			MaxBatchLimit, len(slots))
	}

	msg := telemetryMessage{
		Schema:  mqttio.SchemaID("telemetry-samples"),
		UnitID:  p.unitID,
		WallTS:  mqttio.WallTS(p.clock.Now()),
		Samples: make([]telemetrySample, 0, len(slots)),
	}
	for _, slot := range slots {
		sample, err := encodeSample(slot)
		if err != nil {
			return nil, err
		}
		msg.Samples = append(msg.Samples, sample)
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("gateway: encoding a telemetry batch: %w", err)
	}
	return payload, nil
}

// encodeSample renders one slot. Values are keyed by the tag ids of the
// generated register map, so a renamed tag travels from signals.yaml to the
// wire without a change here.
func encodeSample(slot regmap.Slot) (telemetrySample, error) {
	values := make(map[string]any, len(regmap.Signals))
	for _, sig := range regmap.Signals {
		switch sig.Kind {
		case regmap.KindAnalog:
			v, ok := slot.Analog[sig.Tag]
			if !ok {
				return telemetrySample{}, fmt.Errorf("gateway: the decoded slot %d has no analog tag %q",
					slot.Seq, sig.Tag)
			}
			values[sig.Tag] = v
		case regmap.KindDigital:
			v, ok := slot.Digital[sig.Tag]
			if !ok {
				return telemetrySample{}, fmt.Errorf("gateway: the decoded slot %d has no digital tag %q",
					slot.Seq, sig.Tag)
			}
			values[sig.Tag] = v
		default:
			return telemetrySample{}, fmt.Errorf("gateway: signal %q has unknown kind %d", sig.Tag, sig.Kind)
		}
	}

	return telemetrySample{
		Seq:    slot.Seq,
		SimTS:  mqttio.SimTS(slot.SimTsMs),
		Flags:  telemetryFlags{Discontinuity: slot.Discontinuity, Missing: slot.Missing},
		Values: values,
		Alarms: regmap.AlarmCodes(slot.AlarmBits),
	}, nil
}
