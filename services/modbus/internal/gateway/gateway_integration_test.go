// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The gateway against the two things it actually talks to: a Modbus TCP server
// on a socket and a real Mosquitto broker in a container.
//
// The phases run in order on one gateway, because each one builds on the
// counters the previous one left behind: a clean run at four hundred samples a
// second, an induced lag whose drop count must be exact, a device that goes
// away and comes back, and the probe the Compose healthcheck runs. Every
// wall-clock bound is multiplied by FDP_TIMING_SLACK.

package gateway_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// The shape of the run: three thousand samples written at four hundred a
// second is the rate a 4000x replay of a ten-second dataset produces, and it
// empties the 256-slot ring more than eleven times over.
const (
	streamSamples = 3000
	// writeBurst samples are written every writeInterval, which is 400 a
	// second before the timing slack stretches it.
	writeBurst    = 4
	writeInterval = 10 * time.Millisecond
	// lagSamples are written while the poller is held still; 300 is more
	// than the ring holds, so the gateway must lose exactly 300 - 256 of
	// them.
	lagSamples   = 300
	expectedLoss = lagSamples - regmap.RingSlots
	// resumeSamples are written after the device came back, to prove the
	// gateway resumed at the sequence number it had.
	resumeSamples = 30
)

// encodedSlot is one sample already rendered into registers, so the writer
// goroutine touches neither the register map nor the testing handle.
type encodedSlot struct {
	seq     uint32
	simTsMs uint64
	regs    [regmap.SlotRegs]uint16
}

// encodeSeries renders count consecutive samples from seq.
func encodeSeries(t *testing.T, seq uint32, count int) []encodedSlot {
	t.Helper()

	out := make([]encodedSlot, 0, count)
	for _, slot := range slotSeries(t, seq, count) {
		regs, err := regmap.EncodeSlot(slot)
		require.NoError(t, err)
		out = append(out, encodedSlot{seq: slot.Seq, simTsMs: slot.SimTsMs, regs: regs})
	}
	return out
}

// writeSlots writes the samples into the device in the order the simulator
// does: the slot first, then the head that advertises it.
func writeSlots(device *testutil.ModbusDevice, slots []encodedSlot) {
	for _, slot := range slots {
		device.WriteSlot(slot.seq, slot.regs)
		device.SetSimTime(slot.simTsMs)
		device.SetHead(slot.seq)
	}
}

// pausablePoller holds the gateway still between two poll cycles. It blocks at
// the start of a cycle — the header read — so a paused gateway has always
// finished publishing what it last read, which is what makes the drop count
// below exact.
type pausablePoller struct {
	gateway.Poller

	mu      sync.Mutex
	gate    chan struct{}
	blocked chan struct{}
}

// newPausablePoller wraps p.
func newPausablePoller(p gateway.Poller) *pausablePoller {
	return &pausablePoller{Poller: p, blocked: make(chan struct{}, 1)}
}

// Pause makes the next header read block until Resume.
func (p *pausablePoller) Pause() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.gate == nil {
		p.gate = make(chan struct{})
	}
}

// Resume releases a paused poller.
func (p *pausablePoller) Resume() {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.gate != nil {
		close(p.gate)
		p.gate = nil
	}
}

// WaitBlocked waits until a poll cycle has actually stopped at the gate.
func (p *pausablePoller) WaitBlocked(t *testing.T) {
	t.Helper()

	select {
	case <-p.blocked:
	case <-time.After(budget(t, settleBudget)):
		t.Fatal("the poller never reached the gate")
	}
}

// ReadHolding blocks a header read while the poller is paused and otherwise
// forwards to the real client.
func (p *pausablePoller) ReadHolding(addr, quantity uint16) ([]uint16, error) {
	if addr == regmap.HeaderBase {
		p.mu.Lock()
		gate := p.gate
		p.mu.Unlock()

		if gate != nil {
			select {
			case p.blocked <- struct{}{}:
			default:
			}
			<-gate
		}
	}
	return p.Poller.ReadHolding(addr, quantity)
}

// freePort reserves a loopback port and releases it again, so the health
// server of this test never collides with another test binary's.
func freePort(t *testing.T) int {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	_, raw, err := net.SplitHostPort(listener.Addr().String())
	require.NoError(t, err)
	require.NoError(t, listener.Close())

	port, err := strconv.Atoi(raw)
	require.NoError(t, err)
	return port
}

// gatewayCredentials returns the broker credentials of the gateway. The
// committed ACL grants them exactly the two topics it publishes on; without
// infra/mosquitto in the checkout the container runs an anonymous fallback
// configuration and there is nothing to authenticate with.
func gatewayCredentials(t *testing.T) (user, password string) {
	t.Helper()

	if _, committed := testutil.MosquittoConfigDir(); !committed {
		return "", ""
	}
	return gateway.MQTTUsername, testutil.MosquittoPassword(t, gateway.MQTTUsername)
}

