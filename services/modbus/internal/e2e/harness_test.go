// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The machine the five scenarios run on: a simulator, its Modbus listener, the
// gateway and the observers, all in this process, against one real Mosquitto
// container.
//
// Nothing here asserts; the scenarios do. Every wall-clock bound below is
// multiplied by FDP_TIMING_SLACK — 1 locally, 3 in CI.

package e2e

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/ctrl7"
	"fault-diagnosis-poc/services/modbus/internal/gateway"
	"fault-diagnosis-poc/services/modbus/internal/injection"
	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/regmap"
	"fault-diagnosis-poc/services/modbus/internal/replay"
	"fault-diagnosis-poc/services/modbus/internal/sim"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// The broker credentials of infra/mosquitto/passwd.txt. Their passwords are
// committed PoC defaults, overridable through MQTT_<USER>_PASSWORD; they are
// not secrets.
const (
	userSim         = sim.MQTTUsername
	userGateway     = gateway.MQTTUsername
	userBackendOps  = "backend-ops"
	userBackendDiag = "backend-diag"
	userEval        = "eval"
)

// The recording every scenario replays: the first recorded day, with both of
// its real holes (307 s at 12:48:40 and 12,929 s at 19:40:04). No MetroPT-3
// row is committed, so a checkout without the slice skips and a run with
// FDP_REQUIRE_DATASET=1 fails.
const (
	daySlice = "sim-day-2020-02-01"
	dayRows  = 7144
)

// timingSlackEnv multiplies every wall-clock bound in this package.
const timingSlackEnv = "FDP_TIMING_SLACK"

// The wall-clock bounds, all multiplied by the slack above.
const (
	// connectBudget bounds one connection to the broker.
	connectBudget = 5 * time.Second
	// deliveryBudget bounds the wait for a message to arrive.
	deliveryBudget = 10 * time.Second
	// settleBudget bounds the wait for a counter to reach a value.
	settleBudget = 30 * time.Second
	// silenceWindow is how long a topic is watched to prove nothing arrives on
	// it.
	silenceWindow = 2 * time.Second
	// pollStep is how often a polling wait re-reads its condition.
	pollStep = 2 * time.Millisecond
)

// controlSpeed is the speed the scenarios that drive the control plane boot
// at: 600x is the README tour's own speed, one recorded minute a tenth of a
// second.
const controlSpeed = 600

// The two injections the scenarios run: one that moves the oil temperature
// alone, and one that moves the room the unit stands in.
const (
	oilInjection     = "oil_cooler_fouling"
	ambientInjection = "high_ambient_temperature"
)

// gatewayPollInterval is the idle poll interval of the gateway in these
// scenarios. The simulator refreshes its header every 100 ms, so a shorter
// interval only spins; 20 ms lets the gateway read a fresh header within a
// fifth of that and still batch what the header reveals.
const gatewayPollInterval = 20 * time.Millisecond

// gatewayStatusInterval is how often the gateway republishes its retained
// heartbeat, short enough that a scenario never waits five seconds for a
// counter to appear on the wire.
const gatewayStatusInterval = 500 * time.Millisecond

// timingSlack returns the multiplier for a wall-clock bound.
func timingSlack(t testing.TB) time.Duration {
	t.Helper()

	raw := os.Getenv(timingSlackEnv)
	if raw == "" {
		return 1
	}
	slack, err := strconv.Atoi(raw)
	require.NoErrorf(t, err, "%s must be an integer", timingSlackEnv)
	require.Positivef(t, slack, "%s must be positive", timingSlackEnv)
	return time.Duration(slack)
}

// budget scales one wall-clock bound with the slack.
func budget(t testing.TB, d time.Duration) time.Duration {
	t.Helper()
	return d * timingSlack(t)
}

// message is one delivery, kept with the instant it reached this process so a
// latency can be measured from it.
type message struct {
	topic   string
	payload []byte
	retain  bool
	at      time.Time
}

