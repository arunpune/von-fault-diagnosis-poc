// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The control plane, the status publisher and the ground-truth publisher run
// here against the in-process broker of internal/testutil and a fake clock:
// every message is a real MQTT publication, and nothing in the file waits for
// wall time except the deliveries themselves. control_integration_test.go
// repeats the same round trips against a real Mosquitto with the committed
// ACL.
//
// The harness below is shared with status_test.go, gt_test.go and
// noleak_test.go.

package sim_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// Wall-clock bounds. They only ever bound a failure: every fact the tests
// assert is produced by the fake clock, and each bound is multiplied by
// FDP_TIMING_SLACK through budget.
const (
	// deliveryBudget is how long a message that must arrive is waited for.
	deliveryBudget = 5 * time.Second
	// connectBudget bounds one connection to the in-process broker.
	connectBudget = 10 * time.Second
	// silenceWindow is how long a topic is watched before its silence counts.
	silenceWindow = 2 * time.Second
	// ackDeadline is the acknowledgement budget, measured from the PUBLISH of
	// the command to the arrival of its answer.
	ackDeadline = 100 * time.Millisecond
)

// The fixed instants the fake clocks start at, so every rendered document is
// byte-for-byte predictable.
const (
	// wallStart is what wall_ts carries until a test advances the clock.
	wallStart = "2026-09-20T09:00:00.000Z"
	// datasetFirst and datasetLast are the bounds of the 120-row synthetic
	// file the harness generates, ten seconds apart (testutil.SynthStart).
	datasetFirst = "2020-02-01T00:00:00.000Z"
	datasetLast  = "2020-02-01T00:19:50.000Z"
	datasetRows  = 120
)

// budget scales one wall-clock bound with FDP_TIMING_SLACK.
func budget(t *testing.T, d time.Duration) time.Duration {
	t.Helper()
	return d * timingSlack(t)
}

// mqttMessage is one delivery as the observer saw it.
type mqttMessage struct {
	topic   string
	payload []byte
	retain  bool
	// at is when the observer's handler ran, which is what the
	// acknowledgement deadline is measured against.
	at time.Time
}

// mqttCollector records what a subscription delivered, in order.
type mqttCollector struct {
	mu       sync.Mutex
	messages []mqttMessage
	arrived  chan struct{}
}

// newCollector returns an empty collector.
func newCollector() *mqttCollector {
	return &mqttCollector{arrived: make(chan struct{}, 256)}
}

// handle is the mqttio.Handler the collector registers.
func (c *mqttCollector) handle(topic string, payload []byte, retain bool) {
	c.mu.Lock()
	c.messages = append(c.messages, mqttMessage{
		topic: topic, payload: append([]byte(nil), payload...), retain: retain, at: time.Now(),
	})
	c.mu.Unlock()

	select {
	case c.arrived <- struct{}{}:
	default:
	}
}

// on returns every message delivered on one topic so far.
func (c *mqttCollector) on(topic string) []mqttMessage {
	c.mu.Lock()
	defer c.mu.Unlock()

	var out []mqttMessage
	for _, m := range c.messages {
		if m.topic == topic {
			out = append(out, m)
		}
	}
	return out
}

// under returns every message delivered on a topic starting with prefix.
func (c *mqttCollector) under(prefix string) []mqttMessage {
	c.mu.Lock()
	defer c.mu.Unlock()

	var out []mqttMessage
	for _, m := range c.messages {
		if strings.HasPrefix(m.topic, prefix) {
			out = append(out, m)
		}
	}
	return out
}

// await waits until n messages have arrived on topic and returns them.
func (c *mqttCollector) await(t *testing.T, topic string, n int, within time.Duration) []mqttMessage {
	t.Helper()

	var got []mqttMessage
	require.Eventuallyf(t, func() bool {
		got = c.on(topic)
		return len(got) >= n
	}, within, time.Millisecond, "%d messages on %s, expected %d", len(c.on(topic)), topic, n)
	return got
}

