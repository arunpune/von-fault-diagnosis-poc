// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Cost tab over the msw fixtures (cost.json: 41 billed calls, a Jev and a language-model
// row in `recent`; decisions.json: the same Jev decision, a rules decision and a failed call),
// plus the live path: two `decision` frames and a `cost.update` frame go through the page's own
// cache reducers (`installWsCache`) and the tab follows.

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiCost, ApiDecisions, ApiStatus } from "@/api/types";
import { installWsCache } from "@/api/ws-cache";
import { dispatchFrame } from "@/api/ws-dispatch";
import type { FrameOf } from "@/api/ws-types";
import CostTab from "@/features/cost/CostTab";
import { applyStatusSnapshot, resetLiveStore } from "@/store/live-store";
import { fixtures, frames } from "@/test/msw/fixtures";
import { apiError } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/render";

const JEV_DECISION = "6a0c8e37-2b41-4f9d-8c05-1d2e3f4a5b60";
const LLM_DECISION = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const RULES_DECISION = "0e5f7a21-9c34-4b6d-81a7-2f3e4d5c6b70";
const FAILED_DECISION = "7e2a9c05-4d18-4b73-9e60-3a4b5c6d7e80";

const NOTHING_BILLED: ApiCost = {
  totals: { usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 },
  by_backend: {},
  by_day: [],
  prices: {
    jev_input_per_mtok: 0.042,
    llm_input_per_mtok: null,
    llm_output_per_mtok: null,
    as_of: "2026-09-19",
  },
  recent: [],
};

const NO_DECISIONS: ApiDecisions = { items: [], next_cursor: null };

function answerCost(body: ApiCost): void {
  server.use(http.get("/api/cost", () => HttpResponse.json(body)));
}

function answerDecisions(body: ApiDecisions): void {
  server.use(http.get("/api/decisions", () => HttpResponse.json(body)));
}

/** The fixture status with `name` as the active decision backend. */
function statusWithBackend(name: "jev" | "llm" | "rules", model: string): ApiStatus {
  const status: ApiStatus = structuredClone(fixtures.status);
  if (status.backend === null) {
    throw new Error("status.json carries a backend status");
  }
  status.backend.backend = { name, model };
  return status;
}

function cellTexts(row: HTMLElement): (string | null)[] {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

/**
 * Gives every element a size, so the chart's ResponsiveContainer lays the chart out in jsdom
 * (which has no layout) instead of warning about a zero-sized container.
 */
function giveElementsASize(): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 112, width: 640, height: 112 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    toJSON: () => rect,
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(112);
}

beforeEach(() => {
  resetLiveStore();
  giveElementsASize();
});

afterEach(() => {
  resetLiveStore();
  window.history.replaceState(null, "", "/");
});

describe("CostTab summary", () => {
  it("shows the running total, the calls and the tokens with thousands separators", async () => {
    renderWithProviders(<CostTab />);

    expect(await screen.findByTestId("cost-total")).toHaveTextContent(/^\$0\.031841$/);
    const summary = screen.getByRole("region", { name: "Running total" });
    const terms = within(summary).getAllByRole("term");
    const values = within(summary).getAllByRole("definition");
    expect(terms.map((term, index) => [term.textContent, values[index]?.textContent])).toEqual([
      ["Total spent", "$0.031841"],
      ["Billed calls", "41"],
      ["Input tokens", "74,892"],
      ["Output tokens", "1,420"],
    ]);
  });

  it("states the prices and the day they were checked", async () => {
    renderWithProviders(<CostTab />);

    expect(await screen.findByTestId("cost-prices")).toHaveTextContent(
      "Jev $0.042 per MTok input, output free; " +
        "language model $3.00 per MTok input, $15.00 per MTok output · prices as of 2026-09-19",
    );
  });

  it("splits the totals per decision backend", async () => {
    renderWithProviders(<CostTab />);

    const table = await screen.findByRole("table", { name: "Cost by backend" });
    const [, jev, llm] = within(table).getAllByRole("row");
    // The backend's name with its model under it.
    expect(jev && cellTexts(jev)).toEqual(["Jevjev-1.13.0", "38", "70,512", "0", "$0.003145"]);
    expect(llm && cellTexts(llm)).toEqual([
      "Language modelsmall-language-model-v2",
      "3",
      "4,380",
      "1,420",
      "$0.028696",
    ]);
  });

  it("explains a zero total under the rules backend", async () => {
    // Held by the live store before the first render, so the sentence does not wait on a poll.
    applyStatusSnapshot(statusWithBackend("rules", "rules-v1"));
    answerCost(NOTHING_BILLED);
    answerDecisions(NO_DECISIONS);
    renderWithProviders(<CostTab />);

    expect(await screen.findByText("Rules backend: no model calls, no cost.")).toBeInTheDocument();
    expect(screen.getByTestId("cost-total")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("cost-prices")).toHaveTextContent(
      /^\$0\.042 per MTok input, output free · prices as of 2026-09-19$/,
    );
    expect(screen.queryByRole("table", { name: "Cost by backend" })).not.toBeInTheDocument();
  });

  it("does not explain a zero total under a model backend", async () => {
    // Held by the live store before the first render, so the absence below is not a race with
    // the status poll.
    applyStatusSnapshot(statusWithBackend("jev", "jev-1.13.0"));
    answerCost(NOTHING_BILLED);
    answerDecisions(NO_DECISIONS);
    renderWithProviders(<CostTab />);

    await screen.findByText("No decisions yet, so nothing has been spent.");
    expect(screen.getByTestId("cost-total")).toHaveTextContent("$0.00");
    expect(screen.queryByText("Rules backend: no model calls, no cost.")).not.toBeInTheDocument();
  });
});

