// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The topic table and the broker ACL. `topics.json` is the single description of the topic tree:
// `infra/mosquitto/acl` is rendered from it and diffed against the committed file, so a mistake
// here becomes a broker that hands ground truth to the browser.

import type { AnySchemaObject } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AJV_OPTIONS } from "../src/generated/validators.ts";
import {
  ACL,
  DEFAULT_UNIT_ID,
  ROOTS,
  TOPIC_META,
  schemaForTopic,
  subscriptionsFor,
  topics,
} from "../src/generated/topics.ts";
import { contractsDir, listSchemaNames, schemaPath } from "../src/testing.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/**
 * Schemas named by `topics.json` that no `schemas/v1` file defines yet.
 *
 * One name per line, so changes that each add a schema remove their own line without touching the
 * others. The list is empty once every topic has its schema.
 */
const pendingSchemas: string[] = [];

/** The credentials that are allowed to see the ground-truth root at all. */
const GT_READERS = ["backend-ops", "sim", "eval"];

const table = JSON.parse(readFileSync(join(contractsDir, "topics.json"), "utf8")) as {
  roots: Record<string, string>;
  default_unit_id: string;
  topics: Record<string, { template: string; schema: string }>;
  acl: Record<string, { read: string[]; write: string[] }>;
};

/** MQTT topic-filter matching: `+` covers one level, `#` covers the rest. */
function filterMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");
  for (let index = 0; index < filterLevels.length; index += 1) {
    const level = filterLevels[index];
    if (level === "#") return true;
    if (index >= topicLevels.length) return false;
    if (level === "+") continue;
    if (level !== topicLevels[index]) return false;
  }
  return filterLevels.length === topicLevels.length;
}

/** True when any of the credential's read filters matches any of the topics. */
function readsAnyOf(credential: keyof typeof ACL, candidates: readonly string[]): boolean {
  const filters = subscriptionsFor(credential);
  return candidates.some((topic) => filters.some((filter) => filterMatches(filter, topic)));
}

const gtTopics = [
  topics.gtCatalog(),
  topics.gtInjection(),
  topics.gtInjectionActive(),
  topics.gtMarker(),
];
const controlTopics = [topics.controlCmd(), topics.controlAck()];