// expectNothing asserts that nothing arrives under prefix for the whole
// window. It is the non-delivery form of an isolation check and needs a
// positive control beside it.
func (c *mqttCollector) expectNothing(t *testing.T, prefix string, window time.Duration) {
	t.Helper()

	deadline := time.After(window)
	for {
		select {
		case <-deadline:
			assert.Empty(t, c.under(prefix), "nothing may be delivered under %s", prefix)
			return
		case <-c.arrived:
			require.Emptyf(t, c.under(prefix), "a message was delivered under %s", prefix)
		}
	}
}

// controlOpts configures the harness.
type controlOpts struct {
	// Rows is how many synthetic rows the recording holds.
	Rows int
	// Catalog is the injection catalog; nil offers the harness default.
	Catalog *injection.Catalog
	// Presets are the jump targets.
	Presets []sim.Preset
	// Speed, Autoplay and Loop are the engine configuration.
	Speed    uint16
	Autoplay bool
	Loop     bool
	// GTDir overrides where the forwarded ground-truth documents are read
	// from; the default is services/modbus/testdata/gt.
	GTDir string
}

// control is one wired machine: an engine on a synthetic recording, the three
// publishers, a simulator client and an observer that sees every topic.
type control struct {
	t      *testing.T
	clock  *testutil.FakeClock
	engine *sim.Engine
	plane  *sim.ControlPlane
	gt     *sim.GtPublisher
	status *sim.StatusPublisher
	topics mqttio.Topics
	seen   *mqttCollector

	url string
	ops *mqttio.Client

	cancel  context.CancelFunc
	engines chan error
	ticker  chan struct{}
	stopped bool
}

// newControl builds and starts the whole control plane. It stops with the
// test.
func newControl(t *testing.T, opts controlOpts) *control {
	t.Helper()

	if opts.Speed == 0 {
		opts.Speed = 1
	}
	if opts.Rows == 0 {
		opts.Rows = datasetRows
	}
	if opts.Catalog == nil {
		opts.Catalog = testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60))
	}
	if opts.GTDir == "" {
		opts.GTDir = testutil.TestdataPath("gt")
	}

	source, err := replay.Open(synthCSV(t, opts.Rows, nil), regmap.Signals)
	require.NoError(t, err)
	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)

	start, err := time.Parse(time.RFC3339, wallStart)
	require.NoError(t, err)

	c := &control{
		t:       t,
		clock:   testutil.NewFakeClock(start),
		topics:  mqttio.Topics{UnitID: mqttio.DefaultUnitID},
		seen:    newCollector(),
		url:     testutil.StartEmbeddedBroker(t),
		engines: make(chan error, 1),
		ticker:  make(chan struct{}),
	}

	engine, err := sim.New(sim.Config{
		Speed:    opts.Speed,
		Autoplay: opts.Autoplay,
		Loop:     opts.Loop,
		Presets:  opts.Presets,
	}, source, injection.NewEngine(regmap.Signals, opts.Catalog, injection.WithBootID("aaaaaa")),
		alarms, c.clock, sim.NewStore())
	require.NoError(t, err)
	c.engine = engine

	documents, err := sim.LoadGtDocuments(sim.Config{GTDir: opts.GTDir})
	require.NoError(t, err)

	c.gt, err = sim.NewGtPublisher(sim.GtConfig{
		UnitID:    mqttio.DefaultUnitID,
		Clock:     c.clock,
		Documents: documents,
		Catalog:   opts.Catalog,
		Gaps:      len(source.Gaps()),
	})
	require.NoError(t, err)

	c.status = sim.NewStatusPublisher(mqttio.DefaultUnitID, c.clock, start)
	c.plane, err = sim.NewControlPlane(sim.ControlPlaneConfig{
		Engine: engine,
		UnitID: mqttio.DefaultUnitID,
		Clock:  c.clock,
		Status: c.status,
		GT:     c.gt,
	})
	require.NoError(t, err)
	engine.OnMarker, engine.OnInjection = c.plane.OnMarker, c.plane.OnInjection

	ctx, cancel := context.WithCancel(t.Context())
	c.cancel = cancel
	go func() { c.engines <- engine.Run(ctx) }()

	// The observer subscribes before the simulator connects, so the retained
	// documents of the first connection arrive as live publications and the
	// order of the whole session is visible.
	observer := c.connect(t, "fdp-observer", nil)
	require.NoError(t, observer.Subscribe(c.ctx(t), "#", 1, c.seen.handle))

	c.connect(t, "fdp-sim", func(client *mqttio.Client) { c.plane.ConnectionUp(client) })
	c.ops = c.connect(t, "fdp-ops", nil)

	go func() {
		defer close(c.ticker)
		c.plane.Run(ctx)
	}()

	t.Cleanup(func() {
		c.stop()
		assert.NoError(t, engine.Close())
	})
	// Everything a session publishes on connect has to be on the wire before
	// a test counts messages.
	c.seen.await(t, c.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	c.seen.await(t, c.topics.StatusSim(), 1, budget(t, deliveryBudget))
	c.waitTimers(1)
	return c
}

