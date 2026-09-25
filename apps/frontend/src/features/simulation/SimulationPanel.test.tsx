// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The simulation panel against the msw backend: each control posts the documented `{ args }`
// body to its route, reads the acknowledged status back, and says what went wrong in one
// sentence. Requests are recorded by a pass-through handler that answers nothing, so the fixture
// handler still acknowledges every command.

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ApiSimCommandResult,
  ApiStatus,
  ControlError,
  RunningInstance,
  StatusSim,
} from "@/api/types";
import SimulationPanel from "@/features/simulation/SimulationPanel";
import { tid } from "@/lib/testids";
import { applyStatusSnapshot, resetLiveStore, setLinkState } from "@/store/live-store";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

interface SentCommand {
  path: string;
  body: unknown;
}

/** Records every simulator command and lets the fixture handler answer it. */
function recordCommands(): SentCommand[] {
  const sent: SentCommand[] = [];
  server.use(
    http.post("/api/sim/:cmd", async ({ request }) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
    }),
  );
  return sent;
}

function simStatus(): StatusSim {
  if (fixtures.status.sim === null) {
    throw new Error("status.json carries a sim status");
  }
  return fixtures.status.sim;
}

/**
 * Puts the fixture status, with the given replay state and injections, into the live store and
 * opens the link: what the live feed does on every (re)connect.
 */
function seedStatus(sim: Partial<StatusSim>, injections: readonly RunningInstance[]): void {
  const status: ApiStatus = {
    ...fixtures.status,
    sim: { ...simStatus(), ...sim },
    injections_active: [...injections],
  };
  act(() => {
    applyStatusSnapshot(status);
    setLinkState("open");
  });
}

/** A 202 whose acknowledgement refuses every command with `error`. */
function refuseWith(error: ControlError): void {
  const result: ApiSimCommandResult = structuredClone(fixtures.simCommandResult);
  if (result.ack === null) {
    throw new Error("sim-command-result.json carries an ack");
  }
  result.ack = { ...result.ack, ok: false, error };
  server.use(http.post("/api/sim/:cmd", () => HttpResponse.json(result, { status: 202 })));
}

/**
 * Renders the panel over an open link and the fixture status (changed by `sim` and
 * `injections`), and waits until the catalog is in.
 */
async function renderPanel(
  sim: Partial<StatusSim> = {},
  injections: readonly RunningInstance[] = fixtures.status.injections_active,
) {
  const user = userEvent.setup();
  const view = renderWithProviders(<SimulationPanel />);
  seedStatus(sim, injections);
  await waitFor(() => {
    expect(screen.getByTestId(tid.sim.play)).toBeEnabled();
  });
  await screen.findByRole("button", { name: "Jump to" });
  return { user, ...view };
}

/**
 * Opens a dropdown menu from its trigger with the keyboard, a path that must keep working, and
 * returns it. Radix opens menus on pointerdown; under jsdom a pointer-opened menu closes again
 * in the same act() flush once an earlier test in the file clicked anything, so the menus are
 * opened by key here and their items chosen by click or key.
 */
async function openMenu(user: UserEvent, trigger: string): Promise<HTMLElement> {
  act(() => screen.getByRole("button", { name: trigger }).focus());
  await user.keyboard("{Enter}");
  return screen.findByRole("menu");
}

async function expectToast(text: string): Promise<void> {
  expect(await screen.findByText(text)).toBeInTheDocument();
}

beforeEach(() => {
  resetLiveStore();
});

afterEach(() => {
  resetLiveStore();
  // Sonner keeps its toasts in module state and replays the active ones to the next Toaster.
  toast.dismiss();
});

describe("play and pause", () => {
  it("posts play with empty args and turns into Pause from the acknowledged status", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel({ state: "paused" });

    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(await screen.findByRole("button", { name: "Pause" })).toBeEnabled();
    expect(sent).toEqual([{ path: "/api/sim/play", body: { args: {} } }]);

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("button", { name: "Play" })).toBeEnabled();
    expect(sent.at(-1)).toEqual({ path: "/api/sim/pause", body: { args: {} } });
  });

  it("reads Play while the replay is stopped", async () => {
    await renderPanel({ state: "stopped" });

    expect(screen.getByTestId(tid.sim.play)).toHaveTextContent("Play");
  });

  it("rests while its command is in flight", async () => {
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post("/api/sim/:cmd", async () => {
        await answered;
      }),
    );
    const { user } = await renderPanel();
    const button = screen.getByTestId(tid.sim.play);

    await user.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(button).toHaveAttribute("aria-busy", "true");

    act(() => release());

    await waitFor(() => {
      expect(screen.getByTestId(tid.sim.play)).toBeEnabled();
    });
  });

  it("rests while the link is down and says why", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SimulationPanel />);
    act(() => setLinkState("reconnecting"));
    const button = screen.getByTestId(tid.sim.play);

    expect(button).toBeDisabled();
    await user.tab();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Waiting for the backend");
    expect(button).toBeDisabled();
  });
});

