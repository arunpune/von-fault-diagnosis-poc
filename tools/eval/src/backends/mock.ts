// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Von without a key: the real Von backend talking to the contracts' mock
// TypeSafe server on a free local port.
//
// Nothing about the backend is faked. `createVonBackend` builds the same state
// and the same three questions it would send to the API, the SDK makes the same
// `POST /v1/systemone`, and the answers travel back through the same parser, so
// a mock run exercises the whole decision path. Only the judgment is not Von's:
// the mock answers with the `best-overlap` policy by default, which is
// deterministic on the request, and `confident-first` only when a caller asks
// for it. The report marks every mock column "not informative".
//
// The key is a fixed stand-in and the mock accepts no other bearer, so a real
// key can never reach it, not even by a configuration mistake.

import { MOCK_MODEL, startMockTypeSafe } from "@fdp/contracts/mock";
import type { AnswerPolicy, AnswerPolicyName, MockTypeSafe } from "@fdp/contracts/mock";
import { Secret, createVonBackend } from "@fdp/backend/pipeline";

import { ConfigError } from "../config.ts";
import type { EvalConfig } from "../config.ts";
import { counted, millisecondsOf, newStats, SIGNAL_LABELS } from "./types.ts";
import type { BackendHandle, HandleDeps } from "./types.ts";

/** The bearer the harness sends its own mock; never a real key. */
export const MOCK_API_KEY = "eval-mock";

/** The Von backend's per-attempt timeout, the same as a live run's. */
export const VON_TIMEOUT_MS = 10_000;

/** The named policy behind a mock run's answers. */
export const DEFAULT_MOCK_POLICY: AnswerPolicyName = "best-overlap";

/** How a caller may steer the mock; a test asks for `confident-first` or scripts answers. */
export interface MockOptions {
  readonly answerPolicy?: AnswerPolicyName;
  readonly answer?: AnswerPolicy;
}

/** The mock handle, with its server exposed so a test can read what was asked. */
export interface MockVonHandle extends BackendHandle {
  readonly server: MockTypeSafe;
}

/**
 * Starts the mock TypeSafe server and the Von backend that talks to it.
 *
 * @throws ConfigError when `VON_MODEL` names a version the mock does not answer, since every
 * decision of the run would otherwise fail with a 422.
 */
export async function createMockVonHandle(
  cfg: Pick<EvalConfig, "vonModel">,
  deps: HandleDeps,
  options: MockOptions = {},
): Promise<MockVonHandle> {
  if (cfg.vonModel !== MOCK_MODEL) {
    throw new ConfigError(
      "VON_MODEL",
      `mock mode answers only ${MOCK_MODEL}; unset VON_MODEL or choose another mode`,
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
  const backend = createVonBackend({
    apiKey: new Secret(MOCK_API_KEY),
    baseURL: server.url,
    model: cfg.vonModel,
    timeoutMs: VON_TIMEOUT_MS,
    labels: SIGNAL_LABELS,
    wall: millisecondsOf(deps.wall),
  });

  let closed: Promise<void> | undefined;
  return {
    name: "von",
    model: cfg.vonModel,
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
