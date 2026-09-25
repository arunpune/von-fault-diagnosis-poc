// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EvidenceTable } from "@/components/common/EvidenceTable";
import { suspectEventRows, ticketEvidenceRows } from "@/lib/evidence";
import { fixtures } from "@/test/msw/fixtures";

const LABELS: Readonly<Record<string, string>> = { line_pressure: "Line pressure (P2)" };

function labelOf(signal: string): string | undefined {
  return LABELS[signal];
}

describe("EvidenceTable", () => {
  it("lists a ticket's evidence with values against their usual level", () => {
    render(<EvidenceTable rows={ticketEvidenceRows(fixtures.ticket)} caption="Ticket evidence" />);

    const table = screen.getByRole("table", { name: "Ticket evidence" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Signal", "Observation", "Value", "Duration"]);
    const [, first, second] = within(table).getAllByRole("row");
    expect(first).toHaveTextContent("Loaded run duration");
    expect(first).toHaveTextContent("5,322 s");
    expect(first).toHaveTextContent("usual 186 s");
    expect(second).toHaveTextContent("Dryer purge pressure");
    expect(second).toHaveTextContent("1.12 barusual 0.02 bar");
    expect(second).toHaveTextContent("several hours");
  });

  it("names signals with the registry's labels and humanises the rest", () => {
    const event = fixtures.events.items[1];
    if (event === undefined) {
      throw new Error("events.json has a second item");
    }
    render(<EvidenceTable rows={suspectEventRows(event)} signalLabel={labelOf} />);

    expect(screen.getByRole("table", { name: "Evidence" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Line pressure (P2)" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Cut out reached" })).toBeInTheDocument();
    const motor = screen.getByRole("cell", { name: "Motor current" }).closest("tr");
    expect(motor).toHaveTextContent("Below normal, steady");
    expect(motor).toHaveTextContent("5.08 A");
  });

  it("shows a dash for a row without a value or a duration", () => {
    render(
      <EvidenceTable rows={[{ signal: "flow_pulse", statement: "No pulses while loaded." }]} />,
    );

    expect(screen.getAllByRole("cell", { name: "—" })).toHaveLength(2);
  });

  it("says so when there is no evidence", () => {
    render(<EvidenceTable rows={[]} emptyMessage="Evidence not loaded." />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Evidence not loaded.")).toBeInTheDocument();
  });
});
