// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gateway

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// Reconnect policy: 200 ms doubling to 5 s, each wait spread by
// ReconnectJitter so a fleet of gateways does not retry in lockstep.
const (
	// ReconnectMinBackoff is the first wait after a Modbus failure.
	ReconnectMinBackoff = 200 * time.Millisecond
	// ReconnectMaxBackoff is the ceiling the backoff doubles up to.
	ReconnectMaxBackoff = 5 * time.Second
	// ReconnectJitter is the fraction a wait is spread by, in both
	// directions.
	ReconnectJitter = 0.2
	// MapMajorRetry is how long the gateway waits before looking at the header
	// again after refusing the device's register map major.
	MapMajorRetry = 5 * time.Second
)

// Clock is the wall clock the gateway reads. Production uses SystemClock;
// tests supply a fake one so a message's wall_ts is as deterministic as its
// sim_ts.
type Clock interface {
	// Now returns the current instant.
	Now() time.Time
	// After returns a channel that receives once d has passed.
	After(d time.Duration) <-chan time.Time
}

// SystemClock is the real clock.
type SystemClock struct{}

// Now returns the current instant.
func (SystemClock) Now() time.Time { return time.Now() }

// After returns a channel that receives once d has passed.
func (SystemClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Snapshot is everything the heartbeat and the health endpoint report. The
// poll loop writes it; the other goroutines only read copies.
type Snapshot struct {
	// Counters are the reader's totals.
	Counters Counters
	// LastSeq is the sequence number of the newest published sample.
	LastSeq uint32
	// LastSimTsMs is that sample's simulated time, epoch milliseconds.
	LastSimTsMs uint64
	// HasSample is false until the first sample was published.
	HasSample bool
	// HeadSeq is the head sequence of the last header read.
	HeadSeq uint32
	// SamplesPublished and BatchesPublished count what reached the broker.
	SamplesPublished uint64
	BatchesPublished uint64
	// PublishErrors counts the batches the broker refused or did not
	// acknowledge; each one is dropped, never queued.
	PublishErrors uint64
	// ModbusConnected and MQTTConnected are the two links.
	ModbusConnected bool
	MQTTConnected   bool
	// LastHeaderRead is when the device's header was last read successfully.
	LastHeaderRead time.Time
	// LastError is the English description of the last failed cycle, empty
	// once a cycle succeeds again.
	LastError string
	// MapMajor and MapMinor are the device's register map version, valid
	// only while HasMapVersion is true.
	MapMajor      uint16
	MapMinor      uint16
	HasMapVersion bool
}

// Options are the replaceable parts of a Service. The zero value asks for the
// production defaults.
type Options struct {
	// Clock replaces SystemClock.
	Clock Clock
	// Logger replaces slog.Default().
	Logger *slog.Logger
	// Jitter spreads one backoff wait. It replaces the randomised default,
	// which is what makes a reconnect test deterministic.
	Jitter func(time.Duration) time.Duration
}

// Service is the gateway: a poll loop over the device's ring, a telemetry
// publisher, a retained heartbeat and a health endpoint.
type Service struct {
	cfg       Config
	poller    Poller
	broker    Broker
	reader    *Reader
	publisher *Publisher
	status    *StatusPublisher
	clock     Clock
	log       *slog.Logger
	jitter    func(time.Duration) time.Duration

	// mapMajorLogged keeps the register-map refusal to one log line per
	// device, however long the gateway retries.
	mapMajorLogged bool

	mu   sync.Mutex
	snap Snapshot
}

// New assembles a Service. It does not connect: Run does, and keeps
// reconnecting for as long as its context lives.
func New(cfg Config, poller Poller, broker Broker, opts Options) (*Service, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	clock := opts.Clock
	if clock == nil {
		clock = SystemClock{}
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	jitter := opts.Jitter
	if jitter == nil {
		jitter = randomJitter
	}

	status, err := NewStatusPublisher(broker, cfg, clock, clock.Now())
	if err != nil {
		return nil, err
	}

	return &Service{
		cfg:       cfg,
		poller:    poller,
		broker:    broker,
		reader:    NewReader(poller),
		publisher: NewPublisher(broker, cfg.UnitID, clock),
		status:    status,
		clock:     clock,
		log:       logger,
		jitter:    jitter,
	}, nil
}

// Snapshot returns the gateway's observable state, with the MQTT link read
// from the broker at the moment of the call.
func (s *Service) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.snap.MQTTConnected = s.broker.Connected()
	return s.snap
}

// HealthHandler serves HealthPath from this service's snapshot.
func (s *Service) HealthHandler() http.Handler {
	return HealthHandler(s.Snapshot, s.clock)
}

// TelemetryTopic and StatusTopic are where the service publishes.
func (s *Service) TelemetryTopic() string { return s.publisher.Topic() }
func (s *Service) StatusTopic() string    { return s.status.Topic() }

// Run polls the device and publishes until ctx is cancelled, at which point it
// returns nil: a cancelled context is how the gateway is asked to stop, not a
// failure. It never returns while ctx lives — every Modbus failure is a
// reconnect, not an exit.
func (s *Service) Run(ctx context.Context) error {
	var heartbeats sync.WaitGroup
	heartbeats.Add(1)
	go func() {
		defer heartbeats.Done()
		s.runHeartbeat(ctx)
	}()
	defer heartbeats.Wait()

	defer func() {
		if err := s.poller.Close(); err != nil {
			s.log.Warn("closing the Modbus connection failed", slog.Any("error", err))
		}
		s.setModbusConnected(false)
	}()

	batch := make([]regmap.Slot, 0, s.cfg.MaxBatch)
	backoff := time.Duration(0)
	connected := false

	for {
		if ctx.Err() != nil {
			return nil
		}

		if !connected {
			if err := s.connect(); err != nil {
				s.recordError(err)
				s.log.Warn("connecting to the device failed",
					slog.String("addr", s.cfg.ModbusAddr), slog.Any("error", err))
				backoff = s.nextBackoff(backoff)
				if !s.wait(ctx, backoff) {
					return nil
				}
				continue
			}
			backoff, connected = 0, true
		}

		poll, err := s.reader.Poll()
		if err != nil {
			batch = s.flush(ctx, batch)

			var mapErr *MapMajorError
			if errors.As(err, &mapErr) {
				s.refuseMapMajor(mapErr)
				if !s.wait(ctx, MapMajorRetry) {
					return nil
				}
				continue
			}

			s.recordError(err)
			s.log.Warn("a poll cycle failed; reconnecting",
				slog.String("addr", s.cfg.ModbusAddr), slog.Any("error", err))
			s.disconnect()
			connected = false
			backoff = s.nextBackoff(backoff)
			if !s.wait(ctx, backoff) {
				return nil
			}
			continue
		}

		s.recordPoll(poll)

		for _, slot := range poll.Samples {
			batch = append(batch, slot)
			if len(batch) == s.cfg.MaxBatch {
				batch = s.flush(ctx, batch)
			}
		}
		if !poll.More {
			batch = s.flush(ctx, batch)
		}
		if len(poll.Samples) == 0 && !s.wait(ctx, s.cfg.PollInterval) {
			return nil
		}
	}
}

// connect opens the device connection and records it.
func (s *Service) connect() error {
	if err := s.poller.Open(); err != nil {
		return err
	}
	s.setModbusConnected(true)
	s.log.Info("connected to the device", slog.String("addr", s.cfg.ModbusAddr))
	return nil
}

// disconnect closes the device connection. The reader keeps its sequence
// number, so the ring rule counts whatever the device overwrote while the
// gateway was away.
func (s *Service) disconnect() {
	if err := s.poller.Close(); err != nil {
		s.log.Warn("closing the Modbus connection failed", slog.Any("error", err))
	}
	s.setModbusConnected(false)
}

// flush publishes batch and returns the empty batch to carry on with. A
// publish failure costs the batch: telemetry is never queued while the broker
// is down.
func (s *Service) flush(ctx context.Context, batch []regmap.Slot) []regmap.Slot {
	if len(batch) == 0 {
		return batch
	}

	if err := s.publisher.Publish(ctx, batch); err != nil {
		s.recordPublishError(err)
		if ctx.Err() == nil {
			s.log.Warn("publishing a telemetry batch failed; the batch is dropped",
				slog.Int("samples", len(batch)), slog.Any("error", err))
		}
		return batch[:0]
	}
	s.recordPublished(batch)
	return batch[:0]
}

// runHeartbeat publishes the retained status message, immediately and then
// every StatusInterval.
func (s *Service) runHeartbeat(ctx context.Context) {
	for {
		if err := s.status.Publish(ctx, s.Snapshot()); err != nil && ctx.Err() == nil {
			s.log.Warn("publishing the gateway status failed", slog.Any("error", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-s.clock.After(s.cfg.StatusInterval):
		}
	}
}

// refuseMapMajor marks the gateway unhealthy and logs the refusal once.
func (s *Service) refuseMapMajor(err *MapMajorError) {
	s.recordError(err)
	if s.mapMajorLogged {
		return
	}
	s.mapMajorLogged = true
	s.log.Error("refusing the device's register map",
		slog.String("addr", s.cfg.ModbusAddr),
		slog.Uint64("device_map_major", uint64(err.Device)),
		slog.Uint64("gateway_map_major", uint64(err.Expected)),
		slog.Any("error", err))
}

// wait sleeps for d or until ctx ends, and reports whether the sleep completed.
func (s *Service) wait(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	select {
	case <-ctx.Done():
		return false
	case <-s.clock.After(d):
		return true
	}
}

// nextBackoff doubles the previous wait up to ReconnectMaxBackoff and spreads
// the result.
func (s *Service) nextBackoff(previous time.Duration) time.Duration {
	next := previous * 2
	if previous == 0 {
		next = ReconnectMinBackoff
	}
	next = min(next, ReconnectMaxBackoff)
	return s.jitter(next)
}

// randomJitter spreads d by up to ReconnectJitter in either direction.
func randomJitter(d time.Duration) time.Duration {
	spread := (rand.Float64()*2 - 1) * ReconnectJitter
	return time.Duration(float64(d) * (1 + spread))
}

// recordPoll folds one successful cycle into the snapshot.
func (s *Service) recordPoll(poll Poll) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.snap.Counters = s.reader.Counters()
	s.snap.HeadSeq = poll.Header.HeadSeq
	s.snap.MapMajor, s.snap.MapMinor = poll.Header.MapMajor, poll.Header.MapMinor
	s.snap.HasMapVersion = true
	s.snap.LastHeaderRead = s.clock.Now()
	s.snap.LastError = ""
}

// recordPublished folds one delivered batch into the snapshot. last_seq is the
// newest sample the gateway published, which is what the status schema states.
func (s *Service) recordPublished(batch []regmap.Slot) {
	s.mu.Lock()
	defer s.mu.Unlock()

	newest := batch[len(batch)-1]
	s.snap.LastSeq, s.snap.LastSimTsMs, s.snap.HasSample = newest.Seq, newest.SimTsMs, true
	s.snap.SamplesPublished += uint64(len(batch))
	s.snap.BatchesPublished++
}

// recordPublishError counts a dropped batch.
func (s *Service) recordPublishError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.snap.PublishErrors++
	s.snap.LastError = err.Error()
}

// recordError stores the reason the last cycle failed and refreshes the
// counters, which a failed read has already incremented.
func (s *Service) recordError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.snap.Counters = s.reader.Counters()
	s.snap.LastError = err.Error()
}

// setModbusConnected records the state of the device connection.
func (s *Service) setModbusConnected(connected bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.snap.ModbusConnected = connected
}
