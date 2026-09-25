// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the generic fixture harness of `schemas.test.ts` cannot see: the rules that hold *across*
// the WebSocket and REST schemas and the schemas they were derived from. Three of them guard a
// duplication the contract deliberately accepts — the per-command argument definitions of
// `api-sim-command`, the channel names of `ws-client-message` and the closure field name of
// `api-ticket-close` — and a fourth proves that a frame's payload is the very document the sibling
// schema describes, which is what lets the frontend hand a frame straight to a component.

import type { AnySchemaObject, ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AJV_OPTIONS } from "../src/generated/validators.ts";
import { fixturesFor, listSchemaNames, schemaPath } from "../src/testing.ts";
import type { ValidFixture } from "../src/testing.ts";
import { parseIsoMs } from "../src/time.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** The hand-written sources, not the embedded copies: the files are the contract. */
const sources = new Map<string, AnySchemaObject>(
  listSchemaNames().map((name) => [
    name,
    JSON.parse(readFileSync(schemaPath(name), "utf8")) as AnySchemaObject,
  ]),
);

function source(name: string): AnySchemaObject {
  const schema = sources.get(name);
  if (schema === undefined) throw new Error(`missing schema ${name}`);
  return schema;
}

/** One Ajv instance built from the files, in exactly the mode the generated validators use. */
const ajv = new Ajv2020({ ...AJV_OPTIONS });
addFormats(ajv);
for (const schema of sources.values()) ajv.addSchema(schema);

/** A validator for a schema or for one of its definitions, addressed by URI. */
function validatorFor(uri: string): ValidateFunction {
  const validator = ajv.getSchema(uri);
  if (validator === undefined) throw new Error(`${uri}: did not compile`);
  return validator;
}

/** The issue texts of the last failed validation, in the `<path> <message>` form. */
function issueTexts(validator: ValidateFunction): string[] {
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? ""}`,
  );
}

function defs(name: string): Record<string, unknown> {
  return source(name).$defs as Record<string, unknown>;
}

/** The `enum` of a string definition, read from the file rather than repeated here. */
function enumOf(name: string, definition: string): string[] {
  const value = (defs(name)[definition] as { enum?: unknown }).enum;
  if (!Array.isArray(value)) throw new Error(`${name}#/$defs/${definition}: no enum`);
  return value as string[];
}

