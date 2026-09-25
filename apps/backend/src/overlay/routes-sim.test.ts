// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `POST /api/sim/*` through `fastify.inject`, with the control passthrough
// replaced by a double: the seven path segments map to the seven commands, an
// accepted command answers 202 with an `api-sim-command-result`, bad arguments
// answer 400 and an unreachable broker answers 503.

import { isValid, type ApiSimCommandResult, type Command } from "@fdp/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newId } from "../ids.ts";
import { overlaySimRoutes, SIM_ROUTES } from "./routes-sim.ts";
import { SimCommandError, SimUnreachableError, type SimControl } from "./simctl.ts";
import { controlAckFor } from "../../test/helpers/overlay.ts";

interface SentCommand {
  cmd: Command;
  args: Record<string, unknown>;
}

interface FakeControl extends SimControl {
  readonly sent: SentCommand[];
  reject(error: Error): void;
  setReachable(value: boolean): void;
  answerWithAck(value: boolean): void;
}

function fakeControl(): FakeControl {
  const sent: SentCommand[] = [];
  let reachable = true;
  let rejection: Error | null = null;
  let withAck = true;

  return {
    sent,
    start: () => Promise.resolve(),
    reachable: () => reachable,
    stop: () => undefined,

    setReachable(value) {
      reachable = value;
    },
    reject(error) {
      rejection = error;
    },
    answerWithAck(value) {
      withAck = value;
    },

    send(cmd, args) {
      if (rejection !== null) return Promise.reject(rejection);
      sent.push({ cmd, args });
      const cmdId = newId();
      const result: ApiSimCommandResult = {
        cmd_id: cmdId,
        accepted: true,
        ack: withAck ? controlAckFor(cmdId, cmd) : null,
      };
      return Promise.resolve(result);
    },
  };
}

let fastify: FastifyInstance;
let control: FakeControl;

beforeEach(async () => {
  control = fakeControl();
  fastify = Fastify({ logger: false });
  await fastify.register(overlaySimRoutes({ control }), { prefix: "/api" });
  await fastify.ready();
});

afterEach(async () => {
  await fastify.close();
});

describe("the seven routes", () => {
  it("maps every path segment to the command it names", async () => {
    for (const segment of Object.keys(SIM_ROUTES)) {
      const response = await fastify.inject({ method: "POST", url: `/api/sim/${segment}` });
      expect(response.statusCode, segment).toBe(202);
    }
    expect(control.sent.map((command) => command.cmd)).toEqual([
      "play",
      "pause",
      "set_speed",
      "jump",
      "inject",
      "clear_injections",
      "reset",
    ]);
  });

  it("answers 202 with an api-sim-command-result", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/api/sim/jump",
      payload: { args: { preset_id: "f3_air_leak_jun05" } },
    });

    expect(response.statusCode).toBe(202);
    expect(isValid("api-sim-command-result", response.json())).toBe(true);
    expect(control.sent[0]).toEqual({
      cmd: "jump",
      args: { preset_id: "f3_air_leak_jun05" },
    });
  });

  it("answers 202 with a null acknowledgement when the simulator stayed silent", async () => {
    control.answerWithAck(false);
    const response = await fastify.inject({ method: "POST", url: "/api/sim/play" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, ack: null });
  });

  it("treats a body without args as the empty argument object", async () => {
    await fastify.inject({ method: "POST", url: "/api/sim/pause", payload: {} });
    expect(control.sent[0]?.args).toEqual({});
  });

  it("has no route for a command the simulator does not take", async () => {
    const response = await fastify.inject({ method: "POST", url: "/api/sim/rewind" });
    expect(response.statusCode).toBe(404);
  });
});

describe("what it refuses", () => {
  it("answers 400 when the arguments do not match the command", async () => {
    control.reject(new SimCommandError("set_speed", ["/speed must be <= 3600"]));
    const response = await fastify.inject({
      method: "POST",
      url: "/api/sim/speed",
      payload: { args: { speed: 4000 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "bad_request", details: { cmd: "set_speed" } },
    });
  });

  it("answers 503 when the broker connection is down", async () => {
    control.setReachable(false);
    const response = await fastify.inject({ method: "POST", url: "/api/sim/play" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "sim_unreachable" } });
    expect(control.sent).toEqual([]);
  });

  it("answers 503 when the publication itself failed", async () => {
    control.reject(new SimUnreachableError(new Error("write after end")));
    const response = await fastify.inject({ method: "POST", url: "/api/sim/play" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "sim_unreachable" } });
  });
});
