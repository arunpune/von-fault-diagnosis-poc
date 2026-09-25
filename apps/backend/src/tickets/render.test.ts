// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What a technician reads on a ticket: the catalog entry the
// decision chose, the evidence detection wrote, and the decision's numbers —
// nothing else. The snapshot pins the whole body for the signature-A fixture.

import { describe, expect, it } from "vitest";

import {
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../test/fixtures/catalog/events.ts";
import { candidatesFor, catalogEntry } from "../../test/fixtures/catalog/index.ts";
import { answered, eventAt } from "../episodes/decisions.test-helper.ts";
import { renderTicket } from "./render.ts";

const CANDIDATES = candidatesFor(SIGNATURE_A_CANDIDATE_IDS);
const LEAK = catalogEntry("dryer_purge_leak");

function decisionOn(event = SIGNATURE_A_EVENT, choice = LEAK.fault_id) {
  return answered({
    event,
    candidates: CANDIDATES,
    episodeId: "00000001-0000-4000-8000-000000000001",
    decisionId: "00000003-0000-4000-8000-000000000001",
    choice,
    confidence: 0.9,
  }).decision;
}

describe("renderTicket", () => {
  it("renders the chosen cause under the condition the episode fired on", () => {
    const rendered = renderTicket(LEAK, decisionOn(), SIGNATURE_A_EVENT);

    expect(rendered).toMatchInlineSnapshot(`
      {
        "backend": "rules",
        "cause": "The purge valve of the desiccant dryer does not close fully after a regeneration pulse, so compressed air keeps escaping through the purge silencer. The unit replaces the loss continuously, stays loaded far longer than usual and stops reaching its cut-out pressure.",
        "checks": [
          "Listen at the purge silencer with the unit loaded; a steady hiss between changeover pulses is the fault.",
          "Watch the purge pressure gauge through a full tower period and note whether it ever falls back.",
        ],
        "condition_id": "continuous_load",
        "confidence": 0.9,
        "evidence": [
          {
            "metric": "dryer_purge_pressure",
            "observation": "Dryer purge pressure has been far above its normal band for about an hour.",
          },
          {
            "metric": "loaded_run_duration",
            "observation": "The loaded run has lasted far longer than any run of the reference month.",
          },
          {
            "metric": "cut_out_reached",
            "observation": "No loaded run has ended at the cut-out pressure in the last hour.",
          },
        ],
        "fault_id": "dryer_purge_leak",
        "manual_ref": {
          "anchor": "fault:dryer_purge_leak",
          "section": "8.4",
          "title": "Dryer purge pressure high, air escaping at the purge silencer",
        },
        "model": "rules-v1",
        "probabilities": {
          "airend_element_wear": 0.016666666666666663,
          "downstream_air_leak": 0.016666666666666663,
          "dryer_purge_leak": 0.9,
          "high_air_demand": 0.016666666666666663,
          "intake_filter_clogged": 0.016666666666666663,
          "none_of_these": 0.016666666666666663,
          "purge_silencer_damaged": 0.016666666666666663,
        },
        "rationale": null,
        "remedy": "Overhaul or replace the purge valve, then repeat the tower period test and confirm that the purge line falls back between pulses.",
        "severity": "high",
        "title": "Dryer purge valve not seating — Compressor stays loaded and does not reach cut-out",
      }
    `);
  });

  it("repeats the event's evidence verbatim and in order", () => {
    const rendered = renderTicket(LEAK, decisionOn(), SIGNATURE_A_EVENT);

    expect(rendered.evidence).toEqual(SIGNATURE_A_EVENT.evidence);
    expect(rendered.evidence).not.toBe(SIGNATURE_A_EVENT.evidence);
  });

  it("keeps the ticket's own condition when a merged episode's event updates it", () => {
    const purge = eventAt(
      SIGNATURE_A_EVENT,
      "22222222-0000-4000-8000-000000000001",
      SIGNATURE_A_EVENT.sim_ts,
      {
        symptom_key: "purge_pressure_high",
        co_symptoms: ["continuous_load"],
      },
    );

    const own = renderTicket(LEAK, decisionOn(purge), purge);
    const merged = renderTicket(LEAK, decisionOn(purge), purge, "continuous_load");

    expect(own.condition_id).toBe("purge_pressure_high");
    expect(merged.condition_id).toBe("continuous_load");
    expect(merged.title).toBe(
      "Dryer purge valve not seating — Compressor stays loaded and does not reach cut-out",
    );
  });

  it("falls back to the entry's first condition when neither symptom is listed", () => {
    const cycling = eventAt(
      SIGNATURE_A_EVENT,
      "22222222-0000-4000-8000-000000000002",
      SIGNATURE_A_EVENT.sim_ts,
      {
        symptom_key: "frequent_cycling",
      },
    );

    expect(renderTicket(LEAK, decisionOn(cycling), cycling).condition_id).toBe(
      LEAK.conditions[0]?.condition_id,
    );
  });

  it("refuses a candidate the decision did not choose", () => {
    const decision = decisionOn(SIGNATURE_A_EVENT, "purge_silencer_damaged");

    expect(() => renderTicket(LEAK, decision, SIGNATURE_A_EVENT)).toThrow(
      /chose purge_silencer_damaged, not dryer_purge_leak/,
    );
  });
});
