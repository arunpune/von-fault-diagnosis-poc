// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The small shared pieces: the empty and error states, the manual citation and the code chip.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Code } from "@/components/common/Code";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState } from "@/components/common/ErrorState";
import { ManualRef } from "@/components/common/ManualRef";

describe("EmptyState", () => {
  it("shows the directive sentence and the control that takes the next step", () => {
    render(
      <EmptyState action={<button type="button">Play</button>}>
        No alerts yet. Press Play, or jump to a known failure.
      </EmptyState>,
    );

    expect(
      screen.getByText("No alerts yet. Press Play, or jump to a known failure."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("says what failed and why, and retries on request", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ErrorState
        message="Couldn't load tickets."
        detail="The backend could not be reached."
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load tickets.");
    expect(alert).toHaveTextContent("The backend could not be reached.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no retry without a handler", () => {
    render(<ErrorState message="Couldn't load the cost." />);

    expect(screen.getByRole("alert")).toHaveTextContent(/^Couldn't load the cost\.$/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("ManualRef", () => {
  it("cites the section, its title and the page", () => {
    render(<ManualRef reference={{ section: "8.3", title: "Low line pressure", page: 41 }} />);

    expect(screen.getByText("§8.3 Low line pressure, p. 41").tagName).toBe("CITE");
  });
});

describe("Code", () => {
  it("shows a code in full", () => {
    render(<Code value="dryer_purge_leak" />);

    const code = screen.getByText("dryer_purge_leak");
    expect(code.tagName).toBe("CODE");
    expect(code).not.toHaveAttribute("title");
  });

  it("shortens a long id and keeps the full id in the title", () => {
    render(<Code value="2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60" short />);

    expect(screen.getByText("8d7e60")).toHaveAttribute(
      "title",
      "2c7f8a15-4b90-4d63-8e27-1a0b9c8d7e60",
    );
  });
});
