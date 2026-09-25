// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ApiError, CLIENT_ERROR_CODES } from "@/api/client";
import { SIM_TIMEOUT_CODE } from "@/api/endpoints";
import type { ControlError } from "@/api/types";
import { commandErrorSentence } from "@/features/simulation/command-errors";

/** A command the simulator refused, as `useSimCommand` rejects with it. */
function refusal(code: string, message = "the simulator's own sentence"): ApiError {
  return new ApiError(202, code, message);
}

describe("commandErrorSentence", () => {
  // Every code of `control-ack.error`, so a code added to the contract fails to compile here.
  const refusals: Readonly<Record<ControlError["code"], string>> = {
    unknown_preset: "That preset is not in the catalog",
    unknown_injection: "That fault is not in the catalog",
    bad_args: "The simulator rejected the parameters",
    out_of_range: "That time is outside the replayed data",
    speed_out_of_range: "The simulator runs between 1× and 3,600×",
    not_ready: "The simulator is still starting",
    internal: "Replay cursor lost; restart the simulator.",
    unknown_cmd: "No such command: rewind.",
  };

  it.each(Object.entries(refusals))("words the refusal %s", (code, sentence) => {
    const message =
      code === "internal" || code === "unknown_cmd" ? sentence : "the simulator's own sentence";
    expect(commandErrorSentence(refusal(code, message))).toBe(sentence);
  });

  it("shows the simulator's message for a refusal a newer simulator added", () => {
    expect(commandErrorSentence(refusal("tower_locked", "The dryer towers are locked."))).toBe(
      "The dryer towers are locked.",
    );
  });

  it("says the simulator did not answer, whichever wait ran out", () => {
    const backendWait = new ApiError(202, SIM_TIMEOUT_CODE, "no ack");
    const proxyWait = new ApiError(504, SIM_TIMEOUT_CODE, "gateway timeout");

    expect(commandErrorSentence(backendWait)).toBe("The simulator did not answer in time");
    expect(commandErrorSentence(proxyWait)).toBe("The simulator did not answer in time");
  });

  it("says the backend is unavailable when nothing answered or the backend failed", () => {
    const network = new ApiError(0, CLIENT_ERROR_CODES.network, "fetch failed");
    const upstream = new ApiError(502, "http_502", "HTTP 502 Bad Gateway");
    const internal = new ApiError(500, "internal", "unexpected");

    expect(commandErrorSentence(network)).toBe("Backend unavailable");
    expect(commandErrorSentence(upstream)).toBe("Backend unavailable");
    expect(commandErrorSentence(internal)).toBe("Backend unavailable");
  });

  it("words the command route's own refusals", () => {
    const badRequest = new ApiError(400, "bad_request", "args/speed must be <= 3600");
    const unreachable = new ApiError(503, "sim_unreachable", "the broker connection is down");

    expect(commandErrorSentence(badRequest)).toBe("The backend rejected the parameters");
    expect(commandErrorSentence(unreachable)).toBe("The simulator cannot be reached");
  });

  it("shows the message of any other API error, and a plain sentence for anything else", () => {
    expect(commandErrorSentence(new ApiError(404, "not_found", "No route POST /api/sim/x"))).toBe(
      "No route POST /api/sim/x",
    );
    expect(commandErrorSentence(new TypeError("undefined is not a function"))).toBe(
      "The command failed",
    );
  });
});
