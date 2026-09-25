// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The sentence a failed simulator command shows. A command fails in one of three places, and
// `useSimCommand` hands each over as an `ApiError`:
//
//   * the simulator refused it: status 202 and the acknowledgement's code (`control-ack.error`);
//   * the simulator never answered: code `sim_timeout`, whether the backend's wait ran out
//     (202 with a null ack) or the proxy's did (504);
//   * the backend or the network failed: the route's `api-error` code, or a client code.
//
// A refusal the interface can explain gets its own sentence; `internal`, `unknown_cmd` and any
// code a newer simulator adds show the simulator's own message, which the contract keeps to one
// English sentence for the operator.

import { ApiError } from "@/api/client";
import { SIM_TIMEOUT_CODE } from "@/api/endpoints";
import type { ControlError } from "@/api/types";

/** The HTTP status `useSimCommand` gives a refusal: the command was accepted, then refused. */
const REFUSED_STATUS = 202;

/** The refusals the interface words itself; the others show the simulator's message. */
const ACK_SENTENCES: Readonly<Record<string, string>> = {
  unknown_preset: "That preset is not in the catalog",
  unknown_injection: "That fault is not in the catalog",
  bad_args: "The simulator rejected the parameters",
  out_of_range: "That time is outside the replayed data",
  speed_out_of_range: "The simulator runs between 1× and 3,600×",
  not_ready: "The simulator is still starting",
} satisfies Partial<Record<ControlError["code"], string>>;

/** `api-error` codes of `POST /api/sim/:cmd`. */
const ROUTE_SENTENCES: Readonly<Record<string, string>> = {
  bad_request: "The backend rejected the parameters",
  sim_unreachable: "The simulator cannot be reached",
};

const TIMEOUT_SENTENCE = "The simulator did not answer in time";
/** No answer at all (status 0) or a failing backend (5xx). */
const UNAVAILABLE_SENTENCE = "Backend unavailable";
/** Anything that is not an `ApiError`: a defect, never a state of the stack. */
const FAILED_SENTENCE = "The command failed";

function isUnavailable(error: ApiError): boolean {
  return error.status === 0 || error.status >= 500;
}

/** What a failed simulator command says to the operator, as one sentence for a toast. */
export function commandErrorSentence(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return FAILED_SENTENCE;
  }
  if (error.code === SIM_TIMEOUT_CODE) {
    return TIMEOUT_SENTENCE;
  }
  if (error.status === REFUSED_STATUS) {
    return ACK_SENTENCES[error.code] ?? error.message;
  }
  const routeSentence = ROUTE_SENTENCES[error.code];
  if (routeSentence !== undefined) {
    return routeSentence;
  }
  return isUnavailable(error) ? UNAVAILABLE_SENTENCE : error.message;
}
