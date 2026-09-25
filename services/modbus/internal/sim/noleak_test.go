// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The ground-truth isolation rule
// (docs/architecture.md#ground-truth-isolation), asserted from the diagnosis
// side: with an injection running, every byte the machine publishes under
// plant/ and every byte its health port serves is searched for the vocabulary
// of the ground truth. The broker ACL draws the same line
// (infra/mosquitto/acl) and control_integration_test.go asserts that half;
// this file asserts that the payloads themselves carry nothing, so a
// misconfigured broker could not leak what is not there.

package sim_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/sim"
)

// groundTruthWords are the substrings no message under plant/ may contain.
// They are matched case-insensitively against the raw payload, so a field
// name, a value and a topic reference are all caught.
var groundTruthWords = []string{"inject", "fault_id", "instance_id", "preset", "gt/"}

// assertNoGroundTruth fails with the offending word and the payload.
func assertNoGroundTruth(t *testing.T, what string, payload []byte) {
	t.Helper()

	lower := strings.ToLower(string(payload))
	for _, word := range groundTruthWords {
		assert.NotContainsf(t, lower, word,
			"%s carries the ground-truth word %q: %s", what, word, payload)
	}
}

func TestPlantTopicsCarryNoGroundTruthWhileAnInjectionRuns(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{Speed: 60, Autoplay: true})
	c.waitTimers(2)

	// The overlay is started through the engine rather than over MQTT,
	// because the acknowledgement of `inject` is the one message that may
	// name an instance (see the last test in this file) and this search is
	// about everything else.
	require.NoError(t, c.engine.Apply(sim.Inject("hot_oil", nil)).Err)
	c.seen.await(t, c.topics.GtInjection(), 1, budget(t, deliveryBudget))
	require.Len(t, c.engine.Snapshot().Injections, 1, "the overlay is running")

	// One control round trip and one status tick while it runs. `pause` is
	// the honest case: a command that has nothing to do with the overlay and
	// whose own name is not one of the words below — unlike
	// `clear_injections`, which would trip the search on the command name the
	// control schema itself defines.
	_, _ = c.command(cmdIDTwo, "pause", `{}`)
	c.clock.Advance(sim.StatusInterval)
	c.seen.await(t, c.topics.StatusSim(), 3, budget(t, deliveryBudget))

	plant := c.seen.under("plant/")
	require.NotEmpty(t, plant, "there is something to search")
	seenAck, seenStatus := false, false
	for _, message := range plant {
		assertNoGroundTruth(t, message.topic, message.payload)
		switch message.topic {
		case c.topics.ControlAck():
			seenAck = true
		case c.topics.StatusSim():
			seenStatus = true
		}
	}
	assert.True(t, seenAck, "an acknowledgement was searched")
	assert.True(t, seenStatus, "a status document was searched")

	// The positive control: the same run did publish the running instance,
	// under the root only the ground-truth readers may subscribe to. Without
	// it, a machine that published nothing at all would pass.
	events := c.seen.on(c.topics.GtInjection())
	require.NotEmpty(t, events, "the ground truth was published somewhere")
	assert.Contains(t, string(events[0].payload), "instance_id", "gt/ is where it lives")
	assert.Contains(t, string(events[0].payload), "fault_id")
}

func TestHealthBodiesCarryNoGroundTruthWhileAnInjectionRuns(t *testing.T) {
	t.Parallel()

	c := newControl(t, controlOpts{})
	_, _ = c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	require.Len(t, c.engine.Snapshot().Injections, 1)

	health, err := sim.NewHealthServer(0, sim.Probes{
		CSVIndexed:      func() bool { return true },
		ModbusListening: func() bool { return true },
		MQTTConnected:   c.plane.Connected,
		Snapshot:        c.engine.Snapshot,
	}, nil)
	require.NoError(t, err)
	require.NoError(t, health.Start())
	t.Cleanup(func() { assert.NoError(t, health.Shutdown(t.Context())) })

	for _, path := range []string{sim.HealthPath, sim.StatusPath} {
		body := httpBody(t, "http://"+health.Addr()+path)
		assertNoGroundTruth(t, path, body)
		assert.Contains(t, string(body), `"mqtt_connected":true`,
			"the broker session is what makes the machine ready")
	}
}

// httpBody performs one GET and returns the body.
func httpBody(t *testing.T, url string) []byte {
	t.Helper()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { assert.NoError(t, resp.Body.Close()) }()

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return body
}

func TestTheInjectAcknowledgementCarriesOnlyTheInstanceID(t *testing.T) {
	t.Parallel()

	// The one exception to the rule above, and it is deliberate: the
	// acknowledgement of a successful `inject` names the instance it started
	// (control-ack.schema.json). plant/cau-7/control/# is not a diagnosis
	// topic — the ACL grants it to backend-ops alone, the credential that
	// issued the command, and anonymous clients read only
	// plant/cau-7/{telemetry,status,events,decisions,alerts}. So the
	// identifier goes back to the caller that asked for it and reaches nothing
	// that diagnoses.
	c := newControl(t, controlOpts{})
	payload, _ := c.command(cmdIDOne, "inject", `{"injection_id":"hot_oil"}`)
	ack := parseAck(t, payload)

	require.True(t, ack.OK)
	assert.Equal(t, "inj-aaaaaa-1", ack.InstanceID)

	// Nothing else about the overlay travels with it: no injection id, no
	// fault id, and a status document that says only where the cursor sits.
	assert.NotContains(t, string(payload), "hot_oil")
	assert.NotContains(t, string(payload), "fault_id")
	assert.NotContains(t, string(payload), "oil_cooler_fouled")
	assertNoGroundTruth(t, "the status inside the acknowledgement", ack.Status)
}
