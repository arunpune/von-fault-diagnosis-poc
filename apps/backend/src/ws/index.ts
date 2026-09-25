// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /ws`, the one WebSocket endpoint.
 *
 * The route is outside the `/api` prefix, as nginx and the Vite development
 * server proxy it, and it does one thing: every socket `@fastify/websocket`
 * accepts is handed to the hub, which owns everything a socket receives and
 * everything it may send (`hub.ts`). The stream is server to client; the
 * only frames a browser sends are `subscribe` and `ping`, and commands are
 * REST posts.
 *
 * On shutdown (`fastify.close()`) the hub closes every socket with 1001 before
 * the plugin closes the server, so a browser reconnects instead of reporting
 * an abnormal closure. The hook is added before the plugin is registered
 * because `preClose` hooks run in the order they were added.
 */

import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";

import { CLOSE_GOING_AWAY, type Hub } from "./hub.ts";

export { createHub } from "./hub.ts";
export type { Hub, HubCounters, HubInfo, HubOptions, HubSocket } from "./hub.ts";

/** The path the browser opens; nginx and Vite proxy it beside `/api`. */
export const WS_PATH = "/ws";

/** A client frame is `subscribe` or `ping`; nothing it may send comes near this. */
export const CLIENT_FRAME_MAX_BYTES = 64 * 1024;

export function wsRoutes(hub: Pick<Hub, "attach" | "closeAll">): FastifyPluginAsync {
  return async (fastify) => {
    fastify.addHook("preClose", async () => {
      hub.closeAll(CLOSE_GOING_AWAY, "server shutting down");
    });
    await fastify.register(websocket, { options: { maxPayload: CLIENT_FRAME_MAX_BYTES } });
    fastify.get(WS_PATH, { websocket: true }, (socket) => {
      hub.attach(socket);
    });
  };
}
