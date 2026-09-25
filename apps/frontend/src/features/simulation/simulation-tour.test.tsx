// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The README tour's simulation steps through the whole page (an integration test; the browser
// tours are under e2e/): Play, Jump to "Air leak – 5 Jun 2020", Inject fault →
// "Oil cooler fouling", Clear injections. The backend is a small stateful simulator behind msw:
// each command changes its replay state and injections and acknowledges with the new status, and
// `GET /api/status` serves the same state. The page runs its real live feed over a FakeWebSocket:
// on open it reads `GET /api/status` into the live store, and the running injections then arrive
// as `overlay.injection_active` frames, as the backend sends them.

import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it } from "vitest";

import { startLiveFeed, type LiveFeed } from "@/api/live-feed";
import type {
  ApiSimCommandResult,
  ApiStatus,
  InjectArgs,
  RunningInstance,
  SimCommandName,
  SimCommandSegment,
  StatusSim,
} from "@/api/types";
import App from "@/App";
import { tid } from "@/lib/testids";
import { resetLiveStore } from "@/store/live-store";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { createFakeSocket, FakeWebSocket } from "@/test/fake-websocket";
import { fixtures, frames } from "@/test/msw/fixtures";
import { server } from "@/test/msw/server";
import { createTestQueryClient, renderWithProviders } from "@/test/render";

const MS_PER_MINUTE = 60_000;
/** Four steps through the whole page; the budget leaves room for a loaded CI runner. */
const TOUR_TIMEOUT_MS = 20_000;

const COMMANDS: Readonly<Record<SimCommandSegment, SimCommandName>> = {
  play: "play",
  pause: "pause",
  speed: "set_speed",
  jump: "jump",
  inject: "inject",
  clear: "clear_injections",
  reset: "reset",
};

interface SentCommand {
  path: string;
  body: unknown;
}

function isSegment(value: string): value is SimCommandSegment {
  return Object.hasOwn(COMMANDS, value);
}

function isoPlusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MS_PER_MINUTE).toISOString();
}

/** A replay that starts stopped at the first row, with nothing injected. */
class FakeSimulator {
  readonly sent: SentCommand[] = [];
  private wallMs = Date.parse("2026-09-19T10:01:00.000Z");
  private sim: StatusSim;
  private injections: RunningInstance[] = [];

  constructor() {
    const base = fixtures.status.sim;
    if (base === null) {
      throw new Error("status.json carries a sim status");
    }
    this.sim = { ...base, state: "stopped", sim_ts: base.dataset.first_ts, speed: 600 };
    this.sim.wall_ts = this.nextWallTs();
  }

  status(): ApiStatus {
    return { ...fixtures.status, sim: this.sim, injections_active: this.injections };
  }

  command(segment: SimCommandSegment, body: unknown): ApiSimCommandResult {
    this.sent.push({ path: `/api/sim/${segment}`, body });
    const args = (body as { args: unknown }).args;
    this.apply(segment, args);
    this.sim = { ...this.sim, wall_ts: this.nextWallTs() };
    const cmdId = crypto.randomUUID();
    return {
      cmd_id: cmdId,
      accepted: true,
      ack: {
        schema: "urn:fdp:schema:control-ack:v1",
        unit_id: this.sim.unit_id,
        wall_ts: this.sim.wall_ts,
        cmd_id: cmdId,
        cmd: COMMANDS[segment],
        ok: true,
        error: null,
        status: this.sim,
      },
    };
  }

  private apply(segment: SimCommandSegment, args: unknown): void {
    switch (segment) {
      case "play":
        this.sim = { ...this.sim, state: "playing" };
        return;
      case "pause":
        this.sim = { ...this.sim, state: "paused" };
        return;
      case "speed":
        this.sim = { ...this.sim, speed: (args as { speed: number }).speed };
        return;
      case "jump":
        this.jump((args as { preset_id: string }).preset_id);
        return;
      case "inject":
        this.inject(args as InjectArgs);
        return;
      case "clear":
        this.injections = [];
        return;
      case "reset":
        this.sim = { ...this.sim, state: "stopped", sim_ts: this.sim.dataset.first_ts };
        this.injections = [];
        return;
    }
  }

  private jump(presetId: string): void {
    const preset = fixtures.overlayCatalog.presets.presets.find(
      (item) => item.preset_id === presetId,
    );
    if (preset === undefined) {
      throw new Error(`the tour jumps to a catalog preset, not ${presetId}`);
    }
    this.sim = { ...this.sim, sim_ts: isoPlusMinutes(preset.sim_ts, -preset.lead_in_min) };
    this.injections = [];
  }

  private inject({ injection_id: injectionId, params }: InjectArgs): void {
    const entry = fixtures.overlayCatalog.injections.find(
      (item) => item.injection_id === injectionId,
    );
    if (entry === undefined) {
      throw new Error(`the tour injects a catalog entry, not ${injectionId}`);
    }
    const durationSimMin = params?.duration_sim_min ?? entry.default_duration_sim_min;
    this.injections = [
      ...this.injections,
      {
        instance_id: `inj-tour-${this.injections.length + 1}`,
        injection_id: injectionId,
        fault_id: entry.fault_id,
        started_sim_ts: this.sim.sim_ts,
        ends_sim_ts: isoPlusMinutes(this.sim.sim_ts, durationSimMin),
        params: { magnitude: params?.magnitude ?? 1, duration_sim_min: durationSimMin },
      },
    ];
  }

