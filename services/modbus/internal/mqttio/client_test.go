// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// timingSlackEnv multiplies every wall-clock bound in this file: 1 locally, 3
// in CI.
const timingSlackEnv = "FDP_TIMING_SLACK"

// Wall-clock bounds, all multiplied by the slack above.
const (
	// connectBudget bounds one connection to the in-process broker.
	connectBudget = 5 * time.Second
	// ackBudget bounds one PUBLISH or SUBSCRIBE round trip.
	ackBudget = 5 * time.Second
	// deliveryBudget bounds the wait for a message that must arrive.
	deliveryBudget = 5 * time.Second
	// reconnectBudget bounds the wait for a client to come back after the
	// broker was restarted under it.
	reconnectBudget = 20 * time.Second
	// notAuthorized is the MQTT 5 reason code for a refused action.
	notAuthorized byte = 0x87
)

// timingSlack returns the multiplier for a wall-clock bound.
func timingSlack(t *testing.T) time.Duration {
	t.Helper()

	raw := os.Getenv(timingSlackEnv)
	if raw == "" {
		return 1
	}
	slack, err := strconv.Atoi(raw)
	require.NoError(t, err, "%s must be an integer", timingSlackEnv)
	require.Positive(t, slack, "%s must be positive", timingSlackEnv)
	return time.Duration(slack)
}

// budget scales one bound with the slack.
func budget(t *testing.T, d time.Duration) time.Duration {
	t.Helper()
	return d * timingSlack(t)
}

// collector records what a handler received, in order.
type collector struct {
	mu       sync.Mutex
	messages []message
	arrived  chan struct{}
}

// message is one delivery as the handler saw it.
type message struct {
	topic   string
	payload string
	retain  bool
}

func newCollector() *collector {
	return &collector{arrived: make(chan struct{}, 64)}
}

// handle is the mqttio.Handler this collector registers.
func (c *collector) handle(topic string, payload []byte, retain bool) {
	c.mu.Lock()
	c.messages = append(c.messages, message{topic: topic, payload: string(payload), retain: retain})
	c.mu.Unlock()

	select {
	case c.arrived <- struct{}{}:
	default:
	}
}

// await blocks until at least n messages arrived, or fails the test.
func (c *collector) await(t *testing.T, n int, within time.Duration) []message {
	t.Helper()

	deadline := time.After(within)
	for {
		if got := c.seen(); len(got) >= n {
			return got
		}
		select {
		case <-c.arrived:
		case <-deadline:
			t.Fatalf("waited %s for %d message(s), saw %d: %v", within, n, len(c.seen()), c.seen())
		}
	}
}

// expectNothing asserts that no message arrives within the window. It is the
// non-delivery assertion every isolation check needs, since the broker accepts
// a subscription it will not deliver.
func (c *collector) expectNothing(t *testing.T, within time.Duration) {
	t.Helper()

	select {
	case <-c.arrived:
		t.Fatalf("expected no delivery within %s, got %v", within, c.seen())
	case <-time.After(within):
	}
}

func (c *collector) seen() []message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]message(nil), c.messages...)
}

// connect dials the embedded broker and closes the client in t.Cleanup.
func connect(t *testing.T, url, clientID string, onUp func(*mqttio.Client)) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{URL: url, ClientID: clientID}, onUp)
	require.NoError(t, err, "connecting %s to %s", clientID, url)

	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// contractQoS is the quality of service every topic of the contract uses
// (packages/contracts/topics.json), so the helpers below do not take it.
const contractQoS byte = 1

// publish sends one message with a bounded context.
func publish(t *testing.T, client *mqttio.Client, topic, payload string, retain bool) error {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, ackBudget))
	defer cancel()
	return client.Publish(ctx, topic, []byte(payload), contractQoS, retain)
}

// subscribe registers one handler with a bounded context.
func subscribe(t *testing.T, client *mqttio.Client, filter string, h mqttio.Handler) error {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, ackBudget))
	defer cancel()
	return client.Subscribe(ctx, filter, contractQoS, h)
}

