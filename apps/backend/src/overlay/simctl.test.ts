// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The control passthrough against a broker double: what it publishes, how it
// matches an acknowledgement, what it answers when none arrives, and what it
// refuses before anything is published.
//
// The wait is shortened to a few milliseconds rather than faked: the ack
// arrives through the double, so the only real time the tests spend is the one
// test that deliberately lets the wait expire.

import { isValid, topics } from "@fdp/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { newId } from "../ids.ts";
import { createLogger } from "../log.ts";
import {
  createSimControl,
  SimCommandError,
  SimUnreachableError,
  type SimControl,
} from "./simctl.ts";
import { controlAckFor, fakeOpsClient, type FakeOpsClient } from "../../test/helpers/overlay.ts";

const UNIT = "cau-7";
const WALL = "2026-09-21T08:00:05.000Z";
const ACK_TIMEOUT_MS = 25;

const logger = createLogger({ logLevel: "silent", unitId: UNIT, version: "test" });

let ops: FakeOpsClient;
let control: SimControl;

beforeEach(async () => {
  ops = fakeOpsClient();
  control = createSimControl({
    ops,
    wall: fixedClock(WALL),
    logger,
    unitId: UNIT,
    ackTimeoutMs: ACK_TIMEOUT_MS,
  });
  await control.start();
});

/** Answer every command the double receives, as the simulator would. */
function answerCommands(ok = true): void {
  const original = ops.publishJson.bind(ops);
  ops.publishJson = async (schema, topic, payload, options) => {
    await original(schema, topic, payload, options);
    const { cmd_id: cmdId, cmd } = payload as { cmd_id: string; cmd: "jump" };
    const ack = controlAckFor(cmdId, cmd);
    await ops.deliver(topics.controlAck(UNIT), ok ? ack : { ...ack, ok: false });
  };
}

describe("send", () => {
  it("publishes a control-cmd with a fresh id and the wall clock's instant", async () => {
    answerCommands();
    const result = await control.send("jump", { preset_id: "f3_air_leak_jun05" });

    expect(ops.published).toHaveLength(1);
    expect(ops.published[0]).toMatchObject({
      schema: "control-cmd",
      topic: topics.controlCmd(UNIT),
      retain: false,
    });
    expect(ops.published[0]?.payload).toEqual({
      schema: "urn:fdp:schema:control-cmd:v1",
      unit_id: UNIT,
      wall_ts: WALL,
      cmd_id: result.cmd_id,
      cmd: "jump",
      args: { preset_id: "f3_air_leak_jun05" },
    });
    expect(result.cmd_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("resolves with the acknowledgement that carries its own cmd_id", async () => {
    answerCommands();
    const result = await control.send("jump", { preset_id: "f3_air_leak_jun05" });

    expect(result.accepted).toBe(true);
    expect(result.ack?.cmd_id).toBe(result.cmd_id);
    expect(isValid("api-sim-command-result", result)).toBe(true);
  });

  it("carries a refusal through: a refused command is still an acknowledgement", async () => {
    answerCommands(false);
    const result = await control.send("jump", { preset_id: "no_such_preset" });
    expect(result.ack?.ok).toBe(false);
  });

  it("ignores an acknowledgement for another command", async () => {
    const pending = control.send("play", {});
    await ops.deliver(topics.controlAck(UNIT), controlAckFor(newId(), "play"));
    await expect(pending).resolves.toMatchObject({ accepted: true, ack: null });
  });

  it("answers with a null acknowledgement when none arrives in time", async () => {
    const started = Date.now();
    const result = await control.send("play", {});
    expect(result).toMatchObject({ accepted: true, ack: null });
    expect(isValid("api-sim-command-result", result)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("sends the empty argument object for the commands that take none", async () => {
    await control.send("reset", {});
    expect(ops.published[0]?.payload).toMatchObject({ cmd: "reset", args: {} });
  });
});

describe("what it refuses", () => {
  it("publishes nothing when the arguments do not match the command", async () => {
    await expect(control.send("set_speed", { speed: 0 })).rejects.toBeInstanceOf(SimCommandError);
    await expect(control.send("jump", {})).rejects.toBeInstanceOf(SimCommandError);
    await expect(
      control.send("jump", { preset_id: "f3_air_leak_jun05", sim_ts: "2020-02-01T04:00:00.000Z" }),
    ).rejects.toBeInstanceOf(SimCommandError);
    await expect(control.send("play", { speed: 2 })).rejects.toBeInstanceOf(SimCommandError);
    expect(ops.published).toEqual([]);
  });

  it("names the failing keyword so the route can pass it on", async () => {
    await expect(control.send("set_speed", { speed: 4000 })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.stringContaining("speed")]),
    });
  });

  it("reports a broker that refused the publication", async () => {
    ops.failNextPublish();
    await expect(control.send("play", {})).rejects.toBeInstanceOf(SimUnreachableError);
  });

  it("drops an acknowledgement that does not match its schema", async () => {
    const pending = control.send("play", {});
    await ops.deliver(topics.controlAck(UNIT), { schema: "urn:fdp:schema:control-ack:v1" });
    await expect(pending).resolves.toMatchObject({ ack: null });
  });
});

describe("reachable", () => {
  it("follows the broker connection", () => {
    expect(control.reachable()).toBe(true);
    ops.setConnected(false);
    expect(control.reachable()).toBe(false);
  });
});

describe("stop", () => {
  it("settles every outstanding command instead of leaving a caller hanging", async () => {
    const pending = control.send("play", {});
    control.stop();
    await expect(pending).resolves.toMatchObject({ ack: null });
  });
});