// collector is one subscriber's view of the broker. It is written by the
// client's dispatch goroutine and read by the test's.
type collector struct {
	mu      sync.Mutex
	byTopic map[string][]message
	all     []message
}

// newCollector returns an empty collector.
func newCollector() *collector {
	return &collector{byTopic: map[string][]message{}}
}

// handle is the mqttio.Handler that feeds the collector.
func (c *collector) handle(topic string, payload []byte, retain bool) {
	m := message{topic: topic, payload: append([]byte(nil), payload...), retain: retain, at: time.Now()}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.byTopic[topic] = append(c.byTopic[topic], m)
	c.all = append(c.all, m)
}

// on returns every message delivered on one topic so far.
func (c *collector) on(topic string) []message {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]message(nil), c.byTopic[topic]...)
}

// count returns how many messages arrived on one topic so far.
func (c *collector) count(topic string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.byTopic[topic])
}

// under returns every message whose topic starts with prefix.
func (c *collector) under(prefix string) []message {
	c.mu.Lock()
	defer c.mu.Unlock()

	var out []message
	for _, m := range c.all {
		if strings.HasPrefix(m.topic, prefix) {
			out = append(out, m)
		}
	}
	return out
}

// await waits until at least n messages have arrived on topic and returns
// them, failing the test when they do not.
func (c *collector) await(t *testing.T, topic string, n int, within time.Duration) []message {
	t.Helper()

	deadline := time.Now().Add(within)
	for {
		if got := c.on(topic); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d messages arrived on %s within %s",
				c.count(topic), n, topic, within)
		}
		time.Sleep(pollStep)
	}
}

// last returns the newest payload delivered on one topic.
func (c *collector) last(t *testing.T, topic string) []byte {
	t.Helper()

	got := c.on(topic)
	require.NotEmptyf(t, got, "nothing was delivered on %s", topic)
	return got[len(got)-1].payload
}

// expectNothing watches prefix for within and fails on the first message that
// arrives under it. The caller proves separately that something was there to
// be missed, since the broker accepts a subscription it will not deliver.
func (c *collector) expectNothing(t *testing.T, prefix string, within time.Duration) {
	t.Helper()

	before := len(c.under(prefix))
	time.Sleep(within)
	after := c.under(prefix)
	if len(after) > before {
		t.Fatalf("%d message(s) arrived under %q within %s, starting with %s",
			len(after)-before, prefix, within, after[before].topic)
	}
}

// waitFor polls cond until it holds, failing the test with what was awaited.
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	waitUntil(t, budget(t, settleBudget), cond, what)
}

// waitUntil is waitFor with its own bound, for a wait that is longer than a
// counter settling — a whole recorded day, for instance.
func waitUntil(t *testing.T, within time.Duration, cond func() bool, what string) {
	t.Helper()

	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", within, what)
		}
		time.Sleep(pollStep)
	}
}

// stackOpts is what a scenario chooses about its machine.
type stackOpts struct {
	// slice is the MetroPT-3 slice to replay; empty means the day fixture.
	slice string
	// speed is the replay speed the engine boots at.
	speed uint16
	// loop makes the replay wrap instead of stopping at the last row.
	loop bool
	// modbusPort pins the simulator's listener, so a scenario that restarts
	// the simulator can bind the same address again. Zero is ephemeral.
	modbusPort int
}

