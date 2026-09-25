// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `tools/eval/fixtures/catalog.json` — the reference fault catalog the manual build exports, init
// ingests and the evaluation harness scores against — is a `catalog` document. The file is
// committed, so this test is hard: it never skips. It is what keeps the four readers of that one
// file honest.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Catalog } from "../src/generated/types.ts";
import { contractsDir } from "../src/testing.ts";
import { validate } from "../src/validate.ts";

const CATALOG_FILE = join(
  resolve(contractsDir, "..", ".."),
  "tools",
  "eval",
  "fixtures",
  "catalog.json",
);

const document = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as unknown;

describe("tools/eval/fixtures/catalog.json", () => {
  it("validates against the catalog schema", () => {
    const result = validate("catalog", document);
    expect(result.ok ? [] : result.errors.map((error) => error.text)).toEqual([]);
  });

  const catalog = document as Catalog;

  it("names every cause, condition, signal, alarm and task once", () => {
    for (const [what, ids] of [
      ["causes", catalog.causes.map((cause) => cause.fault_id)],
      ["conditions", catalog.conditions.map((condition) => condition.id)],
      ["signals", catalog.signals.map((signal) => signal.id)],
      ["alarms", catalog.alarms.map((alarm) => alarm.code)],
      ["maintenance", catalog.maintenance.map((task) => task.id)],
      ["parameters", catalog.parameters.map((parameter) => parameter.id)],
    ] as const) {
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index).sort();
      expect({ what, duplicates }).toEqual({ what, duplicates: [] });
    }
  });

  it("resolves every cause a condition lists and every condition a cause explains", () => {
    const faultIds = new Set(catalog.causes.map((cause) => cause.fault_id));
    const conditionIds = new Set(catalog.conditions.map((condition) => condition.id));

    const unknownCauses = catalog.conditions
      .flatMap((condition) =>
        condition.causes.map((cause) => `${condition.id} -> ${cause.fault_id}`),
      )
      .filter((edge) => !faultIds.has(edge.split(" -> ")[1] ?? ""))
      .sort();
    expect(unknownCauses).toEqual([]);

    const unknownConditions = catalog.causes
      .flatMap((cause) =>
        cause.conditions.map((condition) => `${cause.fault_id} -> ${condition.condition_id}`),
      )
      .filter((edge) => !conditionIds.has(edge.split(" -> ")[1] ?? ""))
      .sort();
    expect(unknownConditions).toEqual([]);
  });

  it("resolves every alarm code a cause or a condition refers to", () => {
    const codes = new Set(catalog.alarms.map((alarm) => alarm.code));
    const referenced = [
      ...catalog.conditions.flatMap((condition) =>
        condition.alarms.map((code) => `${condition.id} -> ${code}`),
      ),
      ...catalog.causes.flatMap((cause) => [
        ...cause.related_alarms.map((code) => `${cause.fault_id} -> ${code}`),
        ...cause.conditions.flatMap((condition) =>
          condition.alarms.map((code) => `${cause.fault_id}/${condition.condition_id} -> ${code}`),
        ),
      ]),
    ];
    expect(referenced.filter((edge) => !codes.has(edge.split(" -> ")[1] ?? "")).sort()).toEqual([]);
  });

  it("resolves every maintenance task a cause refers to", () => {
    const tasks = new Set(catalog.maintenance.map((task) => task.id));
    const referenced = catalog.causes.flatMap((cause) =>
      cause.maintenance.map((id) => `${cause.fault_id} -> ${id}`),
    );
    expect(referenced.filter((edge) => !tasks.has(edge.split(" -> ")[1] ?? "")).sort()).toEqual([]);
  });
});
