// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { INTERNAL_FRAME_TYPES, isKnownFrameType, SERVER_FRAME_TYPES } from "@/api/ws-types";

describe("the frame types", () => {
  it("are the contract's eighteen server types, telemetry.series included", () => {
    expect(SERVER_FRAME_TYPES).toHaveLength(18);
    expect(SERVER_FRAME_TYPES).toEqual(
      expect.arrayContaining([
        "hello",
        "snapshot",
        "heartbeat",
        "telemetry.series",
        "alarm.native",
        "cost.update",
      ]),
    );
    expect(new Set(SERVER_FRAME_TYPES).size).toBe(18);
  });

  it("add the UI-internal link.open, which never crosses the wire", () => {
    expect(INTERNAL_FRAME_TYPES).toEqual(["link.open"]);
    expect(SERVER_FRAME_TYPES).not.toContain("link.open");
  });

  it("tell a known type from one a newer server might send", () => {
    expect(isKnownFrameType("overlay.injection_active")).toBe(true);
    expect(isKnownFrameType("link.open")).toBe(true);
    expect(isKnownFrameType("episode.update")).toBe(false);
    expect(isKnownFrameType("")).toBe(false);
  });
});