// ctx returns a context bounded by the connection budget.
func (c *control) ctx(t *testing.T) context.Context {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	t.Cleanup(cancel)
	return ctx
}

// connect dials the in-process broker and closes the client with the test.
func (c *control) connect(t *testing.T, clientID string, onUp func(*mqttio.Client)) *mqttio.Client {
	t.Helper()

	client, err := mqttio.Connect(c.ctx(t), mqttio.Config{URL: c.url, ClientID: clientID}, onUp)
	require.NoError(t, err, "connecting %s", clientID)
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer cancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// stop cancels the engine and the status ticker and waits for both. It is
// idempotent.
func (c *control) stop() {
	c.t.Helper()

	if c.stopped {
		return
	}
	c.stopped = true
	c.cancel()

	select {
	case err := <-c.engines:
		assert.NoError(c.t, err)
	case <-time.After(budget(c.t, deliveryBudget)):
		c.t.Error("the emit loop did not return after its context was cancelled")
	}
	select {
	case <-c.ticker:
	case <-time.After(budget(c.t, deliveryBudget)):
		c.t.Error("the status ticker did not return after its context was cancelled")
	}
}

// waitTimers blocks until the fake clock holds at least n pending timers, so
// an Advance that follows provably wakes the work the test is measuring.
func (c *control) waitTimers(n int) {
	c.t.Helper()

	require.Eventuallyf(c.t, func() bool { return c.clock.Pending() >= n },
		budget(c.t, deliveryBudget), time.Millisecond,
		"the fake clock holds %d timers, expected %d", c.clock.Pending(), n)
}

// send publishes one control command as the backend ops client does. args is
// the raw argument object.
func (c *control) send(cmdID, cmd, args string) time.Time {
	c.t.Helper()

	payload := fmt.Sprintf(
		`{"schema":"urn:fdp:schema:control-cmd:v1","unit_id":%q,"wall_ts":%q,"cmd_id":%q,"cmd":%q,"args":%s}`,
		mqttio.DefaultUnitID, wallStart, cmdID, cmd, args)

	c.waitForOps()
	sent := time.Now()
	require.NoError(c.t, c.ops.Publish(c.ctx(c.t), c.topics.ControlCmd(), []byte(payload), 1, false))
	return sent
}

// waitForOps blocks until the commanding client has a session. After a broker
// restart every client reconnects on its own schedule, and a command published
// while this one is still down would simply be lost.
func (c *control) waitForOps() {
	c.t.Helper()

	require.Eventually(c.t, c.ops.Connected, budget(c.t, connectBudget), time.Millisecond,
		"the commanding client never reconnected")
}

// sendRaw publishes a payload the harness does not build, for the messages the
// simulator must ignore.
func (c *control) sendRaw(payload string) {
	c.t.Helper()

	c.waitForOps()
	require.NoError(c.t, c.ops.Publish(c.ctx(c.t), c.topics.ControlCmd(), []byte(payload), 1, false))
}

// command sends one command and returns its acknowledgement and how long the
// answer took.
func (c *control) command(cmdID, cmd, args string) ([]byte, time.Duration) {
	c.t.Helper()

	before := len(c.seen.on(c.topics.ControlAck()))
	sent := c.send(cmdID, cmd, args)
	acks := c.seen.await(c.t, c.topics.ControlAck(), before+1, budget(c.t, deliveryBudget))
	ack := acks[before]
	return ack.payload, ack.at.Sub(sent)
}

// ackOf is the parsed shape the tests assert on when a golden document would
// only repeat the engine's own state.
type ackOf struct {
	Schema     string          `json:"schema"`
	UnitID     string          `json:"unit_id"`
	WallTS     string          `json:"wall_ts"`
	CmdID      string          `json:"cmd_id"`
	Cmd        string          `json:"cmd"`
	OK         bool            `json:"ok"`
	Error      *ackErrorOf     `json:"error"`
	Status     json.RawMessage `json:"status"`
	InstanceID string          `json:"instance_id"`
}

// ackErrorOf is the refusal object.
type ackErrorOf struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// parseAck reads one acknowledgement.
func parseAck(t *testing.T, payload []byte) ackOf {
	t.Helper()

	var ack ackOf
	require.NoError(t, json.Unmarshal(payload, &ack), "the acknowledgement is not JSON: %s", payload)
	return ack
}

// statusGolden renders the status document a paused or playing machine on the
// harness recording publishes.
func statusGolden(state string, speed int, simTS string) string {
	return fmt.Sprintf(`{
		"schema": "urn:fdp:schema:status-sim:v1",
		"unit_id": "cau-7",
		"wall_ts": %q,
		"state": %q,
		"speed": %d,
		"sim_ts": %q,
		"head_seq": 0,
		"dataset": {"first_ts": %q, "last_ts": %q, "rows": %d},
		"loop": false,
		"uptime_s": 0
	}`, wallStart, state, speed, simTS, datasetFirst, datasetLast, datasetRows)
}

// ackGolden renders the acknowledgement a successful command produces.
func ackGolden(cmdID, cmd, status, instanceID string) string {
	instance := ""
	if instanceID != "" {
		instance = fmt.Sprintf(`, "instance_id": %q`, instanceID)
	}
	return fmt.Sprintf(`{
		"schema": "urn:fdp:schema:control-ack:v1",
		"unit_id": "cau-7",
		"wall_ts": %q,
		"cmd_id": %q,
		"cmd": %q,
		"ok": true,
		"error": null,
		"status": %s%s
	}`, wallStart, cmdID, cmd, status, instance)
}

// The command identifiers the tests use. The schema asks for a UUID, and the
// acknowledgement echoes it, so they are real ones.
const (
	cmdIDOne   = "3f2c8a10-0000-4000-8000-000000000001"
	cmdIDTwo   = "3f2c8a10-0000-4000-8000-000000000002"
	cmdIDThree = "3f2c8a10-0000-4000-8000-000000000003"
)

// midPreset is a jump target inside the synthetic recording: the row one
// hundred steps in, with five simulated minutes of lead-in, so a jump to it
// lands on row seventy.
func midPreset() []sim.Preset {
	first := uint64(testutil.SynthStart.UnixMilli())
	return []sim.Preset{{
		PresetID:  "fixture_mid",
		Label:     "Mid recording",
		SimTsMs:   first + 100*stepMs,
		LeadInMin: 5,
	}}
}

func TestControlPlaneAcknowledgesEveryCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		cmd        string
		args       string
		status     string
		instanceID string
	}{
		{
			name: "play", cmd: "play", args: `{}`,
			status: statusGolden("playing", 1, datasetFirst),
		},
		{
			name: "pause", cmd: "pause", args: `{}`,
			status: statusGolden("paused", 1, datasetFirst),
		},
		{
			name: "set_speed", cmd: "set_speed", args: `{"speed":600}`,
			status: statusGolden("paused", 600, datasetFirst),
		},
		{
			name: "jump to an instant", cmd: "jump", args: `{"sim_ts":"2020-02-01T00:05:00.000Z"}`,
			status: statusGolden("paused", 1, "2020-02-01T00:05:00.000Z"),
		},
		{
			name: "jump to a preset", cmd: "jump", args: `{"preset_id":"fixture_mid"}`,
			status: statusGolden("paused", 1, "2020-02-01T00:11:40.000Z"),
		},
		{
			name: "inject", cmd: "inject", args: `{"injection_id":"hot_oil"}`,
			status: statusGolden("paused", 1, datasetFirst), instanceID: "inj-aaaaaa-1",
		},
		{
			name: "clear_injections", cmd: "clear_injections", args: `{}`,
			status: statusGolden("paused", 1, datasetFirst),
		},
		{
			name: "reset", cmd: "reset", args: `{}`,
			status: statusGolden("paused", 1, datasetFirst),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := newControl(t, controlOpts{Presets: midPreset()})
			ack, _ := c.command(cmdIDOne, tc.cmd, tc.args)

			assert.JSONEq(t, ackGolden(cmdIDOne, tc.cmd, tc.status, tc.instanceID), string(ack))
		})
	}
}