  private nextWallTs(): string {
    this.wallMs += 1_000;
    return new Date(this.wallMs).toISOString();
  }
}

let simulator: FakeSimulator;
let queryClient: QueryClient;
let feed: LiveFeed | null = null;

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
  resetLiveStore();
  FakeWebSocket.reset();
  queryClient = createTestQueryClient();
  simulator = new FakeSimulator();
  server.use(
    http.get("/api/status", () => HttpResponse.json(simulator.status())),
    http.post("/api/sim/:cmd", async ({ params, request }) => {
      const segment = String(params.cmd);
      if (!isSegment(segment)) {
        return HttpResponse.json(
          { error: { code: "not_found", message: segment } },
          { status: 404 },
        );
      }
      return HttpResponse.json(simulator.command(segment, await request.json()), { status: 202 });
    }),
  );
});

afterEach(() => {
  feed?.stop();
  feed = null;
  act(() => {
    resetLiveStore();
  });
  queryClient.clear();
  toast.dismiss();
});

/** Renders the page, starts its live feed and accepts the socket, which resyncs on open. */
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

/** Pushes the simulator's running injections, as the backend does after each change. */
function pushInjections(socket: FakeWebSocket): void {
  const template = frames["overlay.injection_active"];
  act(() => {
    socket.message({
      ...template,
      payload: { ...template.payload, active: simulator.status().injections_active },
    });
  });
}

/** Opens a menu from the keyboard (see SimulationPanel.test.tsx for why not by pointer). */
async function openMenu(user: UserEvent, trigger: string): Promise<HTMLElement> {
  act(() => screen.getByRole("button", { name: trigger }).focus());
  await user.keyboard("{Enter}");
  return screen.findByRole("menu");
}

it(
  "plays, jumps to the 5 Jun 2020 air leak, injects oil cooler fouling and clears it",
  async () => {
    const user = userEvent.setup();
    const socket = boot();
    const panel = screen.getByRole("region", { name: "Simulation" });
    await waitFor(() => {
      expect(within(panel).getByTestId(tid.sim.play)).toBeEnabled();
    });
    expect(within(panel).getByTestId(tid.sim.play)).toHaveTextContent("Play");
    expect(within(panel).getByTestId(tid.sim.speed)).toHaveTextContent("600×");

    // 1. Press Play: the acknowledgement says the replay plays, so the button offers Pause.
    await user.click(within(panel).getByRole("button", { name: "Play" }));
    expect(await within(panel).findByRole("button", { name: "Pause" })).toBeEnabled();

    // 2. Jump to the tour's preset, listed among the dataset failures.
    const jumpMenu = await openMenu(user, "Jump to");
    const failures = within(jumpMenu).getByRole("group", { name: "Dataset failures" });
    await user.click(within(failures).getByRole("menuitem", { name: "Air leak – 5 Jun 2020" }));
    expect(await screen.findByText("Jumped to Air leak – 5 Jun 2020")).toBeInTheDocument();

    // 3. Inject oil cooler fouling with the catalog's defaults.
    const injectMenu = await openMenu(user, "Inject fault");
    await user.click(
      within(injectMenu).getByRole("menuitemcheckbox", { name: "Oil cooler fouling" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Inject Oil cooler fouling" });
    await user.click(within(dialog).getByRole("button", { name: "Inject" }));
    expect(await screen.findByText("Injected Oil cooler fouling")).toBeInTheDocument();

    pushInjections(socket);
    const active = within(panel).getByTestId(tid.sim.active);
    expect(active).toHaveTextContent("Oil cooler fouling since 2020-06-05 06:00:00");
    const reopened = await openMenu(user, "Inject fault");
    expect(
      within(reopened).getByRole("menuitemcheckbox", { name: "Oil cooler fouling" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");

    // 4. Clear the injection.
    await user.click(within(panel).getByRole("button", { name: "Clear injections" }));
    expect(await screen.findByText("Injections cleared")).toBeInTheDocument();

    pushInjections(socket);
    expect(within(panel).getByTestId(tid.sim.active)).toHaveTextContent("None running.");
    expect(within(panel).getByTestId(tid.sim.clear)).toBeDisabled();

    expect(simulator.sent).toEqual([
      { path: "/api/sim/play", body: { args: {} } },
      { path: "/api/sim/jump", body: { args: { preset_id: "f3_air_leak_jun05" } } },
      {
        path: "/api/sim/inject",
        body: {
          args: {
            injection_id: "oil_cooler_fouling",
            params: { magnitude: 1, duration_sim_min: 600 },
          },
        },
      },
      { path: "/api/sim/clear", body: { args: {} } },
    ]);
    expect(simulator.status().sim).toMatchObject({
      state: "playing",
      sim_ts: "2020-06-05T06:00:00.000Z",
    });
  },
  TOUR_TIMEOUT_MS,
);
