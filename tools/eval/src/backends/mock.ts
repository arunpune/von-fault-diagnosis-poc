// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Jev without a key: the real Jev backend talking to the contracts' mock
// TypeSafe server on a free local port.
//
// Nothing about the backend is faked. `createJevBackend` builds the same state
// and the same three questions it would send to the API, the SDK makes the same
// `POST /v1/systemone`, and the answers travel back through the same parser, so
// a mock run exercises the whole decision path. Only the judgment is not Jev's:
// the mock answers with the `best-overlap` policy by default, which is
// deterministic on the request, and `confident-first` only when a caller asks
// for it. The report marks every mock column "not informative".
//
// The key is a fixed stand-in and the mock accepts no other bearer, so a real
// key can never reach it, not even by a configuration mistake.

import { MOCK_MODEL, startMockTypeSafe } from "@fdp/contracts/mock";
import type { AnswerPolicy, AnswerPolicyName, MockTypeSafe } from "@fdp/contracts/mock";
import { Secret, createJevBackend } from "@fdp/backend/pipeline";

import { ConfigError } from "../config.ts";
import type { EvalConfig } from "../config.ts";
import { counted, millisecondsOf, newStats, SIGNAL_LABELS } from "./types.ts";
import type { BackendHandle, HandleDeps } from "./types.ts";

/** The bearer the harness sends its own mock; never a real key. */
export const MOCK_API_KEY = "eval-mock";

/** The Jev backend's per-attempt timeout, the same as a live run's. */
export const JEV_TIMEOUT_MS = 10_000;

/** The named policy behind a mock run's answers. */
export const DEFAULT_MOCK_POLICY: AnswerPolicyName = "best-overlap";

/** How a caller may steer the mock; a test asks for `confident-first` or scripts answers. */
export interface MockOptions {
  readonly answerPolicy?: AnswerPolicyName;
  readonly answer?: AnswerPolicy;
}

/** The mock handle, with its server exposed so a test can read what was asked. */
export interface MockJevHandle extends BackendHandle {
  readonly server: MockTypeSafe;
}

/**
 * Starts the mock TypeSafe server and the Jev backend that talks to it.
 *
 * @throws ConfigError when `JEV_MODEL` names a version the mock does not answer, since every
 * decision of the run would otherwise fail with a 422.
 */
export async function createMockJevHandle(
  cfg: Pick<EvalConfig, "jevModel">,
  deps: HandleDeps,
  options: MockOptions = {},
): Promise<MockJevHandle> {
  if (cfg.jevModel !== MOCK_MODEL) {
    throw new ConfigError(
      "JEV_MODEL",
      `mock mode answers only ${MOCK_MODEL}; unset JEV_MODEL or choose another mode`,
    );
  }

  const server = await startMockTypeSafe({
    port: 0,
    apiKey: MOCK_API_KEY,
    model: MOCK_MODEL,
    answerPolicy: options.answerPolicy ?? DEFAULT_MOCK_POLICY,
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  });

  const stats = newStats();
  const backend = createJevBackend({
    apiKey: new Secret(MOCK_API_KEY),
    baseURL: server.url,
    model: cfg.jevModel,
    timeoutMs: JEV_TIMEOUT_MS,
    labels: SIGNAL_LABELS,
    wall: millisecondsOf(deps.wall),
  });

  let closed: Promise<void> | undefined;
  return {
    name: "jev",
    model: cfg.jevModel,
    mode: "mock",
    backend: counted(backend, stats),
    stats,
    server,
    close: () => {
      closed ??= server.close();
      return closed;
    },
  };
}
