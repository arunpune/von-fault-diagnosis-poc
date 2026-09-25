// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeverityBadge } from "@/components/common/SeverityBadge";
import { SEVERITY_LEVELS } from "@/lib/severity";

describe("SeverityBadge", () => {
  it.each(SEVERITY_LEVELS)("always shows the level %s as text, tinted with its token", (level) => {
    render(<SeverityBadge level={level} data-testid="badge" />);

    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(new RegExp(`^${level}$`));
    expect(badge).toHaveAttribute("data-severity", level);
    expect(badge).toHaveAttribute("title", `Severity: ${level}`);
    expect(badge).toHaveClass(`text-severity-${level}`, `border-severity-${level}`);
  });

  it("shows a level this build does not know as its own text in the lowest tone", () => {
    render(<SeverityBadge level="catastrophic" className="ml-2" />);

    const badge = screen.getByText("catastrophic");
    expect(badge).toHaveClass("text-severity-low", "ml-2");
  });
});