// stack is one running machine: the simulator with its control plane, the
// gateway, and the two observers the ACL grants a view through.
type stack struct {
	t *testing.T

	brokerURL string
	committed bool
	topics    mqttio.Topics
	fixture   *fixture
	opts      stackOpts

	store   *sim.Store
	engine  *sim.Engine
	server  *sim.Server
	plane   *sim.ControlPlane
	health  *sim.HealthServer
	catalog *injection.Catalog
	presets []sim.Preset
	// forwardsRealDocuments is true when the ground-truth tree carries the
	// documents packages/ground-truth ships rather than the cut-down fixtures,
	// which is what decides whether the catalog can be validated against
	// gt-catalog.
	forwardsRealDocuments bool

	service    *gateway.Service
	gatewayURL string

	// plant is what an anonymous subscriber sees: plant/# and nothing else.
	plant *collector
	// gt is what backend-ops sees: the ground-truth tree and the
	// acknowledgements of the commands it sends.
	gt *collector

	ops *mqttio.Client

	// rootCtx is the context every goroutine of this machine descends from.
	// It is held here rather than passed down because a scenario replaces the
	// replay process mid-test, and the replacement has to descend from the
	// same shutdown as the process it succeeds.
	rootCtx context.Context
	cancel  context.CancelFunc
	stopped chan struct{}
	// The replay process has its own context, so a scenario can end it and
	// start another one behind the same Modbus address.
	replayCancel  context.CancelFunc
	replayStopped chan struct{}

	commands int
}

// startReplay builds the register store, the engine and the Modbus listener,
// and is the whole of what a `docker restart modbus-sim` replaces: the
// gateway keeps its connection settings and its sequence number, and only
// the process behind the address is new.
//
// autoplay decides whether the engine boots playing. The first process of a
// stack boots paused, so the gateway adopts an empty ring and the first
// sample it publishes is sequence number one; a replacement boots playing,
// because there is no control plane wired to the new engine to play it.
func (s *stack) startReplay(t *testing.T, autoplay bool) {
	t.Helper()

	source, err := replay.Open(s.fixture.path, regmap.Signals)
	require.NoError(t, err)
	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)

	s.store = sim.NewStore()
	s.engine, err = sim.New(sim.Config{
		Speed: s.opts.speed, Loop: s.opts.loop, Autoplay: autoplay, Presets: s.presets,
	}, source, injection.NewEngine(regmap.Signals, s.catalog, injection.WithBootID(bootID(t))),
		alarms, sim.RealClock{}, s.store)
	require.NoError(t, err)

	s.server, err = sim.NewServer(sim.ServerConfig{
		Bind: "127.0.0.1", Port: s.opts.modbusPort, MaxClients: 8,
	}, s.store)
	require.NoError(t, err)
	require.NoError(t, s.server.Start())
}

// runReplay drives the current engine until stopReplay or the stack's own
// shutdown.
func (s *stack) runReplay(t *testing.T) {
	t.Helper()

	replayCtx, cancel := context.WithCancel(s.rootCtx)
	stopped := make(chan struct{})
	s.replayCancel, s.replayStopped = cancel, stopped

	engine := s.engine
	go func() {
		defer close(stopped)
		assert.NoError(t, engine.Run(replayCtx))
	}()
}

// stopReplay ends the current replay process and releases its listener, so
// another one can bind the same address.
func (s *stack) stopReplay(t *testing.T) {
	t.Helper()

	s.replayCancel()
	select {
	case <-s.replayStopped:
	case <-time.After(budget(t, settleBudget)):
		t.Fatal("the emit loop did not return")
	}
	require.NoError(t, s.engine.Close())
	require.NoError(t, s.server.Stop())
}

// groundTruthDir resolves the ground-truth documents the simulator forwards.
// The real tree under packages/ground-truth/data is used when the checkout has
// it — the fixtures under services/modbus/testdata/gt are cut down for the
// offline tests and do not satisfy the forwarded documents' schemas. It lives
// outside the Go module and is resolved four levels up, exactly as schematest
// resolves the schemas beside it.
func groundTruthDir() (dir string, real bool) {
	abs, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "packages", "ground-truth", "data"))
	if err != nil {
		return testutil.TestdataPath("gt"), false
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return testutil.TestdataPath("gt"), false
	}
	return abs, true
}

// startBroker runs the pinned Mosquitto image for one test and reports
// whether it came up on the committed configuration, which is what decides
// whether the ACL can be asserted.
func startBroker(t *testing.T) (url string, committed bool) {
	t.Helper()

	url, cfgDir := testutil.StartMosquitto(t)
	_, committed = testutil.MosquittoConfigDir()
	t.Logf("broker at %s, configuration from %s (committed ACL: %t)", url, cfgDir, committed)
	return url, committed
}