func TestControlPlaneAnswersWithinTheAcknowledgementBudget(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})

	// The inject path is the long one: it applies the command on the emit loop
	// and publishes two ground-truth messages from the loop's goroutine before
	// the acknowledgement goes out.
	_, took := c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	assert.Less(t, took, budget(t, ackDeadline), "an acknowledgement is due within 100 ms")
}

func TestControlPlaneReportsEveryErrorCode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cmd  string
		args string
		code string
	}{
		{"an unknown command", "fly", `{}`, "unknown_cmd"},
		{"a speed of zero", "set_speed", `{"speed":0}`, "speed_out_of_range"},
		{"a speed past the maximum", "set_speed", `{"speed":3601}`, "speed_out_of_range"},
		{"a speed that is not a number", "set_speed", `{"speed":"fast"}`, "bad_args"},
		{"a speed that is not whole", "set_speed", `{"speed":1.5}`, "bad_args"},
		{"set_speed without a speed", "set_speed", `{}`, "bad_args"},
		{"an unknown preset", "jump", `{"preset_id":"no_such_preset"}`, "unknown_preset"},
		{"an instant before the recording", "jump", `{"sim_ts":"2019-01-01T00:00:00.000Z"}`, "out_of_range"},
		{"an instant after the recording", "jump", `{"sim_ts":"2021-01-01T00:00:00.000Z"}`, "out_of_range"},
		{"an unreadable instant", "jump", `{"sim_ts":"the afternoon"}`, "bad_args"},
		{"a jump that names both targets", "jump", `{"preset_id":"fixture_mid","sim_ts":"2020-02-01T00:05:00.000Z"}`, "bad_args"},
		{"a jump that names neither", "jump", `{}`, "bad_args"},
		{"an unknown injection", "inject", `{"injection_id":"no_such_injection"}`, "unknown_injection"},
		{"an injection without an id", "inject", `{}`, "bad_args"},
		{"a magnitude outside its bounds", "inject", `{"injection_id":"hot_oil","params":{"magnitude":9}}`, "bad_args"},
		{"a parameter the definition does not declare", "inject", `{"injection_id":"hot_oil","params":{"severity":2}}`, "bad_args"},
		{"an argument on a command that takes none", "play", `{"speed":600}`, "bad_args"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := newControl(t, controlOpts{Presets: midPreset()})
			payload, _ := c.command(cmdIDOne, tc.cmd, tc.args)
			ack := parseAck(t, payload)

			assert.False(t, ack.OK)
			assert.Equal(t, tc.cmd, ack.Cmd, "the command is echoed unchanged")
			assert.Equal(t, cmdIDOne, ack.CmdID)
			require.NotNil(t, ack.Error, "a refusal carries an error object")
			assert.Equal(t, tc.code, ack.Error.Code)
			assert.NotEmpty(t, ack.Error.Message, "the operator is told why")
			assert.Empty(t, ack.InstanceID, "a refused command starts nothing")
			assert.JSONEq(t, statusGolden("paused", 1, datasetFirst), string(ack.Status),
				"a refusal leaves the machine where it was")
		})
	}
}

