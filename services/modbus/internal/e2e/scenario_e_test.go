// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Scenario E: the two restarts the stack has to survive.
//
// The broker is stopped for three seconds and brought back. Publishing fails
// while it is away — the gateway never queues telemetry — the retained
// heartbeat returns afterwards, and the stream resumes without ever repeating
// a sequence number. Then the simulator process is replaced behind the same
// Modbus address: the gateway sees the head go backwards, records a simulator
// restart and carries on from the new head.
//
// Docker republishes the mapped port whenever a container starts, so the
// clients talk to a forwarder on a loopback address that outlives the
// container behind it.

package e2e

import (
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// outage is how long the broker stays down, long enough for the gateway's own
// publish timeout to expire on a batch (gateway.PublishTimeout is 2 s).
const outage = 3 * time.Second

// dialTimeout bounds one connection from the forwarder to the container.
const dialTimeout = 2 * time.Second

// brokerLink is a loopback address in front of the broker container.
//
// It forwards while the broker is up and refuses while it is down, so a
// client keeps one address across a restart that moves the container's
// published port.
type brokerLink struct {
	listener net.Listener
	// url is the address the clients connect to; it never changes.
	url string

	mu     sync.Mutex
	target string
	live   []net.Conn
}

// newBrokerLink starts the forwarder in front of target and closes it with
// the test.
func newBrokerLink(t *testing.T, target string) *brokerLink {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	link := &brokerLink{listener: listener, url: "mqtt://" + listener.Addr().String(), target: target}
	go link.accept()
	t.Cleanup(link.close)
	return link
}

// accept forwards every connection until the listener closes.
func (l *brokerLink) accept() {
	for {
		client, err := l.listener.Accept()
		if err != nil {
			return
		}
		go l.forward(client)
	}
}

// forward joins one client connection to the broker, or closes it at once
// while the broker is down.
func (l *brokerLink) forward(client net.Conn) {
	target := l.currentTarget()
	if target == "" {
		_ = client.Close()
		return
	}
	broker, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		_ = client.Close()
		return
	}
	l.track(client, broker)

	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = client.Close()
			_ = broker.Close()
		})
	}
	go func() { _, _ = io.Copy(broker, client); stop() }()
	go func() { _, _ = io.Copy(client, broker); stop() }()
}

// currentTarget returns the container address to dial, empty while the broker
// is down.
func (l *brokerLink) currentTarget() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.target
}

// track remembers a pair of connections so cut can tear them down.
func (l *brokerLink) track(conns ...net.Conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.live = append(l.live, conns...)
}

// cut drops every connection and refuses new ones, which is what a client
// sees when the broker behind the forwarder goes away.
func (l *brokerLink) cut() {
	l.mu.Lock()
	live := l.live
	l.live, l.target = nil, ""
	l.mu.Unlock()

	for _, conn := range live {
		_ = conn.Close()
	}
}

// point sends new connections to target again.
func (l *brokerLink) point(target string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.target = target
}

// close shuts the forwarder down.
func (l *brokerLink) close() {
	_ = l.listener.Close()
	l.cut()
}