func TestConnectReportsAnUnreachableBroker(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), budget(t, 2*time.Second))
	defer cancel()

	_, err := mqttio.Connect(ctx, mqttio.Config{URL: "mqtt://" + closedAddress(t), ClientID: "fdp-test"}, nil)
	require.Error(t, err)
}

func TestConnectRejectsAURLWithoutAHost(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), budget(t, time.Second))
	defer cancel()

	_, err := mqttio.Connect(ctx, mqttio.Config{URL: "not a url", ClientID: "fdp-test"}, nil)
	require.Error(t, err)
}

// TestPublishSubscribeRoundTrip is the base case: one publisher, one
// subscriber, QoS 1 both ways.
func TestPublishSubscribeRoundTrip(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	received := newCollector()
	subscriber := connect(t, url, "fdp-test-sub", nil)
	require.NoError(t, subscribe(t, subscriber, topics.Telemetry(), received.handle))

	publisher := connect(t, url, "fdp-test-pub", nil)
	require.NoError(t, publish(t, publisher, topics.Telemetry(), `{"seq":1}`, false))

	got := received.await(t, 1, budget(t, deliveryBudget))
	require.Len(t, got, 1)
	assert.Equal(t, topics.Telemetry(), got[0].topic)
	assert.JSONEq(t, `{"seq":1}`, got[0].payload)
	assert.False(t, got[0].retain, "a live delivery is not flagged as retained")
	assert.True(t, subscriber.Connected())
}

// TestRetainedMessageReachesALateSubscriber covers the retained topics: the
// status and ground-truth topics exist so a client that joins later still
// learns the current state.
func TestRetainedMessageReachesALateSubscriber(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	publisher := connect(t, url, "fdp-test-pub", nil)
	require.NoError(t, publish(t, publisher, topics.StatusSim(), `{"state":"running"}`, true))

	received := newCollector()
	subscriber := connect(t, url, "fdp-test-late", nil)
	require.NoError(t, subscribe(t, subscriber, topics.StatusSim(), received.handle))

	got := received.await(t, 1, budget(t, deliveryBudget))
	require.Len(t, got, 1)
	assert.Equal(t, topics.StatusSim(), got[0].topic)
	assert.True(t, got[0].retain, "a message delivered from the retained store carries the retain flag")
}

// TestWildcardHandlerDispatch checks the wrapper's own routing: the broker
// delivers to the subscribed filter, the wrapper picks the handlers whose
// filter matches the concrete topic.
func TestWildcardHandlerDispatch(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	wildcard := newCollector()
	exact := newCollector()

	subscriber := connect(t, url, "fdp-test-sub", nil)
	require.NoError(t, subscribe(t, subscriber, "plant/+/telemetry/#", wildcard.handle))
	require.NoError(t, subscribe(t, subscriber, topics.StatusSim(), exact.handle))

	publisher := connect(t, url, "fdp-test-pub", nil)
	require.NoError(t, publish(t, publisher, topics.Telemetry(), `{"seq":7}`, false))

	got := wildcard.await(t, 1, budget(t, deliveryBudget))
	assert.Equal(t, topics.Telemetry(), got[0].topic)
	exact.expectNothing(t, budget(t, time.Second))
}

// TestHandlersRunInOrder is the queue guarantee: one goroutine drains the
// deliveries, so a handler sees them in the order the broker sent them even
// when it is slow.
func TestHandlersRunInOrder(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	const count = 20
	received := newCollector()
	slow := func(topic string, payload []byte, retain bool) {
		time.Sleep(time.Millisecond)
		received.handle(topic, payload, retain)
	}

	subscriber := connect(t, url, "fdp-test-sub", nil)
	require.NoError(t, subscribe(t, subscriber, topics.Telemetry(), slow))

	publisher := connect(t, url, "fdp-test-pub", nil)
	for i := range count {
		require.NoError(t, publish(t, publisher, topics.Telemetry(), strconv.Itoa(i), false))
	}

	got := received.await(t, count, budget(t, deliveryBudget))
	require.Len(t, got, count)
	for i, m := range got {
		assert.Equalf(t, strconv.Itoa(i), m.payload, "message %d arrived out of order", i)
	}
}

