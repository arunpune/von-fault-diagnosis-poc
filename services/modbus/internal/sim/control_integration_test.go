// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The control plane against the broker it runs with in production: one
// Mosquitto container with the committed configuration, the `sim` credential
// on the machine's side and `backend-ops` on the caller's (docs/simulation.md,
// "Control commands and acknowledgements").
//
// The phases run in order on one machine, because each builds on what the
// previous left retained: the session comes up and announces itself, the seven
// commands are issued and acknowledged, and the ACL is then asserted from both
// sides — an anonymous subscriber sees the status and never the ground truth,
// while the read-only `eval` credential does. Every wall-clock bound is
// multiplied by FDP_TIMING_SLACK.

package sim_test

import (
	"context"
	"encoding/json"
	"fmt"
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

// The broker credentials of infra/mosquitto/passwd.txt. Their passwords are
// committed PoC defaults, overridable through MQTT_<USER>_PASSWORD; they are
// not secrets.
const (
	userSim        = "sim"
	userBackendOps = "backend-ops"
	userEval       = "eval"
)

// statusDeadline is the bound on the retained status: a change is visible
// within 1.2 s, one status tick plus a fifth.
const statusDeadline = 1200 * time.Millisecond

// integrationRows is the length of the recording the container run replays.
// Two thousand ten-second rows are five and a half simulated hours, which the
// fastest speed this file asks for cannot exhaust while the phases run, so no
// assertion about the replay state races the end of the data.
const integrationRows = 2000

// broker is one machine wired to a real Mosquitto: the simulator's own
// session, a commanding session and whatever observers a phase needs.
type broker struct {
	t       *testing.T
	url     string
	topics  mqttio.Topics
	engine  *sim.Engine
	plane   *sim.ControlPlane
	ops     *mqttio.Client
	seen    *mqttCollector
	cancel  context.CancelFunc
	engines chan error
	ticker  chan struct{}
	// forwardsRealDocuments is true when the catalog carries the documents
	// packages/ground-truth ships rather than the cut-down fixtures, which is
	// what decides whether it can be validated against gt-catalog.
	forwardsRealDocuments bool
}

// connectAs dials the broker with one of the ACL's credentials and closes the
// client with the test.
func connectAs(t *testing.T, url, clientID, username, password string, onUp func(*mqttio.Client)) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{
		URL:      url,
		ClientID: clientID,
		Username: username,
		Password: password,
	}, onUp)
	require.NoError(t, err, "connecting %s as %q", clientID, username)

	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// startMachine wires an engine, the three publishers and the two sessions
// against the running broker. The clock is the real one here: the phases
// measure wall time, which is the point of running against a container.
func startMachine(t *testing.T, url string, credential, password func(string) string) *broker {
	t.Helper()

	source, err := replay.Open(synthCSV(t, integrationRows, nil), regmap.Signals)
	require.NoError(t, err)
	alarms, err := ctrl7.New(regmap.Alarms, regmap.Signals)
	require.NoError(t, err)

	catalog := testCatalog(t, offsetDefinition("hot_oil", "oil_temperature", 14, 60))
	gtDir, b := testutil.TestdataPath("gt"), &broker{}
	if dir, ok := groundTruthDocuments(); ok {
		gtDir, b.forwardsRealDocuments = dir, true
	}
	documents, err := sim.LoadGtDocuments(sim.Config{GTDir: gtDir})
	require.NoError(t, err)

	b.t = t
	b.url = url
	b.topics = mqttio.Topics{UnitID: mqttio.DefaultUnitID}
	b.seen = newCollector()
	b.engines = make(chan error, 1)
	b.ticker = make(chan struct{})

	b.engine, err = sim.New(sim.Config{Speed: 60, Presets: midPreset()}, source,
		injection.NewEngine(regmap.Signals, catalog, injection.WithBootID("aaaaaa")),
		alarms, sim.RealClock{}, sim.NewStore())
	require.NoError(t, err)

	gt, err := sim.NewGtPublisher(sim.GtConfig{
		UnitID: mqttio.DefaultUnitID, Clock: sim.RealClock{},
		Documents: documents, Catalog: catalog, Gaps: len(source.Gaps()),
	})
	require.NoError(t, err)

	b.plane, err = sim.NewControlPlane(sim.ControlPlaneConfig{
		Engine: b.engine,
		UnitID: mqttio.DefaultUnitID,
		Clock:  sim.RealClock{},
		Status: sim.NewStatusPublisher(mqttio.DefaultUnitID, sim.RealClock{}, time.Now()),
		GT:     gt,
	})
	require.NoError(t, err)
	b.engine.OnMarker, b.engine.OnInjection = b.plane.OnMarker, b.plane.OnInjection

	ctx, cancel := context.WithCancel(t.Context())
	b.cancel = cancel
	go func() { b.engines <- b.engine.Run(ctx) }()

	// backend-ops reads the acknowledgements and the whole ground-truth tree,
	// which is what the ACL grants it.
	b.ops = connectAs(t, url, "fdp-sim-it-ops", credential(userBackendOps), password(userBackendOps), nil)
	require.NoError(t, subscribeWithin(t, b.ops, b.topics.ControlAck(), b.seen.handle))
	require.NoError(t, subscribeWithin(t, b.ops, "gt/#", b.seen.handle))

	connectAs(t, url, "fdp-sim-it-sim", credential(userSim), password(userSim),
		func(client *mqttio.Client) { b.plane.ConnectionUp(client) })

	go func() {
		defer close(b.ticker)
		b.plane.Run(ctx)
	}()

	t.Cleanup(func() {
		cancel()
		select {
		case err := <-b.engines:
			assert.NoError(t, err)
		case <-time.After(budget(t, deliveryBudget)):
			t.Error("the emit loop did not return")
		}
		select {
		case <-b.ticker:
		case <-time.After(budget(t, deliveryBudget)):
			t.Error("the status ticker did not return")
		}
		assert.NoError(t, b.engine.Close())
	})

	b.seen.await(t, b.topics.GtCatalog(), 1, budget(t, deliveryBudget))
	return b
}

