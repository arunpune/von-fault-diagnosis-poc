// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The live entry point end to end, inside the page: the real App with the msw REST handlers, the
// real live feed over a FakeWebSocket, and the frames a backend sends after connecting. The
// browser-level reconnect is the Playwright tour's; this proves the wiring without a browser.

import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { getDecisions } from "@/api/endpoints";
import { startLiveFeed, type LiveFeed } from "@/api/live-feed";
import { qk } from "@/api/query-keys";
import type { ApiDecisions, ApiEvents, Decision, StatusBackend, StatusSim } from "@/api/types";
import { registerFrameHandler } from "@/api/ws-dispatch";
import type { FrameOf, WsFrame } from "@/api/ws-types";
import { tid } from "@/lib/testids";
import { getLiveState, resetLiveStore } from "@/store/live-store";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { fixtures, frames } from "@/test/msw/fixtures";
import { createTestQueryClient, renderWithProviders } from "@/test/render";

let feed: LiveFeed | null = null;
let queryClient: QueryClient;
let linkOpens = 0;
let disposeLinkOpen: () => void = () => undefined;

/** A frame of `type` around `payload`, in the fixture's envelope. */
function frame<T extends Exclude<WsFrame["type"], "link.open">>(
  type: T,
  payload: FrameOf<T>["payload"],
): FrameOf<T> {
  return { ...frames[type], payload } as FrameOf<T>;
}

function simStatus(): StatusSim {
  if (fixtures.status.sim === null) {
    throw new Error("status.json carries a sim status");
  }
  return fixtures.status.sim;
}

function send(socket: FakeWebSocket, item: WsFrame): void {
  act(() => {
    socket.message(item);
  });
}

function bar(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

/** Boots the page and its live feed and accepts the socket; `settled` waits for the resync. */
function boot(): FakeWebSocket {
  renderWithProviders(<App />, { queryClient });
  feed = startLiveFeed({
    queryClient,
    url: "ws://dashboard.test/ws",
    createSocket: createFakeSocket,
  });
  const socket = FakeWebSocket.latest();
  act(() => {
    socket.open();
  });
  return socket;
}

async function settled(opens: number): Promise<void> {
  await waitFor(() => {
    expect(linkOpens).toBe(opens);
    expect(queryClient.isFetching()).toBe(0);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  FakeWebSocket.reset();
  queryClient = createTestQueryClient();
  linkOpens = 0;
  disposeLinkOpen = registerFrameHandler("link.open", () => {
    linkOpens += 1;
  });
});

afterEach(() => {
  feed?.stop();
  feed = null;
  disposeLinkOpen();
  act(() => {
    resetLiveStore();
  });
  queryClient.clear();
});

describe("the page on its live feed", () => {
  it("follows hello, snapshot, statuses, alerts and decisions into the status bar and the cache", async () => {
    const socket = boot();
    expect(bar(tid.status.link)).toHaveTextContent("Linkopen");

    // hello names the backend before any status is known.
    send(
      socket,
      frame("hello", { ...frames.hello.payload, decision_backend: "llm", model: "claude-opus-5" }),
    );
    expect(bar(tid.status.backend)).toHaveTextContent("Claude · claude-opus-5");

    // The resync on open brings GET /api/status; the backend status now names the backend.
    await settled(1);
    expect(bar(tid.status.backend)).toHaveTextContent("Jev · jev-1.13.0");
    expect(bar(tid.status.clock)).toHaveTextContent("2020-06-05 09:48:20 UTC");

    // snapshot: the statuses of the same instant, the overlay caches seeded.
    send(socket, frames.snapshot);
    expect(queryClient.getQueryData(qk.overlayCatalog())).toEqual(
      frames.snapshot.payload.overlay.catalog,
    );
    expect(getLiveState().alertsActive).toEqual([]);

    // status.sim moves the clock and the replay state.
    const paused: StatusSim = {
      ...simStatus(),
      state: "paused",
      sim_ts: "2020-06-05T10:15:00.000Z",
      wall_ts: "2026-09-19T10:01:00.000Z",
    };
    send(socket, frame("status.sim", paused));
    expect(bar(tid.status.clock)).toHaveTextContent("2020-06-05 10:15:00 UTC");
    expect(bar(tid.status.state)).toHaveTextContent("paused");

    // status.backend with a silent telemetry watchdog flips the telemetry lamp.
    const silent: StatusBackend = {
      ...fixtures.status.backend,
      wall_ts: "2026-09-19T10:01:00.000Z",
      heartbeat: { telemetry_silent: true, decision_api_silent: false },
    };
    send(socket, frame("status.backend", silent));
    expect(bar(tid.status.telemetry)).toHaveTextContent("Telemetrysilent");
    expect(bar(tid.status.decisions)).toHaveTextContent("Decisionsok");

    // alert.system raises and clears a banner in the live store.
    send(socket, frames["alert.system"]);
    expect(getLiveState().alertsActive).toEqual([frames["alert.system"].payload]);
    send(socket, frame("alert.system", { ...frames["alert.system"].payload, state: "cleared" }));
    expect(getLiveState().alertsActive).toEqual([]);

    // decision lands in the loaded decisions list, newest first, and in its detail cache.
    await act(() =>
      queryClient.prefetchQuery({ queryKey: qk.decisions(), queryFn: () => getDecisions() }),
    );
    const decision: Decision = {
      ...frames.decision.payload,
      decision_id: "0b7d2c4e-6f81-4a93-b5c2-7d8e9f0a1b2c",
      sim_ts: "2020-06-05T10:14:00.000Z",
    };
    send(socket, frame("decision", decision));
    const decisions = queryClient.getQueryData<ApiDecisions>(qk.decisions());
    expect(decisions?.items[0]).toEqual(decision);
    expect(decisions?.items).toHaveLength(fixtures.decisions.items.length + 1);
    expect(queryClient.getQueryData(qk.decision(decision.decision_id))).toEqual(decision);

    // event.suspect lands in the events cache the Events tab counts.
    await waitFor(() => {
      expect(screen.getByTestId(tid.events.tab)).toHaveTextContent("Events3");
    });
    send(
      socket,
      frame("event.suspect", {
        ...frames["event.suspect"].payload,
        event_id: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
        sim_ts: "2020-06-05T10:14:00.000Z",
      }),
    );
    expect(queryClient.getQueryData<ApiEvents>(qk.events())?.items).toHaveLength(4);
    // The query observers hear of the patch on the cache's next notification tick.
    await waitFor(() => {
      expect(screen.getByTestId(tid.events.tab)).toHaveTextContent("Events4");
    });

    expect(socket.sent).toEqual([]);
  });

  it("shows the outage, reconnects and resyncs", async () => {
    // The shortest jittered retry, 375 ms, keeps the wait inside waitFor's second.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const socket = boot();
    await settled(1);

    act(() => {
      socket.close(1006);
    });
    expect(bar(tid.status.link)).toHaveTextContent("Linkreconnecting");
    expect(bar(tid.status.telemetry)).toHaveTextContent("Telemetryunknown");

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
    act(() => {
      FakeWebSocket.latest().open();
    });

    await settled(2);
    expect(bar(tid.status.link)).toHaveTextContent("Linkopen");
    expect(bar(tid.status.telemetry)).toHaveTextContent("Telemetryok");
  });
});
