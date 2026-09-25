// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { PresetDef } from "@/api/types";
import { groupPresets } from "@/features/simulation/presets";
import { fixtures } from "@/test/msw/fixtures";

const PRESETS: readonly PresetDef[] = fixtures.overlayCatalog.presets.presets;

function preset(presetId: string, kind: string): PresetDef {
  const base = PRESETS[0];
  if (base === undefined) {
    throw new Error("overlay-catalog.json lists presets");
  }
  // A kind outside the contract's enum stands for one a newer catalog adds.
  return { ...base, preset_id: presetId, kind: kind as PresetDef["kind"] };
}

describe("groupPresets", () => {
  it("puts failures and precursors under Dataset failures, the rest under Diagnostic", () => {
    const groups = groupPresets(PRESETS);

    expect(groups.map((group) => group.title)).toEqual(["Dataset failures", "Diagnostic"]);
    expect(groups[0]?.presets.map((item) => item.label)).toEqual([
      "Air leak – 18 Apr 2020",
      "Air leak – 30 May 2020",
      "Air leak – 5 Jun 2020",
      "Air leak precursor – 14 Jul 2020",
      "Air leak – 15 Jul 2020",
    ]);
    expect(groups[1]?.presets.map((item) => item.kind)).toEqual([
      "baseline",
      "diagnostic",
      "diagnostic",
      "diagnostic",
    ]);
  });

  it("keeps the catalog's order inside each section", () => {
    const groups = groupPresets(PRESETS);
    const order = PRESETS.map((item) => item.preset_id);

    for (const group of groups) {
      const positions = group.presets.map((item) => order.indexOf(item.preset_id));
      expect(positions.toSorted((a, b) => a - b)).toEqual(positions);
    }
  });

  it("drops an empty section and files a kind it does not know under Diagnostic", () => {
    const groups = groupPresets([preset("dryer_swap", "maintenance")]);

    expect(groups).toEqual([{ title: "Diagnostic", presets: [expect.anything()] }]);
    expect(groupPresets([])).toEqual([]);
  });
});
