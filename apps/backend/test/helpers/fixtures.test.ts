// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The generated telemetry fixtures, when they are there.
 *
 * Nothing derived from MetroPT-3 is committed, so this file skips on a machine
 * that has not run `make fixtures` and `pnpm --filter @fdp/backend fixtures`.
 * `test/global-setup.ts` turns that skip into a failure under
 * `FDP_REQUIRE_DATASET=1`, which is how CI insists on the dataset.
 */

import { isValid } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { BACKEND_FIXTURE_NAMES, hasFixture, loadFixture } from "./fixtures.ts";

const present = BACKEND_FIXTURE_NAMES.filter((name) => hasFixture(name));

describe.skipIf(present.length === 0)("the generated telemetry fixtures", () => {
  it("are all six, or the suite says which are missing", () => {
    expect(present).toEqual([...BACKEND_FIXTURE_NAMES]);
  });

  it.each(present)("%s validates batch by batch against telemetry-samples", (name) => {
    const fixture = loadFixture(name);
    expect(fixture.batches.length).toBeGreaterThan(0);
    for (const batch of fixture.batches) expect(isValid("telemetry-samples", batch)).toBe(true);
  });

  it.each(present)("%s records where it came from", (name) => {
    const fixture = loadFixture(name);
    expect(fixture.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.slice.length).toBeGreaterThan(0);
    expect(fixture.generated_by).toContain("make-fixtures.ts");
    expect(typeof fixture.signals_provisional).toBe("boolean");
  });

  it.each(present)("%s counts its samples in order, from one", (name) => {
    const fixture = loadFixture(name);
    const samples = fixture.batches.flatMap((batch) => batch.samples);
    expect(samples.length).toBe(fixture.samples);
    expect(samples[0]?.seq).toBe(1);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]?.seq).toBe((samples[index - 1]?.seq ?? 0) + 1);
    }
  });

  it.skipIf(!hasFixture("gap-jump"))("marks the jump of the synthetic fixture exactly once", () => {
    const fixture = loadFixture("gap-jump");
    const flagged = fixture.batches
      .flatMap((batch) => batch.samples)
      .filter((sample) => sample.flags.discontinuity);
    expect(flagged).toHaveLength(1);
    expect(fixture.slice).toMatch(/^synthetic:/);
  });

  it.skipIf(!hasFixture("baseline-feb"))("keeps the baseline fixture free of any jump", () => {
    const fixture = loadFixture("baseline-feb");
    const flagged = fixture.batches
      .flatMap((batch) => batch.samples)
      .filter((sample) => sample.flags.discontinuity);
    expect(flagged).toEqual([]);
  });
});
