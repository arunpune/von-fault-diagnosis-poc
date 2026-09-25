// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SignalMove } from "@/api/types";
import { describeSignalMove } from "@/features/decisions/signal-moves";
import { fixtures } from "@/test/msw/fixtures";

const LABELS: Readonly<Record<string, string>> = {
  oil_temperature: "Oil temperature",
  line_pressure: "Line pressure",
};

function signalLabel(signalId: string): string | undefined {
  return LABELS[signalId];
}

describe("describeSignalMove", () => {
  it("uses the catalog's own sentence when it has one", () => {
    const [move] = fixtures.catalogFault.signal_moves;

    expect(describeSignalMove(move, signalLabel)).toBe(
      "How fast line pressure falls while the unit is not delivering is gradually faster. The earliest sign, visible in the idle phase of every cycle.",
    );
  });

  it("words a signal's move from its label, direction and phase", () => {
    const move: SignalMove = { signal: "oil_temperature", direction: "rises", phase: "loaded" };

    expect(describeSignalMove(move, signalLabel)).toBe("Oil temperature rises while loaded.");
  });

  it("words a behaviour's move from its humanised id and leaves out an any phase", () => {
    const move: SignalMove = { behaviour: "load_cycle_rate", direction: "higher", phase: "any" };

    expect(describeSignalMove(move, signalLabel)).toBe("Load cycle rate is higher.");
  });

  it("humanises a signal the registry does not label and ignores a blank sentence", () => {
    const move: SignalMove = { signal: "dryer_purge_pressure", direction: "high", text: " " };

    expect(describeSignalMove(move, signalLabel)).toBe("Dryer purge pressure is high.");
  });

  it("reads a direction or phase a newer vocabulary adds as its own words", () => {
    const move = {
      signal: "line_pressure",
      direction: "oscillates_fast",
      phase: "purging",
    } as unknown as SignalMove;

    expect(describeSignalMove(move, signalLabel)).toBe("Line pressure oscillates fast purging.");
  });
});