// subscribeWithin sends one SUBSCRIBE under the connection budget.
func subscribeWithin(t *testing.T, client *mqttio.Client, filter string, h mqttio.Handler) error {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()
	return client.Subscribe(ctx, filter, 1, h)
}

// command publishes one command as backend-ops and returns its acknowledgement
// and how long the answer took.
func (b *broker) command(cmdID, cmd, args string) ([]byte, time.Duration) {
	b.t.Helper()

	payload := []byte(`{"schema":"urn:fdp:schema:control-cmd:v1","unit_id":"` + mqttio.DefaultUnitID +
		`","wall_ts":"` + mqttio.WallTS(time.Now()) + `","cmd_id":"` + cmdID +
		`","cmd":"` + cmd + `","args":` + args + `}`)

	before := len(b.seen.on(b.topics.ControlAck()))
	ctx, cancel := context.WithTimeout(context.Background(), budget(b.t, deliveryBudget))
	defer cancel()

	sent := time.Now()
	require.NoError(b.t, b.ops.Publish(ctx, b.topics.ControlCmd(), payload, 1, false))

	acks := b.seen.await(b.t, b.topics.ControlAck(), before+1, budget(b.t, deliveryBudget))
	ack := acks[before]
	return ack.payload, ack.at.Sub(sent)
}

