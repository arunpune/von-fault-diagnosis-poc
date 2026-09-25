// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package sim

import "time"

// Clock is the time source the pacing loop reads. Production code uses
// RealClock; tests drive internal/testutil's FakeClock, which satisfies this
// interface structurally.
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

// Speed bounds of the replay (docs/simulation.md, "Simulated time and speed").
const (
	// MinSpeed is the slowest replay: simulated time runs at wall time.
	MinSpeed uint16 = 1
	// MaxSpeed is the fastest replay: one simulated hour per wall second.
	MaxSpeed uint16 = 3600
)

// maxWait caps the sleep the pacing loop ever asks for. Nothing in the replay
// needs a longer one — a source step above replay.GapThresholdMs is collapsed
// before the loop waits for it — so a value beyond the cap can only come from
// a corrupt file, and waiting a day for it would look like a hang.
const maxWait = time.Hour

// simClock is the simulated clock: the anchor pair (anchorWall, anchorSimMs)
// plus a speed factor.
//
//	simNow = anchorSimMs + (Now() − anchorWall) × speed   while playing
//	simNow = anchorSimMs                                  while frozen
//
// Every command that changes the speed, the position or the state re-anchors
// at the current simNow, so the simulated instant never jumps sideways when
// the pacing changes.
//
// It is owned by the emit loop and is not safe for concurrent use.
type simClock struct {
	clock       Clock
	anchorWall  time.Time
	anchorSimMs uint64
	speed       uint16
	running     bool
}

// newSimClock returns a frozen clock at simMs.
func newSimClock(clock Clock, simMs uint64, speed uint16) *simClock {
	return &simClock{
		clock:       clock,
		anchorWall:  clock.Now(),
		anchorSimMs: simMs,
		speed:       speed,
	}
}

// wallNow returns the underlying wall time.
func (c *simClock) wallNow() time.Time { return c.clock.Now() }

// now returns the simulated instant in epoch milliseconds UTC.
func (c *simClock) now() uint64 {
	if !c.running {
		return c.anchorSimMs
	}
	elapsed := c.clock.Now().Sub(c.anchorWall)
	if elapsed <= 0 {
		return c.anchorSimMs
	}
	return c.anchorSimMs + uint64(elapsed.Milliseconds())*uint64(c.speed)
}

// reanchor moves the anchor to simMs without changing whether the clock runs.
func (c *simClock) reanchor(simMs uint64) {
	c.anchorWall, c.anchorSimMs = c.clock.Now(), simMs
}

// start resumes the clock at its current instant.
func (c *simClock) start() {
	c.reanchor(c.now())
	c.running = true
}

// freeze stops the clock at its current instant.
func (c *simClock) freeze() {
	c.reanchor(c.now())
	c.running = false
}

// freezeAt stops the clock at simMs, which is what the end of data does with
// the timestamp of the last row.
func (c *simClock) freezeAt(simMs uint64) {
	c.reanchor(simMs)
	c.running = false
}

// setSpeed re-anchors at the current instant and replays from there at speed.
func (c *simClock) setSpeed(speed uint16) {
	c.reanchor(c.now())
	c.speed = speed
}

// waitFor returns the wall duration until the clock reaches targetMs, zero
// when it already has.
//
// The division rounds up, so the loop never wakes a fraction of a millisecond
// before the row is due and then has to compute a second, shorter wait.
func (c *simClock) waitFor(targetMs uint64) time.Duration {
	now := c.now()
	if targetMs <= now {
		return 0
	}
	deltaMs := targetMs - now
	if deltaMs > uint64(maxWait/time.Millisecond) {
		deltaMs = uint64(maxWait / time.Millisecond)
	}
	speed := uint64(c.speed)
	ns := (deltaMs*uint64(time.Millisecond) + speed - 1) / speed
	wait := time.Duration(ns)
	if wait > maxWait {
		wait = maxWait
	}
	return wait
}

// after returns a channel that fires when the clock reaches targetMs.
func (c *simClock) after(targetMs uint64) <-chan time.Time {
	return c.clock.After(c.waitFor(targetMs))
}
