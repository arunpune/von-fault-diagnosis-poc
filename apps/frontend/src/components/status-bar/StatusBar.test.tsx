// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startLiveFeed, type LiveFeed } from "@/api/live-feed";
import type { StatusBackend, StatusSim } from "@/api/types";
import { dispatchFrame, registerFrameHandler } from "@/api/ws-dispatch";
import type { FrameOf, WsFrame } from "@/api/ws-types";
import { BackendChip } from "@/components/status-bar/BackendChip";
import type * as BackendChipModule from "@/components/status-bar/BackendChip";
import type * as DatasetProgressModule from "@/components/status-bar/DatasetProgress";
import type * as ReplayStateModule from "@/components/status-bar/ReplayState";
import type * as SimClockModule from "@/components/status-bar/SimClock";
import type * as StatusLampsModule from "@/components/status-bar/StatusLamps";
import StatusBar from "@/components/status-bar/StatusBar";
import { RECONNECT_BANNER_DELAY_MS } from "@/components/status-bar/status-words";
import { tid } from "@/lib/testids";
import {
  applyStatusSnapshot,
  countDroppedFrame,
  resetLiveStore,
  setDerivedSimNow,
  setLinkState,
  type LiveState,
} from "@/store/live-store";
import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { fixtures, frames } from "@/test/msw/fixtures";
import { createTestQueryClient, renderWithProviders } from "@/test/render";

// Render counters: every part of the bar is wrapped in a component that counts its renders and
// then renders the real part in its own place, so the store subscriptions stay where they are.
const { renders, counted } = vi.hoisted(() => {
  const renders: Record<string, number> = {};
  function counted<P extends object>(name: string, Part: (props: P) => ReactNode) {
    renders[name] = 0;
    return function Counted(props: P) {
      renders[name] = (renders[name] ?? 0) + 1;
      return Part(props);
    };
  }
  return { renders, counted };
});

vi.mock("@/components/status-bar/SimClock", async (importOriginal) => {
  const actual = await importOriginal<typeof SimClockModule>();
  return { SimClock: counted("SimClock", actual.SimClock) };
});
vi.mock("@/components/status-bar/ReplayState", async (importOriginal) => {
  const actual = await importOriginal<typeof ReplayStateModule>();
  return { ReplayState: counted("ReplayState", actual.ReplayState) };
});
vi.mock("@/components/status-bar/DatasetProgress", async (importOriginal) => {
  const actual = await importOriginal<typeof DatasetProgressModule>();
  return { DatasetProgress: counted("DatasetProgress", actual.DatasetProgress) };
});
vi.mock("@/components/status-bar/StatusLamps", async (importOriginal) => {
  const actual = await importOriginal<typeof StatusLampsModule>();
  return {
    LinkLamp: counted("LinkLamp", actual.LinkLamp),
    TelemetryLamp: counted("TelemetryLamp", actual.TelemetryLamp),
    GatewayDropped: counted("GatewayDropped", actual.GatewayDropped),
    DecisionsLamp: counted("DecisionsLamp", actual.DecisionsLamp),
  };
});
vi.mock("@/components/status-bar/BackendChip", async (importOriginal) => {
  const actual = await importOriginal<typeof BackendChipModule>();
  return { ...actual, LiveBackendChip: counted("LiveBackendChip", actual.LiveBackendChip) };
});

function resetRenders(): void {
  for (const name of Object.keys(renders)) {
    renders[name] = 0;
  }
}

function simStatus(): StatusSim {
  if (fixtures.status.sim === null) {
    throw new Error("status.json carries a sim status");
  }
  return fixtures.status.sim;
}

/** A frame of `type` around `payload`, in the fixture's envelope. */
function frame<T extends Exclude<WsFrame["type"], "link.open">>(
  type: T,
  payload: FrameOf<T>["payload"],
): FrameOf<T> {
  return { ...frames[type], payload } as FrameOf<T>;
}

function push(item: WsFrame): void {
  act(() => {
    dispatchFrame(item);
  });
}

function seed(link: LiveState["link"] = "open"): void {
  act(() => {
    applyStatusSnapshot(fixtures.status);
    setLinkState(link);
  });
}

