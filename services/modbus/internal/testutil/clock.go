// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package testutil holds the test helpers shared by the packages of this
// module: a deterministic clock, fixture path resolution, the synthetic CSV
// generator and the resolver for the MetroPT-3 slices `make fixtures` cuts.
//
// It is test-only by convention — no production package may import it, and
// the arch test of internal/arch keeps the binaries away from it.
package testutil

import (
	"slices"
	"sync"
	"time"
)

// Clock is the time source the simulator's pacing loop reads. Production code
// uses RealClock, tests drive a FakeClock.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

// RealClock is the wall clock.
type RealClock struct{}

// Now returns the current wall time.
func (RealClock) Now() time.Time { return time.Now() }

// After returns a channel that receives after d.
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// timer is one pending FakeClock deadline.
type timer struct {
	deadline time.Time
	ch       chan time.Time
}

// FakeClock is a Clock whose time only moves when a test moves it. It is safe
// for concurrent use: the pacing loop reads it from its own goroutine while
// the test advances it.
//
// The zero value is not usable; construct one with NewFakeClock.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer
}

// NewFakeClock returns a clock that starts at start.
func NewFakeClock(start time.Time) *FakeClock {
	return &FakeClock{now: start}
}

// Now returns the clock's current time.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// After registers a timer for d from now and returns its channel. A
// non-positive duration fires immediately, like time.After.
func (c *FakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	ch := make(chan time.Time, 1)
	deadline := c.now.Add(d)
	if !deadline.After(c.now) {
		ch <- c.now
		return ch
	}
	c.timers = append(c.timers, &timer{deadline: deadline, ch: ch})
	return ch
}

// Advance moves the clock forward by d and fires every timer whose deadline
// has passed, in deadline order, each with its own deadline as the value. A
// non-positive d fires nothing.
//
// The channels are buffered, so Advance never blocks on a receiver that is not
// listening yet.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if d > 0 {
		c.now = c.now.Add(d)
	}

	due := make([]*timer, 0, len(c.timers))
	pending := c.timers[:0]
	for _, t := range c.timers {
		if t.deadline.After(c.now) {
			pending = append(pending, t)
			continue
		}
		due = append(due, t)
	}
	c.timers = pending

	slices.SortStableFunc(due, func(a, b *timer) int { return a.deadline.Compare(b.deadline) })
	for _, t := range due {
		t.ch <- t.deadline
	}
}

// Pending reports how many timers are waiting for their deadline.
func (c *FakeClock) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}
