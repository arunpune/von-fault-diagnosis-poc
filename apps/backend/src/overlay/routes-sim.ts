// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/sim/*`: the replay controls.
 *
 * Seven routes, one per command the simulator accepts. The path segment names
 * the command and the body carries its arguments, so the document the contract
 * validates — `{ cmd, args }` — is assembled here and never sent by a client;
 * that is what keeps `api-sim-command` and `control-cmd` the same pair of
 * definitions on both sides of the broker.
 *
 * Three answers:
 *
 *   * **202** with an `api-sim-command-result`. Accepted means published, not
 *     applied: `ack` carries the simulator's answer when it arrived inside the
 *     wait and is null when it did not.
 *   * **400** with an `api-error` when the arguments do not match the command.
 *   * **503** with an `api-error` when the broker is down or refused the
 *     publication — the simulator is unreachable, and the caller may retry.
 *
 * The command routes live apart from `routes-read.ts` on purpose: the read
 * endpoint of the overlay must stay a read endpoint, and dependency-cruiser
 * keeps the control passthrough out of it.
 */

import type { Command } from "@fdp/contracts";
import type { FastifyPluginAsync } from "fastify";

import { overlayError } from "./errors.ts";
import { SimCommandError, SimUnreachableError, type SimControl } from "./simctl.ts";

/** The path segment of each route and the command it names. */
export const SIM_ROUTES: Readonly<Record<string, Command>> = {
  play: "play",
  pause: "pause",
  speed: "set_speed",
  jump: "jump",
  inject: "inject",
  clear: "clear_injections",
  reset: "reset",
};

export interface SimRoutePorts {
  readonly control: SimControl;
}

/** The body every command route takes; the commands without arguments take none. */
interface CommandBody {
  args?: Record<string, unknown>;
}

/** The body as an argument object: an absent body is the empty one. */
function argsOf(body: CommandBody | undefined | null): Record<string, unknown> {
  return body?.args ?? {};
}

export function overlaySimRoutes(ports: SimRoutePorts): FastifyPluginAsync {
  return async (fastify) => {
    for (const [segment, cmd] of Object.entries(SIM_ROUTES)) {
      fastify.post<{ Body: CommandBody | undefined }>(`/sim/${segment}`, async (request, reply) => {
        if (!ports.control.reachable()) {
          return reply
            .code(503)
            .send(overlayError("sim_unreachable", "the broker connection is down", { cmd }));
        }
        try {
          const result = await ports.control.send(cmd, argsOf(request.body));
          return reply.code(202).send(result);
        } catch (error) {
          if (error instanceof SimCommandError) {
            return reply
              .code(400)
              .send(overlayError("bad_request", error.message, { cmd, issues: error.issues }));
          }
          if (error instanceof SimUnreachableError) {
            request.log.warn({ err: error, cmd }, "the command could not be published");
            return reply.code(503).send(overlayError("sim_unreachable", error.message, { cmd }));
          }
          throw error;
        }
      });
    }
  };
}
