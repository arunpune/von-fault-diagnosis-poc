// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
)

// Session defaults: a 20 s keep-alive with a 60 s session expiry survives a
// broker restart without leaving a stale session behind for a whole minute.
const (
	// DefaultKeepAliveS is the keep-alive used when Config leaves it at zero.
	DefaultKeepAliveS uint16 = 20
	// DefaultSessionExpiryS is the session expiry used when Config leaves it at zero.
	DefaultSessionExpiryS uint32 = 60
	// resubscribeTimeout bounds one SUBSCRIBE sent while restoring the
	// subscriptions of a reconnected client.
	resubscribeTimeout = 10 * time.Second
)

// Reconnect backoff. autopaho would otherwise retry every 10 s, which is a
// long outage for a gateway whose broker was merely restarted; these bounds
// retry within a second at first and settle at half a minute. Nothing outside
// this package fixes them, so they are the wrapper's own choice.
const (
	reconnectMinDelay        = 250 * time.Millisecond
	reconnectMaxDelay        = 30 * time.Second
	reconnectInitialMaxDelay = 1 * time.Second
	reconnectFactor          = 1.5
)

// Config is everything a service needs to reach the broker. Password is never
// logged and never appears in an error message.
type Config struct {
	// URL is the broker address, for example "mqtt://mqtt:1883".
	URL string
	// ClientID is the MQTT client identifier, "<service>-<hostname>" by
	// convention.
	ClientID string
	// Username and Password are the broker credentials; an empty Username
	// connects anonymously.
	Username string
	Password string
	// KeepAliveS is the keep-alive in seconds; zero means DefaultKeepAliveS.
	KeepAliveS uint16
	// SessionExpiryS is the session expiry in seconds; zero means
	// DefaultSessionExpiryS.
	SessionExpiryS uint32
}

// Handler receives one publication. It runs on the client's dispatch
// goroutine, in the order the broker delivered the messages, so it may block
// without stalling the network loop — but it delays every later message.
type Handler func(topic string, payload []byte, retain bool)

// ReasonError reports an MQTT 5 reason code of 0x80 or above: the broker
// accepted the packet and refused the action. The ACL tests assert on Code,
// where 0x87 is "Not authorized".
type ReasonError struct {
	// Code is the SUBACK or PUBACK reason code.
	Code byte
	// Op is "subscribe" or "publish".
	Op string
	// Topic is the topic or filter the broker refused.
	Topic string
}

func (e *ReasonError) Error() string {
	return fmt.Sprintf("mqttio: %s %q refused by the broker with reason code 0x%02x", e.Op, e.Topic, e.Code)
}

// reasonFailure is the first reason code that means failure (MQTT 5 §2.4).
const reasonFailure byte = 0x80

// subscription is one remembered filter, replayed after every reconnect.
type subscription struct {
	filter  string
	qos     byte
	handler Handler
}

// delivery is one received publication waiting for the dispatch goroutine.
type delivery struct {
	topic   string
	payload []byte
	retain  bool
}

// Client is a connected MQTT 5 client. It is safe for concurrent use.
type Client struct {
	cm     *autopaho.ConnectionManager
	cancel context.CancelFunc
	// ready is closed once cm is set; the OnConnectionUp callback may fire
	// before autopaho.NewConnection has returned.
	ready chan struct{}
	// logURL is the broker URL with any userinfo password replaced.
	logURL   string
	clientID string

	up atomic.Bool

	mu   sync.RWMutex
	subs []subscription

	// queue is an unbounded FIFO: the paho reader appends and signals, the
	// dispatch goroutine drains. Unbounded is deliberate — a bounded queue
	// would push back on the reader, which is what this design avoids.
	qmu      sync.Mutex
	qcond    *sync.Cond
	queue    []delivery
	qclosed  bool
	pumpDone chan struct{}

	closeOnce sync.Once
	done      chan struct{}
}

