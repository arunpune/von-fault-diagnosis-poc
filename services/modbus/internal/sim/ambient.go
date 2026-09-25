// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Package sim is the machine: the replay engine, the register store, the
// read-only Modbus server and the synthetic extras the recording does not
// carry.
package sim

import "math"

// The synthetic ambient-temperature model (docs/simulation.md, "Synthetic
// ambient temperature"):
//
//	ambient(t) = 15 + 7·sin(2π·(doy(t) − 105)/365)
//	                + 4·sin(2π·(hour(t) − 9)/24)
//	                + n(t)   °C
//
// The seasonal term peaks in mid-April and bottoms in mid-October, which puts
// the daily mean near 9 °C in February and near 22 °C in August; the diurnal
// term peaks at 15:00 and bottoms at 03:00 UTC.
const (
	ambientMeanC              = 15.0
	ambientSeasonalAmplitudeC = 7.0
	ambientSeasonalPeakDoy    = 105.0
	ambientDaysPerYear        = 365.0
	ambientDiurnalAmplitudeC  = 4.0
	ambientDiurnalZeroHour    = 9.0
	ambientHoursPerDay        = 24.0
)

// AmbientNoiseC is the half-width of the deterministic noise the model adds,
// in °C: n(t) ∈ [−AmbientNoiseC, +AmbientNoiseC].
const AmbientNoiseC = 0.3

const (
	msPerHour uint64 = 3_600_000
	msPerDay  uint64 = 24 * msPerHour
)

// Ambient returns the synthetic ambient temperature in °C for a sample whose
// simulated timestamp is simTsMs, epoch milliseconds UTC.
//
// It is a pure function of that timestamp: the same instant always yields the
// same value, whatever the replay speed, whether the row is reached by playing
// forward or by jumping, and however many times it is recomputed. The noise
// term is a hash of the timestamp rather than a draw from a generator, so
// there is no state to seed and no state to reset.
//
// The high_ambient_temperature injection overlay adds to this value; the
// result is written at slot offset 22 and published as
// values.ambient_temperature.
func Ambient(simTsMs uint64) float64 {
	doy := float64(dayOfYear(simTsMs))
	hour := float64(simTsMs%msPerDay) / float64(msPerHour)

	seasonal := ambientSeasonalAmplitudeC *
		math.Sin(2*math.Pi*(doy-ambientSeasonalPeakDoy)/ambientDaysPerYear)
	diurnal := ambientDiurnalAmplitudeC *
		math.Sin(2*math.Pi*(hour-ambientDiurnalZeroHour)/ambientHoursPerDay)

	return ambientMeanC + seasonal + diurnal + ambientNoise(simTsMs)
}

// daysFromMarchToJanuary is the number of days from 1 March to 31 December,
// the length of the part of a March-based year that falls in the calendar year
// it starts in.
const daysFromMarchToJanuary int64 = 306

// daysBeforeMarch is the number of days of January and February in a common
// year; a leap year has one more.
const daysBeforeMarch int64 = 31 + 28

// dayOfYear returns the 1-based day of the year of an epoch-millisecond
// instant read as UTC, matching time.Time.YearDay.
//
// It is the civil-from-days conversion on a year that starts on 1 March, which
// puts the leap day last and removes every special case from the month
// arithmetic. Doing it here rather than through time.Time keeps Ambient free
// of allocation and of the monotonic-clock machinery: the emit loop calls it
// once per emitted sample, and the injection engine may call it again.
func dayOfYear(simTsMs uint64) int {
	days := int64(simTsMs / msPerDay)

	// Days since 0000-03-01, which is the start of a 400-year era.
	const epochToEraStart = 719468
	z := days + epochToEraStart
	era := z / 146097
	dayOfEra := z - era*146097 // [0, 146096]
	yearOfEra := (dayOfEra - dayOfEra/1460 + dayOfEra/36524 - dayOfEra/146096) / 365
	dayOfMarchYear := dayOfEra - (365*yearOfEra + yearOfEra/4 - yearOfEra/100) // [0, 365]

	if dayOfMarchYear >= daysFromMarchToJanuary {
		// January or February of the next calendar year.
		return int(dayOfMarchYear-daysFromMarchToJanuary) + 1
	}
	year := yearOfEra + era*400
	offset := daysBeforeMarch
	if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
		offset++
	}
	return int(dayOfMarchYear+offset) + 1
}

// ambientNoise maps the FNV-1a 64 hash of the timestamp uniformly onto
// [−AmbientNoiseC, +AmbientNoiseC].
func ambientNoise(simTsMs uint64) float64 {
	// The top 53 bits of the hash are as many bits as a float64 mantissa
	// holds, so the quotient is a uniform value in [0, 1).
	unit := float64(fnv1a64(simTsMs)>>11) / float64(uint64(1)<<53)
	return (2*unit - 1) * AmbientNoiseC
}

// fnv1a64 is FNV-1a over the eight big-endian bytes of v. It matches
// hash/fnv's New64a fed with those bytes and allocates nothing, which matters
// because the emit loop calls it once per sample and the model is measured at
// a million calls.
func fnv1a64(v uint64) uint64 {
	const (
		offsetBasis uint64 = 14695981039346656037
		prime       uint64 = 1099511628211
	)
	hash := offsetBasis
	for shift := 56; shift >= 0; shift -= 8 {
		hash ^= (v >> uint(shift)) & 0xff
		hash *= prime
	}
	return hash
}
