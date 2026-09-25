// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Whether the alerts list is scrolled to its top, and a way back there (the "N new" pill). The
// list scrolls inside the shadcn ScrollArea, whose viewport is the Radix element marked
// `data-slot="scroll-area-viewport"`; the hook finds it under the root it is given and listens
// to its scroll events passively (client-passive-event-listeners). Only the derived boolean is
// state, so scrolling re-renders the panel when it crosses the threshold and not on every pixel
// (rerender-derived-state).

import { useCallback, useEffect, useState, type RefObject } from "react";

/** Within this many pixels of the top the list counts as at the top. */
export const AT_TOP_THRESHOLD_PX = 8;

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

function viewportOf(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(VIEWPORT_SELECTOR) ?? null;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ScrollTop {
  /** True while the list shows its first rows. */
  readonly atTop: boolean;
  /** Scrolls back to the first rows; instantly when the viewer asks for reduced motion. */
  readonly scrollToTop: () => void;
}

export function useScrollTop(rootRef: RefObject<HTMLElement | null>): ScrollTop {
  const [atTop, setAtTop] = useState(true);

  useEffect(() => {
    const viewport = viewportOf(rootRef.current);
    if (viewport === null) {
      return undefined;
    }
    const onScroll = () => setAtTop(viewport.scrollTop <= AT_TOP_THRESHOLD_PX);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [rootRef]);

  const scrollToTop = useCallback(() => {
    const viewport = viewportOf(rootRef.current);
    if (viewport === null) {
      return;
    }
    viewport.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "instant" : "smooth" });
    setAtTop(true);
  }, [rootRef]);

  return { atTop, scrollToTop };
}
