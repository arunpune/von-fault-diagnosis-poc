// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

//go:build integration

// The ACL of infra/mosquitto is an isolation boundary, and Mosquitto 2.0.22
// draws it in two different ways:
//
//   - a denied PUBLISH is answered with PUBACK reason code 0x87 on MQTT 5, so
//     the publisher learns it was refused;
//   - a denied SUBSCRIBE is granted a normal SUBACK and then simply never
//     delivers, so the only honest assertion is non-delivery within a window,
//     paired with a positive control that does receive the message.
//
// Both forms appear below. Every wall-clock bound scales with
// FDP_TIMING_SLACK.

package mqttio_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// isolationWindow is how long a denied subscriber is watched before its
// silence counts as isolation.
const isolationWindow = 2 * time.Second

// The credentials of infra/mosquitto/passwd.txt. Their passwords are the
// committed PoC defaults, overridable through MQTT_<USER>_PASSWORD; they are
// not secrets.
const (
	userGateway    = "gateway"
	userSim        = "sim"
	userBackendOps = "backend-ops"
	userEval       = "eval"
)

// connectAs dials the broker with one of the ACL's credentials and closes the
// client in t.Cleanup.
func connectAs(t *testing.T, url, clientID, username, password string) *mqttio.Client {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{
		URL:      url,
		ClientID: clientID,
		Username: username,
		Password: password,
	}, nil)
	require.NoError(t, err, "connecting %s as %q", clientID, username)

	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), budget(t, connectBudget))
		defer closeCancel()
		_ = client.Close(closeCtx)
	})
	return client
}

// TestMosquittoIntegration runs the whole package against a real broker: one
// container, several credentials, the assertions in an order that leaves the
// retained ground-truth catalog in place for the isolation check that needs
// it.
func TestMosquittoIntegration(t *testing.T) {
	url, cfgDir := testutil.StartMosquitto(t)
	_, committed := testutil.MosquittoConfigDir()
	t.Logf("broker at %s, configuration from %s (committed ACL: %t)", url, cfgDir, committed)

	topics := mqttio.Topics{UnitID: mqttio.DefaultUnitID}

	t.Run("telemetry reaches an anonymous subscriber", func(t *testing.T) {
		received := newCollector()
		anonymous := connectAs(t, url, "fdp-it-anon-telemetry", "", "")
		// The README's `mosquitto_sub -t 'plant/#'` has to work for telemetry
		// without credentials.
		require.NoError(t, subscribe(t, anonymous, "plant/#", received.handle))

		gateway := publisherAs(t, url, "fdp-it-gateway", userGateway, committed)
		require.NoError(t, publish(t, gateway, topics.Telemetry(), `{"seq":1}`, false))

		got := received.await(t, 1, budget(t, deliveryBudget))
		assert.Equal(t, topics.Telemetry(), got[0].topic)
		assert.JSONEq(t, `{"seq":1}`, got[0].payload)
	})

	if !committed {
		t.Log("infra/mosquitto is not in this checkout: the ACL assertions are skipped " +
			"and only the round trip above ran")
		return
	}

	t.Run("the gateway may not publish ground truth", func(t *testing.T) {
		gateway := connectAs(t, url, "fdp-it-gateway-gt", userGateway, testutil.MosquittoPassword(t, userGateway))

		err := publish(t, gateway, topics.GtMarker(), `{"kind":"jump"}`, false)

		var reason *mqttio.ReasonError
		require.ErrorAs(t, err, &reason, "a denied PUBLISH must come back as a reason code")
		assert.Equal(t, notAuthorized, reason.Code)
		assert.Equal(t, topics.GtMarker(), reason.Topic)
	})

	t.Run("the simulator publishes the retained catalog to backend-ops", func(t *testing.T) {
		received := newCollector()
		ops := connectAs(t, url, "fdp-it-ops", userBackendOps, testutil.MosquittoPassword(t, userBackendOps))
		require.NoError(t, subscribe(t, ops, "gt/#", received.handle))

		sim := connectAs(t, url, "fdp-it-sim", userSim, testutil.MosquittoPassword(t, userSim))
		require.NoError(t, publish(t, sim, topics.GtCatalog(), `{"injections":[]}`, true))

		got := received.await(t, 1, budget(t, deliveryBudget))
		assert.Equal(t, topics.GtCatalog(), got[0].topic)
	})

	t.Run("anonymous clients may not read ground truth", func(t *testing.T) {
		// The retained catalog published above is waiting on the broker, so
		// both subscribers would receive it the moment they subscribe — if the
		// ACL let them.
		denied := newCollector()
		anonymous := connectAs(t, url, "fdp-it-anon-gt", "", "")
		require.NoError(t, subscribe(t, anonymous, "gt/#", denied.handle))

		control := newCollector()
		evaluator := connectAs(t, url, "fdp-it-eval", userEval, testutil.MosquittoPassword(t, userEval))
		require.NoError(t, subscribe(t, evaluator, "gt/#", control.handle))

		// Positive control first: the read-only eval credential does get it,
		// which proves the message was there to be missed.
		got := control.await(t, 1, budget(t, deliveryBudget))
		assert.Equal(t, topics.GtCatalog(), got[0].topic)
		assert.True(t, got[0].retain, "the catalog is delivered from the retained store")

		denied.expectNothing(t, budget(t, isolationWindow))
	})

	t.Run("the simulator may not read telemetry", func(t *testing.T) {
		denied := newCollector()
		sim := connectAs(t, url, "fdp-it-sim-telemetry", userSim, testutil.MosquittoPassword(t, userSim))
		// Mosquitto grants this SUBSCRIBE and then never delivers on it, so
		// the SUBACK itself says nothing.
		require.NoError(t, subscribe(t, sim, "plant/cau-7/telemetry/#", denied.handle))

		control := newCollector()
		anonymous := connectAs(t, url, "fdp-it-anon-control", "", "")
		require.NoError(t, subscribe(t, anonymous, topics.Telemetry(), control.handle))

		gateway := connectAs(t, url, "fdp-it-gateway-telemetry", userGateway, testutil.MosquittoPassword(t, userGateway))
		require.NoError(t, publish(t, gateway, topics.Telemetry(), `{"seq":2}`, false))

		got := control.await(t, 1, budget(t, deliveryBudget))
		assert.JSONEq(t, `{"seq":2}`, got[0].payload)

		denied.expectNothing(t, budget(t, isolationWindow))
	})
}

// publisherAs connects the gateway credential when the committed ACL is in
// use, and anonymously otherwise — the generated fallback configuration has no
// credentials at all.
func publisherAs(t *testing.T, url, clientID, user string, committed bool) *mqttio.Client {
	t.Helper()

	if !committed {
		return connectAs(t, url, clientID, "", "")
	}
	return connectAs(t, url, clientID, user, testutil.MosquittoPassword(t, user))
}
