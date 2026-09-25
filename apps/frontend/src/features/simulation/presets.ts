// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The "Jump to" menu's sections. The catalog lists its presets in the order the menu shows
// them; the menu splits them by what they demonstrate: the dataset's own failures and their
// precursors first, then the diagnostic cases and normal operation.

import type { PresetDef } from "@/api/types";

export interface PresetGroup {
  /** The section heading. */
  title: string;
  /** The section's presets, in catalog order. */
  presets: PresetDef[];
}

const DATASET_FAILURE_KINDS: ReadonlySet<string> = new Set<PresetDef["kind"]>([
  "failure",
  "precursor",
]);

/**
 * The non-empty sections, "Dataset failures" before "Diagnostic". Diagnostic takes the
 * diagnostic and baseline presets, and any kind a newer catalog adds.
 */
export function groupPresets(presets: readonly PresetDef[]): PresetGroup[] {
  const failures: PresetDef[] = [];
  const diagnostic: PresetDef[] = [];
  for (const preset of presets) {
    (DATASET_FAILURE_KINDS.has(preset.kind) ? failures : diagnostic).push(preset);
  }
  const groups: PresetGroup[] = [
    { title: "Dataset failures", presets: failures },
    { title: "Diagnostic", presets: diagnostic },
  ];
  return groups.filter((group) => group.presets.length > 0);
}
