// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchCounters,
  dispatchFrame,
  registerFrameHandler,
  type FrameHandler,
} from "@/api/ws-dispatch";
import { SERVER_FRAME_TYPES, type WsFrame, type WsFrameType } from "@/api/ws-types";
import { frames } from "@/test/msw/fixtures";

const disposers: (() => void)[] = [];

/** Registers for the length of one test. */
function register<T extends WsFrameType>(type: T, handler: FrameHandler<T>): void {
  disposers.push(registerFrameHandler(type, handler));
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

const LINK_OPEN: WsFrame = { type: "link.open", wall_ts: "2026-09-19T10:00:00.000Z" };

describe("dispatchFrame", () => {
  it("hands each frame to the handlers of its type only", () => {
    const onTicket = vi.fn();
    const onDecision = vi.fn();
    register("ticket", onTicket);
    register("decision", onDecision);

    dispatchFrame(frames.ticket);

    expect(onTicket).toHaveBeenCalledExactlyOnceWith(frames.ticket);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("routes every one of the eighteen server frame types and the internal link.open", () => {
    const seen: string[] = [];
    for (const type of SERVER_FRAME_TYPES) {
      register(type, (frame) => seen.push(frame.type));
    }
    register("link.open", (frame) => seen.push(frame.type));

    for (const type of SERVER_FRAME_TYPES) {
      dispatchFrame(frames[type]);
    }
    dispatchFrame(LINK_OPEN);

    expect(seen).toEqual([...SERVER_FRAME_TYPES, "link.open"]);
  });

  it("narrows the payload to the frame's type", () => {
    const codes: string[] = [];
    register("alarm.native", (frame) =>
      codes.push(`${frame.payload.code}:${String(frame.payload.active)}`),
    );

    dispatchFrame(frames["alarm.native"]);

    expect(codes).toEqual(["W102:true"]);
  });

  it("stops calling a handler once it is unregistered", () => {
    const handler = vi.fn();
    const dispose = registerFrameHandler("heartbeat", handler);

    dispatchFrame(frames.heartbeat);
    dispose();
    dispose();
    dispatchFrame(frames.heartbeat);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats the same function registered twice as two registrations", () => {
    const handler = vi.fn();
    const first = registerFrameHandler("heartbeat", handler);
    register("heartbeat", handler);

    dispatchFrame(frames.heartbeat);
    first();
    dispatchFrame(frames.heartbeat);

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("keeps calling the other handlers when one throws, and logs and counts the failure", () => {
    const failing = vi.fn(() => {
      throw new Error("reducer bug");
    });
    const healthy = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    register("decision", failing);
    register("decision", healthy);
    const before = dispatchCounters().handlerErrors;

    dispatchFrame(frames.decision);

    expect(healthy).toHaveBeenCalledOnce();
    expect(dispatchCounters().handlerErrors).toBe(before + 1);
    expect(consoleError).toHaveBeenCalledWith(
      "ws-dispatch: a decision handler failed",
      expect.any(Error),
    );
  });

  it("ignores a frame of a type this build does not know, with a debug line and a count", () => {
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const before = dispatchCounters().unknownFrames;
    const unknown = { ...frames.heartbeat, type: "episode.update" } as unknown as WsFrame;

    dispatchFrame(unknown);

    expect(dispatchCounters().unknownFrames).toBe(before + 1);
    expect(consoleDebug).toHaveBeenCalledWith(
      'ws-dispatch: ignoring a frame of unknown type "episode.update"',
    );
  });

  it("ignores a known frame nobody listens to", () => {
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const before = dispatchCounters();

    dispatchFrame(frames["telemetry.samples"]);

    expect(dispatchCounters()).toEqual(before);
    expect(consoleDebug).not.toHaveBeenCalled();
  });

  it("applies a registration made during dispatch from the next frame on", () => {
    const late = vi.fn();
    register("heartbeat", () => {
      register("heartbeat", late);
    });

    dispatchFrame(frames.heartbeat);
    expect(late).not.toHaveBeenCalled();

    dispatchFrame(frames.heartbeat);
    expect(late).toHaveBeenCalledOnce();
  });
});