// newStack wires the whole machine against an already running broker and
// leaves it paused at the first row, with the gateway synced on an empty ring.
//
// The simulator boots paused on purpose: the gateway adopts the device's head
// on its first poll and never replays a backlog, so a machine that had already
// emitted samples could not be observed from sequence number one. The
// scenarios play it with the control command an operator would use, which is
// the same path the README tour takes.
func newStack(t *testing.T, brokerURL string, committed bool, opts stackOpts) *stack {
	t.Helper()

	if opts.slice == "" {
		opts.slice = daySlice
	}
	if opts.speed == 0 {
		opts.speed = sim.MaxSpeed
	}

	path := testutil.SliceCSV(t, opts.slice)
	s := &stack{
		t:         t,
		brokerURL: brokerURL,
		committed: committed,
		topics:    mqttio.Topics{UnitID: mqttio.DefaultUnitID},
		fixture:   readFixture(t, path),
		opts:      opts,
		plant:     newCollector(),
		gt:        newCollector(),
		stopped:   make(chan struct{}),
	}

	gtDir, real := groundTruthDir()
	s.forwardsRealDocuments = real
	catalog, err := injection.LoadCatalog(sim.Config{GTDir: gtDir}.InjectionsPath(), regmap.Signals)
	require.NoError(t, err)
	s.catalog = catalog
	documents, err := sim.LoadGtDocuments(sim.Config{GTDir: gtDir})
	require.NoError(t, err)

	// The engine's own presets stay the fixtures: they are the only ones with
	// a jump target inside the first recorded day, which is the slice every
	// scenario replays. The documents above are what the simulator forwards,
	// and they are the real ones whenever the checkout has them.
	s.presets, err = sim.LoadPresets(testutil.FixturePath(t, "gt/presets.json"))
	require.NoError(t, err)

	s.startReplay(t, false)

	// The catalog advertises how many holes the recording has; the fixture
	// found them with the same threshold the replay source uses.
	gt, err := sim.NewGtPublisher(sim.GtConfig{
		UnitID: s.topics.UnitID, Clock: sim.RealClock{},
		Documents: documents, Catalog: s.catalog, Gaps: len(s.fixture.gaps),
	})
	require.NoError(t, err)

	s.plane, err = sim.NewControlPlane(sim.ControlPlaneConfig{
		Engine: s.engine,
		UnitID: s.topics.UnitID,
		Clock:  sim.RealClock{},
		Status: sim.NewStatusPublisher(s.topics.UnitID, sim.RealClock{}, time.Now()),
		GT:     gt,
		Logger: discardLogger(),
	})
	require.NoError(t, err)
	s.engine.OnMarker, s.engine.OnInjection = s.plane.OnMarker, s.plane.OnInjection

	s.health, err = sim.NewHealthServer(0, sim.Probes{
		CSVIndexed:      func() bool { return true },
		ModbusListening: s.server.Listening,
		MQTTConnected:   s.plane.Connected,
		Snapshot:        s.engine.Snapshot,
	}, discardLogger())
	require.NoError(t, err)
	require.NoError(t, s.health.Start())

	// The observers subscribe before the machine speaks, so nothing a
	// scenario asserts on can be published before there is a reader for it.
	s.ops = s.connectAs(t, "ops", userBackendOps, nil)
	require.NoError(t, s.subscribe(s.ops, s.topics.ControlAck(), s.gt.handle))
	require.NoError(t, s.subscribe(s.ops, mqttio.GtRoot+"/#", s.gt.handle))

	anonymous := s.connectAs(t, "watch", "", nil)
	require.NoError(t, s.subscribe(anonymous, mqttio.PlantRoot+"/#", s.plant.handle))

	s.connectAs(t, "sim", userSim, func(client *mqttio.Client) { s.plane.ConnectionUp(client) })
	publisher := s.connectAs(t, "gw", userGateway, nil)

	cfg := gateway.DefaultConfig()
	cfg.ModbusAddr = s.server.Addr()
	cfg.ModbusTimeout = budget(t, 2*time.Second)
	cfg.PollInterval = gatewayPollInterval
	cfg.StatusInterval = budget(t, gatewayStatusInterval)
	cfg.MQTTURL = brokerURL
	cfg.HTTPPort = freePort(t)
	s.gatewayURL = "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.HTTPPort))

	s.service, err = gateway.New(cfg, gateway.NewModbusPoller(cfg.ModbusAddr, cfg.ModbusTimeout),
		publisher, gateway.Options{Logger: discardLogger()})
	require.NoError(t, err)

	gatewayHealth, err := gateway.StartHealthServer(
		net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.HTTPPort)), s.service.HealthHandler())
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	s.rootCtx, s.cancel = ctx, cancel

	s.runReplay(t)

	var running sync.WaitGroup
	running.Add(2)
	go func() { defer running.Done(); s.plane.Run(ctx) }()
	go func() { defer running.Done(); assert.NoError(t, s.service.Run(ctx)) }()
	go func() { running.Wait(); close(s.stopped) }()

	t.Cleanup(func() {
		cancel()
		for _, done := range []<-chan struct{}{s.stopped, s.replayStopped} {
			select {
			case <-done:
			case <-time.After(budget(t, settleBudget)):
				t.Error("the machine did not shut down")
			}
		}
		assert.NoError(t, s.engine.Close())
		assert.NoError(t, s.server.Stop())

		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		assert.NoError(t, gatewayHealth.Close(closeCtx))
		assert.NoError(t, s.health.Shutdown(closeCtx))
	})

	// The retained catalog and the retained status prove the simulator's
	// session is up and that both observers are being served; the first poll
	// cycle proves the gateway adopted the empty ring, which is what makes
	// the first published sample sequence number one.
	s.gt.await(t, s.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	s.plant.await(t, s.topics.StatusSim(), 1, budget(t, deliveryBudget))
	waitFor(t, func() bool { return s.service.Snapshot().Counters.Polls > 0 },
		"the gateway's first poll cycle")
	return s
}

