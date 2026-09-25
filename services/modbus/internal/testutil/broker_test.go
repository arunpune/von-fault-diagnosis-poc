// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/mqttio"
	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

// brokerBudget bounds one connection to the in-process broker.
const brokerBudget = 5 * time.Second

// connectAndClose proves the broker at url accepts an MQTT 5 client, and
// leaves nothing attached: the client disconnects before the function
// returns, so a restart or a shutdown afterwards is not racing a session.
func connectAndClose(t *testing.T, url, clientID string) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), brokerBudget)
	defer cancel()

	client, err := mqttio.Connect(ctx, mqttio.Config{URL: url, ClientID: clientID}, nil)
	require.NoError(t, err, "connecting to %s", url)
	require.NoError(t, client.Close(ctx))
}

func TestStartEmbeddedBrokerAcceptsClients(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)

	assert.True(t, strings.HasPrefix(url, "mqtt://127.0.0.1:"),
		"the broker URL names the loopback address: %s", url)
	assert.False(t, strings.HasSuffix(url, ":0"), "the URL carries the port the kernel assigned")

	connectAndClose(t, url, "fdp-testutil-probe")
}

// TestEmbeddedBrokersDoNotShareAPort is what lets packages, and parallel
// test runs, start their own broker at the same time.
func TestEmbeddedBrokersDoNotShareAPort(t *testing.T) {
	first := testutil.StartEmbeddedBroker(t)
	second := testutil.StartEmbeddedBroker(t)

	assert.NotEqual(t, first, second)
}

// TestRestartEmbeddedBrokerKeepsThePort is the property the reconnect tests
// rely on: the client keeps dialling the URL it was handed.
func TestRestartEmbeddedBrokerKeepsThePort(t *testing.T) {
	url := testutil.StartEmbeddedBroker(t)
	connectAndClose(t, url, "fdp-testutil-before")

	testutil.RestartEmbeddedBroker(t, url)

	connectAndClose(t, url, "fdp-testutil-after")
}

// TestDeniedBranchIsOneSubtree pins the constants the reason-code tests build
// on: one prefix, one filter under it, one topic under it.
func TestDeniedBranchIsOneSubtree(t *testing.T) {
	assert.Equal(t, "denied/", testutil.DeniedPrefix)
	assert.Equal(t, "denied/#", testutil.DeniedFilter)
	assert.True(t, strings.HasPrefix(testutil.DeniedTopic, testutil.DeniedPrefix))
}
