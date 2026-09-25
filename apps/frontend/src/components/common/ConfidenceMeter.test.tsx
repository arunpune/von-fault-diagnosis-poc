// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfidenceMeter } from "@/components/common/ConfidenceMeter";

const GATE = [
  { value: 0.85, label: "Ticket at 85 %" },
  { value: 0.6, label: "Review at 60 %" },
];

describe("ConfidenceMeter", () => {
  it("exposes the confidence as a named progress bar with its percentage", () => {
    render(<ConfidenceMeter value={0.913} />);

    const bar = screen.getByRole("progressbar", { name: "Confidence" });
    expect(bar).toHaveAttribute("aria-valuenow", "91");
    expect(bar).toHaveAttribute("aria-valuetext", "91 %");
    expect(screen.getByText("91 %")).toHaveAttribute("aria-hidden", "true");
  });

  it("marks each threshold it is given where it sits on the bar", () => {
    const { container } = render(
      <ConfidenceMeter
        value={0.72}
        thresholds={GATE}
        label="Decision confidence"
        data-testid="meter"
      />,
    );

    expect(screen.getByRole("progressbar", { name: "Decision confidence" })).toBeInTheDocument();
    const ticks = container.querySelectorAll<HTMLElement>("[data-threshold]");
    expect([...ticks].map((tick) => [tick.title, tick.style.left])).toEqual([
      ["Ticket at 85 %", "85%"],
      ["Review at 60 %", "60%"],
    ]);
    expect(screen.getByTestId("meter")).toContainElement(ticks[0] ?? null);
  });

  it("keeps the bar inside 0–100 % for an out-of-range or missing value", () => {
    const { rerender } = render(
      <ConfidenceMeter value={1.4} thresholds={[{ value: -1, label: "floor" }]} />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    rerender(<ConfidenceMeter value={Number.NaN} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "—");
  });
});