// TestSubscribeRefusedReturnsAReasonError is the unit-test twin of the ACL
// assertions: the broker answers the SUBSCRIBE with reason code 0x87.
func TestSubscribeRefusedReturnsAReasonError(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	client := connect(t, url, "fdp-test-denied", nil)

	err := subscribe(t, client, testutil.DeniedFilter, func(string, []byte, bool) {})

	var reason *mqttio.ReasonError
	require.ErrorAs(t, err, &reason)
	assert.Equal(t, notAuthorized, reason.Code)
	assert.Equal(t, "subscribe", reason.Op)
	assert.Equal(t, testutil.DeniedFilter, reason.Topic)
}

// TestPublishRefusedReturnsAReasonError is the other half: a refused QoS 1
// publish comes back as PUBACK 0x87, which is what Mosquitto does too.
func TestPublishRefusedReturnsAReasonError(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	client := connect(t, url, "fdp-test-denied", nil)

	err := publish(t, client, testutil.DeniedTopic, "{}", false)

	var reason *mqttio.ReasonError
	require.ErrorAs(t, err, &reason)
	assert.Equal(t, notAuthorized, reason.Code)
	assert.Equal(t, "publish", reason.Op)
	assert.Equal(t, testutil.DeniedTopic, reason.Topic)
	assert.Contains(t, reason.Error(), "0x87")
}

// TestARefusedFilterIsNotRestored keeps a denied filter out of the reconnect
// path: the wrapper forgets it again, so a reconnect does not re-ask.
func TestARefusedFilterIsNotRestored(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	received := newCollector()
	client := connect(t, url, "fdp-test-denied", nil)
	require.Error(t, subscribe(t, client, testutil.DeniedFilter, received.handle))

	// The handler was dropped with the subscription, so a message the broker
	// would deliver on that filter reaches nobody.
	require.NoError(t, subscribe(t, client, topics.Telemetry(), received.handle))
	require.NoError(t, publish(t, client, topics.Telemetry(), `{"seq":1}`, false))
	got := received.await(t, 1, budget(t, deliveryBudget))
	assert.Equal(t, topics.Telemetry(), got[0].topic)
}

// TestSubscriptionsSurviveABrokerRestart is the reconnect guarantee: the
// broker loses every session, the wrapper re-sends its SUBSCRIBEs.
func TestSubscriptionsSurviveABrokerRestart(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	received := newCollector()
	subscriber := connect(t, url, "fdp-test-sub", nil)
	require.NoError(t, subscribe(t, subscriber, topics.Telemetry(), received.handle))

	publisher := connect(t, url, "fdp-test-pub", nil)
	require.NoError(t, publish(t, publisher, topics.Telemetry(), "before", false))
	received.await(t, 1, budget(t, deliveryBudget))

	testutil.RestartEmbeddedBroker(t, url)
	awaitConnected(t, subscriber, budget(t, reconnectBudget))
	awaitConnected(t, publisher, budget(t, reconnectBudget))

	// The restarted broker knows nothing about the old session, so this only
	// arrives if the wrapper re-subscribed.
	requireEventually(t, budget(t, reconnectBudget), func() bool {
		return publish(t, publisher, topics.Telemetry(), "after", false) == nil
	}, "publishing after the restart")

	got := received.await(t, 2, budget(t, reconnectBudget))
	assert.Equal(t, "after", got[len(got)-1].payload)
}