function backendWith(patch: Partial<StatusBackend>): StatusBackend {
  return { ...fixtures.status.backend, wall_ts: "2026-09-19T10:00:30.000Z", ...patch };
}

function lamp(testId: string): HTMLElement {
  return screen.getByTestId(testId);
}

afterEach(() => {
  act(() => {
    resetLiveStore();
  });
  vi.useRealTimers();
});

describe("StatusBar", () => {
  it("shows the unit, clock, replay, dataset position, lamps, backend and theme toggle", () => {
    seed();
    renderWithProviders(<StatusBar />);

    expect(screen.getByText("CAU-7 compressed-air unit")).toBeInTheDocument();
    expect(lamp(tid.status.clock)).toHaveTextContent("2020-06-05 09:48:20 UTC");
    expect(lamp(tid.status.state)).toHaveTextContent("playing600×");
    expect(lamp(tid.status.state)).toHaveAttribute("data-state", "playing");
    const position = screen.getByRole("progressbar", { name: "Dataset position" });
    expect(position).toHaveAttribute(
      "aria-valuetext",
      "58.8 % through 2020-02-01 00:00:00 → 2020-09-01 03:59:50 UTC",
    );
    expect(lamp(tid.status.link)).toHaveTextContent("Linkopen");
    expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetryok");
    expect(lamp(tid.status.decisions)).toHaveTextContent("Decisionsok");
    expect(lamp(tid.status.backend)).toHaveTextContent("Von · von-1.13.0");
    expect(lamp(tid.status.theme)).toHaveAccessibleName(/^Theme: /);
    expect(screen.queryByText(/^dropped/)).not.toBeInTheDocument();
  });

  it("waits quietly before the first status", () => {
    renderWithProviders(<StatusBar />);

    expect(lamp(tid.status.clock)).toHaveTextContent("— UTC");
    expect(lamp(tid.status.state)).toHaveTextContent("no replay yet");
    expect(screen.getByRole("progressbar", { name: "Dataset position" })).toHaveAttribute(
      "aria-valuetext",
      "Not known yet",
    );
    expect(lamp(tid.status.link)).toHaveTextContent("Linkconnecting");
    expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetryunknown");
    expect(lamp(tid.status.backend)).toHaveTextContent("No backend yet");
  });

  describe("the lamps", () => {
    it("follow the link state", () => {
      seed("connecting");
      renderWithProviders(<StatusBar />);
      const link = lamp(tid.status.link);
      expect(link).toHaveAttribute("data-lamp", "off");

      act(() => {
        setLinkState("open");
      });
      expect(link).toHaveTextContent("Linkopen");
      expect(link).toHaveAttribute("data-lamp", "ok");
      expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetryok");

      act(() => {
        setLinkState("reconnecting");
      });
      expect(link).toHaveTextContent("Linkreconnecting");
      expect(link).toHaveAttribute("data-lamp", "warn");
      expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetryunknown");
      expect(lamp(tid.status.decisions)).toHaveTextContent("Decisionsunknown");
    });

    it("follow the backend's watchdogs", () => {
      seed();
      renderWithProviders(<StatusBar />);

      push(
        frame(
          "status.backend",
          backendWith({ heartbeat: { telemetry_silent: true, decision_api_silent: true } }),
        ),
      );

      expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetrysilent");
      expect(lamp(tid.status.telemetry)).toHaveAttribute("data-lamp", "warn");
      expect(lamp(tid.status.decisions)).toHaveTextContent("Decisionssilent");
      expect(lamp(tid.status.decisions)).toHaveAttribute("data-lamp", "warn");
    });

    it("say no model for the rules backend", () => {
      seed();
      renderWithProviders(<StatusBar />);

      push(frame("status.backend", backendWith({ backend: { name: "rules", model: "rules-v1" } })));

      expect(lamp(tid.status.decisions)).toHaveTextContent("Decisionsno model");
      expect(lamp(tid.status.decisions)).toHaveAttribute("data-lamp", "off");
    });

    it("say incompatible when the backend speaks another schema major", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      seed();
      renderWithProviders(<StatusBar />);

      push(
        frame("hello", {
          ...frames.hello.payload,
          schema_major: 2,
        } as unknown as FrameOf<"hello">["payload"]),
      );

      expect(lamp(tid.status.link)).toHaveTextContent("Linkincompatible");
      expect(lamp(tid.status.link)).toHaveAttribute("data-lamp", "warn");
    });

    it("show the gateway's dropped samples beside the telemetry lamp, explained on hover", async () => {
      const user = userEvent.setup();
      seed();
      renderWithProviders(<StatusBar />);
      const gateway = fixtures.status.gateway;
      if (gateway === null) {
        throw new Error("status.json carries a gateway status");
      }

      push(
        frame("status.gateway", {
          ...gateway,
          wall_ts: "2026-09-19T10:00:30.000Z",
          dropped_total: 1_204,
        }),
      );

      const dropped = screen.getByText("dropped 1,204");
      expect(within(screen.getByRole("group", { name: "Health" })).getByText("dropped 1,204")).toBe(
        dropped,
      );
      await user.hover(dropped);
      expect(
        await screen.findByRole("tooltip", { name: /The gateway missed 1,204 samples/ }),
      ).toBeInTheDocument();
    });

    it("explain the link and count the malformed messages on hover", async () => {
      const user = userEvent.setup();
      seed();
      act(() => {
        countDroppedFrame();
        countDroppedFrame();
      });
      renderWithProviders(<StatusBar />);

      await user.hover(lamp(tid.status.link));

      expect(
        await screen.findByRole("tooltip", {
          name: "Live updates are streaming from the backend. 2 malformed messages were ignored.",
        }),
      ).toBeInTheDocument();
    });
  });

  describe("the backend chip", () => {
    it("names the backend from the status, per backend", () => {
      seed();
      renderWithProviders(<StatusBar />);
      const chip = lamp(tid.status.backend);

      push(
        frame("status.backend", backendWith({ backend: { name: "llm", model: "claude-opus-5" } })),
      );
      expect(chip).toHaveTextContent("Claude · claude-opus-5");

      push(
        frame(
          "status.backend",
          backendWith({
            wall_ts: "2026-09-19T10:00:40.000Z",
            backend: { name: "rules", model: "rules-v1" },
          }),
        ),
      );
      expect(chip).toHaveTextContent(/^Rules$/);
    });

    it("names the backend from hello until a status arrives", () => {
      renderWithProviders(<StatusBar />);

      push(
        frame("hello", {
          ...frames.hello.payload,
          decision_backend: "llm",
          model: "claude-opus-5",
        }),
      );

      expect(lamp(tid.status.backend)).toHaveTextContent("Claude · claude-opus-5");
    });

    it("shows any backend it is given, for the decision sheet", () => {
      renderWithProviders(<BackendChip backend={{ name: "von", model: "von-1.13.0" }} />);

      expect(screen.getByText("Von · von-1.13.0")).toHaveAttribute(
        "title",
        "Decision backend: Von · von-1.13.0",
      );
    });
  });

  describe("the sim clock", () => {
    it("follows the recorder's latest point once it has one", () => {
      seed();
      renderWithProviders(<StatusBar />);

      act(() => {
        setDerivedSimNow(Date.UTC(2020, 5, 5, 9, 50, 7));
      });

      const clock = lamp(tid.status.clock);
      expect(clock).toHaveTextContent("2020-06-05 09:50:07 UTC");
      expect(within(clock).getByText("2020-06-05 09:50:07")).toHaveAttribute(
        "dateTime",
        "2020-06-05T09:50:07.000Z",
      );
    });
  });

  describe("the dataset position", () => {
    it("moves with the sim clock", () => {
      seed();
      renderWithProviders(<StatusBar />);
      const sim = simStatus();

      push(
        frame("status.sim", {
          ...sim,
          sim_ts: sim.dataset.last_ts,
          wall_ts: "2026-09-19T10:00:30.000Z",
        }),
      );

      const position = screen.getByRole("progressbar", { name: "Dataset position" });
      expect(position).toHaveAttribute("aria-valuenow", "100");
      expect(position).toHaveAttribute(
        "aria-valuetext",
        expect.stringMatching(/^100\.0 % through/),
      );
    });
  });

  describe("the reconnecting banner", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("appears once the link has been reconnecting for 5 s and goes when it is back", () => {
      seed();
      renderWithProviders(<StatusBar />);

      act(() => {
        setLinkState("reconnecting");
      });
      act(() => {
        vi.advanceTimersByTime(RECONNECT_BANNER_DELAY_MS - 1);
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("Reconnecting to the backend…");

      act(() => {
        setLinkState("open");
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("counts every outage afresh", () => {
      seed();
      renderWithProviders(<StatusBar />);

      act(() => {
        setLinkState("reconnecting");
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      act(() => {
        setLinkState("open");
      });
      act(() => {
        setLinkState("reconnecting");
      });
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("never shows while the first connection is still being made", () => {
      renderWithProviders(<StatusBar />);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});

describe("StatusBar over a live socket", () => {
  let feed: LiveFeed | null = null;
  let disposeLinkOpen: (() => void) | null = null;

  afterEach(() => {
    feed?.stop();
    feed = null;
    disposeLinkOpen?.();
    disposeLinkOpen = null;
  });

  async function connect(): Promise<FakeWebSocket> {
    FakeWebSocket.reset();
    const queryClient = createTestQueryClient();
    let opened = false;
    disposeLinkOpen = registerFrameHandler("link.open", () => {
      opened = true;
    });
    renderWithProviders(<StatusBar />, { queryClient });
    feed = startLiveFeed({
      queryClient,
      url: "ws://dashboard.test/ws",
      createSocket: createFakeSocket,
    });
    const socket = FakeWebSocket.latest();
    act(() => {
      socket.open();
    });
    await waitFor(() => {
      expect(opened).toBe(true);
    });
    expect(lamp(tid.status.link)).toHaveTextContent("Linkopen");
    return socket;
  }

  it("re-renders only the clock and the replay state on a status.sim frame", async () => {
    const socket = await connect();
    const sim = simStatus();
    resetRenders();

    act(() => {
      socket.message(
        frame("status.sim", {
          ...sim,
          state: "paused",
          sim_ts: "2020-06-05T09:48:30.000Z",
          wall_ts: "2026-09-19T10:00:01.000Z",
        }),
      );
    });

    expect(lamp(tid.status.clock)).toHaveTextContent("2020-06-05 09:48:30 UTC");
    expect(lamp(tid.status.state)).toHaveTextContent("paused");
    expect(renders.SimClock).toBe(1);
    expect(renders.ReplayState).toBe(1);
    expect(renders).toMatchObject({
      LinkLamp: 0,
      TelemetryLamp: 0,
      GatewayDropped: 0,
      DecisionsLamp: 0,
      LiveBackendChip: 0,
    });

    resetRenders();
    act(() => {
      socket.message(
        frame("status.sim", {
          ...sim,
          state: "paused",
          sim_ts: "2020-06-05T09:48:40.000Z",
          wall_ts: "2026-09-19T10:00:02.000Z",
        }),
      );
    });
    expect(renders.SimClock).toBe(1);
    expect(renders.ReplayState).toBe(0);
    expect(renders.DatasetProgress).toBe(0);
  });

  it("flips the telemetry lamp on a status.backend frame with a silent telemetry watchdog", async () => {
    const socket = await connect();
    resetRenders();

    act(() => {
      socket.message(
        frame(
          "status.backend",
          backendWith({ heartbeat: { telemetry_silent: true, decision_api_silent: false } }),
        ),
      );
    });

    expect(lamp(tid.status.telemetry)).toHaveTextContent("Telemetrysilent");
    expect(lamp(tid.status.telemetry)).toHaveAttribute("data-lamp", "warn");
    expect(renders.TelemetryLamp).toBe(1);
    expect(renders).toMatchObject({
      SimClock: 0,
      ReplayState: 0,
      DecisionsLamp: 0,
      LinkLamp: 0,
      LiveBackendChip: 0,
    });
  });
});
