// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { render, renderHook, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import { lazyWithPreload, useMountedOnceOpened } from "@/lib/lazy";

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

describe("lazyWithPreload", () => {
  it("shares one import between preload and render", async () => {
    const load = vi.fn(() => Promise.resolve({ default: Greeting }));
    const LazyGreeting = lazyWithPreload(load);

    await LazyGreeting.preload();
    await LazyGreeting.preload();
    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyGreeting name="recorder" />
      </Suspense>,
    );

    expect(await screen.findByText("Hello recorder")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not load anything until asked", () => {
    const load = vi.fn(() => Promise.resolve({ default: Greeting }));

    lazyWithPreload(load);

    expect(load).not.toHaveBeenCalled();
  });

  it("never rejects from preload and retries after a failed load", async () => {
    const load = vi
      .fn<() => Promise<{ default: typeof Greeting }>>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockResolvedValueOnce({ default: Greeting });
    const LazyGreeting = lazyWithPreload(load);

    await expect(LazyGreeting.preload()).resolves.toBeUndefined();
    await expect(LazyGreeting.preload()).resolves.toBeUndefined();

    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("useMountedOnceOpened", () => {
  it("is false until the first open and stays true after closing", () => {
    const { result, rerender } = renderHook(({ open }) => useMountedOnceOpened(open), {
      initialProps: { open: false },
    });
    expect(result.current).toBe(false);

    rerender({ open: true });
    expect(result.current).toBe(true);

    rerender({ open: false });
    expect(result.current).toBe(true);
  });

  it("is true at once when mounted open", () => {
    const { result } = renderHook(() => useMountedOnceOpened(true));

    expect(result.current).toBe(true);
  });
});
