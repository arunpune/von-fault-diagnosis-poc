// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which backend a run builds, over the environment combinations that matter.
 *
 * The failure cases are the interesting ones. A run configured for Jev that
 * quietly answered with the rules twin would put a whole evaluation under the
 * wrong label, so every missing key and every missing factory has to stop the
 * process with a message naming what is missing.
 */

import { describe, expect, it } from "vitest";

import { ConfigError, loadEnv } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import { selectBackend } from "./select.ts";
import type { DecisionBackendFactories } from "./select.ts";
import type { DecisionBackend, DecisionOutput } from "./types.ts";

/** A backend that answers nothing; only its name is ever read here. */
function stub(name: DecisionBackend["name"], model: string): DecisionBackend {
  return {
    name,
    model,
    decide: () =>
      Promise.reject(new Error("the stub backend never answers")) as Promise<DecisionOutput>,
  };
}

const ALL_FACTORIES: DecisionBackendFactories = {
  rules: () => stub("rules", "rules-v1"),
  jev: (env: Env) => stub("jev", env.jevModel),
  llm: (env: Env) => stub("llm", env.llmModel),
};

function envOf(source: NodeJS.ProcessEnv): Env {
  return loadEnv(source);
}

describe("selectBackend: which backend a run uses", () => {
  it.each([
    { name: "no key at all", source: {}, expected: "rules" },
    { name: "a TypeSafe key", source: { TYPESAFE_API_KEY: "k" }, expected: "jev" },
    {
      name: "an explicit rules choice with a key present",
      source: { DECISION_BACKEND: "rules", TYPESAFE_API_KEY: "k" },
      expected: "rules",
    },
    {
      name: "an explicit llm choice",
      source: { DECISION_BACKEND: "llm", LLM_API_KEY: "k" },
      expected: "llm",
    },
    {
      name: "an explicit jev choice",
      source: { DECISION_BACKEND: "jev", TYPESAFE_API_KEY: "k" },
      expected: "jev",
    },
  ])("$name builds the $expected backend", ({ source, expected }) => {
    expect(selectBackend(envOf(source), ALL_FACTORIES).name).toBe(expected);
  });

  it("builds the backend from the environment it was given", () => {
    const env = envOf({ TYPESAFE_API_KEY: "k", JEV_MODEL: "jev-1.13.0" });
    expect(selectBackend(env, ALL_FACTORIES).model).toBe("jev-1.13.0");
  });
});

describe("selectBackend: what stops a run at startup", () => {
  it("names the factory that was not injected", () => {
    const env = envOf({ TYPESAFE_API_KEY: "k" });
    expect(() => selectBackend(env, { rules: ALL_FACTORIES.rules })).toThrow(ConfigError);
    expect(() => selectBackend(env, { rules: ALL_FACTORIES.rules })).toThrow(/no jev backend/);
  });

  it("names the missing llm factory too", () => {
    const env = envOf({ DECISION_BACKEND: "llm", LLM_API_KEY: "k" });
    expect(() => selectBackend(env, { rules: ALL_FACTORIES.rules })).toThrow(/no llm backend/);
  });

  it("names the missing TypeSafe key", () => {
    // `loadEnv` refuses this combination too; `selectBackend` repeats the check
    // because the evaluation harness builds an `Env` of its own.
    const env: Env = { ...envOf({ TYPESAFE_API_KEY: "k" }), typesafeApiKey: null };
    expect(() => selectBackend(env, ALL_FACTORIES)).toThrow(/TYPESAFE_API_KEY is not set/);
  });

  it("names the missing LLM key", () => {
    const env: Env = { ...envOf({ DECISION_BACKEND: "llm", LLM_API_KEY: "k" }), llmApiKey: null };
    expect(() => selectBackend(env, ALL_FACTORIES)).toThrow(/LLM_API_KEY is not set/);
  });

  it("names the provider it cannot speak to", () => {
    const env: Env = {
      ...envOf({ DECISION_BACKEND: "llm", LLM_API_KEY: "k" }),
      llmProvider: "some-other-provider",
    };
    expect(() => selectBackend(env, ALL_FACTORIES)).toThrow(/only anthropic is implemented/);
  });

  it("always has the rules twin, whatever else is missing", () => {
    const env = envOf({ DECISION_BACKEND: "rules" });
    expect(selectBackend(env, { rules: ALL_FACTORIES.rules }).name).toBe("rules");
  });
});
