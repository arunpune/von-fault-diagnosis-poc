// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import DecisionSheet from "@/features/decisions/DecisionSheet";
import { tid } from "@/lib/testids";
import { fixtures } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

const ANSWERED_ID = fixtures.decision.decision_id;
const FAILED_ID = fixtures.decisionFailed.decision_id;
const RULES_REVIEW_ID = "0e5f7a21-9c34-4b6d-81a7-2f3e4d5c6b70";

function renderSheet(decisionId: string | null, onClose = vi.fn()) {
  return {
    onClose,
    ...renderWithProviders(<DecisionSheet decisionId={decisionId} onClose={onClose} />),
  };
}

async function openSheet(decisionId: string, name: string | RegExp): Promise<HTMLElement> {
  renderSheet(decisionId);
  return screen.findByRole("dialog", { name });
}

function section(sheet: HTMLElement, title: string): HTMLElement {
  return within(sheet).getByRole("region", { name: title });
}

/** The sheet's subtitle: the element its `aria-describedby` names. */
function description(sheet: HTMLElement): HTMLElement {
  const element = document.getElementById(sheet.getAttribute("aria-describedby") ?? "");
  if (element === null) {
    throw new Error("the sheet has no description");
  }
  return element;
}

describe("DecisionSheet with an answered decision", () => {
  it("names the chosen cause, its id, severity, gate outcome, backend and sim time", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    expect(sheet).toHaveAttribute("data-testid", tid.decision.sheet);
    expect(within(sheet).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Dryer purge valve not seating",
    );
    const header = description(sheet);
    expect(within(header).getByText("dryer_purge_leak")).toBeInTheDocument();
    expect(within(header).getByText("high")).toHaveAttribute("data-severity", "high");
    expect(within(header).getByText("Ticket")).toBeInTheDocument();
    expect(within(header).getByText("Von · von-1.13.0")).toBeInTheDocument();
    expect(within(header).getByText("2020-06-05 09:41:12 UTC")).toBeInTheDocument();
  });

  it("shows every section in order, each under its own heading", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    expect(
      within(sheet)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Confidence",
      "Candidates",
      "Severity",
      "Evidence",
      "Ticket",
      "Cost",
      "Decision input",
    ]);
    expect(
      within(sheet)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Dryer purge valve not seating",
      "Leak in the distribution network",
      "Air demand above the rated delivery",
      "Minimum-pressure valve fault",
      "Decision input",
      "Close",
    ]);
    for (const button of within(sheet).getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("measures the confidence against the decision's own gate thresholds", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const meter = within(sheet).getByTestId(tid.decision.confidence);
    expect(within(meter).getByRole("progressbar", { name: "Decision confidence" })).toHaveAttribute(
      "aria-valuetext",
      "91 %",
    );
    const ticks = meter.querySelectorAll("[data-threshold]");
    expect(Array.from(ticks, (tick) => tick.getAttribute("title"))).toEqual([
      "Ticket at 85 %",
      "Review at 60 %",
    ]);
    expect(section(sheet, "Confidence")).toHaveTextContent(
      "Ticket at 85 % or more, review queue at 60 % or more.",
    );
  });

  it("lists the candidates most likely first, with manual references, and none of these last", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const rows = within(section(sheet, "Candidates")).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      tid.decision.candidate("dryer_purge_leak"),
      tid.decision.candidate("downstream_air_leak"),
      tid.decision.candidate("high_air_demand"),
      tid.decision.candidate("minimum_pressure_valve_fault"),
      tid.decision.candidate("none_of_these"),
    ]);
    expect(
      rows.map(
        (row) => within(row).getAllByRole("progressbar")[0]?.getAttribute("aria-valuetext") ?? "",
      ),
    ).toEqual(["71 %", "14 %", "7 %", "5 %", "3 %"]);

    const chosen = within(sheet).getByTestId(tid.decision.candidate("dryer_purge_leak"));
    expect(within(chosen).getByText("Chosen")).toBeInTheDocument();
    expect(
      within(chosen).getByText("§8.3 Compressor stays loaded and does not reach cut-out"),
    ).toBeInTheDocument();
    expect(
      within(chosen).getByRole("progressbar", {
        name: "Evidence match of Dryer purge valve not seating",
      }),
    ).toHaveAttribute("aria-valuetext", "88 %");
    const benign = within(sheet).getByTestId(tid.decision.candidate("high_air_demand"));
    expect(within(benign).getByText("benign")).toBeInTheDocument();
  });

  it("sorts candidates by probability whatever order the backend sent them in", async () => {
    const reversed = structuredClone(fixtures.decision);
    reversed.candidates.reverse();
    server.use(http.get("/api/decisions/:id", () => HttpResponse.json(reversed)));
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const rows = within(section(sheet, "Candidates")).getAllByRole("listitem");
    expect(rows[0]?.dataset.testid).toBe(tid.decision.candidate("dryer_purge_leak"));
    expect(rows.at(-1)?.dataset.testid).toBe(tid.decision.candidate("none_of_these"));
  });

  it("expands a candidate into its catalog entry, loaded on first open", async () => {
    const user = userEvent.setup();
    let catalogRequests = 0;
    server.use(
      http.get("/api/catalog/faults/:faultId", () => {
        catalogRequests += 1;
        return HttpResponse.json(fixtures.catalogFault);
      }),
    );
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");
    expect(catalogRequests).toBe(0);

    const trigger = within(sheet).getByRole("button", { name: "Leak in the distribution network" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);

    const row = within(sheet).getByTestId(tid.decision.candidate("downstream_air_leak"));
    expect(await within(row).findByText(/^Air escapes from the pipework/)).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByRole("heading", { name: "Expected signal movements" })).toBeVisible();
    expect(
      within(row).getByText("How often the compressor loads per hour is gradually higher."),
    ).toBeInTheDocument();
    const checks = within(row).getByRole("heading", { name: "Checks" }).nextElementSibling;
    expect(checks?.tagName).toBe("OL");
    expect(within(checks as HTMLElement).getAllByRole("listitem")).toHaveLength(4);
    expect(within(row).getByText(/^Seal or replace the leaking joints/)).toBeInTheDocument();

    await user.click(trigger);
    await user.click(trigger);
    expect(within(row).getByText(/^Air escapes from the pipework/)).toBeInTheDocument();
    expect(catalogRequests).toBe(1);
  });

  it("says so when a candidate is not in the catalog", async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    await user.click(within(sheet).getByRole("button", { name: "Minimum-pressure valve fault" }));

    expect(await within(sheet).findByText("This cause is not in the catalog.")).toBeInTheDocument();
  });

  it("shows the severity level, its four-segment score, confidence and level probabilities", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const severity = within(sheet).getByTestId(tid.decision.severity);
    expect(within(severity).getByText("high")).toHaveAttribute("data-severity", "high");
    const meter = within(severity).getByRole("img", { name: "Severity score 2 of 3" });
    expect(meter.children).toHaveLength(4);
    expect(Array.from(meter.children, (segment) => segment.hasAttribute("style"))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(severity).toHaveTextContent("Confidence 74 %");
    const levels = within(severity).getByRole("list", {
      name: "Probability of each severity level",
    });
    expect(
      within(levels)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["low 2 %", "medium 11 %", "high 74 %", "critical 13 %"]);
  });

  it("builds the evidence from the suspect event the decision answered", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const evidence = section(sheet, "Evidence");
    const table = await within(evidence).findByRole("table", {
      name: "Evidence of the suspect event",
    });
    expect(
      within(table).getByText(
        "The unit has been loaded without reaching cut-out for about an hour.",
      ),
    ).toBeInTheDocument();
    expect(await within(table).findByText("Dryer purge pressure")).toBeInTheDocument();
    expect(evidence).toHaveTextContent(
      "Machine loaded; observed over 1 h up to 2020-06-05 09:41:12.",
    );
    expect(within(evidence).getByText("stuck_loaded")).toBeInTheDocument();
    expect(within(evidence).getByText("purge_pressure_high")).toBeInTheDocument();
    expect(within(evidence).getByText("W102")).toBeInTheDocument();
    expect(within(evidence).getByText("W103")).toBeInTheDocument();
  });

  it("links the ticket of the decision's episode", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const link = await within(sheet).findByRole("link", { name: "Ticket #8d7e60" });
    expect(link).toHaveAttribute("data-testid", tid.decision.ticketLink);
    expect(link).toHaveAttribute("href", "#/tickets/2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60");
    expect(section(sheet, "Ticket")).toHaveTextContent("Open, confidence 91 %");
  });

  it("gives the tokens, the cost, the prices with their date and the latency", async () => {
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const cost = section(sheet, "Cost");
    expect(within(cost).getByText("1,834 in, 0 out")).toBeInTheDocument();
    expect(within(cost).getByText("$0.000077")).toBeInTheDocument();
    expect(
      within(cost).getByText("$0.042 per MTok input, output free, prices as of 2026-09-19"),
    ).toBeInTheDocument();
    expect(within(cost).getByText("1.24 s")).toBeInTheDocument();
  });

  it("keeps the decision input closed until asked, then shows what the model saw", async () => {
    const user = userEvent.setup();
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    const input = within(sheet).getByTestId(tid.decision.input);
    expect(
      within(input).queryByText("This is what the decision model saw."),
    ).not.toBeInTheDocument();
    await user.click(within(input).getByRole("button", { name: "Decision input" }));

    expect(within(input).getByText("This is what the decision model saw.")).toBeVisible();
    expect(input.querySelector("pre")?.textContent).toContain('"controller_alarms": [');
  });

  it("closes through its named Close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet(ANSWERED_ID);
    const sheet = await screen.findByRole("dialog", { name: "Dryer purge valve not seating" });

    await user.click(within(sheet).getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("DecisionSheet with other decisions", () => {
  it("hides the input section when the backend returned no state, and says Rules", async () => {
    const sheet = await openSheet(RULES_REVIEW_ID, "Leak in the distribution network");

    expect(within(sheet).queryByTestId(tid.decision.input)).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole("heading", { name: "Decision input" }),
    ).not.toBeInTheDocument();
    expect(within(sheet).getByText("Rules")).toBeInTheDocument();
    expect(within(sheet).getByText("Review")).toBeInTheDocument();
    expect(section(sheet, "Cost")).toHaveTextContent("Rules backend: no model call, no cost.");
    expect(await within(sheet).findByRole("link", { name: "Ticket #8d9e01" })).toBeInTheDocument();
  });

  it("renders a failed decision with its error and without candidates or severity", async () => {
    const sheet = await openSheet(FAILED_ID, "Decision failed");

    const alert = within(sheet).getByRole("alert");
    expect(alert).toHaveTextContent("The decision backend failed: timeout");
    expect(alert).toHaveTextContent("The decision backend did not answer within 10 s.");
    expect(within(sheet).getByText("Logged")).toBeInTheDocument();
    expect(
      within(sheet)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Evidence", "Ticket", "Cost"]);
    expect(within(sheet).queryByTestId(tid.decision.severity)).not.toBeInTheDocument();
    expect(section(sheet, "Cost")).toHaveTextContent("10.01 s");
  });

  it("names the gate's note when no ticket of the episode is loaded", async () => {
    server.use(http.get("/api/tickets", () => HttpResponse.json({ items: [], next_cursor: null })));
    const sheet = await openSheet(RULES_REVIEW_ID, "Leak in the distribution network");

    expect(
      await within(section(sheet, "Ticket")).findByText("In review queue"),
    ).toBeInTheDocument();
    expect(within(sheet).queryByTestId(tid.decision.ticketLink)).not.toBeInTheDocument();
  });

  it("says the evidence is not loaded when the suspect event is not in the cache", async () => {
    server.use(
      http.get("/api/events/suspect", () => HttpResponse.json({ items: [], next_cursor: null })),
    );
    const sheet = await openSheet(ANSWERED_ID, "Dryer purge valve not seating");

    expect(
      await within(section(sheet, "Evidence")).findByText(/^Evidence not loaded/),
    ).toBeInTheDocument();
  });

  it("titles itself Decision with the id while loading and when the id is unknown", async () => {
    const sheet = await openSheet("dec-unknown", "Decision");

    expect(within(sheet).getByText("dec-unknown")).toBeInTheDocument();
    expect(await within(sheet).findByText(/^No decision has this id/)).toBeInTheDocument();
  });

  it("offers a retry when the decision fails to load", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(
        "/api/decisions/:id",
        () => apiError(503, "upstream_unavailable", "Database down."),
        {
          once: true,
        },
      ),
    );
    const sheet = await openSheet(ANSWERED_ID, "Decision");

    expect(await within(sheet).findByText("Couldn't load the decision.")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Dryer purge valve not seating" }),
      ).toBeInTheDocument();
    });
  });

  it("renders nothing while no decision is routed", () => {
    renderSheet(null);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
