// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AlertSystem,
  ApiStatus,
  SnapshotPayload,
  StatusBackend,
  StatusGateway,
  StatusSim,
} from "@/api/types";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf, WsFrame } from "@/api/ws-types";
import {
  applyAck,
  applyStatusSnapshot,
  countDroppedFrame,
  getLiveState,
  resetLiveStore,
  setDerivedSimNow,
  setLinkState,
  useActiveAlerts,
  useActiveInjections,
  useBackendStatus,
  useDecisionBackend,
  useGatewayStatus,
  useLinkState,
  useLiveValue,
  useSimNow,
  useSimStatus,
} from "@/store/live-store";
import { fixtures, frames } from "@/test/msw/fixtures";

afterEach(() => {
  act(() => {
    resetLiveStore();
  });
});

function simStatus(): StatusSim {
  if (fixtures.status.sim === null) {
    throw new Error("status.json carries a sim status");
  }
  return fixtures.status.sim;
}

function gatewayStatus(): StatusGateway {
  if (fixtures.status.gateway === null) {
    throw new Error("status.json carries a gateway status");
  }
  return fixtures.status.gateway;
}

const backendStatus: StatusBackend = fixtures.status.backend;

/** A frame of `type` around `payload`, in the fixture's envelope. */
function frame<T extends Exclude<WsFrame["type"], "link.open">>(
  type: T,
  payload: FrameOf<T>["payload"],
): FrameOf<T> {
  return { ...frames[type], payload } as FrameOf<T>;
}

function push(...pushed: WsFrame[]): void {
  act(() => {
    for (const item of pushed) {
      dispatchFrame(item);
    }
  });
}

function useEverything() {
  return {
    link: useLinkState(),
    sim: useSimStatus(),
    gateway: useGatewayStatus(),
    backend: useBackendStatus(),
    identity: useDecisionBackend(),
    alerts: useActiveAlerts(),
    injections: useActiveInjections(),
    now: useSimNow(),
  };
}

function raisedAlert(): AlertSystem {
  return frames["alert.system"].payload;
}

describe("the initial state", () => {
  it("is connecting, with nothing known yet", () => {
    const { result } = renderHook(useEverything);

    expect(result.current).toEqual({
      link: "connecting",
      sim: null,
      gateway: null,
      backend: null,
      identity: null,
      alerts: [],
      injections: [],
      now: null,
    });
    expect(getLiveState()).toMatchObject({ linkNote: null, droppedFrames: 0, hello: null });
  });
});

describe("the status frames", () => {
  it("replace the status of their kind", () => {
    const { result } = renderHook(useEverything);

    push(frames["status.sim"], frames["status.gateway"], frames["status.backend"]);

    expect(result.current.sim).toEqual(frames["status.sim"].payload);
    expect(result.current.gateway).toEqual(frames["status.gateway"].payload);
    expect(result.current.backend).toEqual(frames["status.backend"].payload);
    expect(result.current.now).toBe(Date.parse(frames["status.sim"].payload.sim_ts));
  });

  it("ignore a status older than the one held", () => {
    const { result } = renderHook(() => useSimStatus());
    push(frames["status.sim"]);

    const stale = {
      ...simStatus(),
      state: "stopped" as const,
      wall_ts: "2026-09-19T09:00:00.000Z",
    };
    push(frame("status.sim", stale));
    expect(result.current?.state).toBe("playing");

    const fresh = { ...simStatus(), state: "paused" as const, wall_ts: "2026-09-19T10:00:01.500Z" };
    push(frame("status.sim", fresh));
    expect(result.current?.state).toBe("paused");
  });

  it("keep the reference of a status repeated verbatim", () => {
    const { result } = renderHook(() => useSimStatus());
    push(frames["status.sim"]);
    const before = result.current;

    push(frame("status.sim", structuredClone(frames["status.sim"].payload)));

    expect(result.current).toBe(before);
  });

  it("re-render only the consumers of the status that changed", () => {
    let backendRenders = 0;
    let simRenders = 0;
    renderHook(() => {
      backendRenders += 1;
      return useBackendStatus();
    });
    renderHook(() => {
      simRenders += 1;
      return useSimStatus();
    });
    const [backendBefore, simBefore] = [backendRenders, simRenders];

    push(frames["status.sim"]);
    push(frame("status.sim", { ...simStatus(), wall_ts: "2026-09-19T10:00:01.500Z" }));

    expect(simRenders - simBefore).toBe(2);
    expect(backendRenders - backendBefore).toBe(0);
  });
});

