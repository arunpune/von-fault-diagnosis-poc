// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startLiveFeed, type LiveFeed } from "@/api/live-feed";
import { qk } from "@/api/query-keys";
import type { ApiEvents, StatusSim } from "@/api/types";
import { dispatchFrame, registerFrameHandler } from "@/api/ws-dispatch";
import { getLiveState, resetLiveStore } from "@/store/live-store";
import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { fixtures, frames } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { createTestQueryClient } from "@/test/render";

let queryClient: QueryClient;
let feed: LiveFeed | null = null;
const disposers: (() => void)[] = [];

/** Records each `link.open` with the simulator status the live store held when it went out. */
function watchLinkOpen(): (StatusSim | null)[] {
  const seen: (StatusSim | null)[] = [];
  disposers.push(
    registerFrameHandler("link.open", () => {
      seen.push(getLiveState().sim);
    }),
  );
  return seen;
}

function start(): LiveFeed {
  feed = startLiveFeed({
    queryClient,
    url: "ws://dashboard.test/ws",
    createSocket: createFakeSocket,
  });
  return feed;
}

beforeEach(() => {
  queryClient = createTestQueryClient();
  FakeWebSocket.reset();
});

afterEach(() => {
  feed?.stop();
  feed = null;
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetLiveStore();
  queryClient.clear();
});

describe("startLiveFeed", () => {
  it("opens the socket and reports the link state to the live store", () => {
    const { client } = start();

    expect(FakeWebSocket.latest().url).toBe("ws://dashboard.test/ws");
    expect(client.state).toBe("connecting");
    expect(getLiveState().link).toBe("connecting");
  });

  it("re-reads the status, invalidates every query and then dispatches link.open on open", async () => {
    const opens = watchLinkOpen();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    start();

    FakeWebSocket.latest().open();
    expect(getLiveState().link).toBe("open");

    await vi.waitFor(() => {
      expect(opens).toHaveLength(1);
    });
    expect(opens[0]).toEqual(fixtures.status.sim);
    expect(getLiveState().alertsActive).toEqual(fixtures.status.alerts_active);
    expect(getLiveState().injectionsActive).toEqual(fixtures.status.injections_active);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith();
  });

  it("repeats the sequence after every reconnect", async () => {
    // The shortest jittered retry, 375 ms, keeps the wait well inside waitFor's second.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const opens = watchLinkOpen();
    start();
    FakeWebSocket.latest().open();
    await vi.waitFor(() => {
      expect(opens).toHaveLength(1);
    });

    FakeWebSocket.latest().close(1006);
    expect(getLiveState().link).toBe("reconnecting");
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
    FakeWebSocket.latest().open();

    await vi.waitFor(() => {
      expect(opens).toHaveLength(2);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("still dispatches link.open when the status read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    server.use(http.get("/api/status", () => apiError(503, "upstream_unavailable", "no broker")));
    const opens = watchLinkOpen();
    start();

    FakeWebSocket.latest().open();

    await vi.waitFor(() => {
      expect(opens).toEqual([null]);
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet when the link dropped again before the status came back", async () => {
    let answer: (() => void) | undefined;
    server.use(
      http.get(
        "/api/status",
        () =>
          new Promise<Response>((resolve) => {
            answer = () => {
              resolve(HttpResponse.json(fixtures.status));
            };
          }),
        { once: true },
      ),
    );
    const opens = watchLinkOpen();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    start();
    FakeWebSocket.latest().open();
    await vi.waitFor(() => {
      expect(answer).toBeDefined();
    });

    FakeWebSocket.latest().close(1006);
    answer?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getLiveState()).toMatchObject({ link: "reconnecting", sim: null });
    expect(opens).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("routes frames to the live store and to the query cache", () => {
    queryClient.setQueryData<ApiEvents>(qk.events(), { items: [], next_cursor: null });
    start();
    const socket = FakeWebSocket.latest();
    socket.open();

    socket.message(frames["status.backend"]);
    socket.message(frames["event.suspect"]);

    expect(getLiveState().backend).toEqual(frames["status.backend"].payload);
    expect(queryClient.getQueryData<ApiEvents>(qk.events())?.items).toEqual([
      frames["event.suspect"].payload,
    ]);
  });

  it("counts the malformed frames in the live store", () => {
    const { client } = start();
    FakeWebSocket.latest().open();

    FakeWebSocket.latest().message("not json");
    FakeWebSocket.latest().message({
      schema: "urn:fdp:schema:ws-server-message:v9",
      type: "hello",
    });

    expect(getLiveState().droppedFrames).toBe(2);
    expect(client.droppedFrames).toBe(2);
  });

  it("closes the link and unregisters the reducers on stop", () => {
    queryClient.setQueryData<ApiEvents>(qk.events(), { items: [], next_cursor: null });
    const running = start();
    const socket = FakeWebSocket.latest();
    socket.open();

    running.stop();
    feed = null;
    dispatchFrame(frames["event.suspect"]);

    expect(getLiveState().link).toBe("closed");
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(queryClient.getQueryData<ApiEvents>(qk.events())?.items).toEqual([]);
  });
});
