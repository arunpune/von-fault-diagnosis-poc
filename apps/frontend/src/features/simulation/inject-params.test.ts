// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { InjectionDef, ParamDef } from "@/api/types";
import {
  durationSteps,
  fmtParam,
  fmtSimMinutes,
  injectArgs,
  paramStep,
  tunableParams,
} from "@/features/simulation/inject-params";
import { fixtures } from "@/test/msw/fixtures";

function injection(injectionId: string): InjectionDef {
  const entry = fixtures.overlayCatalog.injections.find(
    (item) => item.injection_id === injectionId,
  );
  if (entry === undefined) {
    throw new Error(`overlay-catalog.json has no injection ${injectionId}`);
  }
  return entry;
}

const OIL_COOLER = injection("oil_cooler_fouling");

function param(name: string, min: number, max: number, value = min): ParamDef {
  return { name, min, max, default: value };
}

describe("tunableParams", () => {
  it("offers the magnitude every catalog entry declares", () => {
    for (const entry of fixtures.overlayCatalog.injections) {
      expect(tunableParams(entry).map((item) => item.name)).toEqual(["magnitude"]);
    }
  });

  it("leaves out a parameter the inject command cannot override", () => {
    const entry: InjectionDef = {
      ...OIL_COOLER,
      params: [param("ramp_in_min", 0, 240), param("magnitude", 0.25, 2, 1)],
    };

    expect(tunableParams(entry).map((item) => item.name)).toEqual(["magnitude"]);
  });
});

describe("paramStep and fmtParam", () => {
  it("splits a range into about forty round steps", () => {
    expect(paramStep(param("magnitude", 0.25, 2))).toBe(0.05);
    expect(paramStep(param("magnitude", 0, 100))).toBe(2.5);
    expect(paramStep(param("magnitude", 0, 10))).toBe(0.25);
    expect(paramStep(param("magnitude", 0, 1_000))).toBe(25);
  });

  it("steps by one over an empty or inverted range", () => {
    expect(paramStep(param("magnitude", 1, 1))).toBe(1);
    expect(paramStep(param("magnitude", 2, 1))).toBe(1);
  });

  it("shows as many decimals as the step has", () => {
    expect(fmtParam(1, 0.05)).toBe("1.00");
    expect(fmtParam(12.5, 2.5)).toBe("12.5");
    expect(fmtParam(1_250, 25)).toBe("1,250");
  });
});

describe("durationSteps and fmtSimMinutes", () => {
  it("offers half an hour to ten simulated days, the default included once", () => {
    const steps = durationSteps(OIL_COOLER.default_duration_sim_min);

    expect(steps[0]).toBe(30);
    expect(steps.at(-1)).toBe(14_400);
    expect(steps.filter((minutes) => minutes === 600)).toHaveLength(1);
    expect(steps.toSorted((a, b) => a - b)).toEqual(steps);
  });

  it("slots a default that is not a step into its place", () => {
    const steps = durationSteps(90);

    expect(steps.slice(0, 4)).toEqual([30, 60, 90, 120]);
  });

  it("reads a length in simulated minutes in its two largest units", () => {
    expect(fmtSimMinutes(600)).toBe("10 h");
    expect(fmtSimMinutes(90)).toBe("1 h 30 min");
    expect(fmtSimMinutes(14_400)).toBe("10 d");
  });
});

describe("injectArgs", () => {
  it("sends the magnitude and the duration as overrides", () => {
    expect(injectArgs(OIL_COOLER, new Map([["magnitude", 1.5]]), 720)).toEqual({
      injection_id: "oil_cooler_fouling",
      params: { magnitude: 1.5, duration_sim_min: 720 },
    });
  });

  it("sends only the duration when the definition offers no magnitude", () => {
    expect(injectArgs(OIL_COOLER, new Map(), 240)).toEqual({
      injection_id: "oil_cooler_fouling",
      params: { duration_sim_min: 240 },
    });
  });
});