// connectAs dials the broker with one of the ACL's credentials, or
// anonymously when the checkout has no committed configuration to
// authenticate against. The client closes with the test.
func (s *stack) connectAs(t *testing.T, role, user string, onUp func(*mqttio.Client)) *mqttio.Client {
	t.Helper()

	username, password := s.credential(t, user)
	return connectAs(t, s.brokerURL, "fdp-e2e-"+role+"-"+bootID(t), username, password, onUp)
}

// credential returns the username and password to connect user with, or two
// empty strings when the fallback broker has no credentials at all.
func (s *stack) credential(t *testing.T, user string) (username, password string) {
	t.Helper()

	if !s.committed || user == "" {
		return "", ""
	}
	return user, testutil.MosquittoPassword(t, user)
}

// connectAs dials one broker session and closes it with the test.
func connectAs(t *testing.T, url, clientID, user, password string,
	onUp func(*mqttio.Client),
) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{
		URL: url, ClientID: clientID, Username: user, Password: password,
	}, onUp)
	require.NoErrorf(t, err, "connecting %s as %q", clientID, user)

	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// subscribe sends one SUBSCRIBE under the connection budget.
func (s *stack) subscribe(client *mqttio.Client, filter string, h mqttio.Handler) error {
	s.t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(s.t, connectBudget))
	defer cancel()
	return client.Subscribe(ctx, filter, 1, h)
}

// ack is the acknowledgement of one command, in the `control-ack` shape of
// packages/contracts.
type ack struct {
	Schema     string          `json:"schema"`
	UnitID     string          `json:"unit_id"`
	CmdID      string          `json:"cmd_id"`
	Cmd        string          `json:"cmd"`
	OK         bool            `json:"ok"`
	Error      *ackError       `json:"error"`
	Status     json.RawMessage `json:"status"`
	InstanceID string          `json:"instance_id"`
	raw        []byte
	// took is the wall time from the PUBLISH of the command to the arrival
	// of this acknowledgement.
	took time.Duration
}