// TestGatewayAgainstMosquitto is the gateway's end-to-end test.
func TestGatewayAgainstMosquitto(t *testing.T) {
	brokerURL, cfgDir := testutil.StartMosquitto(t)
	_, committed := testutil.MosquittoConfigDir()
	t.Logf("broker at %s, configuration from %s (committed ACL: %t)", brokerURL, cfgDir, committed)

	device := testutil.StartModbusDevice(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}
	received := newCollector()

	// The subscriber connects anonymously: the committed ACL grants an
	// anonymous client read access to plant/cau-7/telemetry/# and
	// plant/cau-7/status/#, which is all this test reads.
	subscriber := connectClient(t, brokerURL, "gateway-it-subscriber")
	subCtx, cancelSub := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancelSub()
	require.NoError(t, subscriber.Subscribe(subCtx, topics.Telemetry(), 1, received.Handle))
	require.NoError(t, subscriber.Subscribe(subCtx, topics.StatusGateway(), 1, received.Handle))

	user, password := gatewayCredentials(t)
	publisher := connectAs(t, brokerURL, "gateway-it-publisher", user, password)

	cfg := gateway.DefaultConfig()
	cfg.ModbusAddr = device.Addr()
	cfg.ModbusTimeout = budget(t, 2*time.Second)
	cfg.PollInterval = 2 * time.Millisecond
	cfg.StatusInterval = 250 * time.Millisecond
	cfg.MQTTURL = brokerURL
	cfg.HTTPPort = freePort(t)

	poller := newPausablePoller(gateway.NewModbusPoller(cfg.ModbusAddr, cfg.ModbusTimeout))
	service, err := gateway.New(cfg, poller, publisher, gateway.Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Jitter: func(d time.Duration) time.Duration { return d },
	})
	require.NoError(t, err)

	health, err := gateway.StartHealthServer(net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.HTTPPort)),
		service.HealthHandler())
	require.NoError(t, err)
	t.Cleanup(func() {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer cancelClose()
		require.NoError(t, health.Close(closeCtx))
	})

	ctx, cancel := context.WithCancel(context.Background())
	var running sync.WaitGroup
	running.Add(1)
	go func() {
		defer running.Done()
		assert.NoError(t, service.Run(ctx))
	}()
	t.Cleanup(func() {
		cancel()
		running.Wait()
	})

	// The first cycle adopts the device's head, so nothing is written before
	// it has happened.
	waitFor(t, func() bool { return service.Snapshot().Counters.Polls > 0 }, "the first poll cycle")

	// Phase 1: three thousand samples at four hundred a second, delivered
	// contiguously and in batches the schema accepts.
	stream := encodeSeries(t, 1, streamSamples)
	interval := budget(t, writeInterval)
	for i := 0; i < len(stream); i += writeBurst {
		writeSlots(device, stream[i:min(i+writeBurst, len(stream))])
		time.Sleep(interval)
	}
	waitFor(t, func() bool { return service.Snapshot().LastSeq >= streamSamples },
		"the gateway to publish every sample of the stream")
	waitFor(t, func() bool {
		return lastReceivedSeq(t, received, topics.Telemetry()) == streamSamples
	}, "every sample to reach the subscriber")

	batches := rawBatches(t, received.On(topics.Telemetry()))
	assertSeqEqual(t, contiguousFrom(1, streamSamples), flatten(batches),
		"every sequence number, once and in order")
	for i, batch := range batches {
		assert.NotEmpty(t, batch, "batch %d", i)
		assert.LessOrEqual(t, len(batch), gateway.MaxBatchLimit, "batch %d", i)
	}
	assert.Zero(t, service.Snapshot().Counters.Dropped, "a gateway that keeps up drops nothing")

	status := latestStatus(t, received, topics.StatusGateway())
	assert.Zero(t, status.DroppedTotal, "the retained heartbeat agrees")
	assert.Equal(t, uint32(streamSamples), status.LastSeq)
	assert.True(t, status.Modbus.Connected)
	assert.True(t, status.MQTTConnected)

	probeCtx, cancelProbe := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancelProbe()
	require.NoError(t, gateway.Probe(probeCtx, cfg.HTTPPort), "a working gateway probes clean")

	// Phase 2: the device runs away while the poller is held still. 300 new
	// samples, a ring of 256: exactly 44 are gone.
	poller.Pause()
	poller.WaitBlocked(t)
	lastBeforeLag := service.Snapshot().LastSeq
	writeSlots(device, encodeSeries(t, lastBeforeLag+1, lagSamples))
	poller.Resume()

	head := lastBeforeLag + lagSamples
	waitFor(t, func() bool { return service.Snapshot().LastSeq >= head }, "the gateway to catch up again")
	assert.Equal(t, uint64(expectedLoss), service.Snapshot().Counters.Dropped,
		"exactly the samples the ring overwrote")

	waitFor(t, func() bool { return lastReceivedSeq(t, received, topics.Telemetry()) == head },
		"the samples after the lag to reach the subscriber")
	assertSeqEqual(t, append(contiguousFrom(1, streamSamples),
		contiguousFrom(head-regmap.RingSlots+1, regmap.RingSlots)...),
		flatten(rawBatches(t, received.On(topics.Telemetry()))),
		"the gateway resumes at head - 255 and loses nothing else")

	waitFor(t, func() bool {
		return latestStatus(t, received, topics.StatusGateway()).DroppedTotal == expectedLoss
	}, "the heartbeat to report the loss")

	// Phase 3: the device goes away and comes back; the sequence number
	// survives it.
	device.Stop()
	waitFor(t, func() bool { return !service.Snapshot().ModbusConnected }, "the Modbus link to drop")
	device.Start(t)

	writeSlots(device, encodeSeries(t, head+1, resumeSamples))
	waitFor(t, func() bool { return service.Snapshot().LastSeq >= head+resumeSamples },
		"the gateway to reconnect and resume")

	assert.Equal(t, uint64(expectedLoss), service.Snapshot().Counters.Dropped,
		"a reconnect that loses nothing adds no drop")
	waitFor(t, func() bool {
		return lastReceivedSeq(t, received, topics.Telemetry()) == head+resumeSamples
	}, "the samples published after the reconnect")

	after := flatten(rawBatches(t, received.On(topics.Telemetry())))
	assertSeqEqual(t, contiguousFrom(head+1, resumeSamples), after[len(after)-resumeSamples:],
		"the gateway resumed at lastSeq + 1")

	// Every message on the wire is the one the contracts declare.
	for i, payload := range received.On(topics.Telemetry()) {
		schematest.Validate(t, "telemetry-samples", payload)
		require.NotContains(t, string(payload), "inject",
			"message %d: the connector knows nothing about injections (ground-truth isolation)", i)
		if i > 20 {
			break
		}
	}
	schematest.Validate(t, "status-gateway", lastPayload(t, received, topics.StatusGateway()))

	// Phase 4: a device that has been gone for longer than the freshness
	// window fails the probe the Compose healthcheck runs.
	device.Stop()
	time.Sleep(budget(t, gateway.HeaderFreshness+time.Second))
	staleCtx, cancelStale := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancelStale()
	require.Error(t, gateway.Probe(staleCtx, cfg.HTTPPort),
		"a gateway whose device has been silent for more than the freshness window is unhealthy")
}