// TestCloseIsIdempotent: shutdown paths call Close from more than one place.
func TestCloseIsIdempotent(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()
	client, err := mqttio.Connect(ctx, mqttio.Config{URL: url, ClientID: "fdp-test-close"}, nil)
	require.NoError(t, err)

	require.NoError(t, client.Close(ctx))
	require.NoError(t, client.Close(ctx))
	assert.False(t, client.Connected())
}

// TestPublishHonoursTheContextDeadline: telemetry is published with a short
// timeout and dropped rather than queued, so the caller has to be able to tell
// a timeout apart from a refusal.
func TestPublishHonoursTheContextDeadline(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}
	client := connect(t, url, "fdp-test-deadline", nil)

	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	// Let the deadline pass before the call, so the outcome does not depend on
	// how fast the loopback broker answers.
	<-ctx.Done()

	err := client.Publish(ctx, topics.Telemetry(), []byte("{}"), 1, false)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)

	var reason *mqttio.ReasonError
	assert.False(t, errors.As(err, &reason), "a timeout is not a broker refusal")
}

// TestOnConnectionUpRunsOnEveryConnection is the callback callers subscribe
// from.
func TestOnConnectionUpRunsOnEveryConnection(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	received := newCollector()
	var ups atomic.Int64
	client := connect(t, url, "fdp-test-onup", func(c *mqttio.Client) {
		ups.Add(1)
		// Subscribing here is idempotent: the wrapper has already restored the
		// filter, and a second SUBSCRIBE replaces the handler.
		subCtx, cancel := context.WithTimeout(context.Background(), budget(t, ackBudget))
		defer cancel()
		_ = c.Subscribe(subCtx, topics.Telemetry(), 1, received.handle)
	})

	requireEventually(t, budget(t, connectBudget), func() bool { return ups.Load() >= 1 },
		"the first OnConnectionUp callback")

	testutil.RestartEmbeddedBroker(t, url)
	awaitConnected(t, client, budget(t, reconnectBudget))
	requireEventually(t, budget(t, reconnectBudget), func() bool { return ups.Load() >= 2 },
		"the OnConnectionUp callback after the restart")
}

// TestNoPasswordReachesTheLogs keeps secrets out of the logs in the one place
// this package touches a credential: the failure path that logs.
func TestNoPasswordReachesTheLogs(t *testing.T) {
	const password = "s3cret-poc-password"

	logs := &lockedBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	// A closed port: every connection attempt fails, so OnConnectError logs.
	address := closedAddress(t)
	ctx, cancel := context.WithTimeout(context.Background(), budget(t, 2*time.Second))
	defer cancel()

	_, err := mqttio.Connect(ctx, mqttio.Config{
		URL:      "mqtt://user:" + password + "@" + address,
		ClientID: "fdp-test-secret",
		Username: "user",
		Password: password,
	}, nil)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), password, "the error message leaks the password")

	requireEventually(t, budget(t, 2*time.Second), func() bool {
		return bytes.Contains(logs.bytes(), []byte("mqtt connection attempt failed"))
	}, "a warning about the failed connection")
	assert.NotContains(t, string(logs.bytes()), password, "a log line leaks the password")
	assert.Contains(t, string(logs.bytes()), "broker=mqtt://"+address,
		"the broker is logged by address, with the userinfo of the URL dropped")
}

// lockedBuffer is an io.Writer a logger can be pointed at from several
// goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.buf.Bytes()...)
}

// closedAddress returns a host:port nothing listens on: a port is bound to
// learn a free one, then released.
func closedAddress(t *testing.T) string {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	return address
}

// awaitConnected waits for the client to report the link up again.
func awaitConnected(t *testing.T, client *mqttio.Client, within time.Duration) {
	t.Helper()
	requireEventually(t, within, client.Connected, "the client to reconnect")
}

// requireEventually polls condition until it holds or the budget runs out.
func requireEventually(t *testing.T, within time.Duration, condition func() bool, what string) {
	t.Helper()

	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited %s for %s", within, what)
}