// Connect dials the broker and returns once the connection is up.
//
// onUp, when not nil, runs after every successful connection — the first one
// and every reconnect — with the client as its argument, which is where a
// caller subscribes. The wrapper has already restored the subscriptions of
// earlier calls to Subscribe by then, so a caller that subscribes once after
// Connect is equally safe.
//
// ctx bounds the wait for the first connection only; the connection itself
// outlives it and ends with Close.
func Connect(ctx context.Context, cfg Config, onUp func(*Client)) (*Client, error) {
	broker, err := url.Parse(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("mqttio: parsing the broker URL: %w", err)
	}
	if broker.Host == "" {
		return nil, fmt.Errorf("mqttio: the broker URL %q has no host", broker.Redacted())
	}
	// MQTT credentials travel in the CONNECT packet, not in the URL. Any
	// userinfo is dropped before the URL reaches autopaho, which repeats it
	// verbatim in its connection errors — a password in the URL would
	// otherwise reach a log line through them.
	dialURL := *broker
	dialURL.User = nil

	c := &Client{
		ready:    make(chan struct{}),
		logURL:   dialURL.Redacted(),
		clientID: cfg.ClientID,
		pumpDone: make(chan struct{}),
		done:     make(chan struct{}),
	}
	c.qcond = sync.NewCond(&c.qmu)

	keepAlive := cfg.KeepAliveS
	if keepAlive == 0 {
		keepAlive = DefaultKeepAliveS
	}
	sessionExpiry := cfg.SessionExpiryS
	if sessionExpiry == 0 {
		sessionExpiry = DefaultSessionExpiryS
	}

	// The connection manager must outlive ctx, which only bounds the wait for
	// the first connection: cancelling the context passed to NewConnection
	// shuts the manager down.
	connCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	c.cancel = cancel

	pahoCfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{&dialURL},
		KeepAlive:                     keepAlive,
		SessionExpiryInterval:         sessionExpiry,
		CleanStartOnInitialConnection: true,
		ReconnectBackoff: autopaho.NewExponentialBackoff(
			reconnectMinDelay, reconnectMaxDelay, reconnectInitialMaxDelay, reconnectFactor),
		ConnectUsername: cfg.Username,
		ConnectPassword: []byte(cfg.Password),
		OnConnectionUp: func(cm *autopaho.ConnectionManager, _ *paho.Connack) {
			// The snapshot is taken here, synchronously, and not in the
			// goroutine below: it must hold exactly the subscriptions that
			// existed before this connection came up. A Subscribe that starts
			// afterwards sends its own SUBSCRIBE, and replaying it as well
			// would make the broker deliver every retained message twice. On
			// the first connection the snapshot is empty, which is why Connect
			// does not re-subscribe anything.
			c.mu.RLock()
			restore := slices.Clone(c.subs)
			c.mu.RUnlock()

			// Must not block: autopaho calls this on its main loop.
			go c.connectionUp(cm, restore, onUp)
		},
		OnConnectionDown: func() bool {
			c.up.Store(false)
			return true
		},
		OnConnectError: func(err error) {
			c.warn("mqtt connection attempt failed", err)
		},
		ClientConfig: paho.ClientConfig{
			ClientID:          cfg.ClientID,
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){c.onPublishReceived},
			OnClientError: func(err error) {
				c.warn("mqtt client error", err)
			},
		},
	}

	cm, err := autopaho.NewConnection(connCtx, pahoCfg)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("mqttio: starting the connection to %s: %w", c.logURL, err)
	}
	c.cm = cm
	close(c.ready)
	go c.pump()

	if err := cm.AwaitConnection(ctx); err != nil {
		// Nothing is handed to the caller, so this client is shut down here:
		// closing done releases any OnConnectionUp goroutine that raced the
		// failure, and stopPump joins the dispatch goroutine.
		cancel()
		close(c.done)
		c.stopPump()
		return nil, fmt.Errorf("mqttio: waiting for the connection to %s: %w", c.logURL, err)
	}
	return c, nil
}

// Connected reports whether the connection is currently up. It is a health
// signal, not a guarantee: the link can drop between the call and the next
// publish.
func (c *Client) Connected() bool { return c.up.Load() }

