// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// StatusQoS is the delivery guarantee of the heartbeat. It is published
// retained, so a backend that connects later immediately learns whether the
// gateway is alive.
const StatusQoS byte = 1

// statusMessage is the status-gateway payload.
//
// The names are the ones
// packages/contracts/schemas/v1/status-gateway.schema.json requires; the extra
// counters the gateway reports beyond the schema follow below them with the
// same "_total" suffix the schema uses for a monotonic counter.
type statusMessage struct {
	Schema string `json:"schema"`
	UnitID string `json:"unit_id"`
	WallTS string `json:"wall_ts"`

	LastSeq         uint32       `json:"last_seq"`
	DroppedTotal    uint64       `json:"dropped_total"`
	PollsTotal      uint64       `json:"polls_total"`
	PollErrorsTotal uint64       `json:"poll_errors_total"`
	PollIntervalMs  int64        `json:"poll_interval_ms"`
	SamplesPerS     float64      `json:"samples_per_s"`
	Modbus          statusModbus `json:"modbus"`
	LastError       *string      `json:"last_error"`

	MQTTConnected         bool    `json:"mqtt_connected"`
	HeadSeq               uint32  `json:"head_seq"`
	LastSimTS             *string `json:"last_sim_ts"`
	ResyncsTotal          uint64  `json:"resyncs_total"`
	SimRestartsTotal      uint64  `json:"sim_restarts_total"`
	PublishErrorsTotal    uint64  `json:"publish_errors_total"`
	SamplesPublishedTotal uint64  `json:"samples_published_total"`
	BatchesPublishedTotal uint64  `json:"batches_published_total"`
	UptimeS               int64   `json:"uptime_s"`
}

// statusModbus is the closed "modbus" object of the schema.
type statusModbus struct {
	Host      string  `json:"host"`
	Port      int     `json:"port"`
	Connected bool    `json:"connected"`
	MapMajor  *uint16 `json:"map_major,omitempty"`
	MapMinor  *uint16 `json:"map_minor,omitempty"`
}

// StatusPublisher renders and sends the retained heartbeat.
//
// It is not safe for concurrent use: one goroutine owns it, and it keeps the
// previous report so samples_per_s is a rate over the last window rather than
// an average since boot.
type StatusPublisher struct {
	broker Broker
	topic  string
	unitID string
	clock  Clock

	host           string
	port           int
	pollIntervalMs int64

	started      time.Time
	lastReportAt time.Time
	lastSamples  uint64
}

// NewStatusPublisher returns a heartbeat publisher for cfg. started is the
// instant the gateway came up, which uptime_s counts from.
func NewStatusPublisher(broker Broker, cfg Config, clock Clock, started time.Time) (*StatusPublisher, error) {
	host, port, err := cfg.ModbusHostPort()
	if err != nil {
		return nil, err
	}
	return &StatusPublisher{
		broker:         broker,
		topic:          mqttio.Topics{UnitID: cfg.UnitID}.StatusGateway(),
		unitID:         cfg.UnitID,
		clock:          clock,
		host:           host,
		port:           port,
		pollIntervalMs: cfg.PollInterval.Milliseconds(),
		started:        started,
		lastReportAt:   started,
	}, nil
}

// Topic is where the heartbeat is published.
func (s *StatusPublisher) Topic() string { return s.topic }

// Publish renders snap and sends it retained.
func (s *StatusPublisher) Publish(ctx context.Context, snap Snapshot) error {
	payload, err := s.Encode(snap)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, PublishTimeout)
	defer cancel()
	return s.broker.Publish(ctx, s.topic, payload, StatusQoS, true)
}

// Encode renders one heartbeat and advances the rate window, so two
// consecutive calls report the samples published between them.
func (s *StatusPublisher) Encode(snap Snapshot) ([]byte, error) {
	now := s.clock.Now()

	msg := statusMessage{
		Schema:          mqttio.SchemaID("status-gateway"),
		UnitID:          s.unitID,
		WallTS:          mqttio.WallTS(now),
		LastSeq:         snap.LastSeq,
		DroppedTotal:    snap.Counters.Dropped,
		PollsTotal:      snap.Counters.Polls,
		PollErrorsTotal: snap.Counters.ReadErrors,
		PollIntervalMs:  s.pollIntervalMs,
		SamplesPerS:     s.rate(now, snap.SamplesPublished),
		Modbus: statusModbus{
			Host:      s.host,
			Port:      s.port,
			Connected: snap.ModbusConnected,
		},
		MQTTConnected:         snap.MQTTConnected,
		HeadSeq:               snap.HeadSeq,
		ResyncsTotal:          snap.Counters.Resyncs,
		SimRestartsTotal:      snap.Counters.SimRestarts,
		PublishErrorsTotal:    snap.PublishErrors,
		SamplesPublishedTotal: snap.SamplesPublished,
		BatchesPublishedTotal: snap.BatchesPublished,
		UptimeS:               int64(now.Sub(s.started) / time.Second),
	}
	if snap.HasMapVersion {
		mapMajor, mapMinor := snap.MapMajor, snap.MapMinor
		msg.Modbus.MapMajor, msg.Modbus.MapMinor = &mapMajor, &mapMinor
	}
	if snap.LastError != "" {
		lastError := snap.LastError
		msg.LastError = &lastError
	}
	if snap.HasSample {
		simTS := mqttio.SimTS(snap.LastSimTsMs)
		msg.LastSimTS = &simTS
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("gateway: encoding the status message: %w", err)
	}
	return payload, nil
}

// rate returns the samples published per wall-clock second since the previous
// report and opens a new window. A window of zero length reports zero rather
// than an infinity the schema would refuse.
func (s *StatusPublisher) rate(now time.Time, published uint64) float64 {
	window := now.Sub(s.lastReportAt)
	delta := published - s.lastSamples
	s.lastReportAt, s.lastSamples = now, published

	if window <= 0 {
		return 0
	}
	return float64(delta) / window.Seconds()
}