// ---------------------------------------------------------------------------
// (a) The REST body and the MQTT command must take the same arguments. `api-sim-command` copies
// the per-command definitions of `control-cmd` because a REST body carries no envelope; nothing but
// this test keeps the two copies identical.
// ---------------------------------------------------------------------------
describe("api-sim-command against control-cmd", () => {
  const shared = ["command", "no_args", "set_speed_args", "jump_args", "inject_args"] as const;

  it.each(shared)("defines %s exactly as control-cmd does", (definition) => {
    expect(defs("api-sim-command")[definition]).toEqual(defs("control-cmd")[definition]);
  });

  it("branches on the same command names in the same order", () => {
    const branches = (schema: AnySchemaObject): string[] => {
      const oneOf = (schema.oneOf ??
        (schema.allOf as AnySchemaObject[]).flatMap((part) =>
          Array.isArray(part.oneOf) ? (part.oneOf as unknown[]) : [],
        )) as { properties: { cmd: { const: string } } }[];
      return oneOf.map((branch) => branch.properties.cmd.const);
    };
    expect(branches(source("api-sim-command"))).toEqual(branches(source("control-cmd")));
    expect([...branches(source("api-sim-command"))].sort()).toEqual(
      [...enumOf("api-sim-command", "command")].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// (b) A client subscribes by naming frame types, so the two enums are one list written twice.
// A type the server can send but a client cannot name would be undeliverable; a channel the server
// never sends would silence a socket for good.
// ---------------------------------------------------------------------------
describe("ws-client-message channels against ws-server-message types", () => {
  const frameTypes = enumOf("ws-server-message", "frame_type");
  const channels = enumOf("ws-client-message", "channel");

  it("lists the eighteen frame types", () => {
    expect(frameTypes).toHaveLength(18);
    expect(new Set(frameTypes).size).toBe(18);
    expect(frameTypes).toContain("telemetry.series");
    expect(frameTypes).toContain("telemetry.samples");
  });

  it("names every frame type as a channel and every channel as a frame type", () => {
    expect(channels).toEqual(frameTypes);
  });

  it("discriminates one oneOf branch per frame type", () => {
    const oneOf = (source("ws-server-message").allOf as AnySchemaObject[]).flatMap((part) =>
      Array.isArray(part.oneOf) ? (part.oneOf as { properties: { type: unknown } }[]) : [],
    );
    expect(oneOf.map((branch) => (branch.properties.type as { const: string }).const)).toEqual(
      frameTypes,
    );
  });
});

// ---------------------------------------------------------------------------
// (c) Every frame type has a valid fixture, and its payload is the very document the sibling
// schema describes: the frontend hands `frame.payload` straight to the component that renders a
// decision, a ticket or a status, so a payload that only validates inside the envelope is a bug.
// ---------------------------------------------------------------------------
describe("ws-server-message payloads", () => {
  /** Frame types whose payload is another message schema, and the schema it is. */
  const EXTERNAL: Readonly<Record<string, string>> = {
    "telemetry.samples": "telemetry-samples",
    "status.sim": "status-sim",
    "status.gateway": "status-gateway",
    "status.backend": "status-backend",
    "event.suspect": "suspect-event",
    decision: "decision",
    ticket: "ticket",
    "alert.system": "alert-system",
    "overlay.catalog": "gt-catalog",
    "overlay.injection": "gt-injection",
    "overlay.injection_active": "gt-injection-active",
    "overlay.marker": "gt-marker",
  };

  /** Where a frame type's payload is defined: a sibling schema, or an inline definition. */
  function payloadSchemaUri(type: string): string {
    const external = EXTERNAL[type];
    if (external !== undefined) return `urn:fdp:schema:${external}:v1`;
    const definition = `${type.split(".").join("_")}_payload`;
    return `urn:fdp:schema:ws-server-message:v1#/$defs/${definition}`;
  }

  const frameTypes = enumOf("ws-server-message", "frame_type");
  const valid = fixturesFor("ws-server-message").valid;
  const typeOf = ({ data }: ValidFixture): string => (data as { type: string }).type;

  it("ships one valid fixture per frame type", () => {
    expect(valid.map(typeOf).sort()).toEqual([...frameTypes].sort());
  });

  it.each(valid)("$file carries a payload that validates on its own", (fixture) => {
    const validator = validatorFor(payloadSchemaUri(typeOf(fixture)));
    const payload = (fixture.data as { payload: unknown }).payload;
    const ok = validator(payload);
    expect(issueTexts(validator)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects a payload that belongs to another type", () => {
    const decision = valid.find((fixture) => typeOf(fixture) === "decision");
    const ticket = valid.find((fixture) => typeOf(fixture) === "ticket");
    expect(decision).toBeDefined();
    expect(ticket).toBeDefined();
    const mismatched = {
      ...((ticket as ValidFixture).data as object),
      payload: (decision as ValidFixture).data,
    };
    expect(validatorFor("urn:fdp:schema:ws-server-message:v1")(mismatched)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) Charts are drawn straight from these points, so a series that is not in time order would
// draw a line that doubles back. The rule holds for the seeded history and for the live frame,
// which share the `series_point` definition.
// ---------------------------------------------------------------------------
describe("series points", () => {
  interface SeriesEntry {
    readonly tag: string;
    readonly points: readonly (readonly [string, number | null])[];
  }

  /** Every `(tag, points)` pair of a fixture, whether it is a REST body or a WS frame. */
  function entriesOf(data: unknown): SeriesEntry[] {
    const body = data as { series?: unknown; payload?: { series?: unknown } };
    const series = body.series ?? body.payload?.series;
    return Array.isArray(series) ? (series as SeriesEntry[]) : [];
  }

  const cases = [
    ...fixturesFor("api-telemetry-series").valid.map((fixture) => ({
      name: "api-telemetry-series",
      ...fixture,
    })),
    ...fixturesFor("ws-server-message")
      .valid.filter((fixture) => (fixture.data as { type: string }).type === "telemetry.series")
      .map((fixture) => ({ name: "ws-server-message", ...fixture })),
  ];

  it("finds a series in both the REST body and the WebSocket frame", () => {
    expect(new Set(cases.map((entry) => entry.name))).toEqual(
      new Set(["api-telemetry-series", "ws-server-message"]),
    );
    expect(cases.every((entry) => entriesOf(entry.data).length > 0)).toBe(true);
  });

  it.each(cases)("$name/$file is chronological per tag", ({ data }) => {
    const outOfOrder = entriesOf(data).flatMap(({ tag, points }) =>
      points
        .map((point, index) => ({ tag, index, point }))
        .filter(
          ({ index }) =>
            index > 0 &&
            parseIsoMs((points[index] as readonly [string, number | null])[0]).getTime() <
              parseIsoMs((points[index - 1] as readonly [string, number | null])[0]).getTime(),
        ),
    );
    expect(outOfOrder).toEqual([]);
  });

  it("keeps the live frame inside sixty-four points per tag", () => {
    const frames = cases.filter((entry) => entry.name === "ws-server-message");
    for (const { data } of frames) {
      for (const { points } of entriesOf(data)) expect(points.length).toBeLessThanOrEqual(64);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) The ticket closure body is `{ verdict, note?, closed_by? }`, never `outcome`, and the field
// name is pinned by a fixture rather than by prose.
// ---------------------------------------------------------------------------
describe("api-ticket-close field name", () => {
  const { valid, invalid } = fixturesFor("api-ticket-close");

  it("carries verdict in every valid fixture and never outcome", () => {
    expect(valid.map(({ file }) => file)).toContain("valid-correct.json");
    expect(valid.map(({ file }) => file)).toContain("valid-wrong-with-note.json");
    for (const { file, data } of valid) {
      const body = data as Record<string, unknown>;
      expect({ file, verdict: body.verdict }).toEqual({ file, verdict: expect.any(String) });
      expect({ file, outcome: "outcome" in body }).toEqual({ file, outcome: false });
    }
  });

  it("rejects a body that spells the field outcome", () => {
    const outcome = invalid.find((fixture) => fixture.file === "invalid-outcome.json");
    expect(outcome).toBeDefined();
    const body = (outcome as { data: Record<string, unknown> }).data;
    expect(body.outcome).toBe("correct");
    expect(validatorFor("urn:fdp:schema:api-ticket-close:v1")(body)).toBe(false);
  });

  it("uses the same verdict values as the ticket-closure message", () => {
    const rest = (source("api-ticket-close").properties as { verdict: { enum: string[] } }).verdict;
    const mqtt = (source("ticket-closure").properties as { verdict: { enum: string[] } }).verdict;
    expect(rest.enum).toEqual(mqtt.enum);
  });
});