// Publish sends one message and waits for its acknowledgement. A PUBACK reason
// code of 0x80 or above becomes a *ReasonError; a ctx deadline becomes the
// context error, so errors.Is(err, context.DeadlineExceeded) holds.
func (c *Client) Publish(ctx context.Context, topic string, payload []byte, qos byte, retain bool) error {
	resp, err := c.cm.Publish(ctx, &paho.Publish{
		Topic:   topic,
		QoS:     qos,
		Retain:  retain,
		Payload: payload,
	})
	// paho reports a failing reason code as an error and still hands back the
	// PUBACK, so the code is read first: a refusal is a *ReasonError, not an
	// opaque transport failure. QoS 0 is unacknowledged and has no response.
	if resp != nil && resp.ReasonCode >= reasonFailure {
		return &ReasonError{Code: resp.ReasonCode, Op: "publish", Topic: topic}
	}
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("mqttio: publishing to %q: %w", topic, ctxErr)
		}
		return fmt.Errorf("mqttio: publishing to %q: %w", topic, err)
	}
	return nil
}

// Subscribe registers h for filter and sends the SUBSCRIBE. A SUBACK reason
// code of 0x80 or above becomes a *ReasonError and the handler is dropped
// again, so a refused filter is not retried after a reconnect.
//
// Subscribing twice to the same filter replaces the handler rather than adding
// a second one, which is what makes a Subscribe from the OnConnectionUp
// callback idempotent.
func (c *Client) Subscribe(ctx context.Context, filter string, qos byte, h Handler) error {
	if h == nil {
		return errors.New("mqttio: Subscribe needs a handler")
	}
	previous, had := c.remember(subscription{filter: filter, qos: qos, handler: h})

	ack, err := c.cm.Subscribe(ctx, &paho.Subscribe{
		Subscriptions: []paho.SubscribeOptions{{Topic: filter, QoS: qos}},
	})
	// As in Publish, paho reports a failing SUBACK as an error and still hands
	// back the packet, so the reason code decides first.
	code, single := subackReason(ack)
	switch {
	case single && code >= reasonFailure:
		c.restore(filter, previous, had)
		return &ReasonError{Code: code, Op: "subscribe", Topic: filter}
	case err != nil:
		c.restore(filter, previous, had)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("mqttio: subscribing to %q: %w", filter, ctxErr)
		}
		return fmt.Errorf("mqttio: subscribing to %q: %w", filter, err)
	case !single:
		c.restore(filter, previous, had)
		return fmt.Errorf("mqttio: subscribing to %q: the broker did not answer with exactly one reason code", filter)
	}
	return nil
}

// subackReason returns the single reason code of a SUBACK answering a
// one-filter SUBSCRIBE, and whether there was exactly one.
func subackReason(ack *paho.Suback) (byte, bool) {
	if ack == nil || len(ack.Reasons) != 1 {
		return 0, false
	}
	return ack.Reasons[0], true
}

// Close disconnects and waits for the client to shut down. It is idempotent:
// every call after the first returns nil without touching the connection.
func (c *Client) Close(ctx context.Context) error {
	var err error
	c.closeOnce.Do(func() {
		close(c.done)
		err = c.cm.Disconnect(ctx)
		c.cancel()
		c.stopPump()
		c.up.Store(false)
	})
	return err
}

// connectionUp restores the subscriptions of earlier connections and then
// hands the client to the caller's callback. It runs on its own goroutine per
// connection, because both steps block on the broker's answer.
func (c *Client) connectionUp(cm *autopaho.ConnectionManager, restore []subscription, onUp func(*Client)) {
	select {
	case <-c.ready:
	case <-c.done:
		return
	}
	c.up.Store(true)
	c.resubscribe(cm, restore)
	if onUp != nil {
		onUp(c)
	}
}