// ackError is the refusal inside an acknowledgement.
type ackError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// simStatus is the `status/sim` document, and the same object travels inside
// every acknowledgement.
type simStatus struct {
	Schema  string `json:"schema"`
	UnitID  string `json:"unit_id"`
	State   string `json:"state"`
	Speed   uint16 `json:"speed"`
	SimTS   string `json:"sim_ts"`
	HeadSeq uint32 `json:"head_seq"`
	Loop    bool   `json:"loop"`
}

// command publishes one command as backend-ops and returns its
// acknowledgement with the round trip it took.
func (s *stack) command(cmd, args string) ack {
	s.t.Helper()

	s.commands++
	cmdID := commandID(s.commands)
	payload := []byte(`{"schema":"` + mqttio.SchemaID("control-cmd") +
		`","unit_id":"` + s.topics.UnitID +
		`","wall_ts":"` + mqttio.WallTS(time.Now()) +
		`","cmd_id":"` + cmdID + `","cmd":"` + cmd + `","args":` + args + `}`)

	before := s.gt.count(s.topics.ControlAck())
	ctx, cancel := context.WithTimeout(context.Background(), budget(s.t, deliveryBudget))
	defer cancel()

	sent := time.Now()
	require.NoError(s.t, s.ops.Publish(ctx, s.topics.ControlCmd(), payload, 1, false))

	got := s.gt.await(s.t, s.topics.ControlAck(), before+1, budget(s.t, deliveryBudget))[before]
	parsed := parseAck(s.t, got.payload)
	parsed.took = got.at.Sub(sent)
	require.Equalf(s.t, cmdID, parsed.CmdID, "the acknowledgement answers the command that was sent")
	return parsed
}

// parseAck decodes one acknowledgement.
func parseAck(t *testing.T, payload []byte) ack {
	t.Helper()

	var a ack
	require.NoError(t, json.Unmarshal(payload, &a), "decoding an acknowledgement: %s", payload)
	a.raw = payload
	return a
}

// status decodes the status object an acknowledgement carries.
func (a ack) status(t *testing.T) simStatus {
	t.Helper()

	var st simStatus
	require.NoError(t, json.Unmarshal(a.Status, &st), "decoding the status of %s", a.Cmd)
	return st
}

// simStatusNow returns the newest retained `status/sim` the anonymous
// subscriber holds.
func (s *stack) simStatusNow(t *testing.T) simStatus {
	t.Helper()

	var st simStatus
	require.NoError(t, json.Unmarshal(s.plant.last(t, s.topics.StatusSim()), &st))
	return st
}

// gatewayStatus is the part of the retained `status/gateway` heartbeat these
// scenarios read.
type gatewayStatus struct {
	LastSeq               uint32 `json:"last_seq"`
	DroppedTotal          uint64 `json:"dropped_total"`
	PollErrorsTotal       uint64 `json:"poll_errors_total"`
	ResyncsTotal          uint64 `json:"resyncs_total"`
	SimRestartsTotal      uint64 `json:"sim_restarts_total"`
	PublishErrorsTotal    uint64 `json:"publish_errors_total"`
	SamplesPublishedTotal uint64 `json:"samples_published_total"`
	BatchesPublishedTotal uint64 `json:"batches_published_total"`
	MQTTConnected         bool   `json:"mqtt_connected"`
	Modbus                struct {
		Connected bool `json:"connected"`
	} `json:"modbus"`
}

// gatewayStatusNow returns the newest heartbeat the anonymous subscriber
// holds.
func (s *stack) gatewayStatusNow(t *testing.T) gatewayStatus {
	t.Helper()

	var st gatewayStatus
	require.NoError(t, json.Unmarshal(s.plant.last(t, s.topics.StatusGateway()), &st))
	return st
}

// telemetryBatch is one `telemetry-samples` message.
type telemetryBatch struct {
	Schema  string            `json:"schema"`
	UnitID  string            `json:"unit_id"`
	Samples []telemetrySample `json:"samples"`
}

