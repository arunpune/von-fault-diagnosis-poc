// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The two identifiers the harness generates itself.
//
// Both are derived, never random: a run is named after the instant it started
// and the profile it ran, and an injection instance is numbered from a boot id
// (`inj-<bootid>-<n>`). Two runs of the same profile over the same cassettes
// must produce metric-identical reports, so nothing here reads a clock or a
// random source on its own.

/** `<yyyymmdd-hhmmss>-<profile>`, the name of a run directory under `reports/eval/`. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9][a-z0-9_-]*$/;

/** `inj-<bootid>-<n>`, the instance id shape the contracts pin for `gt-injection`. */
export const INSTANCE_ID_PATTERN = /^inj-[0-9a-z]+-\d{6}$/;

/** What a profile name and a boot id may contain, so a generated id never needs escaping. */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const BOOT_ID_PATTERN = /^[0-9a-z]{1,16}$/;

/** Instance numbers are zero-padded so that a lexical sort is a chronological one. */
const INSTANCE_DIGITS = 6;
const MAX_INSTANCES = 10 ** INSTANCE_DIGITS;

/**
 * The id of a run: the UTC instant it started, then the profile.
 *
 * @throws TypeError when the profile is not a lowercase identifier, and RangeError when the
 * instant is not representable (which would silently produce a malformed directory name).
 */
export function runId(profile: string, startedAt: Date): string {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new TypeError(`not a profile name: ${JSON.stringify(profile)}`);
  }
  const iso = startedAt.toISOString();
  if (!/^\d{4}-/.test(iso)) {
    throw new RangeError(`run start is not representable as a run id: ${iso}`);
  }
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `${date}-${time}-${profile}`;
}

/**
 * A counter that hands out injection instance ids, starting at `inj-<bootId>-000001`.
 *
 * One counter per replay: every scenario run gets a fresh injection engine, so the
 * n-th injection of a scenario always carries the same id whatever ran before it. `bootId`
 * separates two runs that share a report, as the simulator's boot id separates two restarts.
 *
 * @throws TypeError when the boot id is not lowercase alphanumeric, and RangeError when more
 * than a million instances are asked of one counter (the id would stop being fixed width).
 */
export function createInstanceIds(bootId: string): () => string {
  if (!BOOT_ID_PATTERN.test(bootId)) {
    throw new TypeError(`not a boot id: ${JSON.stringify(bootId)}`);
  }
  let issued = 0;
  return () => {
    issued += 1;
    if (issued >= MAX_INSTANCES) {
      throw new RangeError(`more than ${MAX_INSTANCES - 1} injection instances for boot ${bootId}`);
    }
    return `inj-${bootId}-${String(issued).padStart(INSTANCE_DIGITS, "0")}`;
  };
}