describe("hello", () => {
  it("names the backend until a backend status arrives, which then wins", () => {
    const { result } = renderHook(() => useDecisionBackend());

    push(frames.hello);
    expect(result.current).toEqual({ name: "jev", model: "jev-1.13.0" });

    const rules: StatusBackend = {
      ...backendStatus,
      backend: { name: "rules", model: "rules-v1" },
    };
    push(frame("status.backend", rules));
    expect(result.current).toEqual({ name: "rules", model: "rules-v1" });
  });

  it("keeps the identity's reference while the backend statuses repeat it", () => {
    const { result } = renderHook(() => useDecisionBackend());
    push(frames["status.backend"]);
    const before = result.current;

    push(
      frame("status.backend", {
        ...backendStatus,
        wall_ts: "2026-09-19T10:00:10.000Z",
        episodes_open: 3,
      }),
    );

    expect(result.current).toBe(before);
  });

  it("rejects a schema major other than 1 with a console error and a link note", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useDecisionBackend());
    const future = {
      ...frames.hello.payload,
      schema_major: 2,
    } as unknown as FrameOf<"hello">["payload"];

    push(frame("hello", future));

    expect(result.current).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(getLiveState().linkNote).toMatch(/schema v2; this dashboard reads v1/);

    push(frames.hello);
    expect(getLiveState().linkNote).toBeNull();
    expect(result.current).toEqual({ name: "jev", model: "jev-1.13.0" });
  });
});

describe("snapshot", () => {
  it("applies the statuses, the raised alerts and the running injections", () => {
    const { result } = renderHook(useEverything);
    const snapshot: SnapshotPayload = {
      ...frames.snapshot.payload,
      system_alerts: [raisedAlert()],
    };

    push(frame("snapshot", snapshot));

    expect(result.current.sim).toEqual(snapshot.status.sim);
    expect(result.current.gateway).toEqual(snapshot.status.gateway);
    expect(result.current.backend).toEqual(snapshot.status.backend);
    expect(result.current.alerts).toEqual([raisedAlert()]);
    expect(result.current.injections).toEqual(snapshot.overlay.active?.active);
  });

  it("leaves the injections alone when the snapshot carries no overlay list", () => {
    const { result } = renderHook(() => useActiveInjections());
    act(() => {
      applyStatusSnapshot(fixtures.status);
    });
    const before = result.current;

    push(
      frame("snapshot", {
        ...frames.snapshot.payload,
        overlay: { catalog: null, active: null },
      }),
    );

    expect(result.current).toBe(before);
    expect(result.current).toHaveLength(1);
  });
});

describe("alert.system", () => {
  it("adds a raised alert, replaces it when raised again with news, removes it once cleared", () => {
    const { result } = renderHook(() => useActiveAlerts());
    const alert = raisedAlert();

    push(frames["alert.system"]);
    expect(result.current).toEqual([alert]);
    const first = result.current;

    push(frame("alert.system", structuredClone(alert)));
    expect(result.current).toBe(first);

    const other: AlertSystem = {
      ...alert,
      alert_id: "5b1e7f2c-0a44-4d7e-8f19-2c3d4e5f6a7b",
      kind: "decision_api_silent",
      details: { consecutive_errors: 3 },
    };
    push(frame("alert.system", other));
    const worse: AlertSystem = { ...alert, details: { ...alert.details, timeout_s: 120 } };
    push(frame("alert.system", worse));
    expect(result.current).toEqual([worse, other]);

    push(frame("alert.system", { ...alert, state: "cleared" }));
    expect(result.current).toEqual([other]);
  });

  it("ignores the clearing of an alert it never saw", () => {
    const { result } = renderHook(() => useActiveAlerts());
    push(frames["alert.system"]);
    const before = result.current;

    push(
      frame("alert.system", {
        ...raisedAlert(),
        alert_id: "00000000-0000-4000-8000-000000000000",
        state: "cleared",
      }),
    );

    expect(result.current).toBe(before);
  });
});

describe("overlay.injection_active", () => {
  it("replaces the running injections, an empty list clearing them", () => {
    const { result } = renderHook(() => useActiveInjections());

    push(frames["overlay.injection_active"]);
    expect(result.current).toEqual(frames["overlay.injection_active"].payload.active);

    push(
      frame("overlay.injection_active", {
        ...frames["overlay.injection_active"].payload,
        active: [],
      }),
    );
    expect(result.current).toEqual([]);
  });
});