/**
 * jsdom lays nothing out and has no pointer capture; Radix's slider needs both to turn a pointer
 * position into a value. The track gets a width and the capture is kept per element.
 */
function stubPointerGeometry(track: HTMLElement, width: number): void {
  const captured = new Set<number>();
  track.getBoundingClientRect = () => new DOMRect(0, 0, width, 12);
  track.setPointerCapture = (pointerId: number) => {
    captured.add(pointerId);
  };
  track.hasPointerCapture = (pointerId: number) => captured.has(pointerId);
  track.releasePointerCapture = (pointerId: number) => {
    captured.delete(pointerId);
  };
}

describe("speed", () => {
  it("shows the simulator's speed", async () => {
    await renderPanel();

    const slider = screen.getByRole("slider", { name: "Speed" });
    expect(slider).toHaveAttribute("aria-valuetext", "600×");
    expect(screen.getByTestId(tid.sim.speed)).toHaveTextContent("600×");
  });

  it("posts one speed command per key press, with the step's speed", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();

    act(() => screen.getByRole("slider", { name: "Speed" }).focus());
    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(sent).toEqual([{ path: "/api/sim/speed", body: { args: { speed: 1200 } } }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId(tid.sim.speed)).toHaveTextContent("1,200×");
    });

    await user.keyboard("{End}");

    await waitFor(() => {
      expect(sent.at(-1)).toEqual({ path: "/api/sim/speed", body: { args: { speed: 3600 } } });
    });
    expect(sent).toHaveLength(2);
  });

  it("sends nothing while the thumb is dragged and one command when it is let go", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();
    const track = screen
      .getByRole("slider", { name: "Speed" })
      .closest<HTMLElement>("[data-slot=slider]");
    if (track === null) {
      throw new Error("the speed slider has a root");
    }
    stubPointerGeometry(track, 110);

    // Eleven intervals of 10 px: x = 40 is position 4 (30×), x = 105 the last (3600×).
    await user.pointer({ keys: "[MouseLeft>]", target: track, coords: { clientX: 40 } });
    expect(screen.getByTestId(tid.sim.speed)).toHaveTextContent("30×");
    await user.pointer({ target: track, coords: { clientX: 105 } });

    expect(screen.getByTestId(tid.sim.speed)).toHaveTextContent("3,600×");
    expect(sent).toEqual([]);

    await user.pointer({ keys: "[/MouseLeft]", target: track, coords: { clientX: 105 } });

    await waitFor(() => {
      expect(sent).toEqual([{ path: "/api/sim/speed", body: { args: { speed: 3600 } } }]);
    });
  });

  it("returns to the simulator's speed when the command fails", async () => {
    server.use(http.post("/api/sim/:cmd", () => HttpResponse.error()));
    const { user } = await renderPanel();

    act(() => screen.getByRole("slider", { name: "Speed" }).focus());
    await user.keyboard("{Home}");

    await expectToast("Backend unavailable");
    expect(screen.getByTestId(tid.sim.speed)).toHaveTextContent("600×");
  });
});

