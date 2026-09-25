// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The query one event becomes (stages 2 and 3 of retrieval).
 *
 * The property that matters most is the one the design holds for everything
 * the model and the search see: words, never readings. It is asserted on every
 * fixture event and on an event built to smuggle digits in through each of the
 * four places they could arrive — symptoms, evidence, labels and alarm titles.
 */

import { ALARMS, type Observation, type SuspectEvent } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_CASES,
  OIL_COOLER_EVENT,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import { catalogFromEntries, type Catalog } from "./catalog.ts";
import { observedFromEvent } from "./match.ts";
import {
  MAX_QUERY_OBSERVATIONS,
  buildQuery,
  observationLabel,
  ruleDetails,
  stripDigits,
} from "./query.ts";

const FIXTURE = catalogFromEntries(FIXTURE_CATALOG);

/** The fixture catalog with the symptom sentences only the database holds. */
function withSymptoms(conditionId: string, symptoms: readonly string[]): Catalog {
  const conditions = new Map(FIXTURE.conditions);
  const known = conditions.get(conditionId);
  if (known === undefined) throw new Error(`no condition ${conditionId} in the fixture`);
  conditions.set(conditionId, { ...known, symptoms });
  return { ...FIXTURE, conditions };
}

describe("buildQuery: no digits", () => {
  it.each(FIXTURE_CASES.map((fixture) => [fixture.name, fixture.event] as const))(
    "%s",
    (_name, event) => {
      const query = buildQuery(event, FIXTURE);
      expect(query.text).not.toMatch(/\d/);
      expect(query.text.length).toBeGreaterThan(0);
    },
  );

  it("strips a digit from every source that could carry one", () => {
    const catalog = withSymptoms("continuous_load", [
      "Purge pressure (P4) stays above 0.5 bar for 10 minutes.",
    ]);
    const event: SuspectEvent = {
      ...SIGNATURE_A_EVENT,
      evidence: [{ metric: "dryer_purge_pressure", observation: "Rule R2 saw 3 runs over 900 s." }],
      active_alarms: ["W103"],
    };
    const { text } = buildQuery(event, {
      ...catalog,
      alarmTitles: new Map([["W103", "Alarm W103: purge pressure over 0.5 bar"]]),
    });

    expect(text).not.toMatch(/\d/);
    expect(text).toContain("Purge pressure (P) stays above . bar for minutes.");
    expect(text).toContain("Rule R saw runs over s.");
    expect(text).toContain("Alarm W: purge pressure over . bar");
  });
});

describe("buildQuery: what the sentence is made of", () => {
  it("opens with the event's condition, then its symptoms", () => {
    const catalog = withSymptoms("continuous_load", ["The unit runs loaded without a break."]);
    const { text } = buildQuery(SIGNATURE_A_EVENT, catalog);
    expect(text.startsWith("Compressor stays loaded and does not reach cut-out")).toBe(true);
    expect(text.indexOf("The unit runs loaded without a break.")).toBeLessThan(
      text.indexOf(SIGNATURE_A_EVENT.evidence[0]?.observation ?? "missing"),
    );
  });

  it("carries the rule details, the names of what moved and the alarm titles", () => {
    // The hand-built event has no `rules_fired`, so its rule sentences are the
    // first `rule_ids.length` evidence items, where detection writes them.
    const { text } = buildQuery(SIGNATURE_A_EVENT, FIXTURE);
    const ruleSentences = SIGNATURE_A_EVENT.evidence.slice(0, SIGNATURE_A_EVENT.rule_ids.length);
    expect(ruleSentences).toHaveLength(2);
    for (const item of ruleSentences) expect(text).toContain(item.observation);
    expect(text).toContain("Dryer purge pressure");
    expect(text).toContain("loaded run duration");
    expect(text).toContain("Continuous load time exceeded");
    expect(text).toContain("Dryer purge pressure high");
  });

  it("falls back to the symptom key's own words for a condition the catalog lacks", () => {
    const event: SuspectEvent = { ...OIL_COOLER_EVENT, symptom_key: "vibration_rising" };
    expect(buildQuery(event, FIXTURE).text.startsWith("vibration rising")).toBe(true);
  });

  it("names at most twelve observations that moved, the most abnormal first", () => {
    // Twelve mildly abnormal behaviours `mild behaviour a` … `l`, then one far
    // out of its band, then one sitting quietly where it should.
    const letters = "abcdefghijkl".split("");
    expect(letters).toHaveLength(MAX_QUERY_OBSERVATIONS);
    const mild = (letter: string): Observation => ({
      signal: `mild_behaviour_${letter}`,
      level: "above",
      trend: "flat",
      since: "about an hour",
    });
    const loud: Observation = {
      signal: "oil_temperature",
      level: "far_above",
      trend: "rising",
      since: "about an hour",
    };
    const quiet: Observation = {
      signal: "quiet_behaviour",
      level: "normal",
      trend: "flat",
      since: "about an hour",
    };
    const event: SuspectEvent = {
      ...OIL_COOLER_EVENT,
      evidence: [{ metric: "oil_temperature", observation: "The oil runs hot." }],
      active_alarms: [],
      observations: [mild("a"), ...letters.slice(1).map(mild), loud, quiet],
    };

    const { text } = buildQuery(event, FIXTURE);

    // The loud signal jumps the queue, the last mild one falls off the end,
    // and the quiet one never enters.
    expect(text).toContain("The oil runs hot. Oil temperature mild behaviour a");
    expect(text).toContain("mild behaviour k");
    expect(text).not.toContain("mild behaviour l");
    expect(text).not.toContain("quiet behaviour");
  });

  it("hands the matcher the observed buckets, unknowns dropped", () => {
    const event: SuspectEvent = {
      ...OIL_COOLER_EVENT,
      observations: [
        ...OIL_COOLER_EVENT.observations,
        { signal: "flow_pulse", level: "unknown", trend: "flat", since: "minutes" },
      ],
    };
    const { expectedMoves } = buildQuery(event, FIXTURE);
    expect(expectedMoves).toEqual(observedFromEvent(OIL_COOLER_EVENT.observations));
    expect(expectedMoves.some((move) => move.signal === "flow_pulse")).toBe(false);
  });
});

