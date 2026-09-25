// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay control passthrough.
 *
 * `POST /api/sim/*` is the only way the user interface moves the replay, and
 * this module is the whole of it: validate the pair the route built against
 * `api-sim-command`, publish a `control-cmd` with a fresh `cmd_id`, and wait a
 * short while for the simulator's `control-ack` carrying that same id.
 *
 * The wait is bounded at {@link ACK_TIMEOUT_MS} and its expiry is not an error.
 * The simulator acknowledges every command it receives, but a command sent
 * while it is re-indexing can take longer than a user interface should block
 * on; `api-sim-command-result` says so with `ack: null`, and the interface
 * follows the retained `status/sim` message from there.
 *
 * The command topic lives under the plant root, but the credential that may
 * write to it is the overlay's, so the passthrough sits inside the overlay
 * module with the recorder and never touches the diagnosis client.
 */

import {
  assertValid,
  validate,
  toIsoMs,
  DEFAULT_UNIT_ID,
  type ApiSimCommandResult,
  type Command,
  type ControlAck,
} from "@fdp/contracts";

import type { WallClock } from "../clock.ts";
import { newId } from "../ids.ts";
import type { Logger } from "../log.ts";
import { opsTopics, type OpsClient } from "../mqtt/ops-client.ts";

/** How long a caller waits for the acknowledgement before the result says `null`. */
export const ACK_TIMEOUT_MS = 2_000;

/** Thrown when the arguments do not match the command; the route answers 400. */
export class SimCommandError extends Error {
  readonly issues: readonly string[];

  constructor(cmd: string, issues: readonly string[]) {
    super(`invalid arguments for ${cmd}: ${issues.join("; ")}`);
    this.name = "SimCommandError";
    this.issues = issues;
  }
}

/** Thrown when the command could not be published; the route answers 503. */
export class SimUnreachableError extends Error {
  constructor(cause: unknown) {
    super("the broker did not accept the command", { cause });
    this.name = "SimUnreachableError";
  }
}

export interface SimControlPorts {
  readonly ops: OpsClient;
  readonly wall: WallClock;
  readonly logger: Logger;
  /** The unit the commands address; the contracts' default otherwise. */
  readonly unitId?: string;
  /** Shortened by the unit tests; {@link ACK_TIMEOUT_MS} in the process. */
  readonly ackTimeoutMs?: number;
}

export interface SimControl {
  /** Subscribe the acknowledgement topic. Commands sent before this never match one. */
  start(): Promise<void>;
  /** True while the broker connection is up; the routes answer 503 when it is not. */
  reachable(): boolean;
  /**
   * Publish one command and wait for its acknowledgement.
   *
   * @throws SimCommandError when `{ cmd, args }` does not validate.
   * @throws SimUnreachableError when the broker refused the publication.
   */
  send(cmd: Command, args: Record<string, unknown>): Promise<ApiSimCommandResult>;
  /** Stop waiting for every outstanding acknowledgement. */
  stop(): void;
}

export function createSimControl(ports: SimControlPorts): SimControl {
  const topics = opsTopics(ports.unitId);
  const logger = ports.logger.child({ module: "overlay-simctl" });
  const ackTimeoutMs = ports.ackTimeoutMs ?? ACK_TIMEOUT_MS;

  /** One entry per command still waiting; the ack resolves it, the timer settles it null. */
  const pending = new Map<string, (ack: ControlAck | null) => void>();

  function settle(cmdId: string, ack: ControlAck | null): void {
    const resolve = pending.get(cmdId);
    if (resolve === undefined) return;
    pending.delete(cmdId);
    resolve(ack);
  }

  /** Resolve with the acknowledgement of `cmdId`, or with null once the wait is over. */
  function awaitAck(cmdId: string): Promise<ControlAck | null> {
    return new Promise<ControlAck | null>((resolve) => {
      const timer = setTimeout(() => {
        logger.info({ cmd_id: cmdId, timeout_ms: ackTimeoutMs }, "no acknowledgement in time");
        settle(cmdId, null);
      }, ackTimeoutMs);
      // The process must not be held open by a command nobody is waiting for.
      timer.unref?.();
      pending.set(cmdId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  return {
    async start() {
      await ports.ops.subscribeValidated(topics.controlAck, ({ payload }) => {
        const result = validate("control-ack", payload);
        if (!result.ok) {
          logger.warn({ issue: result.errors[0]?.text ?? "invalid" }, "dropped an invalid ack");
          return;
        }
        settle(result.value.cmd_id, result.value);
      });
    },

    reachable: () => ports.ops.connected(),

    async send(cmd, args) {
      const command = { cmd, args };
      const checked = validate("api-sim-command", command);
      if (!checked.ok) {
        throw new SimCommandError(
          cmd,
          checked.errors.map((error) => error.text),
        );
      }

      const cmdId = newId();
      const message = {
        schema: "urn:fdp:schema:control-cmd:v1",
        unit_id: ports.unitId ?? DEFAULT_UNIT_ID,
        wall_ts: toIsoMs(ports.wall.now()),
        cmd_id: cmdId,
        ...checked.value,
      };

      // The acknowledgement can arrive before `publishJson` resolves, so the
      // waiter is registered first.
      const ack = awaitAck(cmdId);
      try {
        await ports.ops.publishJson("control-cmd", topics.controlCmd, message);
      } catch (error) {
        settle(cmdId, null);
        await ack;
        throw new SimUnreachableError(error);
      }
      logger.info({ cmd, cmd_id: cmdId }, "published a replay command");

      const result: ApiSimCommandResult = { cmd_id: cmdId, accepted: true, ack: await ack };
      assertValid("api-sim-command-result", result);
      return result;
    },

    stop() {
      for (const cmdId of [...pending.keys()]) settle(cmdId, null);
    },
  };
}
