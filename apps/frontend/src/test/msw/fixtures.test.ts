// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The fixtures are the contract: every file under src/test/fixtures is validated against the
// JSON Schemas of @fdp/contracts, so a fixture that drifts from the wire format fails here and
// not in a component test that happens to read the field. The schemas are read as data through
// Vite's glob import — the UI never loads the contracts package's runtime, not even in a test —
// and compiled with the same Ajv options the package uses.

import Ajv2020, { type AnySchemaObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import type { ServerFrameType } from "@/api/types";
import { SERVER_FRAME_TYPES } from "@/api/ws-types";
import { fixtures, frames } from "@/test/msw/fixtures";

const schemaFiles = import.meta.glob<AnySchemaObject>(
  "/node_modules/@fdp/contracts/schemas/v1/*.schema.json",
  { eager: true, import: "default" },
);

const fixtureFiles = import.meta.glob<unknown>("/src/test/fixtures/*.json", {
  eager: true,
  import: "default",
});

/** The options of `@fdp/contracts`'s own validators (`AJV_OPTIONS`). */
const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
addFormats(ajv);
for (const schema of Object.values(schemaFiles)) {
  ajv.addSchema(schema);
}

function schemaId(name: string): string {
  return `urn:fdp:schema:${name}:v1`;
}

function issues(name: string, document: unknown): string[] {
  const validate = ajv.getSchema(schemaId(name));
  if (validate === undefined) {
    throw new Error(`no contract schema named ${name}`);
  }
  return validate(document) ? [] : (validate.errors ?? []).map((error) => ajv.errorsText([error]));
}

/** Fixture file → the contract schema its body (or each of its items) follows. */
const DOCUMENTS: readonly (readonly [file: string, schema: string, document: unknown])[] = [
  ["status.json", "api-status", fixtures.status],
  ["signals.json", "api-signals", fixtures.signals],
  ["series.json", "api-telemetry-series", fixtures.series["api-telemetry-series"]],
  ["events.json", "api-events", fixtures.events],
  ["decisions.json", "api-decisions", fixtures.decisions],
  ["decision.json", "decision", fixtures.decision],
  ["decision-failed.json", "decision", fixtures.decisionFailed],
  ["tickets.json", "api-tickets", fixtures.tickets],
  ["ticket.json", "ticket", fixtures.ticket],
  ["cost.json", "api-cost", fixtures.cost],
  ["catalog-fault.json", "catalog-entry", fixtures.catalogFault],
  ["overlay-catalog.json", "gt-catalog", fixtures.overlayCatalog],
  ["overlay-active.json", "gt-injection-active", fixtures.overlayActive],
  ["sim-command-result.json", "api-sim-command-result", fixtures.simCommandResult],
  ["health.json", "api-health", fixtures.health],
  ...fixtures.alerts.items.map((alert) => ["alerts.json", "alert-system", alert] as const),
  ...fixtures.overlayMarkers.items.map(
    (marker) => ["overlay-markers.json", "gt-marker", marker] as const,
  ),
  ...fixtures.ticket.decisions.map((decision) => ["ticket.json", "decision", decision] as const),
];

function frameFile(type: ServerFrameType): string {
  return `ws-${type.replaceAll(/[._]/g, "-")}.json`;
}

describe("the fixtures follow the contracts", () => {
  it.each(DOCUMENTS)("%s is a valid %s", (_file, schema, document) => {
    expect(issues(schema, document)).toEqual([]);
  });

  it.each(SERVER_FRAME_TYPES)("the %s frame is a valid ws-server-message", (type) => {
    const frame = frames[type];
    expect(frame.type).toBe(type);
    expect(issues("ws-server-message", frame)).toEqual([]);
  });

  it("rejects a document that breaks its schema, so the checks above can fail", () => {
    expect(issues("ticket", { ...fixtures.ticket, status: "pending" })).not.toEqual([]);
    expect(issues("api-ticket-close", { outcome: "correct" })).not.toEqual([]);
  });

  it("keeps the rows without a contract in the backend's shape", () => {
    for (const row of fixtures.overlayInjections.items) {
      expect(Object.keys(row).toSorted()).toEqual([
        "end_sim_ts",
        "fault_id",
        "injection_id",
        "instance_id",
        "params",
        "reason",
        "start_sim_ts",
        "unit_id",
      ]);
    }
  });

  it("checks every fixture file", () => {
    const covered = new Set([
      ...DOCUMENTS.map(([file]) => file),
      ...SERVER_FRAME_TYPES.map(frameFile),
      "overlay-injections.json",
    ]);
    const files = Object.keys(fixtureFiles).map((path) => path.split("/").at(-1));
    expect(files.toSorted()).toEqual([...covered].toSorted());
  });

  it("offers the tour's preset and injection with their README labels", () => {
    const { presets, injections, failures } = fixtures.overlayCatalog;
    expect(presets.presets).toContainEqual(
      expect.objectContaining({
        preset_id: "f3_air_leak_jun05",
        label: "Air leak – 5 Jun 2020",
        kind: "failure",
        sim_ts: "2020-06-05T10:00:00.000Z",
        lead_in_min: 240,
      }),
    );
    expect(injections).toContainEqual(
      expect.objectContaining({
        injection_id: "oil_cooler_fouling",
        label: "Oil cooler fouling",
        fault_id: "oil_cooler_fouled",
      }),
    );
    expect(injections.every((injection) => injection.params.length > 0)).toBe(true);
    expect(failures.failures.map((failure) => failure.id)).toEqual(["F1", "F2", "F3", "F4", "F4b"]);
  });

  it("gives the tickets list one ticket per status", () => {
    expect(fixtures.tickets.items.map((ticket) => ticket.status).toSorted()).toEqual([
      "closed",
      "open",
      "resolved",
      "review",
    ]);
  });

  it("describes the 15 recorded columns and the synthetic ambient temperature", () => {
    const { signals } = fixtures.signals;
    expect(signals.filter((signal) => signal.metropt_column !== null)).toHaveLength(15);
    expect(signals.find((signal) => signal.signal_id === "ambient_temperature")).toMatchObject({
      metropt_column: null,
      source: "synthetic",
    });
  });
});
