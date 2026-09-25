// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The synthetic ambient temperature (docs/simulation.md).
//
// MetroPT-3 recorded no room temperature, so the simulator invents one and
// writes it into the ambient slot of every sample; without it the pipeline
// could not tell an oil temperature that follows a hot room from one that does
// not, which is the discriminator the `high_ambient_temperature` injection is
// built on. The model is a pure function of the simulated instant:
//
//   ambient(t) = 15 + 7·sin(2π·(doy(t) − 105)/365)
//                   + 4·sin(2π·(hour(t) − 9)/24)   °C
//
// The seasonal term crosses the mean going up on day 105 — 15 April — and
// therefore peaks a quarter of a year later, in mid-July; it puts the daily
// mean near 8.3 °C on 1 February and near 21.3 °C on 10 August, the "≈ 9 °C in
// February and ≈ 22 °C in August" the simulator documents. The diurnal term
// peaks at 15:00 and bottoms at 03:00 UTC.
//
// The simulator adds one more term this port deliberately leaves out: a
// deterministic ±0.3 °C hash of `sim_ts` (`services/modbus/internal/sim/
// ambient.go`). The port tolerates the difference rather than reproducing it —
// the bucket detection reads (`cold | mild | warm | hot`) is decided in whole
// degrees, so a third of a degree never moves it — and the parity test allows
// `AMBIENT_TOLERANCE_C` on this one tag. If the port ever adopts the hash, the
// tolerance drops to one register step and this comment goes with it.
//
// The day of the year is computed here rather than through `Date`, with the
// same civil-from-days arithmetic the simulator uses, so the two agree on
// every leap year by construction instead of by test.

/** The yearly mean of the model, in °C. */
export const AMBIENT_MEAN_C = 15;

/** Half the peak-to-peak seasonal swing, in °C. */
export const AMBIENT_SEASONAL_AMPLITUDE_C = 7;

/** The day of the year the seasonal term crosses the mean going up; it peaks 91 days later. */
export const AMBIENT_SEASONAL_PEAK_DOY = 105;

/** The period of the seasonal term, in days; a leap year is not a longer season. */
export const AMBIENT_DAYS_PER_YEAR = 365;

/** Half the peak-to-peak diurnal swing, in °C. */
export const AMBIENT_DIURNAL_AMPLITUDE_C = 4;

/** The UTC hour the diurnal term crosses zero going up; it peaks six hours later. */
export const AMBIENT_DIURNAL_ZERO_HOUR = 9;

/** The period of the diurnal term, in hours. */
export const AMBIENT_HOURS_PER_DAY = 24;

/** The half-width of the hash noise the simulator adds and this port does not, in °C. */
export const AMBIENT_NOISE_C = 0.3;

/**
 * How far the port's ambient value may sit from the simulator's.
 *
 * It is the simulator's noise half-width plus one register step of the tag's 0.01 °C
 * quantisation, rounded up: anything larger is a difference in the model, not in the noise.
 */
export const AMBIENT_TOLERANCE_C = 0.35;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Days from 1 March to 31 December: the part of a March-based year in its own calendar year. */
const DAYS_FROM_MARCH_TO_JANUARY = 306;

/** The days of January and February in a common year. */
const DAYS_BEFORE_MARCH = 31 + 28;

/** Days from 0000-03-01 to the Unix epoch, the offset into a 400-year era. */
const EPOCH_TO_ERA_START = 719_468;

/** Days in a 400-year era, and the three cycle lengths the year-of-era formula corrects by. */
const DAYS_PER_ERA = 146_097;
const DAYS_PER_4_YEARS = 1_460;
const DAYS_PER_CENTURY = 36_524;
const LAST_DAY_OF_ERA = 146_096;

/**
 * The 1-based day of the year of an epoch-millisecond instant read as UTC.
 *
 * It is the civil-from-days conversion on a year that starts on 1 March, which puts the leap
 * day last and removes every special case from the month arithmetic; it is what Go's
 * `time.Time.YearDay` returns for the same instant, and what
 * `services/modbus/internal/sim/ambient.go` computes the same way.
 *
 * Instants before the Unix epoch are outside the recording and outside this function.
 */
export function dayOfYear(simTsMs: number): number {
  const days = Math.floor(simTsMs / MS_PER_DAY);
  const z = days + EPOCH_TO_ERA_START;
  const era = Math.floor(z / DAYS_PER_ERA);
  const dayOfEra = z - era * DAYS_PER_ERA;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / DAYS_PER_4_YEARS) +
      Math.floor(dayOfEra / DAYS_PER_CENTURY) -
      Math.floor(dayOfEra / LAST_DAY_OF_ERA)) /
      365,
  );
  const dayOfMarchYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));

  if (dayOfMarchYear >= DAYS_FROM_MARCH_TO_JANUARY) {
    // January or February of the next calendar year.
    return dayOfMarchYear - DAYS_FROM_MARCH_TO_JANUARY + 1;
  }
  const year = yearOfEra + era * 400;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return dayOfMarchYear + DAYS_BEFORE_MARCH + (leap ? 1 : 0) + 1;
}

/** The fractional UTC hour of an epoch-millisecond instant, in `[0, 24)`. */
export function hourOfDay(simTsMs: number): number {
  const intoDay = simTsMs - Math.floor(simTsMs / MS_PER_DAY) * MS_PER_DAY;
  return intoDay / MS_PER_HOUR;
}

/**
 * The synthetic ambient temperature in °C at a simulated instant.
 *
 * It is the `ambient` hook of `ReplayHooks`: the replay writes it into the synthetic lane of
 * every row before the overlays run, exactly where the simulator computes it, so an
 * injection that raises the room temperature adds to a real value rather than to zero.
 */
export function ambient(simTsMs: number): number {
  const seasonal =
    AMBIENT_SEASONAL_AMPLITUDE_C *
    Math.sin(
      (2 * Math.PI * (dayOfYear(simTsMs) - AMBIENT_SEASONAL_PEAK_DOY)) / AMBIENT_DAYS_PER_YEAR,
    );
  const diurnal =
    AMBIENT_DIURNAL_AMPLITUDE_C *
    Math.sin(
      (2 * Math.PI * (hourOfDay(simTsMs) - AMBIENT_DIURNAL_ZERO_HOUR)) / AMBIENT_HOURS_PER_DAY,
    );
  return AMBIENT_MEAN_C + seasonal + diurnal;
}
