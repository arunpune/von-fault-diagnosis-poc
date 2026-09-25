// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package testutil_test

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/testutil"
)

var epoch = time.Date(2020, 2, 1, 0, 0, 0, 0, time.UTC)

// recv returns the value on ch, or fails when nothing is waiting: a FakeClock
// delivers before Advance returns, so no test needs to wait.
func recv(t *testing.T, ch <-chan time.Time) time.Time {
	t.Helper()
	select {
	case v := <-ch:
		return v
	default:
		t.Fatal("expected a timer to have fired")
		return time.Time{}
	}
}

func assertEmpty(t *testing.T, ch <-chan time.Time) {
	t.Helper()
	select {
	case v := <-ch:
		t.Fatalf("unexpected timer at %s", v)
	default:
	}
}

func TestFakeClockNowMovesOnlyOnAdvance(t *testing.T) {
	t.Parallel()

	c := testutil.NewFakeClock(epoch)
	assert.Equal(t, epoch, c.Now())

	c.Advance(90 * time.Second)
	assert.Equal(t, epoch.Add(90*time.Second), c.Now())

	c.Advance(0)
	assert.Equal(t, epoch.Add(90*time.Second), c.Now())
}

func TestFakeClockAfterFiresAtItsDeadline(t *testing.T) {
	t.Parallel()

	c := testutil.NewFakeClock(epoch)
	ch := c.After(10 * time.Second)
	assert.Equal(t, 1, c.Pending())

	c.Advance(9 * time.Second)
	assertEmpty(t, ch)
	assert.Equal(t, 1, c.Pending())

	c.Advance(time.Second)
	assert.Equal(t, epoch.Add(10*time.Second), recv(t, ch),
		"the timer carries its own deadline, not the clock's new time")
	assert.Equal(t, 0, c.Pending())
}

func TestFakeClockFiresInDeadlineOrder(t *testing.T) {
	t.Parallel()

	c := testutil.NewFakeClock(epoch)
	late := c.After(30 * time.Second)
	early := c.After(10 * time.Second)
	middle := c.After(20 * time.Second)
	beyond := c.After(60 * time.Second)

	c.Advance(30 * time.Second)

	assert.Equal(t, epoch.Add(10*time.Second), recv(t, early))
	assert.Equal(t, epoch.Add(20*time.Second), recv(t, middle))
	assert.Equal(t, epoch.Add(30*time.Second), recv(t, late))
	assertEmpty(t, beyond)
	assert.Equal(t, 1, c.Pending())
}

func TestFakeClockAfterNonPositiveFiresImmediately(t *testing.T) {
	t.Parallel()

	c := testutil.NewFakeClock(epoch)
	assert.Equal(t, epoch, recv(t, c.After(0)))
	assert.Equal(t, epoch, recv(t, c.After(-time.Second)))
	assert.Equal(t, 0, c.Pending())
}

func TestFakeClockIsSafeForConcurrentUse(t *testing.T) {
	t.Parallel()

	const goroutines = 8
	c := testutil.NewFakeClock(epoch)

	var start, done sync.WaitGroup
	start.Add(1)
	done.Add(goroutines)
	for i := range goroutines {
		go func() {
			defer done.Done()
			start.Wait()
			if i%2 == 0 {
				c.After(time.Duration(i+1) * time.Second)
				return
			}
			_ = c.Now()
			c.Advance(time.Second)
		}()
	}
	start.Done()
	done.Wait()

	// Every registered timer has either fired or is still pending; the point
	// of the test is that -race sees no data race and the clock stays usable.
	assert.GreaterOrEqual(t, c.Pending(), 0)
	assert.True(t, c.Now().After(epoch))
}

func TestRealClock(t *testing.T) {
	t.Parallel()

	var c testutil.Clock = testutil.RealClock{}
	before := time.Now()
	assert.False(t, c.Now().Before(before))
	require.NotNil(t, c.After(time.Millisecond))
}
