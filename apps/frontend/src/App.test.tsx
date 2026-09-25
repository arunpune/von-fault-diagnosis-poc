// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "@/App";
import { LazyCostTab, LazyEventsTab, LazyReviewTab } from "@/components/app-shell/lazy-panels";
import { reloadUiPrefs } from "@/store/ui-prefs";
import { renderWithProviders } from "@/test/render";

beforeEach(() => {
  window.localStorage.clear();
  reloadUiPrefs();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function openRoute(hash: string): void {
  act(() => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("App shell", () => {
  it("renders the status bar, the three panels and the bottom tabs", () => {
    renderWithProviders(<App />);

    const statusBar = screen.getByRole("banner");
    expect(within(statusBar).getByText("CAU-7 compressed-air unit")).toBeInTheDocument();
    expect(within(statusBar).getByTestId("status-clock")).toBeInTheDocument();
    expect(within(statusBar).getByRole("button", { name: /^Theme: / })).toBeInTheDocument();

    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("region", { name: "Recorder" }),
    );
    const rail = screen.getByRole("complementary", { name: "Simulation and alerts" });
    expect(within(rail).getByRole("region", { name: "Simulation" })).toBeInTheDocument();
    expect(within(rail).getByRole("region", { name: "Alerts" })).toBeInTheDocument();
    expect(screen.getByText("Press Play to start the replay.")).toBeInTheDocument();

    const tabs = screen.getByRole("tablist", { name: "Records" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Tickets", "Review", "Events", "Cost"]);
    expect(screen.getByRole("tab", { name: /^Tickets/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("radiogroup", { name: "Ticket status" })).toBeInTheDocument();
  });

  it("carries the tab test ids of the registry in src/lib/testids.ts", () => {
    renderWithProviders(<App />);

    for (const name of ["tickets", "review", "events", "cost"]) {
      expect(screen.getByTestId(`tab-${name}`)).toHaveAttribute("role", "tab");
    }
  });

  it("loads a lazy tab when it is selected", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("tab", { name: /^Review/ }));
    expect(await screen.findByRole("table", { name: "Review queue" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Events/ }));
    expect(
      await screen.findByRole("table", { name: "Suspect events, newest first" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /^Cost/ }));
    expect(await screen.findByTestId("cost-total")).toHaveTextContent("$0.031841");
  });

  it("preloads a lazy tab's chunk on hover and on focus of its trigger", async () => {
    const user = userEvent.setup();
    const preloadReview = vi.spyOn(LazyReviewTab, "preload");
    const preloadEvents = vi.spyOn(LazyEventsTab, "preload");
    const preloadCost = vi.spyOn(LazyCostTab, "preload");
    renderWithProviders(<App />);

    await user.hover(screen.getByRole("tab", { name: /^Review/ }));
    act(() => screen.getByRole("tab", { name: /^Cost/ }).focus());

    expect(preloadReview).toHaveBeenCalled();
    expect(preloadCost).toHaveBeenCalled();
    expect(preloadEvents).not.toHaveBeenCalled();
  });

  it("shows no count badge while the counts are not loaded", () => {
    renderWithProviders(<App />);

    expect(screen.getByRole("tab", { name: /^Tickets/ })).toHaveTextContent(/^Tickets$/);
  });

  it("shows the open, review, event and cost counts once they are loaded", async () => {
    renderWithProviders(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("tab-cost")).toHaveTextContent("Cost$0.031841");
    });
    expect(screen.getByTestId("tab-tickets")).toHaveTextContent("Tickets1");
    expect(screen.getByTestId("tab-review")).toHaveTextContent("Review1");
    expect(screen.getByTestId("tab-events")).toHaveTextContent("Events3");
  });
});

describe("sheet routes", () => {
  it("opens the decision sheet from a deep link and clears the hash on close", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "#/decisions/dec-7f3a91");
    renderWithProviders(<App />);

    const sheet = await screen.findByRole("dialog", { name: "Decision" });
    expect(within(sheet).getByText("dec-7f3a91")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Close" }));

    expect(window.location.hash).toBe("");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("opens the ticket sheet when the hash changes", async () => {
    renderWithProviders(<App />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openRoute("#/tickets/tkt-000012");

    const sheet = await screen.findByRole("dialog", { name: "Ticket" });
    expect(within(sheet).getByText("tkt-000012")).toBeInTheDocument();
    expect(await within(sheet).findByText("Couldn't load ticket #000012.")).toBeInTheDocument();
  });
});