// telemetrySample is one published ring slot.
type telemetrySample struct {
	Seq     uint32 `json:"seq"`
	SimTS   string `json:"sim_ts"`
	SimTsMs uint64 `json:"-"`
	Flags   struct {
		Discontinuity bool `json:"discontinuity"`
		Missing       bool `json:"missing"`
	} `json:"flags"`
	Values map[string]any `json:"values"`
	Alarms []string       `json:"alarms"`
}

// analog returns one analog value of a sample.
func (s telemetrySample) analog(t *testing.T, tag string) float64 {
	t.Helper()

	raw, ok := s.Values[tag]
	require.Truef(t, ok, "sample %d carries no %q", s.Seq, tag)
	value, ok := raw.(float64)
	require.Truef(t, ok, "%q of sample %d is %T, not a number", tag, s.Seq, raw)
	return value
}

// samples flattens every telemetry batch the anonymous subscriber holds, in
// arrival order, and checks the envelope of each one on the way.
func (s *stack) samples(t *testing.T) []telemetrySample {
	t.Helper()

	messages := s.plant.on(s.topics.Telemetry())
	out := make([]telemetrySample, 0, len(messages))
	for i, m := range messages {
		out = append(out, decodeBatch(t, m.payload, i)...)
	}
	return out
}

// decodeBatch decodes one telemetry message and reports the samples in it. The
// `alarms` field is read from the raw object as well, because an absent list
// and an empty one decode into the same nil slice.
func decodeBatch(t *testing.T, payload []byte, index int) []telemetrySample {
	t.Helper()

	var batch telemetryBatch
	require.NoErrorf(t, json.Unmarshal(payload, &batch), "decoding telemetry batch %d", index)
	require.NotEmptyf(t, batch.Samples, "telemetry batch %d is empty", index)
	require.LessOrEqualf(t, len(batch.Samples), gateway.MaxBatchLimit,
		"telemetry batch %d carries %d samples", index, len(batch.Samples))

	var raw struct {
		Samples []map[string]json.RawMessage `json:"samples"`
	}
	require.NoError(t, json.Unmarshal(payload, &raw))
	for i := range batch.Samples {
		_, ok := raw.Samples[i]["alarms"]
		require.Truef(t, ok, "sample %d of batch %d has no `alarms` field", batch.Samples[i].Seq, index)

		ms, err := mqttio.ParseTS(batch.Samples[i].SimTS)
		require.NoErrorf(t, err, "sample %d of batch %d carries %q", batch.Samples[i].Seq, index,
			batch.Samples[i].SimTS)
		batch.Samples[i].SimTsMs = ms
	}
	return batch.Samples
}

// publishedSeq returns the sequence numbers the anonymous subscriber has seen
// so far, in arrival order.
func (s *stack) publishedSeq(t *testing.T) []uint32 {
	t.Helper()

	samples := s.samples(t)
	out := make([]uint32, 0, len(samples))
	for _, sample := range samples {
		out = append(out, sample.Seq)
	}
	return out
}

// healthBody performs one GET against a health endpoint and returns the body.
func healthBody(t *testing.T, url string) []byte {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { assert.NoError(t, resp.Body.Close()) }()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return body
}

// commandID renders the nth command identifier of a run as the UUID the
// control schema asks for.
func commandID(n int) string {
	return fmt.Sprintf("3f2c8a10-0000-4000-8000-%012d", n)
}

// bootID returns a short random identifier, so two test binaries running side
// by side never share a client id or a container name.
func bootID(t *testing.T) string {
	t.Helper()

	buf := make([]byte, 3)
	_, err := rand.Read(buf)
	require.NoError(t, err)
	return hex.EncodeToString(buf)
}

// freePort reserves a loopback port and releases it again, so a health server
// of this package never collides with another test binary's.
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

// discardLogger returns a logger that writes nowhere: these scenarios read
// counters and payloads, and the services are deliberately noisy while a
// broker or a device is away.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