describe("CostTab ledger", () => {
  it("merges the recent rows with the decisions, newest first, in six trimmed decimals", async () => {
    renderWithProviders(<CostTab />);

    const table = await screen.findByRole("table", { name: "Cost per decision, newest first" });
    await within(table).findByTestId(`cost-row-${RULES_DECISION}`);
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => row.dataset.testid !== undefined);
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      `cost-row-${JEV_DECISION}`,
      `cost-row-${LLM_DECISION}`,
      `cost-row-${RULES_DECISION}`,
    ]);
    expect(screen.queryByTestId(`cost-row-${FAILED_DECISION}`)).not.toBeInTheDocument();

    // Decision, wall time (the viewer's zone), backend with its model, tokens in and out, cost.
    const [jev, llm, rules] = rows.map(cellTexts);
    expect(jev?.filter((_, index) => index !== 1)).toEqual([
      "4a5b60",
      "Jevjev-1.13.0",
      "1,834",
      "0",
      "$0.000077",
    ]);
    expect(jev?.[1]).toMatch(/^2026-06-0[45] \d\d:\d\d:13 /);
    expect(llm?.slice(2)).toEqual([
      "Language modelsmall-language-model-v2",
      "1,460",
      "473",
      "$0.01147",
    ]);
    expect(rules?.slice(2)).toEqual(["Rulesrules-v1", "0", "0", "$0.00"]);
  });

  it("opens a decision from its id", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CostTab />);

    const link = await screen.findByRole("link", { name: "Open decision 4a5b60" });
    expect(link).toHaveAttribute("href", `#/decisions/${JEV_DECISION}`);
    expect(within(link).getByText("4a5b60")).toHaveAttribute("title", JEV_DECISION);

    await user.click(link);

    expect(window.location.hash).toBe(`#/decisions/${JEV_DECISION}`);
  });

  it("draws the running total as a step chart that does not animate", async () => {
    renderWithProviders(<CostTab />);

    // The chart is a chunk of its own; the first test to show it waits for the charting library.
    const chart = await screen.findByRole(
      "img",
      { name: "Running total over wall time" },
      { timeout: 5_000 },
    );
    await within(screen.getByRole("table", { name: /^Cost per decision/ })).findByTestId(
      `cost-row-${RULES_DECISION}`,
    );
    const curve = chart.querySelector(".recharts-area-curve");
    expect(curve?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+)+$/);
    // An animated area is revealed through a clip rectangle growing from zero width.
    expect(chart.querySelector('clipPath rect[width="0"]')).toBeNull();
  });

  it("draws no chart for a single decision", async () => {
    answerDecisions(NO_DECISIONS);
    answerCost({ ...fixtures.cost, recent: fixtures.cost.recent.slice(0, 1) });
    renderWithProviders(<CostTab />);

    expect(await screen.findByTestId(`cost-row-${JEV_DECISION}`)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Running total over wall time" })).toBeNull();
  });

  it("says nothing has been spent before the first decision", async () => {
    answerCost(NOTHING_BILLED);
    answerDecisions(NO_DECISIONS);
    renderWithProviders(<CostTab />);

    expect(
      await screen.findByText("No decisions yet, so nothing has been spent."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /^Cost per decision/ })).not.toBeInTheDocument();
  });

  it("keeps the recent rows when the decisions cannot be loaded", async () => {
    server.use(
      http.get("/api/decisions", () => apiError(503, "db_unavailable", "Database is down.")),
    );
    renderWithProviders(<CostTab />);

    expect(await screen.findByTestId(`cost-row-${LLM_DECISION}`)).toBeInTheDocument();
    expect(screen.getByTestId(`cost-row-${JEV_DECISION}`)).toBeInTheDocument();
  });
});