// connectAs dials the broker with one of the ACL's credentials, or
// anonymously when user is empty.
func connectAs(t *testing.T, url, clientID, user, password string) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{
		URL:      url,
		ClientID: clientID,
		Username: user,
		Password: password,
	}, nil)
	require.NoError(t, err, "connecting %s as %q", clientID, user)
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// lastReceivedSeq returns the newest sequence number the subscriber has, or 0
// while nothing has arrived.
func lastReceivedSeq(t *testing.T, received *collector, topic string) uint32 {
	t.Helper()

	seqs := flatten(rawBatches(t, received.On(topic)))
	if len(seqs) == 0 {
		return 0
	}
	return seqs[len(seqs)-1]
}

// assertSeqEqual compares two sequences and reports the first place they
// differ, instead of printing three thousand numbers twice.
func assertSeqEqual(t *testing.T, want, got []uint32, msg string) {
	t.Helper()

	for i := range min(len(want), len(got)) {
		if want[i] != got[i] {
			t.Fatalf("%s: sequence %d is %d, want %d (lengths %d and %d)",
				msg, i, got[i], want[i], len(got), len(want))
		}
	}
	require.Len(t, got, len(want), "%s: the sequences agree up to %d entries", msg, min(len(want), len(got)))
}

// statusFields are the heartbeat fields this test asserts on.
type statusFields struct {
	LastSeq      uint32 `json:"last_seq"`
	DroppedTotal uint64 `json:"dropped_total"`
	PollsTotal   uint64 `json:"polls_total"`
	Modbus       struct {
		Connected bool `json:"connected"`
	} `json:"modbus"`
	MQTTConnected bool `json:"mqtt_connected"`
}

// latestStatus decodes the newest heartbeat received so far.
func latestStatus(t *testing.T, received *collector, topic string) statusFields {
	t.Helper()

	var status statusFields
	require.NoError(t, json.Unmarshal(lastPayload(t, received, topic), &status))
	return status
}

// lastPayload returns the newest payload received on topic.
func lastPayload(t *testing.T, received *collector, topic string) []byte {
	t.Helper()

	payloads := received.On(topic)
	require.NotEmpty(t, payloads, "no message on %s yet", topic)
	return payloads[len(payloads)-1]
}
