// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The wall-clock bounds of the tests that run the service, all multiplied by
// FDP_TIMING_SLACK.

package gateway_test

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// timingSlackEnv multiplies every wall-clock bound in these tests: 1 locally,
// 3 in CI.
const timingSlackEnv = "FDP_TIMING_SLACK"

// Wall-clock bounds, all multiplied by the slack above.
const (
	// settleBudget bounds the wait for a counter to reach a value.
	settleBudget = 10 * time.Second
	// connectBudget bounds one connection to the in-process broker.
	connectBudget = 5 * time.Second
)

// pollTick is the poll interval the service tests run with: short enough that
// a test never waits for it, long enough that an idle loop does not spin.
const pollTick = time.Millisecond

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