func TestControlPlaneReplaysTheStoredAcknowledgement(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	first, _ := c.command(cmdIDOne, "set_speed", `{"speed":600}`)
	require.Equal(t, uint16(600), c.engine.Snapshot().Speed)

	// The same identifier with different arguments: the stored answer comes
	// back and the engine never sees the second command.
	second, _ := c.command(cmdIDOne, "set_speed", `{"speed":7}`)

	assert.JSONEq(t, string(first), string(second))
	assert.Equal(t, uint16(600), c.engine.Snapshot().Speed, "a repeat is not applied again")

	// A different identifier is applied normally, which proves the cache is
	// keyed on the identifier and not simply swallowing repeats.
	_, _ = c.command(cmdIDTwo, "set_speed", `{"speed":7}`)
	assert.Equal(t, uint16(7), c.engine.Snapshot().Speed)
}

func TestControlPlaneForgetsCommandsBeyondTheCache(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	oldest := fmt.Sprintf("3f2c8a10-0000-4000-8000-%012d", 0)
	_, _ = c.command(oldest, "set_speed", `{"speed":2}`)

	// Fill the cache past its size, so the first identifier falls out of it.
	for i := 1; i <= sim.AckCacheSize; i++ {
		_, _ = c.command(fmt.Sprintf("3f2c8a10-0000-4000-8000-%012d", i), "set_speed", `{"speed":3}`)
	}
	require.Equal(t, uint16(3), c.engine.Snapshot().Speed)

	// The forgotten identifier is applied again rather than answered from the
	// cache: the rule is the last AckCacheSize commands, not every command.
	_, _ = c.command(oldest, "set_speed", `{"speed":2}`)
	assert.Equal(t, uint16(2), c.engine.Snapshot().Speed)
}