describe("the writers", () => {
  it("apply an acknowledged status unless it is older than the one held", () => {
    const { result } = renderHook(() => useSimStatus());
    act(() => {
      applyStatusSnapshot(fixtures.status);
    });

    act(() => {
      applyAck({ ...simStatus(), state: "stopped", wall_ts: "2026-09-19T09:00:00.000Z" });
    });
    expect(result.current?.state).toBe("playing");

    act(() => {
      applyAck({ ...simStatus(), state: "paused", wall_ts: "2026-09-19T10:00:06.040Z" });
    });
    expect(result.current?.state).toBe("paused");

    act(() => {
      applyStatusSnapshot(fixtures.status);
    });
    expect(result.current?.state).toBe("paused");
  });

  it("replace the alerts and the injections with the snapshot's", () => {
    const snapshot: ApiStatus = { ...fixtures.status, alerts_active: [], injections_active: [] };
    const { result } = renderHook(() => ({
      alerts: useActiveAlerts(),
      injections: useActiveInjections(),
    }));

    act(() => {
      applyStatusSnapshot(fixtures.status);
    });
    expect(result.current.alerts).toHaveLength(1);

    act(() => {
      applyStatusSnapshot(snapshot);
    });
    expect(result.current).toEqual({ alerts: [], injections: [] });
  });

  it("clear a status the snapshot no longer carries", () => {
    const { result } = renderHook(() => useGatewayStatus());

    act(() => {
      applyStatusSnapshot(fixtures.status);
    });
    expect(result.current).toEqual(gatewayStatus());

    act(() => {
      applyStatusSnapshot({ ...fixtures.status, gateway: null });
    });
    expect(result.current).toBeNull();
  });

  it("report the link state and count the dropped frames", () => {
    const { result } = renderHook(() => ({
      link: useLinkState(),
      dropped: useLiveValue((live) => live.droppedFrames),
    }));

    act(() => {
      setLinkState("open");
      countDroppedFrame();
      countDroppedFrame();
    });
    expect(result.current).toEqual({ link: "open", dropped: 2 });

    act(() => {
      setLinkState("reconnecting");
    });
    expect(result.current.link).toBe("reconnecting");
  });

  it("do not wake the subscribers when nothing changed", () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useLinkState();
    });
    const before = renders;

    act(() => {
      setLinkState("connecting");
      setDerivedSimNow(null);
    });

    expect(renders).toBe(before);
  });
});

describe("useSimNow", () => {
  it("follows the recorder's latest point once it has one, the simulator's sim_ts before", () => {
    const { result } = renderHook(() => useSimNow());
    expect(result.current).toBeNull();

    act(() => {
      applyStatusSnapshot(fixtures.status);
    });
    expect(result.current).toBe(Date.parse(simStatus().sim_ts));

    act(() => {
      setDerivedSimNow(Date.UTC(2020, 5, 5, 9, 49));
    });
    expect(result.current).toBe(Date.UTC(2020, 5, 5, 9, 49));

    act(() => {
      setDerivedSimNow(null);
    });
    expect(result.current).toBe(Date.parse(simStatus().sim_ts));
  });

  it("is null while the simulator status carries no readable instant", () => {
    const { result } = renderHook(() => useSimNow());

    act(() => {
      applyAck({ ...simStatus(), sim_ts: "not a time", wall_ts: "2027-01-01T00:00:00.000Z" });
    });

    expect(result.current).toBeNull();
  });
});

describe("useLiveValue", () => {
  it("re-renders only when the derived value changes", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLiveValue((live) => live.sim?.state ?? null);
    });
    push(frames["status.sim"]);
    const before = renders;

    push(
      frame("status.sim", {
        ...simStatus(),
        sim_ts: "2020-06-05T09:50:00.000Z",
        wall_ts: "2026-09-19T10:00:02.000Z",
      }),
    );
    expect(renders).toBe(before);

    push(
      frame("status.sim", { ...simStatus(), state: "paused", wall_ts: "2026-09-19T10:00:03.000Z" }),
    );
    expect(result.current).toBe("paused");
    expect(renders).toBe(before + 1);
  });
});

describe("resetLiveStore", () => {
  it("returns every value to the start and tells the mounted subscribers", () => {
    const { result } = renderHook(useEverything);
    act(() => {
      applyStatusSnapshot(fixtures.status);
      setLinkState("open");
    });
    expect(result.current.link).toBe("open");

    act(() => {
      resetLiveStore();
    });

    expect(result.current).toMatchObject({
      link: "connecting",
      sim: null,
      gateway: null,
      alerts: [],
    });
  });
});