describe("buildQuery: the parts of the stage 2 query and nothing else", () => {
  /** Detection's level, trend and duration words. */
  const BUCKET_WORDS = [
    "far",
    "above",
    "below",
    "normal",
    "rising",
    "falling",
    "flat",
    "stuck",
    "erratic",
    "seconds",
    "minutes",
    "hour",
    "hours",
    "several",
    "day",
    "days",
  ];

  const DETAIL = "Oil climbing steadily with the duty unchanged.";
  const SYMPTOM = "The cooler outlet is hot to the touch.";

  /** An oil-temperature event in the contract's shape: one rule, and sentences for what moved. */
  const bare: SuspectEvent = {
    ...OIL_COOLER_EVENT,
    rule_ids: ["oil_temperature_rising"],
    evidence: [
      { metric: "oil_temperature", observation: DETAIL },
      {
        metric: "oil_temperature",
        observation: "Oil temperature far above normal, rising for several hours.",
      },
      { metric: "line_pressure", observation: "Line pressure normal, falling for minutes." },
    ],
    observations: [
      { signal: "oil_temperature", level: "far_above", trend: "rising", since: "several hours" },
      { signal: "line_pressure", level: "normal", trend: "falling", since: "minutes" },
      { signal: "ambient_temperature", level: "normal", trend: "flat", since: "several hours" },
      { signal: "motor_current", level: "normal", trend: "flat", since: "several hours" },
    ],
    active_alarms: ["W104"],
  };
  /** The same event as detection sends it, with the additive `rules_fired`. */
  const event = { ...bare, rules_fired: [{ detail: DETAIL }] };
  const catalog = catalogFromEntries(FIXTURE_CATALOG, ALARMS, [
    { condition_id: "oil_temperature_high", title: "Oil temperature high", symptoms: [SYMPTOM] },
  ]);
  const { text } = buildQuery(event, catalog);
  const words = text.toLowerCase().split(/[^a-z]+/);

  it("holds the condition title, its symptoms, the rule details, what moved and the alarm titles", () => {
    expect(text.startsWith(`Oil temperature high ${SYMPTOM} ${DETAIL}`)).toBe(true);
    expect(text).toContain("Oil temperature");
    expect(text).toContain("Line pressure");
    expect(text).toContain(catalog.alarmTitles.get("W104") ?? "missing");
    expect(text).not.toMatch(/\d/);
  });

  it("carries no observation sentence and none of detection's bucket words", () => {
    for (const item of event.evidence.slice(1)) expect(text).not.toContain(item.observation);
    for (const word of BUCKET_WORDS) expect(words).not.toContain(word);
  });

  it("names only the observations that moved", () => {
    expect(text).not.toContain("Ambient temperature");
    expect(text).not.toContain("Motor current");
  });

  it("reads the rule details from rules_fired when the event carries it", () => {
    const disagreeing = { ...event, rules_fired: [{ detail: "The duty never changed." }] };
    expect(ruleDetails(disagreeing)).toEqual(["The duty never changed."]);
    expect(buildQuery(disagreeing, catalog).text).not.toContain(DETAIL);
  });

  it("falls back to the rule sentences at the head of the evidence without rules_fired", () => {
    expect(ruleDetails(bare)).toEqual([DETAIL]);
    const malformed = { ...event, rules_fired: [{ rule_id: "oil_temperature_rising" }] };
    expect(ruleDetails(malformed)).toEqual([DETAIL]);
    expect(buildQuery(bare, catalog).text).toBe(text);
  });
});

describe("observationLabel", () => {
  it("uses the register map's name for a tag and the id's words for a behaviour", () => {
    expect(observationLabel("line_pressure")).toBe("Line pressure");
    expect(observationLabel("unloaded_pressure_decay")).toBe("unloaded pressure decay");
  });
});

describe("stripDigits", () => {
  it("removes the digits and the empty brackets they leave behind", () => {
    expect(stripDigits("Line pressure (P2)")).toBe("Line pressure (P)");
    expect(stripDigits("Alarm W103 raised")).toBe("Alarm W raised");
    expect(stripDigits("Reading (12) seen   twice")).toBe("Reading seen twice");
  });
});
