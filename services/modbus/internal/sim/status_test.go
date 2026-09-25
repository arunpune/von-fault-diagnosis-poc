// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/schematest"
	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// statusOf is the status document as the tests read it back.
type statusOf struct {
	Schema  string `json:"schema"`
	UnitID  string `json:"unit_id"`
	WallTS  string `json:"wall_ts"`
	State   string `json:"state"`
	Speed   int    `json:"speed"`
	SimTS   string `json:"sim_ts"`
	HeadSeq int    `json:"head_seq"`
	Dataset struct {
		FirstTS string `json:"first_ts"`
		LastTS  string `json:"last_ts"`
		Rows    int    `json:"rows"`
	} `json:"dataset"`
	Loop    bool `json:"loop"`
	UptimeS int  `json:"uptime_s"`
}

// parseStatus reads one status document.
func parseStatus(t *testing.T, payload []byte) statusOf {
	t.Helper()

	var status statusOf
	require.NoError(t, json.Unmarshal(payload, &status), "the status is not JSON: %s", payload)
	return status
}

func TestStatusIsRetainedAndDescribesTheRecording(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	published := c.seen.await(t, c.topics.StatusSim(), 1, budget(t, deliveryBudget))

	assert.JSONEq(t, statusGolden("paused", 1, datasetFirst), string(published[0].payload))

	// A subscriber that arrives later reads the same document from the
	// broker's retained store, which is what the user interface does on a page
	// load.
	late := newCollector()
	client := c.connect(t, "fdp-late-status", nil)
	require.NoError(t, client.Subscribe(c.ctx(t), c.topics.StatusSim(), 1, late.handle))

	retained := late.await(t, c.topics.StatusSim(), 1, budget(t, deliveryBudget))
	assert.True(t, retained[0].retain, "the status is delivered from the retained store")
	assert.JSONEq(t, statusGolden("paused", 1, datasetFirst), string(retained[0].payload))
}

func TestStatusIsRepublishedEverySecondOfTheClock(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	require.Len(t, c.seen.on(c.topics.StatusSim()), 1, "one document on connect")

	for tick := 2; tick <= 4; tick++ {
		c.clock.Advance(sim.StatusInterval)
		published := c.seen.await(t, c.topics.StatusSim(), tick, budget(t, deliveryBudget))
		assert.Len(t, published, tick, "one document per second of the clock")
		// The ticker has to be armed again before the next advance, or that
		// advance would wake nothing.
		c.waitTimers(1)
	}

	published := c.seen.on(c.topics.StatusSim())
	last := parseStatus(t, published[len(published)-1].payload)
	assert.Equal(t, 3, last.UptimeS, "uptime_s counts the seconds the clock moved")
	assert.Equal(t, "2026-09-20T09:00:03.000Z", last.WallTS)
	assert.Equal(t, datasetFirst, last.SimTS, "a paused machine does not move")
}

func TestStatusFollowsAChangeWithoutWaitingForTheTick(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		cmd   string
		args  string
		state string
		speed int
		simTS string
	}{
		{"play", "play", `{}`, "playing", 1, datasetFirst},
		{"pause", "pause", `{}`, "paused", 1, datasetFirst},
		{"set_speed", "set_speed", `{"speed":600}`, "paused", 600, datasetFirst},
		{"jump", "jump", `{"sim_ts":"2020-02-01T00:05:00.000Z"}`, "paused", 1, "2020-02-01T00:05:00.000Z"},
		{"reset", "reset", `{}`, "paused", 1, datasetFirst},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := newControl(t, controlOpts{})
			require.Len(t, c.seen.on(c.topics.StatusSim()), 1)

			// No clock advance anywhere in this test: the second document is
			// due to the command alone.
			_, _ = c.command(cmdIDOne, tc.cmd, tc.args)
			published := c.seen.await(t, c.topics.StatusSim(), 2, budget(t, deliveryBudget))

			status := parseStatus(t, published[1].payload)
			assert.Equal(t, tc.state, status.State)
			assert.Equal(t, tc.speed, status.Speed)
			assert.Equal(t, tc.simTS, status.SimTS)
		})
	}
}

func TestStatusIsNotRepublishedForACommandThatChangesNothing(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	require.Len(t, c.seen.on(c.topics.StatusSim()), 1)

	// Neither command moves the cursor, the speed or the state; the status
	// topic says nothing about injections, so there is nothing to republish.
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	_, _ = c.command(cmdIDTwo, "clear_injections", `{}`)
	_, _ = c.command(cmdIDThree, "set_speed", `{"speed":0}`)

	assert.Len(t, c.seen.on(c.topics.StatusSim()), 1,
		"an injection, a clear and a refusal leave the retained status alone")
}

func TestStatusReportsThePlayingCursorAndTheHeadSequence(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{Speed: 60, Autoplay: true})
	// Two timers: the pacing one for the row after the boot sample, and the
	// status ticker.
	c.waitTimers(2)

	// One wall-clock second at 60x is a simulated minute, which is six rows
	// of the ten-second recording on top of the boot sample.
	c.clock.Advance(sim.StatusInterval)
	// Both timers armed again means the emit loop is parked on the next row:
	// it has finished with the ones the advance made due, so the snapshot
	// below is settled rather than racing the loop.
	c.waitTimers(2)

	// `play` on a machine that is already playing changes nothing but
	// re-anchors the clock where it stands, and every command that touches the
	// state publishes the status at once — which is how this assertion reads a
	// document taken at a known instant.
	_, _ = c.command(cmdIDOne, "play", `{}`)

	published := c.seen.await(t, c.topics.StatusSim(), 3, budget(t, deliveryBudget))
	status := parseStatus(t, published[len(published)-1].payload)

	assert.Equal(t, "playing", status.State)
	assert.Equal(t, 60, status.Speed)
	assert.Equal(t, "2020-02-01T00:01:00.000Z", status.SimTS)
	assert.Equal(t, 7, status.HeadSeq, "the boot sample and the six rows of a simulated minute")
	assert.Equal(t, datasetFirst, status.Dataset.FirstTS)
	assert.Equal(t, datasetLast, status.Dataset.LastTS)
	assert.Equal(t, datasetRows, status.Dataset.Rows)
	assert.False(t, status.Loop)
}

func TestStatusStopsAtShutdownWithoutANewDocument(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	before := len(c.seen.on(c.topics.StatusSim()))

	c.stop()

	// A SIGTERM publishes nothing new: the retained document stays as the last
	// state the machine was really in.
	assert.Len(t, c.seen.on(c.topics.StatusSim()), before)
}

func TestSchemaStatusSimValidates(t *testing.T) {
	t.Parallel()

	schematest.MustSchemaDir(t)

	c := newControl(t, controlOpts{Speed: 600, Autoplay: true, Loop: true})
	c.waitTimers(2)
	c.clock.Advance(sim.StatusInterval)
	c.waitTimers(2)

	published := c.seen.await(t, c.topics.StatusSim(), 2, budget(t, deliveryBudget))
	for _, message := range published {
		schematest.Validate(t, "status-sim", message.payload)
	}
}
