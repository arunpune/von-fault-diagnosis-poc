// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// Scenario D: the broker draws the isolation boundary the payloads already
// respect.
//
// A publish the ACL refuses comes back as PUBACK reason 0x87. A subscription
// it refuses is proven by non-delivery over a window, never by a reason code:
// Mosquitto accepts a SUBSCRIBE to a filter it will not deliver, so the
// assertion is that nothing arrives while a credential that may read it
// receives the very same messages.
//
// The whole scenario needs infra/mosquitto: the generated fallback
// configuration has no credentials and no ACL, and it skips with a message.

package e2e

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
)

// notAuthorised is the MQTT 5 reason code for a refused PUBLISH or SUBSCRIBE.
const notAuthorised byte = 0x87

// telemetryBranch is the filter the ACL names for the telemetry tree,
// plant/<unit>/telemetry/#, rather than the one topic under it.
func (s *stack) telemetryBranch() string {
	return mqttio.PlantRoot + "/" + s.topics.UnitID + "/telemetry/#"
}

// subscribeAs connects one credential, subscribes it to filter and returns
// what it collects. A broker that refuses the SUBSCRIBE outright is reported
// rather than asserted on: the denial is proven by what never arrives.
func (s *stack) subscribeAs(t *testing.T, role, user, filter string) *collector {
	t.Helper()

	seen := newCollector()
	client := s.connectAs(t, role, user, nil)
	if err := s.subscribe(client, filter, seen.handle); err != nil {
		var reason *mqttio.ReasonError
		require.ErrorAsf(t, err, &reason, "%s subscribing to %s", user, filter)
		assert.Equal(t, notAuthorised, reason.Code)
		t.Logf("the broker refused %q on %s outright (0x%02x)", user, filter, reason.Code)
	}
	return seen
}

func TestScenarioDBrokerACL(t *testing.T) {
	url, committed := startBroker(t)
	if !committed {
		t.Skip("infra/mosquitto is not in this checkout: the broker has no ACL to assert")
	}
	s := newStack(t, url, committed, stackOpts{})

	// Both branches have to carry traffic for a non-delivery assertion to
	// mean anything: telemetry flows from the play, and the injection puts a
	// live event on the ground-truth tree beside the retained catalog.
	require.True(t, s.command("play", `{}`).OK)
	s.plant.await(t, s.topics.Telemetry(), 1, budget(t, deliveryBudget))

	t.Run("the simulator may not read the telemetry it feeds", func(t *testing.T) {
		seen := s.subscribeAs(t, "acl-sim", userSim, s.telemetryBranch())

		before := s.plant.count(s.topics.Telemetry())
		seen.expectNothing(t, mqttio.PlantRoot+"/", budget(t, silenceWindow))
		assert.Greater(t, s.plant.count(s.topics.Telemetry()), before,
			"the positive control: an anonymous subscriber was reading the same topic all along")
	})

	t.Run("the diagnosing backend may not read the ground truth", func(t *testing.T) {
		denied := s.subscribeAs(t, "acl-diag", userBackendDiag, mqttio.GtRoot+"/#")
		control := s.subscribeAs(t, "acl-eval", userEval, mqttio.GtRoot+"/#")

		// The positive control first: the read-only eval credential receives
		// the retained catalog, which proves it was there to be missed.
		received := control.await(t, s.topics.GtCatalog(), 1, budget(t, deliveryBudget))
		assert.True(t, received[0].retain, "the catalog comes from the retained store")

		events := s.gt.count(s.topics.GtInjection())
		require.True(t, s.command("inject", `{"injection_id":"`+oilInjection+`"}`).OK)
		s.gt.await(t, s.topics.GtInjection(), events+1, budget(t, deliveryBudget))
		control.await(t, s.topics.GtInjection(), 1, budget(t, deliveryBudget))

		denied.expectNothing(t, mqttio.GtRoot+"/", budget(t, silenceWindow))
	})

	t.Run("an anonymous subscriber reads the plant and never the ground truth", func(t *testing.T) {
		anonymous := s.subscribeAs(t, "acl-anon", "", mqttio.GtRoot+"/#")

		assert.NotEmpty(t, s.plant.on(s.topics.Telemetry()),
			"the anonymous subscriber of this stack is reading plant/#")
		assert.NotEmpty(t, s.plant.on(s.topics.StatusSim()),
			"including the retained simulator status")
		anonymous.expectNothing(t, mqttio.GtRoot+"/", budget(t, silenceWindow))
	})

	t.Run("the gateway may not publish ground truth", func(t *testing.T) {
		client := s.connectAs(t, "acl-gw-escape", userGateway, nil)

		ctx, cancel := context.WithTimeout(context.Background(), budget(t, deliveryBudget))
		defer cancel()
		err := client.Publish(ctx, s.topics.GtMarker(), []byte(`{"kind":"jump"}`), 1, false)

		var reason *mqttio.ReasonError
		require.ErrorAs(t, err, &reason, "a denied PUBLISH comes back as a reason code")
		assert.Equal(t, notAuthorised, reason.Code)
	})

	t.Run("the simulator may not publish outside its own branch", func(t *testing.T) {
		client := s.connectAs(t, "acl-sim-escape", userSim, nil)

		ctx, cancel := context.WithTimeout(context.Background(), budget(t, deliveryBudget))
		defer cancel()
		err := client.Publish(ctx, s.topics.Telemetry(), []byte(`{"seq":1}`), 1, false)

		var reason *mqttio.ReasonError
		require.ErrorAs(t, err, &reason)
		assert.Equal(t, notAuthorised, reason.Code)
	})

	// Nothing in this scenario went near the device except the gateway's own
	// reads: the gateway is read-only.
	assert.Zero(t, s.server.Refusals(),
		"the gateway only ever read: no write function code reached the simulator")
}
