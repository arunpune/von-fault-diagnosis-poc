// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One region of the page: a title row with optional controls on the right, and a body that
// scrolls on its own. The title names the region for assistive technology, so every panel is a
// landmark a screen reader can jump to.

import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface PanelProps extends Omit<ComponentProps<"section">, "title"> {
  title: string;
  /** Controls shown at the right of the title row (window toggles, counts, …). */
  actions?: ReactNode;
  /**
   * For a body that overflows with nothing focusable inside (the recorder's charts): the body
   * becomes a tab stop named after the panel, so the keyboard can scroll it (WCAG 2.1.1, axe
   * `scrollable-region-focusable`). Chromium already makes such a scroller a tab stop, unnamed.
   */
  focusableBody?: boolean;
}

const BODY_CLASS = "min-h-0 flex-1 overflow-auto";
const FOCUSABLE_BODY_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function Panel({
  title,
  actions,
  focusableBody = false,
  className,
  children,
  ...props
}: PanelProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex min-h-0 min-w-0 flex-col border-b last:border-b-0", className)}
      {...props}
    >
      <div className="flex h-10 shrink-0 items-center gap-3 px-4">
        <h2 id={titleId} className="text-base font-medium">
          {title}
        </h2>
        {actions === undefined ? null : (
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        )}
      </div>
      {focusableBody ? (
        <div
          role="group"
          aria-labelledby={titleId}
          tabIndex={0}
          className={cn(BODY_CLASS, FOCUSABLE_BODY_CLASS)}
        >
          {children}
        </div>
      ) : (
        <div className={BODY_CLASS}>{children}</div>
      )}
    </section>
  );
}