describe("topics.json", () => {
  it("validates against schemas/meta/topics.schema.json", () => {
    const ajv = new Ajv2020({ ...AJV_OPTIONS });
    addFormats(ajv);
    for (const name of listSchemaNames()) {
      ajv.addSchema(JSON.parse(readFileSync(schemaPath(name), "utf8")) as AnySchemaObject);
    }
    const meta = JSON.parse(
      readFileSync(join(contractsDir, "schemas", "meta", "topics.schema.json"), "utf8"),
    ) as AnySchemaObject;
    const validate = ajv.compile(meta);
    expect({ ok: validate(table), errors: validate.errors ?? [] }).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("names an existing v1 schema for every topic, or a declared pending one", () => {
    const known = new Set(listSchemaNames());
    const unexplained = Object.values(table.topics)
      .map((entry) => entry.schema)
      .filter((name) => !known.has(name) && !pendingSchemas.includes(name))
      .sort();
    expect(unexplained).toEqual([]);
  });

  it("keeps pendingSchemas free of schemas that now exist", () => {
    const known = new Set(listSchemaNames());
    expect(pendingSchemas.filter((name) => known.has(name))).toEqual([]);
  });

  it("starts every template with a declared root", () => {
    const roots = new Set(Object.values(table.roots));
    const strays = Object.entries(table.topics)
      .filter(([, entry]) => !roots.has(entry.template.split("/")[0] ?? ""))
      .map(([key]) => key)
      .sort();
    expect(strays).toEqual([]);
  });

  it("puts the unit id in the second level of every template", () => {
    const strays = Object.entries(table.topics)
      .filter(([, entry]) => entry.template.split("/")[1] !== "{unit_id}")
      .map(([key]) => key)
      .sort();
    expect(strays).toEqual([]);
  });
});

describe("generated topic builders", () => {
  it("builds the documented strings for the default unit", () => {
    expect(DEFAULT_UNIT_ID).toBe("cau-7");
    expect(ROOTS).toEqual({ gt: "gt", plant: "plant" });
    expect(topics.telemetrySamples()).toBe("plant/cau-7/telemetry/samples");
    expect(topics.controlCmd()).toBe("plant/cau-7/control/cmd");
    expect(topics.alertsSystem()).toBe("plant/cau-7/alerts/system");
    expect(topics.gtInjectionActive()).toBe("gt/cau-7/injection/active");
    expect(topics.gtMarker("cau-9")).toBe("gt/cau-9/marker");
  });

  it("exposes one meta entry per topic", () => {
    expect(Object.keys(TOPIC_META).length).toBe(Object.keys(table.topics).length);
    expect(TOPIC_META.alertsSystem).toEqual({
      key: "alerts_system",
      template: "plant/{unit_id}/alerts/system",
      schema: "alert-system",
      qos: 1,
      retain: false,
      publisher: "backend-diag",
    });
  });

  it("round-trips every topic through schemaForTopic", () => {
    const known = new Set(listSchemaNames());
    for (const [key, meta] of Object.entries(TOPIC_META)) {
      const topic = meta.template.replace("{unit_id}", DEFAULT_UNIT_ID);
      const expected = known.has(meta.schema) ? meta.schema : undefined;
      expect({ key, schema: schemaForTopic(topic) }).toEqual({ key, schema: expected });
    }
  });

  it("matches a topic of any unit but not a wildcard or a foreign topic", () => {
    expect(schemaForTopic("plant/cau-9/alerts/system")).toBe("alert-system");
    expect(schemaForTopic("plant/+/alerts/system")).toBeUndefined();
    expect(schemaForTopic("plant/cau-7/alerts/system/extra")).toBeUndefined();
    expect(schemaForTopic("plant/cau-7/alerts")).toBeUndefined();
    expect(schemaForTopic("$SYS/broker/uptime")).toBeUndefined();
  });
});

describe("broker ACL", () => {
  it("lets no credential outside backend-ops, sim and eval read the ground-truth root", () => {
    const strays = (Object.keys(ACL) as (keyof typeof ACL)[])
      .filter((credential) => readsAnyOf(credential, gtTopics))
      .filter((credential) => !GT_READERS.includes(credential))
      .sort();
    expect(strays).toEqual([]);
    // `sim` is the publisher of the ground-truth topics and needs no read filter for them.
    expect(readsAnyOf("backend-ops", gtTopics)).toBe(true);
    expect(readsAnyOf("eval", gtTopics)).toBe(true);
    expect(ACL.sim.write).toContain("gt/#");
  });

  it("keeps anonymous away from ground truth and from control", () => {
    expect(readsAnyOf("anonymous", gtTopics)).toBe(false);
    expect(readsAnyOf("anonymous", controlTopics)).toBe(false);
    expect(ACL.anonymous.write).toEqual([]);
  });

  it("gives anonymous exactly the five plant filters and $SYS", () => {
    expect([...ACL.anonymous.read]).toEqual([
      "plant/{unit_id}/telemetry/#",
      "plant/{unit_id}/status/#",
      "plant/{unit_id}/events/#",
      "plant/{unit_id}/decisions",
      "plant/{unit_id}/alerts/#",
      "$SYS/#",
    ]);
    expect(
      [
        topics.telemetrySamples(),
        topics.statusSim(),
        topics.decisions(),
        topics.alertsTicket(),
      ].every((topic) => readsAnyOf("anonymous", [topic])),
    ).toBe(true);
  });

  it("keeps backend-diag away from ground truth and from control", () => {
    expect(readsAnyOf("backend-diag", gtTopics)).toBe(false);
    expect(readsAnyOf("backend-diag", controlTopics)).toBe(false);
  });

  it("makes eval a read-only credential over both roots", () => {
    expect(ACL.eval.write).toEqual([]);
    expect(readsAnyOf("eval", gtTopics)).toBe(true);
    expect(readsAnyOf("eval", [topics.telemetrySamples()])).toBe(true);
  });

  it("substitutes the unit id in the filters it hands out", () => {
    expect(subscriptionsFor("sim", "cau-9")).toEqual(["plant/cau-9/control/cmd"]);
    expect(subscriptionsFor("gateway")).toEqual([]);
  });
});
