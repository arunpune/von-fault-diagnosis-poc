// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"encoding/binary"
	"math/rand/v2"
)

// The seven transform primitives (docs/simulation.md). Each is a pure function
// of the value it reads and the envelope magnitude m; the state guard and the
// per-instance bookkeeping live in the engine.

// applyOffset adds value·m.
func applyOffset(v, value, m float64) float64 { return v + value*m }

// applyScale multiplies by 1+(factor−1)·m, so m = 0 leaves the value alone
// and m = 1 multiplies by factor.
func applyScale(v, factor, m float64) float64 { return v * (1 + (factor-1)*m) }

// applyRamp adds rate·minutes·m, clamped to ±capAbs. A cap of zero caps the
// drift at zero, which is why LoadCatalog rejects a ramp without a rate but
// accepts one with a zero cap only as the author's explicit choice.
func applyRamp(v, ratePerMin, capAbs, m, minutes float64) float64 {
	return v + max(-capAbs, min(capAbs, ratePerMin*minutes*m))
}

// applyNoise adds a draw of the standard normal scaled to deviation sigma·m.
func applyNoise(v, sigma, m, draw float64) float64 { return v + draw*sigma*m }

// FNV-1a over 64 bits (the algorithm of hash/fnv, inlined so seeding a draw
// allocates nothing).
const (
	fnvOffset64 uint64 = 14695981039346656037
	fnvPrime64  uint64 = 1099511628211
)

// fnv64a folds b into the running hash h.
func fnv64a(h uint64, b []byte) uint64 {
	for _, c := range b {
		h ^= uint64(c)
		h *= fnvPrime64
	}
	return h
}

// noiseDraw returns the standard-normal draw one noise transform of one
// instance makes at one simulated instant.
//
// The PRNG is seeded from the instance id, the simulated timestamp and the
// transform's position in the definition, so the same instance replayed over
// the same row yields the same value however often the sim is restarted, at
// any speed, and two noise transforms of one instance never draw the same
// number. The draw does not depend on sigma, which is what makes the deviation
// scale linearly with it.
func noiseDraw(instanceID string, simTsMs uint64, transform int) float64 {
	var buf [12]byte
	binary.BigEndian.PutUint64(buf[0:8], simTsMs)
	binary.BigEndian.PutUint32(buf[8:12], uint32(transform))

	seed := fnv64a(fnvOffset64, []byte(instanceID))
	seed = fnv64a(seed, buf[:])

	// PCG takes two words; the second is the first folded once more so the
	// two are not equal for any input.
	return rand.New(rand.NewPCG(seed, fnv64a(seed, buf[:]))).NormFloat64()
}

// dutyState is the per-instance, per-transform bookkeeping of a duty_shift.
//
// The transform sees one sample at a time, so it tracks the runs of the level
// it stretches as they pass: seen carries the previous sample's source value,
// runStartMs the instant the current run of that level began, and endedMs the
// instant the last run stopped. A run that was already under way when the
// instance started is not tracked — its start is unknown — so duty_shift only
// stretches or suppresses runs it watched begin.
type dutyState struct {
	seen       bool
	prev       bool
	runOpen    bool
	runStartMs uint64
	ending     bool
	endedMs    uint64
}

// applyDutyShift returns the value the tag reports and updates the run
// bookkeeping. v is the source value of this sample, runValue the level the
// transform stretches, and extendS the seconds each run of that level is
// extended (positive) or cut from its start (negative).
func (d *dutyState) applyDutyShift(v, runValue bool, extendS int, simTsMs uint64) bool {
	prev, seen := d.prev, d.seen
	d.prev, d.seen = v, true

	if v != runValue {
		// The level the transform stretches has gone; a positive extension
		// keeps reporting it for its own seconds past the end of the run.
		if seen && prev == runValue {
			d.ending, d.endedMs = true, simTsMs
		}
		d.runOpen = false
		if d.ending {
			if extendS > 0 && simTsMs-d.endedMs < uint64(extendS)*1000 {
				return runValue
			}
			d.ending = false
		}
		return v
	}

	d.ending = false
	if seen && prev != runValue {
		// A watched start: the run is tracked from this sample on.
		d.runOpen, d.runStartMs = true, simTsMs
	} else if !d.runOpen {
		// A run that was already under way when the instance started; its
		// beginning is unknown, so it is neither suppressed nor stretched.
		return v
	}
	if extendS < 0 && simTsMs-d.runStartMs < uint64(-extendS)*1000 {
		return !runValue
	}
	return v
}
