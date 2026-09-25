// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

// msPerMin is the simulated milliseconds in one simulated minute. Envelopes,
// ramps and durations are all stated in minutes in the catalog and evaluated
// against the millisecond sim clock.
const msPerMin = 60_000

// envelope is one running instance's trapezoid in simulated milliseconds.
type envelope struct {
	startMs   uint64
	endMs     uint64
	rampInMs  uint64
	rampOutMs uint64
}

// newEnvelope places the definition's ramps inside the instance's own
// duration.
//
// A definition's ramps always fit its default duration (LoadCatalog rejects
// one that does not), but an instance may ask for a shorter run than the
// default, and the two ramps would then overlap. In that case both are scaled
// down by the same factor, which turns the trapezoid into a triangle instead
// of letting the hold go negative. The model only requires the hold to be
// non-negative for the definition, so this is the smallest sound rule: the
// shape keeps the ratio the author wrote.
func newEnvelope(startMs, endMs uint64, env Envelope) envelope {
	total := endMs - startMs
	in := uint64(env.RampInMin) * msPerMin
	out := uint64(env.RampOutMin) * msPerMin
	if in+out > total {
		in = uint64(float64(total) * float64(in) / float64(in+out))
		out = total - in
	}
	return envelope{startMs: startMs, endMs: endMs, rampInMs: in, rampOutMs: out}
}

// at returns the envelope value at simTsMs: zero before the start and from
// the end on, a linear rise over the ramp in, one through the hold and a
// linear fall over the ramp out. A zero ramp in means the envelope is already
// at one on the instance's first sample.
func (e envelope) at(simTsMs uint64) float64 {
	if simTsMs < e.startMs || simTsMs >= e.endMs {
		return 0
	}
	if e.rampInMs > 0 && simTsMs < e.startMs+e.rampInMs {
		return float64(simTsMs-e.startMs) / float64(e.rampInMs)
	}
	if e.rampOutMs > 0 && simTsMs > e.endMs-e.rampOutMs {
		return float64(e.endMs-simTsMs) / float64(e.rampOutMs)
	}
	return 1
}

// active reports whether simTsMs falls inside the instance's window. The
// primitives that ignore the magnitude — stuck, duty_shift and dropout — take
// effect over exactly this window, so the window and not the envelope decides
// whether an instance runs at all.
func (e envelope) active(simTsMs uint64) bool {
	return simTsMs >= e.startMs && simTsMs < e.endMs
}
