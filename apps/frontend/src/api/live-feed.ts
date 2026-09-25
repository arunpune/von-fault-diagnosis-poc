// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The page's live feed: the one WsClient, wired to the frame dispatcher, to the live store and
// to the query-cache reducers. `main.tsx` starts it once per page load, outside React
// (advanced-init-once rule); the app-level test starts it over a FakeWebSocket.
//
// Reconnect policy: on every open the feed re-reads `GET /api/status` into the live store (the
// statuses, the raised alerts and the running injections, all in that one body), invalidates
// every query so no panel keeps a row a missed push would have changed, and dispatches the
// UI-internal `link.open` frame so the recorder reseeds without importing this module. The
// status goes first, so the recorder anchors its reseed on a fresh sim clock.

import type { QueryClient } from "@tanstack/react-query";

import { getStatus } from "@/api/endpoints";
import type { ApiStatus } from "@/api/types";
import { installWsCache } from "@/api/ws-cache";
import { WsClient, wsUrl, type WsLinkState } from "@/api/ws-client";
import { dispatchFrame } from "@/api/ws-dispatch";
import { applyStatusSnapshot, countDroppedFrame, setLinkState } from "@/store/live-store";

export interface LiveFeedOptions {
  queryClient: QueryClient;
  /** The socket URL; the page's own `/ws` by default. */
  url?: string;
  /** Opens the socket; a test injects `createFakeSocket`. */
  createSocket?: (url: string) => WebSocket;
}

export interface LiveFeed {
  readonly client: WsClient;
  /** Closes the socket and unregisters the cache reducers. */
  stop(): void;
}

async function readStatus(): Promise<ApiStatus | null> {
  try {
    return await getStatus();
  } catch (error) {
    // The frames bring the statuses too; the page stays usable without this read.
    console.warn("live-feed: GET /api/status failed after the link opened", error);
    return null;
  }
}

/**
 * Brings the page back in step after the link opened: the status into the live store, every
 * query invalidated, then `link.open`. When the link dropped or reopened while the status was on
 * its way (`isCurrent` false) it does nothing more: the next open repeats the whole sequence.
 */
async function resyncAfterOpen(queryClient: QueryClient, isCurrent: () => boolean): Promise<void> {
  const status = await readStatus();
  if (!isCurrent()) {
    return;
  }
  if (status !== null) {
    applyStatusSnapshot(status);
  }
  void queryClient.invalidateQueries();
  dispatchFrame({ type: "link.open", wall_ts: new Date().toISOString() });
}

/** Starts the live feed: installs the cache reducers and opens the socket. */
export function startLiveFeed({
  queryClient,
  url = wsUrl(),
  createSocket,
}: LiveFeedOptions): LiveFeed {
  const uninstallCache = installWsCache(queryClient);
  /** Counts the opens, so a resync overtaken by a newer one (or by a loss) stays quiet. */
  let opens = 0;

  const onState = (link: WsLinkState): void => {
    setLinkState(link);
    if (link !== "open") {
      return;
    }
    opens += 1;
    const open = opens;
    void resyncAfterOpen(queryClient, () => open === opens && client.state === "open");
  };

  const client = new WsClient({
    url,
    createSocket,
    onFrame: dispatchFrame,
    onState,
    onDrop: countDroppedFrame,
  });
  client.start();

  return {
    client,
    stop() {
      client.stop();
      uninstallCache();
    },
  };
}