func TestControlPlaneIgnoresWhatIsNotItsCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload string
	}{
		{"another unit", `{"schema":"urn:fdp:schema:control-cmd:v1","unit_id":"cau-9",` +
			`"wall_ts":"` + wallStart + `","cmd_id":"` + cmdIDOne + `","cmd":"play","args":{}}`},
		{"another schema", `{"schema":"urn:fdp:schema:api-sim-command:v1","unit_id":"cau-7",` +
			`"wall_ts":"` + wallStart + `","cmd_id":"` + cmdIDOne + `","cmd":"play","args":{}}`},
		{"no command identifier", `{"schema":"urn:fdp:schema:control-cmd:v1","unit_id":"cau-7",` +
			`"wall_ts":"` + wallStart + `","cmd":"play","args":{}}`},
		{"not JSON at all", `this is not a control command`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := newControl(t, controlOpts{})
			c.sendRaw(tc.payload)

			// A positive control on the same connection: the machine is alive
			// and answers the command that is addressed to it, so the silence
			// above is a refusal to act and not a lost connection.
			payload, _ := c.command(cmdIDTwo, "pause", `{}`)
			assert.Equal(t, cmdIDTwo, parseAck(t, payload).CmdID)
			assert.Len(t, c.seen.on(c.topics.ControlAck()), 1,
				"the ignored message produced no acknowledgement")
			assert.Equal(t, sim.StatePaused, c.engine.Snapshot().State,
				"the ignored message did not start the replay")
		})
	}
}

