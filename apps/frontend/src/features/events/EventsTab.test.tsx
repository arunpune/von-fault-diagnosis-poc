// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Events tab over the msw fixtures: three suspect events of the 5 Jun 2020 air leak story,
// each decided once (the newest by a failed call). A test that needs an undecided event removes
// its decision from the decisions list the mock backend answers.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiDecisions, ApiEvents } from "@/api/types";
import EventsTab from "@/features/events/EventsTab";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

const [NEWEST, AIR_LEAK, CYCLING] = fixtures.events.items;
if (NEWEST === undefined || AIR_LEAK === undefined || CYCLING === undefined) {
  throw new Error("events.json holds three suspect events");
}

/** The decisions list without the decision of `eventId`, so that event is undecided. */
function decisionsWithout(eventId: string): ApiDecisions {
  return {
    items: fixtures.decisions.items.filter((decision) => decision.event_id !== eventId),
    next_cursor: null,
  };
}

function answerDecisions(body: ApiDecisions): void {
  server.use(http.get("/api/decisions", () => HttpResponse.json(body)));
}

function answerEvents(body: ApiEvents): void {
  server.use(http.get("/api/events/suspect", () => HttpResponse.json(body)));
}

async function findRow(eventId: string): Promise<HTMLElement> {
  return screen.findByTestId(`event-row-${eventId}`);
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("EventsTab", () => {
  it("lists every suspect event, newest first, with its symptom, rules, state and readings", async () => {
    renderWithProviders(<EventsTab />);

    const table = await screen.findByRole("table", { name: "Suspect events, newest first" });
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => row.dataset.testid !== undefined);
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      `event-row-${NEWEST.event_id}`,
      `event-row-${AIR_LEAK.event_id}`,
      `event-row-${CYCLING.event_id}`,
    ]);

    const cycling = within(await findRow(CYCLING.event_id)).getAllByRole("cell");
    expect(cycling.map((cell) => cell.textContent)).toEqual([
      "2020-05-22 04:15:00",
      "Frequent cycling",
      "frequent_cyclinglong_loaded_runsfast_decay",
      "Unloaded",
      "5",
      expect.any(String),
    ]);
    const rules = cycling[2]?.querySelectorAll("code") ?? [];
    expect([...rules].map((code) => code.textContent)).toEqual([
      "frequent_cycling",
      "long_loaded_runs",
      "fast_decay",
    ]);
  });

  it("opens the latest decision on the event when its row is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EventsTab />);

    const row = await findRow(AIR_LEAK.event_id);
    const link = await within(row).findByRole("link", { name: "Open decision 4a5b60" });
    expect(link).toHaveAttribute("href", "#/decisions/6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60");

    await user.click(within(row).getByText("Continuous load"));

    expect(window.location.hash).toBe("#/decisions/6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60");
  });

  it("opens the newest of several decisions made on one event", async () => {
    const user = userEvent.setup();
    const [failed, answered] = fixtures.decisions.items;
    if (failed === undefined || answered === undefined) {
      throw new Error("decisions.json holds a failed and an answered decision");
    }
    // A re-decision of the air-leak event, made after the answered one.
    const redecision = {
      ...answered,
      decision_id: "5f4e3d2c-1b0a-4987-8654-3210fedcba98",
      wall_ts: "2026-06-05T09:50:00.000Z",
    };
    answerDecisions({ items: [failed, answered, redecision], next_cursor: null });
    renderWithProviders(<EventsTab />);

    const row = await findRow(AIR_LEAK.event_id);
    await within(row).findByRole("link", { name: "Open decision dcba98" });
    await user.click(within(row).getByText("Loaded"));

    expect(window.location.hash).toBe(`#/decisions/${redecision.decision_id}`);
  });

  it("expands the evidence of an event nobody decided yet", async () => {
    const user = userEvent.setup();
    answerDecisions(decisionsWithout(CYCLING.event_id));
    renderWithProviders(<EventsTab />);

    const row = await findRow(CYCLING.event_id);
    const toggle = await within(row).findByRole("button", { name: "Evidence" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: /^Evidence of/ })).not.toBeInTheDocument();

    await user.click(within(row).getByText("Frequent cycling"));

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const evidence = await screen.findByRole("table", {
      name: "Evidence of the suspect event at 2020-05-22 04:15:00",
    });
    const statements = CYCLING.evidence.map((item) => item.observation);
    for (const statement of statements) {
      expect(within(evidence).getByText(statement)).toBeInTheDocument();
    }
    expect(window.location.hash).toBe("");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => {
      expect(screen.queryByRole("table", { name: /^Evidence of/ })).not.toBeInTheDocument();
    });
  });

  it("labels the evidence with the signal registry's names", async () => {
    const user = userEvent.setup();
    const signals = structuredClone(fixtures.signals);
    signals.signals = signals.signals.map((signal) =>
      signal.signal_id === "line_pressure"
        ? { ...signal, label: "Delivery line pressure" }
        : signal,
    );
    server.use(http.get("/api/signals", () => HttpResponse.json(signals)));
    answerDecisions(decisionsWithout(AIR_LEAK.event_id));
    renderWithProviders(<EventsTab />);

    const row = await findRow(AIR_LEAK.event_id);
    await user.click(await within(row).findByRole("button", { name: "Evidence" }));

    const evidence = await screen.findByRole("table", { name: /^Evidence of/ });
    expect(await within(evidence).findByText("Delivery line pressure")).toBeInTheDocument();
    // A derived behaviour is not in the registry and reads as its humanised id.
    expect(within(evidence).getByText("Loaded run duration")).toBeInTheDocument();
  });

  it("shows skeleton rows while the events load", () => {
    renderWithProviders(<EventsTab />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading suspect events");
  });

  it("says what failed and retries on request", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/events/suspect", () => apiError(503, "db_unavailable", "Database is down.")),
    );
    renderWithProviders(<EventsTab />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load suspect events.");
    expect(alert).toHaveTextContent("Database is down.");

    server.resetHandlers();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("table", { name: "Suspect events, newest first" }),
    ).toBeInTheDocument();
  });

  it("says so when detection has not raised an event yet", async () => {
    answerEvents({ items: [], next_cursor: null });
    renderWithProviders(<EventsTab />);

    expect(await screen.findByText("No suspect events yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