describe("jump to", () => {
  it("lists the presets by section with the README label, selectable by role and test id", async () => {
    const { user } = await renderPanel();

    const menu = await openMenu(user, "Jump to");

    const failures = within(menu).getByRole("group", { name: "Dataset failures" });
    const diagnostic = within(menu).getByRole("group", { name: "Diagnostic" });
    const item = within(failures).getByRole("menuitem", { name: "Air leak – 5 Jun 2020" });
    expect(item).toBe(screen.getByTestId(tid.sim.jumpItem("f3_air_leak_jun05")));
    expect(item).toHaveAttribute("data-preset-id", "f3_air_leak_jun05");
    expect(item).toHaveAccessibleDescription("2020-06-05 10:00:00");
    expect(
      within(failures)
        .getAllByRole("menuitem")
        .map((entry) => entry.getAttribute("data-preset-id")),
    ).toEqual([
      "f1_air_leak_apr18",
      "f2_air_leak_may30",
      "f3_air_leak_jun05",
      "f4_precursor_jul14",
      "f4_air_leak_jul15",
    ]);
    expect(
      within(diagnostic).getByRole("menuitem", { name: "Normal operation – 1 Feb 2020" }),
    ).toBeInTheDocument();
    expect(within(diagnostic).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("posts the preset id and says where it jumped", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();

    await openMenu(user, "Jump to");
    await user.click(screen.getByTestId(tid.sim.jumpItem("f3_air_leak_jun05")));

    await expectToast("Jumped to Air leak – 5 Jun 2020");
    expect(sent).toEqual([
      { path: "/api/sim/jump", body: { args: { preset_id: "f3_air_leak_jun05" } } },
    ]);
  });

  it("is chosen from with the keyboard alone", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();

    await openMenu(user, "Jump to");
    // The first item takes the focus; the next one is the second failure.
    await user.keyboard("{ArrowDown}{Enter}");

    await expectToast("Jumped to Air leak – 30 May 2020");
    expect(sent).toEqual([
      { path: "/api/sim/jump", body: { args: { preset_id: "f2_air_leak_may30" } } },
    ]);
  });
});

describe("inject fault", () => {
  it("lists the catalog's injections, running ones checked and disabled", async () => {
    const { user } = await renderPanel();

    const menu = await openMenu(user, "Inject fault");

    const running = within(menu).getByRole("menuitemcheckbox", { name: "Oil cooler fouling" });
    expect(running).toBe(screen.getByTestId(tid.sim.injectItem("oil_cooler_fouling")));
    expect(running).toHaveAttribute("data-injection-id", "oil_cooler_fouling");
    expect(running).toHaveAttribute("aria-checked", "true");
    expect(running).toHaveAttribute("aria-disabled", "true");
    expect(running).toHaveAccessibleDescription(/oil_cooler_fouled/);

    const benign = within(menu).getByRole("menuitemcheckbox", {
      name: "High ambient temperature",
    });
    expect(benign).toHaveAttribute("aria-checked", "false");
    expect(benign).toHaveAccessibleDescription(/benign/);
    expect(within(menu).getAllByRole("menuitemcheckbox")).toHaveLength(
      fixtures.overlayCatalog.injections.length,
    );
  });

  it("injects with the catalog's defaults from the parameter dialog", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel({}, []);

    const menu = await openMenu(user, "Inject fault");
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Oil cooler fouling" }));

    const dialog = await screen.findByRole("dialog", { name: "Inject Oil cooler fouling" });
    expect(within(dialog).getByRole("slider", { name: "Magnitude" })).toHaveAttribute(
      "aria-valuetext",
      "1.00",
    );
    expect(within(dialog).getByRole("slider", { name: "Duration in sim time" })).toHaveAttribute(
      "aria-valuetext",
      "10 h",
    );
    await user.click(within(dialog).getByRole("button", { name: "Inject" }));

    await expectToast("Injected Oil cooler fouling");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sent).toEqual([
      {
        path: "/api/sim/inject",
        body: {
          args: {
            injection_id: "oil_cooler_fouling",
            params: { magnitude: 1, duration_sim_min: 600 },
          },
        },
      },
    ]);
  });

  it("sends the magnitude and the duration set in the dialog, all from the keyboard", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel({}, []);

    await openMenu(user, "Inject fault");
    // Oil cooler fouling is the first entry, and it has the focus.
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Inject Oil cooler fouling" });

    const magnitude = within(dialog).getByRole("slider", { name: "Magnitude" });
    act(() => magnitude.focus());
    await user.keyboard("{ArrowRight>10/}");
    expect(magnitude).toHaveAttribute("aria-valuetext", "1.50");
    await user.tab();
    expect(within(dialog).getByRole("slider", { name: "Duration in sim time" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    await user.tab();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Inject" })).toHaveFocus();
    await user.keyboard("{Enter}");

    await expectToast("Injected Oil cooler fouling");
    expect(sent).toEqual([
      {
        path: "/api/sim/inject",
        body: {
          args: {
            injection_id: "oil_cooler_fouling",
            params: { magnitude: 1.5, duration_sim_min: 720 },
          },
        },
      },
    ]);
  });

  it("sends nothing when the dialog is cancelled", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel({}, []);

    const menu = await openMenu(user, "Inject fault");
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Motor overload" }));
    const dialog = await screen.findByRole("dialog", { name: "Inject Motor overload" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual([]);
  });
});

describe("active injections and clear", () => {
  it("shows each running injection by its label since it started", async () => {
    await renderPanel();

    const list = await within(screen.getByTestId(tid.sim.active)).findByRole("list", {
      name: "Injected faults",
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Oil cooler fouling since 2020-06-05 08:00:00"]);
  });

  it("clears them with empty args", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();

    await user.click(screen.getByRole("button", { name: "Clear injections" }));

    await expectToast("Injections cleared");
    expect(sent).toEqual([{ path: "/api/sim/clear", body: { args: {} } }]);
  });

  it("rests while none runs", async () => {
    await renderPanel({}, []);

    expect(screen.getByTestId(tid.sim.active)).toHaveTextContent("None running.");
    expect(screen.getByTestId(tid.sim.clear)).toBeDisabled();
  });
});

describe("reset replay", () => {
  it("asks first, sends nothing on cancel and resets on confirmation", async () => {
    const sent = recordCommands();
    const { user } = await renderPanel();

    await user.click(screen.getByTestId(tid.sim.reset));
    let dialog = await screen.findByRole("dialog", { name: "Reset replay" });
    expect(dialog).toHaveAccessibleDescription(
      "Reset the replay to the start of the dataset? Open episodes are aborted.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Reset replay" }));
    dialog = await screen.findByRole("dialog", { name: "Reset replay" });
    await user.click(within(dialog).getByRole("button", { name: "Reset replay" }));

    await expectToast("Replay reset");
    expect(sent).toEqual([{ path: "/api/sim/reset", body: { args: {} } }]);
  });
});

describe("failures", () => {
  // Every code of `control-ack.error`, typed so a code added to the contract is a compile error.
  const refusals: readonly [ControlError["code"], string, string][] = [
    ["unknown_cmd", "No such command: rewind.", "No such command: rewind."],
    ["bad_args", "magnitude out of bounds", "The simulator rejected the parameters"],
    ["unknown_preset", "no preset x", "That preset is not in the catalog"],
    ["unknown_injection", "no injection x", "That fault is not in the catalog"],
    ["out_of_range", "before the first row", "That time is outside the replayed data"],
    ["speed_out_of_range", "speed 0", "The simulator runs between 1× and 3,600×"],
    ["not_ready", "indexing", "The simulator is still starting"],
    ["internal", "Replay cursor lost.", "Replay cursor lost."],
  ];

  it.each(refusals)("says a %s refusal in one sentence", async (code, message, sentence) => {
    refuseWith({ code, message });
    const { user } = await renderPanel();

    await user.click(screen.getByRole("button", { name: "Pause" }));

    await expectToast(sentence);
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
  });

  it("says the simulator did not answer when the proxy gave up (504)", async () => {
    server.use(http.post("/api/sim/:cmd", () => new HttpResponse(null, { status: 504 })));
    const { user } = await renderPanel();

    await user.click(screen.getByRole("button", { name: "Pause" }));

    await expectToast("The simulator did not answer in time");
  });

  it("says the backend is unavailable when nothing answers", async () => {
    server.use(http.post("/api/sim/:cmd", () => HttpResponse.error()));
    const { user } = await renderPanel();

    const menu = await openMenu(user, "Jump to");
    await user.click(within(menu).getByRole("menuitem", { name: "Air leak – 5 Jun 2020" }));

    await expectToast("Backend unavailable");
  });
});

describe("the catalog", () => {
  it("holds the menus' places while it loads", async () => {
    server.use(
      http.get("/api/overlay/catalog", async () => {
        await delay("infinite");
      }),
    );
    renderWithProviders(<SimulationPanel />);

    expect(await screen.findByRole("status")).toHaveTextContent("Loading the presets and faults");
    expect(screen.queryByRole("button", { name: "Jump to" })).not.toBeInTheDocument();
  });

  it("offers a retry when it failed to load, and shows the menus once it loads", async () => {
    server.use(
      http.get(
        "/api/overlay/catalog",
        () => apiError(404, "not_found", "no catalog published yet"),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<SimulationPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the presets and faults.");
    expect(alert).toHaveTextContent("no catalog published yet");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Jump to" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inject fault" })).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("names every control, the dialogs' icon buttons included", async () => {
    const { user } = await renderPanel();

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    await user.click(screen.getByRole("button", { name: "Reset replay" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset replay" });
    for (const button of within(dialog).getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
