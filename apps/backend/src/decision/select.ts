// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which answer engine a run uses (docs/decision-backends.md#choosing-the-backend).
 *
 * The rule is in `config/env.ts`, which resolves `DECISION_BACKEND` — `von`
 * when `TYPESAFE_API_KEY` is set, `rules` otherwise — and refuses a backend
 * whose key is missing. This module is the other half: it turns that word into
 * an object, using factories its caller injects.
 *
 * The injection is the point. The Von backend and the LLM backend live in
 * their own modules, the pipeline wires its own doubles in tests, and the
 * evaluation harness swaps all three. If this module imported them directly,
 * every one of those would have to edit it, and a test that wanted a stub
 * would have to reach around it.
 *
 * A missing factory is a startup failure, not a fall-back: a run configured for
 * Von that quietly answered with the rules twin would put a whole evaluation
 * under the wrong label.
 */

import { ConfigError } from "../config/env.ts";
import type { Env } from "../config/env.ts";
import type { DecisionBackend } from "./types.ts";

/** Builds one backend from the environment it was configured with. */
export type DecisionBackendFactory = (env: Env) => DecisionBackend;

/**
 * The factories the composition root injects.
 *
 * Only `rules` is required: it needs no key and no provider, so every
 * composition can always build it, and a run that asked for it can never fail
 * for want of a factory.
 */
export interface DecisionBackendFactories {
  readonly rules: DecisionBackendFactory;
  readonly von?: DecisionBackendFactory;
  readonly llm?: DecisionBackendFactory;
}

/** The same sentence for every missing factory, naming the one that is missing. */
function missingFactory(name: string): ConfigError {
  return new ConfigError([
    `DECISION_BACKEND is ${name} but no ${name} backend factory was injected; the ` +
      "composition root builds it and passes it to selectBackend",
  ]);
}

/**
 * Build the backend `env` asks for.
 *
 * Throws {@link ConfigError} naming the variable or the factory that is
 * missing, so a misconfigured run stops at startup with one readable message
 * instead of failing on its first suspect event.
 */
export function selectBackend(env: Env, factories: DecisionBackendFactories): DecisionBackend {
  switch (env.decisionBackend) {
    case "von": {
      if (env.typesafeApiKey === null) {
        throw new ConfigError(["DECISION_BACKEND is von but TYPESAFE_API_KEY is not set"]);
      }
      if (factories.von === undefined) throw missingFactory("von");
      return factories.von(env);
    }
    case "llm": {
      if (env.llmApiKey === null) {
        throw new ConfigError(["DECISION_BACKEND is llm but LLM_API_KEY is not set"]);
      }
      if (env.llmProvider !== "anthropic") {
        throw new ConfigError([
          `DECISION_BACKEND is llm but LLM_PROVIDER is ${env.llmProvider}; only anthropic ` +
            "is implemented",
        ]);
      }
      if (factories.llm === undefined) throw missingFactory("llm");
      return factories.llm(env);
    }
    case "rules":
      return factories.rules(env);
  }
}
