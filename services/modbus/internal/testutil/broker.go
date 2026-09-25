// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"
)

// The embedded broker refuses one branch of the topic tree so a unit test can
// exercise the MQTT 5 reason codes that the Mosquitto ACL produces in the
// integration tests, without needing Docker.
const (
	// DeniedPrefix is the branch the embedded broker refuses, for both
	// subscribing and publishing.
	DeniedPrefix = "denied/"
	// DeniedFilter is a subscribe filter the broker answers with SUBACK
	// reason code 0x87 (Not authorized).
	DeniedFilter = DeniedPrefix + "#"
	// DeniedTopic is a topic the broker answers with PUBACK reason code 0x87.
	DeniedTopic = DeniedPrefix + "topic"
)

// brokers maps the URL StartEmbeddedBroker returned to the broker behind it,
// so RestartEmbeddedBroker can find it from the URL the test already holds.
var brokers = struct {
	mu sync.Mutex
	by map[string]*embeddedBroker
}{by: map[string]*embeddedBroker{}}

// embeddedBroker is one mochi-mqtt server bound to a fixed address, so it can
// be stopped and started again on the same port.
type embeddedBroker struct {
	mu      sync.Mutex
	addr    string
	server  *mqtt.Server
	running bool
}

// StartEmbeddedBroker runs an in-process MQTT 5 broker on 127.0.0.1 with a
// port the kernel picks, and returns its URL ("mqtt://127.0.0.1:<port>").
//
// Every connection is accepted, with or without credentials, and every topic
// is allowed except the DeniedPrefix branch. The broker stops in t.Cleanup.
func StartEmbeddedBroker(t testing.TB) string {
	t.Helper()

	broker := &embeddedBroker{addr: "127.0.0.1:0"}
	broker.start(t)
	url := "mqtt://" + broker.addr

	brokers.mu.Lock()
	brokers.by[url] = broker
	brokers.mu.Unlock()

	t.Cleanup(func() {
		broker.stop()
		brokers.mu.Lock()
		delete(brokers.by, url)
		brokers.mu.Unlock()
	})
	return url
}

// RestartEmbeddedBroker stops the broker StartEmbeddedBroker returned url for
// and starts a new one on the same port, which is how the reconnect tests drop
// a connection without changing the address the client dials.
//
// Nothing survives the restart: retained messages, sessions and subscriptions
// are gone, which is the case a client's own re-subscribe has to cover.
func RestartEmbeddedBroker(t testing.TB, url string) {
	t.Helper()

	brokers.mu.Lock()
	broker, ok := brokers.by[url]
	brokers.mu.Unlock()
	if !ok {
		t.Fatalf("testutil: no embedded broker at %s; StartEmbeddedBroker returns the URL to pass here", url)
	}

	broker.stop()
	broker.start(t)
}

// start binds the broker and begins serving. On the first call the address
// still carries port 0 and is replaced by the one the kernel assigned.
func (b *embeddedBroker) start(t testing.TB) {
	t.Helper()

	b.mu.Lock()
	defer b.mu.Unlock()

	// mochi logs every connection at info level; the tests only want their own
	// output.
	server := mqtt.New(&mqtt.Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := server.AddHook(new(denyBranchHook), nil); err != nil {
		t.Fatalf("testutil: adding the embedded broker's auth hook: %v", err)
	}

	listener := listeners.NewTCP(listeners.Config{ID: "fdp-embedded", Address: b.addr})
	if err := server.AddListener(listener); err != nil {
		t.Fatalf("testutil: listening on %s: %v", b.addr, err)
	}
	if err := server.Serve(); err != nil {
		t.Fatalf("testutil: serving the embedded broker on %s: %v", b.addr, err)
	}

	b.addr = listener.Address()
	b.server = server
	b.running = true
}

// stop closes the broker; it is safe to call more than once.
func (b *embeddedBroker) stop() {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.running {
		return
	}
	b.running = false
	_ = b.server.Close()
}

// denyBranchHook accepts every client and refuses the DeniedPrefix branch.
// mochi answers a refused subscribe with SUBACK 0x87 and a refused QoS 1
// publish with PUBACK 0x87, which is what the ReasonError tests assert.
type denyBranchHook struct {
	mqtt.HookBase
}

// ID names the hook in mochi's logs.
func (h *denyBranchHook) ID() string { return "fdp-deny-branch" }

// Provides reports the two hook points this hook implements.
func (h *denyBranchHook) Provides(b byte) bool {
	switch b {
	case mqtt.OnConnectAuthenticate, mqtt.OnACLCheck:
		return true
	default:
		return false
	}
}

// OnConnectAuthenticate accepts every client: the embedded broker exists to
// test the wrapper, not authentication.
func (h *denyBranchHook) OnConnectAuthenticate(_ *mqtt.Client, _ packets.Packet) bool { return true }

// OnACLCheck refuses the denied branch for both reading and writing. topic is
// the published topic on a write and the subscribe filter on a read, and both
// forms start with the same prefix.
func (h *denyBranchHook) OnACLCheck(_ *mqtt.Client, topic string, _ bool) bool {
	return !strings.HasPrefix(topic, DeniedPrefix)
}

// assert the hook satisfies mochi's interface at compile time.
var _ mqtt.Hook = (*denyBranchHook)(nil)
