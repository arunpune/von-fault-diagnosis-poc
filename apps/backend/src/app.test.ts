// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The running service configures the pipeline as the pipeline's own defaults
// and `tools/eval` do: one environment, one rule for every host. The
// evaluation's side is `tools/eval`'s host test.

import { describe, expect, it } from "vitest";

import { pipelineConfig } from "./app.ts";
import { loadEnv } from "./config/env.ts";
import { DEFAULT_PIPELINE_CONFIG } from "./pipeline/index.ts";

describe("pipelineConfig", () => {
  it("is the pipeline's own default configuration when nothing is set", () => {
    expect(pipelineConfig(loadEnv({}))).toEqual(DEFAULT_PIPELINE_CONFIG);
  });

  it("hands the pipeline the gate, the episode timings and GATE_PERSIST_SIM_MIN", () => {
    const cfg = pipelineConfig(
      loadEnv({
        GATE_TICKET_MIN_CONFIDENCE: "0.9",
        GATE_REVIEW_MIN_CONFIDENCE: "0.7",
        DECISION_INTERVAL_SIM_MIN: "15",
        EPISODE_CLEAR_SIM_MIN: "60",
        GATE_PERSIST_SIM_MIN: "5",
      }),
    );
    expect(cfg).toMatchObject({
      gate: { ticketMin: 0.9, reviewMin: 0.7 },
      decisionIntervalSimMin: 15,
      episodeClearSimMin: 60,
      persistSimMin: 5,
    });
    expect(pipelineConfig(loadEnv({ GATE_PERSIST_SIM_MIN: "0" })).persistSimMin).toBe(0);
  });

  it("gates with the running backend's pair: VON_GATE_* for von, GATE_* for rules and llm", () => {
    const variables = {
      GATE_TICKET_MIN_CONFIDENCE: "0.85",
      GATE_REVIEW_MIN_CONFIDENCE: "0.6",
      VON_GATE_TICKET_MIN_CONFIDENCE: "0.9",
      VON_GATE_REVIEW_MIN_CONFIDENCE: "0.7",
      TYPESAFE_API_KEY: "tsk-test-not-a-key",
      LLM_API_KEY: "sk-test-not-a-key",
    };
    expect(pipelineConfig(loadEnv({ ...variables, DECISION_BACKEND: "von" })).gate).toEqual({
      ticketMin: 0.9,
      reviewMin: 0.7,
    });
    for (const backend of ["rules", "llm"]) {
      expect(pipelineConfig(loadEnv({ ...variables, DECISION_BACKEND: backend })).gate).toEqual({
        ticketMin: 0.85,
        reviewMin: 0.6,
      });
    }
  });

  it("gates Von at the pre-registered choice by default, and rules and llm at the pipeline's pair", () => {
    // Unset, Von's pair is the choice in tools/eval/records/von-thresholds-choice.md
    // (review 0.65, ticket 0.85) and N stays 1; tools/eval's host test pins the same numbers.
    const keys = { TYPESAFE_API_KEY: "tsk-test-not-a-key", LLM_API_KEY: "sk-test-not-a-key" };
    const von = pipelineConfig(loadEnv({ ...keys, DECISION_BACKEND: "von" }));
    expect(von.gate).toEqual({ ticketMin: 0.85, reviewMin: 0.65 });
    expect(von.persistSimMin).toBe(1);
    for (const backend of ["rules", "llm"]) {
      expect(pipelineConfig(loadEnv({ ...keys, DECISION_BACKEND: backend })).gate).toEqual(
        DEFAULT_PIPELINE_CONFIG.gate,
      );
    }
  });
});
