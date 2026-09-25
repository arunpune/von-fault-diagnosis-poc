// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Code splitting with preload on intent (vercel-react-best-practices bundle-dynamic-imports and
// bundle-preload). The two sheets and the Review, Events and Cost tabs are not needed for the
// first paint, so App.tsx loads them through `lazyWithPreload` behind Suspense, and the control
// that opens one calls `preload()` on hover or focus so the chunk is usually there by the time it
// is clicked.

import { lazy, useState, type ComponentType, type LazyExoticComponent } from "react";

export type PreloadableComponent<P extends object> = LazyExoticComponent<ComponentType<P>> & {
  /** Starts loading the chunk; resolves once it is loaded or failed and never rejects. */
  preload: () => Promise<void>;
};

/**
 * `React.lazy` plus a `preload()` that shares the same import. A failed load is forgotten, so
 * the next preload or render tries again instead of replaying the error.
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): PreloadableComponent<P> {
  let pending: Promise<{ default: ComponentType<P> }> | null = null;

  function loadOnce(): Promise<{ default: ComponentType<P> }> {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  }

  function preload(): Promise<void> {
    // A failure surfaces when the component renders; preloading is only a head start.
    return loadOnce().then(
      () => undefined,
      () => undefined,
    );
  }

  return Object.assign(lazy(loadOnce), { preload });
}

/**
 * Whether a lazily loaded overlay should be mounted: from the first time it opens on, so its
 * chunk is not fetched before anyone asks for it and its close animation can still play.
 */
export function useMountedOnceOpened(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) {
    // State derived from props during render, the documented alternative to an effect.
    setMounted(true);
  }
  return mounted;
}