func TestScenarioEResilience(t *testing.T) {
	broker := testutil.StartMosquittoContainer(t)
	_, committed := testutil.MosquittoConfigDir()
	link := newBrokerLink(t, broker.Address(t))
	t.Logf("broker at %s through the forwarder at %s (committed ACL: %t)",
		broker.URL, link.url, committed)

	s := newStack(t, link.url, committed, stackOpts{
		speed:      controlSpeed,
		modbusPort: freePort(t),
	})

	require.True(t, s.command("play", `{}`).OK)
	s.plant.await(t, s.topics.Telemetry(), 1, budget(t, deliveryBudget))
	waitFor(t, func() bool { return len(s.publishedSeq(t)) >= 20 }, "the stream to get going")

	t.Run("the stack survives a broker restart", func(t *testing.T) {
		beforeOutage := s.service.Snapshot()
		heartbeats := s.plant.count(s.topics.StatusGateway())
		delivered := len(s.publishedSeq(t))

		link.cut()
		broker.Stop(t)
		time.Sleep(budget(t, outage))
		broker.Start(t)
		link.point(broker.Address(t))

		waitFor(t, func() bool { return s.service.Snapshot().MQTTConnected },
			"the gateway's broker session to come back")
		waitFor(t, func() bool { return s.plant.count(s.topics.StatusGateway()) > heartbeats },
			"the retained gateway heartbeat to return")
		waitFor(t, func() bool { return s.service.Snapshot().LastSeq > beforeOutage.LastSeq },
			"telemetry to resume")
		waitFor(t, func() bool { return len(s.publishedSeq(t)) > delivered },
			"telemetry to reach the subscriber again")

		after := s.service.Snapshot()
		assert.Positive(t, after.PublishErrors,
			"a batch the broker refused is dropped, not queued")

		status := s.gatewayStatusNow(t)
		assert.Positive(t, status.PublishErrorsTotal, "the heartbeat reports the failed publishes")
		assert.True(t, status.MQTTConnected)
		t.Logf("the outage cost %d publish(es) and %d sample(s); the stream resumed at %d",
			after.PublishErrors, after.Counters.Dropped, after.LastSeq)

		// Whatever was lost, nothing was ever sent twice or out of order.
		assertStrictlyIncreasing(t, s.publishedSeq(t))
	})

	t.Run("the gateway follows a simulator that was replaced", func(t *testing.T) {
		restarts := s.service.Snapshot().Counters.SimRestarts
		before := s.service.Snapshot().LastSeq
		previous := len(s.samples(t))
		require.Greater(t, before, uint32(50),
			"the gateway is far enough into the recording that a restart is visible")

		s.stopReplay(t)
		waitFor(t, func() bool { return !s.service.Snapshot().ModbusConnected },
			"the gateway to notice the device is gone")

		// A new process behind the same address, playing from the first row:
		// its head starts again at zero, which is the only way a head ever
		// goes backwards.
		s.startReplay(t, true)
		s.runReplay(t)

		waitFor(t, func() bool {
			return s.service.Snapshot().Counters.SimRestarts > restarts
		}, "the gateway to record the simulator restart")
		waitFor(t, func() bool {
			snap := s.service.Snapshot()
			return snap.ModbusConnected && snap.LastSeq > 0 && snap.LastSeq < before
		}, "the gateway to publish from the new process's head")

		resumed := s.service.Snapshot().LastSeq
		waitFor(t, func() bool { return s.service.Snapshot().LastSeq > resumed },
			"the gateway to carry on from the new head")

		// The same thing seen from the broker: the numbering the subscriber
		// receives from now on is the new process's, and it grows.
		var fresh []uint32
		waitFor(t, func() bool {
			samples := s.samples(t)
			fresh = nil
			for _, sample := range samples[min(previous, len(samples)):] {
				if sample.Seq < before {
					fresh = append(fresh, sample.Seq)
				}
			}
			return len(fresh) >= 5
		}, "the new process's samples to reach the subscriber")
		assertStrictlyIncreasing(t, fresh)

		waitFor(t, func() bool { return s.gatewayStatusNow(t).SimRestartsTotal > restarts },
			"the retained heartbeat to report the simulator restart")
		t.Logf("the gateway recorded %d simulator restart(s), resumed at %d and had been at %d",
			s.gatewayStatusNow(t).SimRestartsTotal, resumed, before)
	})

	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}

// assertStrictlyIncreasing fails on the first sequence number that repeats or
// goes backwards, and reports the holes the outage left as a count rather than
// as a failure: a broker that was away costs samples, and the gateway says how
// many.
func assertStrictlyIncreasing(t *testing.T, seqs []uint32) {
	t.Helper()
	require.NotEmpty(t, seqs)

	holes, lost := 0, uint32(0)
	for i := 1; i < len(seqs); i++ {
		require.Greaterf(t, seqs[i], seqs[i-1],
			"sequence number %d arrived after %d at position %d", seqs[i], seqs[i-1], i)
		if seqs[i] != seqs[i-1]+1 {
			holes++
			lost += seqs[i] - seqs[i-1] - 1
		}
	}
	t.Logf("the subscriber received %d samples in %d run(s), missing %d across the outage",
		len(seqs), holes+1, lost)
}