func TestControlPlaneKeepsUnknownTopLevelFields(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	c.sendRaw(`{"schema":"urn:fdp:schema:control-cmd:v1","unit_id":"cau-7",` +
		`"wall_ts":"` + wallStart + `","cmd_id":"` + cmdIDOne + `","cmd":"set_speed",` +
		`"args":{"speed":42},"issued_by":"a later minor version"}`)

	acks := c.seen.await(t, c.topics.ControlAck(), 1, budget(t, deliveryBudget))
	assert.True(t, parseAck(t, acks[0].payload).OK, "an unknown top-level field is ignored")
	assert.Equal(t, uint16(42), c.engine.Snapshot().Speed)
}

func TestNewControlPlaneRejectsAnIncompleteConfiguration(t *testing.T) {
	t.Parallel()

	documents, err := sim.LoadGtDocuments(sim.Config{GTDir: testutil.TestdataPath("gt")})
	require.NoError(t, err)
	catalog := testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60))
	gt, err := sim.NewGtPublisher(sim.GtConfig{
		UnitID: mqttio.DefaultUnitID, Clock: sim.RealClock{},
		Documents: documents, Catalog: catalog,
	})
	require.NoError(t, err)

	source, err := replay.Open(synthCSV(t, 20, nil), regmap.Signals)
	require.NoError(t, err)
	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)
	engine, err := sim.New(sim.Config{Speed: 1}, source,
		injection.NewEngine(regmap.Signals, catalog), alarms, sim.RealClock{}, sim.NewStore())
	require.NoError(t, err)
	t.Cleanup(func() { assert.NoError(t, engine.Close()) })

	complete := sim.ControlPlaneConfig{
		Engine: engine, UnitID: mqttio.DefaultUnitID, Clock: sim.RealClock{},
		Status: sim.NewStatusPublisher(mqttio.DefaultUnitID, sim.RealClock{}, time.Now()), GT: gt,
	}

	tests := []struct {
		name    string
		corrupt func(*sim.ControlPlaneConfig)
	}{
		{"no engine", func(cfg *sim.ControlPlaneConfig) { cfg.Engine = nil }},
		{"no unit id", func(cfg *sim.ControlPlaneConfig) { cfg.UnitID = "" }},
		{"no clock", func(cfg *sim.ControlPlaneConfig) { cfg.Clock = nil }},
		{"no status publisher", func(cfg *sim.ControlPlaneConfig) { cfg.Status = nil }},
		{"no ground-truth publisher", func(cfg *sim.ControlPlaneConfig) { cfg.GT = nil }},
	}
	for _, tc := range tests {
		cfg := complete
		tc.corrupt(&cfg)
		_, err := sim.NewControlPlane(cfg)
		assert.Errorf(t, err, "%s", tc.name)
	}

	// Before the first connection there is no session, which is what makes
	// /healthz report mqtt_connected=false while `modbus-sim run` is still
	// dialling the broker.
	plane, err := sim.NewControlPlane(complete)
	require.NoError(t, err)
	assert.False(t, plane.Connected(), "a plane that never connected is not ready")
}

func TestSchemaControlAckValidatesForEveryCommand(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cmd  string
		args string
	}{
		{"play", "play", `{}`},
		{"pause", "pause", `{}`},
		{"set_speed", "set_speed", `{"speed":600}`},
		{"jump", "jump", `{"preset_id":"fixture_mid"}`},
		{"inject", "inject", `{"injection_id":"hot_oil"}`},
		{"clear_injections", "clear_injections", `{}`},
		{"reset", "reset", `{}`},
		{"a refusal", "set_speed", `{"speed":0}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// The schema directory decides first, so a checkout without the
			// generated contracts skips before a broker is started.
			schematest.MustSchemaDir(t)

			c := newControl(t, controlOpts{Presets: midPreset()})
			payload, _ := c.command(cmdIDOne, tc.cmd, tc.args)

			schematest.Validate(t, "control-ack", payload)
			schematest.Validate(t, "status-sim", parseAck(t, payload).Status)
		})
	}
}