func TestControlPlaneAgainstMosquitto(t *testing.T) {
	url, cfgDir := testutil.StartMosquitto(t)
	_, committed := testutil.MosquittoConfigDir()
	t.Logf("broker at %s, configuration from %s (committed ACL: %t)", url, cfgDir, committed)

	// Without the committed configuration the generated fallback broker has
	// no credentials at all, so every session connects anonymously and the
	// ACL assertions at the end are skipped.
	credential := func(user string) string {
		if !committed {
			return ""
		}
		return user
	}
	password := func(user string) string {
		if !committed {
			return ""
		}
		return testutil.MosquittoPassword(t, user)
	}

	machine := startMachine(t, url, credential, password)

	// An anonymous subscriber stands in for the browser: plant/# is what the
	// README tells an operator to watch.
	anonymous := newCollector()
	watcher := connectAs(t, url, "fdp-sim-it-anon", "", "", nil)
	require.NoError(t, subscribeWithin(t, watcher, "plant/#", anonymous.handle))
	require.NoError(t, subscribeWithin(t, watcher, "gt/#", anonymous.handle))

	t.Run("every command is acknowledged within the budget", func(t *testing.T) {
		tests := []struct {
			name       string
			cmd        string
			args       string
			state      string
			instanceID string
		}{
			{name: "play", cmd: "play", args: `{}`, state: "playing"},
			{name: "set_speed", cmd: "set_speed", args: `{"speed":600}`, state: "playing"},
			{name: "jump", cmd: "jump", args: `{"preset_id":"fixture_mid"}`, state: "playing"},
			{name: "inject", cmd: "inject", args: `{"injection_id":"hot_oil"}`,
				state: "playing", instanceID: "inj-aaaaaa-1"},
			{name: "clear_injections", cmd: "clear_injections", args: `{}`, state: "playing"},
			{name: "pause", cmd: "pause", args: `{}`, state: "paused"},
			{name: "reset", cmd: "reset", args: `{}`, state: "paused"},
			{name: "a refusal", cmd: "set_speed", args: `{"speed":0}`, state: "paused"},
		}

		for i, tc := range tests {
			cmdID := commandID(i)
			payload, took := machine.command(cmdID, tc.cmd, tc.args)
			ack := parseAck(t, payload)

			assert.Equal(t, cmdID, ack.CmdID, "%s", tc.name)
			assert.Equal(t, tc.cmd, ack.Cmd, "%s", tc.name)
			assert.Equal(t, tc.instanceID, ack.InstanceID, "%s", tc.name)
			assert.Equal(t, tc.state, parseStatus(t, ack.Status).State, "%s", tc.name)
			assert.Lessf(t, took, budget(t, ackDeadline),
				"the acknowledgement of %s took %s; the budget is 100 ms", tc.name, took)
			schematest.Validate(t, "control-ack", payload)
		}

		// The repeat of a command identifier is answered from the cache
		// without touching the machine.
		first, _ := machine.command(commandID(0), "set_speed", `{"speed":900}`)
		second, _ := machine.command(commandID(0), "set_speed", `{"speed":900}`)
		assert.JSONEq(t, string(first), string(second))
	})

	t.Run("the ground truth reached backend-ops", func(t *testing.T) {
		for _, topic := range []string{
			machine.topics.GtCatalog(),
			machine.topics.GtInjection(),
			machine.topics.GtInjectionActive(),
			machine.topics.GtMarker(),
		} {
			messages := machine.seen.await(t, topic, 1, budget(t, deliveryBudget))
			assert.NotEmptyf(t, messages, "nothing arrived on %s", topic)
		}

		if machine.forwardsRealDocuments {
			schematest.Validate(t, "gt-catalog", lastOn(t, machine.seen, machine.topics.GtCatalog()))
		}
		schematest.Validate(t, "gt-injection", lastOn(t, machine.seen, machine.topics.GtInjection()))
		schematest.Validate(t, "gt-injection-active",
			lastOn(t, machine.seen, machine.topics.GtInjectionActive()))
		schematest.Validate(t, "gt-marker", lastOn(t, machine.seen, machine.topics.GtMarker()))
	})

	t.Run("the retained status follows a change within its deadline", func(t *testing.T) {
		before := len(anonymous.on(machine.topics.StatusSim()))
		changed := time.Now()
		_, _ = machine.command(commandID(20), "set_speed", `{"speed":1200}`)

		var status statusOf
		require.Eventuallyf(t, func() bool {
			messages := anonymous.on(machine.topics.StatusSim())
			if len(messages) <= before {
				return false
			}
			status = parseStatus(t, messages[len(messages)-1].payload)
			return status.Speed == 1200
		}, budget(t, statusDeadline), time.Millisecond,
			"the retained status did not follow the change within %s", statusDeadline)
		t.Logf("the status followed the change in %s", time.Since(changed))

		schematest.Validate(t, "status-sim",
			lastOn(t, anonymous, machine.topics.StatusSim()))
	})

	if !committed {
		t.Log("infra/mosquitto is not in this checkout: the ACL assertions are skipped")
		return
	}

	t.Run("the ground truth never reaches an anonymous subscriber", func(t *testing.T) {
		// The positive control first: the read-only eval credential receives
		// the retained catalog, which proves it was there to be missed.
		control := newCollector()
		evaluator := connectAs(t, url, "fdp-sim-it-eval", credential(userEval), password(userEval), nil)
		require.NoError(t, subscribeWithin(t, evaluator, "gt/#", control.handle))

		received := control.await(t, machine.topics.GtCatalog(), 1, budget(t, deliveryBudget))
		assert.True(t, received[0].retain, "the catalog comes from the retained store")

		// The anonymous subscriber has been watching gt/# since before the
		// first command and must have received nothing on it, while its
		// plant/# subscription was delivering all along.
		assert.NotEmpty(t, anonymous.on(machine.topics.StatusSim()),
			"the anonymous subscriber is alive and reading plant/#")
		anonymous.expectNothing(t, "gt/", budget(t, silenceWindow))
	})

	t.Run("the simulator may not publish outside its branch", func(t *testing.T) {
		client := connectAs(t, url, "fdp-sim-it-escape", credential(userSim), password(userSim), nil)

		ctx, cancel := context.WithTimeout(context.Background(), budget(t, deliveryBudget))
		defer cancel()
		err := client.Publish(ctx, machine.topics.Telemetry(), []byte(`{"seq":1}`), 1, false)

		var reason *mqttio.ReasonError
		require.ErrorAs(t, err, &reason, "a denied PUBLISH comes back as a reason code")
		assert.Equal(t, byte(0x87), reason.Code)
	})
}

// commandID renders the nth command identifier of the integration run as a
// UUID, which is what the control schema asks for.
func commandID(n int) string {
	return fmt.Sprintf("3f2c8a10-0000-4000-8000-%012d", n)
}

// lastOn returns the newest payload delivered on one topic.
func lastOn(t *testing.T, c *mqttCollector, topic string) json.RawMessage {
	t.Helper()

	messages := c.on(topic)
	require.NotEmptyf(t, messages, "nothing was delivered on %s", topic)
	return messages[len(messages)-1].payload
}