// resubscribe re-sends the given SUBSCRIBEs on the connection that just came
// up. A failure is logged and left alone: the filter stays remembered and the
// next reconnect tries again.
func (c *Client) resubscribe(cm *autopaho.ConnectionManager, subs []subscription) {
	for _, s := range subs {
		select {
		case <-c.done:
			return
		default:
		}

		ctx, cancel := context.WithTimeout(context.Background(), resubscribeTimeout)
		ack, err := cm.Subscribe(ctx, &paho.Subscribe{
			Subscriptions: []paho.SubscribeOptions{{Topic: s.filter, QoS: s.qos}},
		})
		cancel()

		code, single := subackReason(ack)
		switch {
		case single && code >= reasonFailure:
			c.warn("restoring an MQTT subscription failed",
				&ReasonError{Code: code, Op: "subscribe", Topic: s.filter},
				slog.String("filter", s.filter))
		case err != nil:
			c.warn("restoring an MQTT subscription failed", err, slog.String("filter", s.filter))
		}
	}
}

// remember stores s, replacing any handler already registered for the same
// filter. It returns the replaced subscription and whether there was one, so a
// failed SUBSCRIBE can be rolled back.
func (c *Client) remember(s subscription) (previous subscription, had bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for i := range c.subs {
		if c.subs[i].filter == s.filter {
			previous, had = c.subs[i], true
			c.subs[i] = s
			return previous, had
		}
	}
	c.subs = append(c.subs, s)
	return subscription{}, false
}

// restore undoes remember after a refused or failed SUBSCRIBE.
func (c *Client) restore(filter string, previous subscription, had bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for i := range c.subs {
		if c.subs[i].filter != filter {
			continue
		}
		if had {
			c.subs[i] = previous
			return
		}
		c.subs = append(c.subs[:i], c.subs[i+1:]...)
		return
	}
}

// onPublishReceived hands the message to the dispatch queue and returns at
// once; nothing in this call path may block the paho reader.
func (c *Client) onPublishReceived(pr paho.PublishReceived) (bool, error) {
	c.enqueue(delivery{
		topic: pr.Packet.Topic,
		// paho reuses its read buffers, so the payload is copied.
		payload: slices.Clone(pr.Packet.Payload),
		retain:  pr.Packet.Retain,
	})
	return true, nil
}

func (c *Client) enqueue(d delivery) {
	c.qmu.Lock()
	defer c.qmu.Unlock()

	if c.qclosed {
		return
	}
	c.queue = append(c.queue, d)
	c.qcond.Signal()
}

// pump drains the queue in order on one goroutine per client.
func (c *Client) pump() {
	defer close(c.pumpDone)

	for {
		c.qmu.Lock()
		for len(c.queue) == 0 && !c.qclosed {
			c.qcond.Wait()
		}
		if len(c.queue) == 0 {
			c.qmu.Unlock()
			return
		}
		d := c.queue[0]
		c.queue[0] = delivery{}
		c.queue = c.queue[1:]
		c.qmu.Unlock()

		c.dispatch(d)
	}
}

// stopPump closes the queue and waits for the dispatch goroutine to drain what
// is left, so a handler is never running after Close returns.
func (c *Client) stopPump() {
	c.qmu.Lock()
	c.qclosed = true
	c.qcond.Broadcast()
	c.qmu.Unlock()
	<-c.pumpDone
}

// dispatch calls every handler whose filter matches, in registration order.
func (c *Client) dispatch(d delivery) {
	c.mu.RLock()
	handlers := make([]Handler, 0, len(c.subs))
	for _, s := range c.subs {
		if Match(s.filter, d.topic) {
			handlers = append(handlers, s.handler)
		}
	}
	c.mu.RUnlock()

	for _, h := range handlers {
		h(d.topic, d.payload, d.retain)
	}
}

// warn logs at warn level. The credentials never reach it: the URL is
// redacted, and the password is not among the attributes.
func (c *Client) warn(msg string, err error, attrs ...slog.Attr) {
	args := make([]any, 0, 3+len(attrs))
	args = append(args,
		slog.String("client_id", c.clientID),
		slog.String("broker", c.logURL),
		slog.Any("error", err))
	for _, a := range attrs {
		args = append(args, a)
	}
	slog.Default().Warn(msg, args...)
}