describe("CostTab states", () => {
  it("shows skeleton rows while the cost loads", () => {
    renderWithProviders(<CostTab />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading the cost");
  });

  it("says what failed and retries on request", async () => {
    const user = userEvent.setup();
    server.use(http.get("/api/cost", () => apiError(503, "db_unavailable", "Database is down.")));
    renderWithProviders(<CostTab />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the cost.");
    expect(alert).toHaveTextContent("Database is down.");

    server.resetHandlers();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("cost-total")).toHaveTextContent("$0.031841");
  });
});

// The live path: two decisions are pushed, then the cost update of the second.

const PUSHED_FIRST = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e51";
const PUSHED_SECOND = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e52";

function pushedDecision(decisionId: string, wallTs: string, usd: number, tokens: number) {
  const frame = structuredClone(frames.decision);
  frame.payload = {
    ...frame.payload,
    decision_id: decisionId,
    wall_ts: wallTs,
    usage: { input_tokens: tokens, output_tokens: 0 },
    cost: { ...frame.payload.cost, usd },
  };
  return frame;
}

function costUpdate(decisionId: string, costUsd: number, totalUsd: number, calls: number) {
  const frame = structuredClone(frames["cost.update"]);
  frame.payload = {
    decision_id: decisionId,
    cost_usd: costUsd,
    total_usd: totalUsd,
    calls,
    backend: "jev",
  };
  return frame;
}

/**
 * The backend persists the new totals before it pushes `cost.update`, so the refetch the
 * reducer asks for returns what the frame announced.
 */
function persistTotals(update: FrameOf<"cost.update">): void {
  answerCost({
    ...fixtures.cost,
    totals: { ...fixtures.cost.totals, usd: update.payload.total_usd, calls: update.payload.calls },
  });
}

describe("CostTab live updates", () => {
  it("adds pushed decisions to the ledger and moves the total on the cost update", async () => {
    const { queryClient } = renderWithProviders(<CostTab />);
    await screen.findByTestId(`cost-row-${RULES_DECISION}`);
    const uninstall = installWsCache(queryClient);
    const update = costUpdate(PUSHED_SECOND, 0.000126, 0.0320512, 43);
    persistTotals(update);

    try {
      act(() => {
        dispatchFrame(pushedDecision(PUSHED_FIRST, "2026-06-05T10:30:00.000Z", 0.000084, 2_000));
        dispatchFrame(pushedDecision(PUSHED_SECOND, "2026-06-05T10:31:00.000Z", 0.000126, 3_000));
        dispatchFrame(update);
      });
    } finally {
      uninstall();
    }

    // The query cache notifies its observers on the next tick, not inside the dispatch.
    await waitFor(() => {
      expect(screen.getByTestId("cost-total")).toHaveTextContent(/^\$0\.032051$/);
    });
    const summary = screen.getByRole("region", { name: "Running total" });
    expect(within(summary).getAllByRole("definition")[1]).toHaveTextContent(/^43$/);

    const table = screen.getByRole("table", { name: "Cost per decision, newest first" });
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => row.dataset.testid !== undefined);
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      `cost-row-${PUSHED_SECOND}`,
      `cost-row-${PUSHED_FIRST}`,
      `cost-row-${JEV_DECISION}`,
      `cost-row-${LLM_DECISION}`,
      `cost-row-${RULES_DECISION}`,
    ]);
    // Tokens in, tokens out and cost are the last three cells.
    const [second, first] = rows.map((row) => cellTexts(row).slice(-3));
    expect(second).toEqual(["3,000", "0", "$0.000126"]);
    expect(first).toEqual(["2,000", "0", "$0.000084"]);
  });
});
