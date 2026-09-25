// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// What the binder resolves, checked against the committed ground truth rather
// than against numbers copied into this file.
//
// Every expectation below is read from `@fdp/ground-truth` — the failure the
// scenario names, the injection definition it schedules, the excluded windows
// of the range — so a change to the failure table moves the assertion with it
// and only a genuine disagreement fails. The literals that do appear are F1's
// `onset_known` and F4b's `in_headline`, because those two booleans are the
// assertion, and the instants of the credited span (F3 09:48:30, F2 23:14:56),
// each checked against the table as well. The CTRL-7 raises of the lead-time
// cases are not in the table at all: they are what the port raised over each
// scenario's replay.

import { isExcluded, loadFailureTable, getInjection, precursorFrom } from "@fdp/ground-truth";
import { describe, expect, it } from "vitest";

import { firstAlarmByWindow, leadTimes, matchTickets, spanFrom } from "../metrics/index.ts";
import { bindScenario } from "./bind.ts";
import type { ScoringWindow } from "./bind.ts";
import { SCENARIOS_DIR, ScenarioError, applyProfile, loadAll, loadScenario } from "./load.ts";
import type { Scenario } from "./schema.ts";

const scenarios = loadAll();

function byId(id: string): Scenario {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return scenario;
}

function bind(id: string, profile: "smoke" | "core" | "dev" | "full" = "core") {
  return bindScenario(byId(id), { profile, path: `${id}.json` });
}

function onlyWindow(id: string): ScoringWindow {
  const { windows } = bind(id);
  expect(windows).toHaveLength(1);
  const window = windows[0];
  if (window === undefined) throw new Error("no window");
  return window;
}

/** A copy of a committed scenario with one field replaced, for the negative cases. */
function mutated(id: string, patch: Record<string, unknown>): Scenario {
  return { ...structuredClone(byId(id)), ...patch } as Scenario;
}

describe("failure windows", () => {
  it.each([
    ["f1_air_leak_apr18", "F1"],
    ["f2_air_leak_may30", "F2"],
    ["f3_air_leak_jun05", "F3"],
    ["f4_air_leak_jul15", "F4"],
  ])("%s binds %s with its accepted causes", (id, failureId) => {
    const failure = loadFailureTable().failures.find((row) => row.id === failureId);
    const { replay } = bind(id);
    const window = onlyWindow(id);

    expect(window.id).toBe(failureId);
    expect(window.accepted).toEqual(failure?.accepted_fault_ids);
    expect(window.benign).toBe(false);
    expect(window.headline).toBe(true);
    expect(window.onset?.toISOString()).toBe(failure?.data_onset);
    // The window is the failure clipped to what is replayed, so its end is whichever of the
    // two comes first: F3 runs past the day its scenario replays, the other three do not.
    expect(window.to.getTime()).toBe(
      Math.min(new Date(failure?.end ?? 0).getTime(), replay.to.getTime()),
    );
  });

  it("clips F3 to the replayed range rather than to the failure's own end", () => {
    const { replay } = bind("f3_air_leak_jun05");
    const window = onlyWindow("f3_air_leak_jun05");
    expect(window.to.getTime()).toBe(replay.to.getTime());
    // It opens at the data onset, not at the labelled 10:00 start (the credited span).
    expect(window.from.toISOString()).toBe("2020-06-05T09:48:30.000Z");
  });

  it("takes F4's lead_from from the precursor, not from the window start", () => {
    const precursor = precursorFrom("F4");
    expect(precursor).not.toBeNull();

    const acute = onlyWindow("f4_air_leak_jul15");
    expect(acute.leadFrom.getTime()).toBe(precursor?.getTime());
    expect(acute.nativeLpsFirst?.toISOString()).toBe("2020-07-15T17:20:11.000Z");

    // The precursor scenario ends where the acute window starts, so the precursor is the only
    // thing that gives it a window at all.
    const lead = onlyWindow("f4_precursor_jul14");
    expect(lead.from.getTime()).toBe(precursor?.getTime());
    expect(lead.to.toISOString()).toBe("2020-07-15T14:30:00.000Z");
  });

  it("reports F1's onset as unknown and F4b as a secondary positive", () => {
    expect(onlyWindow("f1_air_leak_apr18").onsetKnown).toBe(false);
    expect(onlyWindow("f2_air_leak_may30").onsetKnown).toBe(true);

    const recurrence = onlyWindow("f4b_recurrence_jul17");
    expect(recurrence.id).toBe("F4b");
    expect(recurrence.headline).toBe(false);
  });

  it("binds every headline failure for the whole recording", () => {
    const { windows } = bind("metropt3_full", "full");
    expect(windows.map((window) => window.id)).toEqual(["F1", "F2", "F3", "F4"]);
    expect(windows.every((window) => window.headline)).toBe(true);
  });
});

/**
 * The credited span: a failure whose onset is known opens at `min(leadFrom, data_onset)`,
 * where `leadFrom` is the precursor when the failure has one, else the labelled start. The
 * instants are written out, and checked against the committed table as well.
 */
describe("the true-positive span", () => {
  function failure(id: string) {
    const found = loadFailureTable().failures.find((row) => row.id === id);
    if (found === undefined) throw new Error(`no failure ${id}`);
    return found;
  }

  function onsetOf(id: string): Date {
    const onset = failure(id).data_onset;
    if (onset === null) throw new Error(`failure ${id} has no data onset`);
    return new Date(onset);
  }

  /** A correct ticket, scored against the scenario's bound windows with the real matcher. */
  function verdict(id: string, openedAt: string): "tp" | "fp" {
    const bound = bind(id);
    const window = bound.windows[0];
    if (window === undefined) throw new Error(`${id} binds no window`);
    const result = matchTickets(
      bound.windows,
      [],
      [
        {
          ticketId: "t1",
          episodeId: "e1",
          openedSimTs: new Date(openedAt),
          faultAtOpen: window.accepted[0] ?? "",
          faultLatest: window.accepted[0] ?? "",
          maxLevel: "ticket",
        },
      ],
      bound.benignFaultIds,
    );
    if (result.tp.length === 1) return "tp";
    expect(result.fp).toHaveLength(1);
    return "fp";
  }

  it("opens F3 at its data onset, 09:48:30, instead of the 10:00 start", () => {
    const window = onlyWindow("f3_air_leak_jun05");
    expect(failure("F3")).toMatchObject({ start: "2020-06-05T10:00:00.000Z", onset_known: true });
    expect(window.from.toISOString()).toBe(failure("F3").data_onset);
    expect(window.from.toISOString()).toBe("2020-06-05T09:48:30.000Z");
    expect(window.leadFrom.toISOString()).toBe("2020-06-05T10:00:00.000Z");
    expect(verdict("f3_air_leak_jun05", "2020-06-05T09:50:30.000Z")).toBe("tp");
    expect(verdict("f3_air_leak_jun05", "2020-06-05T09:47:30.000Z")).toBe("fp");
  });

  it("opens F2 at its data onset, 23:14:56, instead of the 23:30 start", () => {
    const window = onlyWindow("f2_air_leak_may30");
    expect(failure("F2")).toMatchObject({ start: "2020-05-29T23:30:00.000Z", onset_known: true });
    expect(window.from.toISOString()).toBe(failure("F2").data_onset);
    expect(window.from.toISOString()).toBe("2020-05-29T23:14:56.000Z");
    expect(window.leadFrom.toISOString()).toBe("2020-05-29T23:30:00.000Z");
    expect(verdict("f2_air_leak_may30", "2020-05-29T23:16:56.000Z")).toBe("tp");
    expect(verdict("f2_air_leak_may30", "2020-05-29T23:13:56.000Z")).toBe("fp");
  });

  it("still scores a correct ticket before F2's onset, at the 21:36 blip, as a false positive", () => {
    expect(verdict("f2_air_leak_may30", "2020-05-29T21:36:00.000Z")).toBe("fp");
  });

  it("leaves F4 at its precursor, which is earlier than its onset", () => {
    const precursor = precursorFrom("F4");
    expect(precursor?.toISOString()).toBe("2020-07-14T21:28:00.000Z");
    expect(precursor?.getTime()).toBeLessThan(onsetOf("F4").getTime());

    const acute = onlyWindow("f4_air_leak_jul15");
    expect(acute.leadFrom.getTime()).toBe(precursor?.getTime());
    // The acute scenario replays from 12:00 on 15 July, so its window is clipped there.
    expect(acute.from.toISOString()).toBe("2020-07-15T12:00:00.000Z");
    expect(onlyWindow("f4_precursor_jul14").from.getTime()).toBe(precursor?.getTime());
    expect(verdict("f4_precursor_jul14", "2020-07-14T21:28:00.000Z")).toBe("tp");
    expect(verdict("f4_precursor_jul14", "2020-07-14T21:27:00.000Z")).toBe("fp");
  });

  it("leaves F4b at its start, which is earlier than its onset", () => {
    const window = onlyWindow("f4b_recurrence_jul17");
    expect(onsetOf("F4b").getTime()).toBeGreaterThan(new Date(failure("F4b").start).getTime());
    expect(window.from.toISOString()).toBe(failure("F4b").start);
    expect(window.from.toISOString()).toBe("2020-07-16T20:00:00.000Z");
  });

  it("leaves F1 at its start, because its onset is not known", () => {
    const window = onlyWindow("f1_air_leak_apr18");
    expect(failure("F1").onset_known).toBe(false);
    expect(window.from.toISOString()).toBe(failure("F1").start);
    expect(verdict("f1_air_leak_apr18", "2020-04-17T23:59:00.000Z")).toBe("fp");
  });

  it("binds the whole recording's F2 and F3 at their onsets and F1 and F4 as before", () => {
    const { windows } = bind("metropt3_full", "full");
    expect(windows.map((window) => [window.id, window.from.toISOString()])).toEqual([
      ["F1", "2020-04-18T00:00:00.000Z"],
      ["F2", "2020-05-29T23:14:56.000Z"],
      ["F3", "2020-06-05T09:48:30.000Z"],
      ["F4", "2020-07-14T21:28:00.000Z"],
    ]);
  });
});

/**
 * The lead-time reference on the bound windows: the native alarm is searched in
 * `[spanFrom, to)`, the credited span, not in `[leadFrom, to)`. The raises are the CTRL-7
 * port's over each scenario's own replay, with the committed registry, restricted to the
 * scenarios' `native_alarm_codes` (F2's `W103` at 23:16:35 is a later raise of that code, not
 * its first). F3 and F2 move; F1 (onset a lower bound), F4 (precursor earlier than the
 * onset) and F4b (onset after the start) search from `leadFrom` exactly as before.
 */
describe("the lead-time reference on the bound windows", () => {
  function raise(code: string, at: string) {
    return { code, simTs: new Date(at) };
  }

  const RAISES = {
    f1_air_leak_apr18: [
      raise("W103", "2020-04-18T00:25:08.000Z"),
      raise("W102", "2020-04-18T00:34:03.000Z"),
      raise("W101", "2020-04-19T02:13:38.000Z"),
    ],
    f2_air_leak_may30: [
      raise("W103", "2020-05-29T21:35:58.000Z"),
      raise("W103", "2020-05-29T22:51:18.000Z"),
      raise("W103", "2020-05-29T23:16:35.000Z"),
      raise("W102", "2020-05-29T23:25:00.000Z"),
    ],
    f3_air_leak_jun05: [
      raise("W103", "2020-06-05T09:51:19.000Z"),
      raise("W102", "2020-06-05T09:58:35.000Z"),
    ],
    f4_precursor_jul14: [raise("W101", "2020-07-14T21:28:15.000Z")],
    f4_air_leak_jul15: [
      raise("W102", "2020-07-15T14:35:27.000Z"),
      raise("W101", "2020-07-15T17:20:21.000Z"),
      raise("W101", "2020-07-15T23:55:12.000Z"),
    ],
    f4b_recurrence_jul17: [
      raise("W101", "2020-07-17T00:56:10.000Z"),
      raise("W102", "2020-07-17T04:46:18.000Z"),
      raise("W101", "2020-07-17T07:26:44.000Z"),
    ],
  } as const;

  type Id = keyof typeof RAISES;

  /** The lead-time row of one correct ticket, scored on the scenario's bound window. */
  function leadRow(id: Id, openedAt: string, codes?: readonly string[]) {
    const bound = bind(id);
    const [window] = bound.windows;
    if (window === undefined) throw new Error(`${id} binds no window`);
    const fault = window.accepted[0] ?? "";
    const match = matchTickets(
      bound.windows,
      [],
      [
        {
          ticketId: "t1",
          episodeId: "e1",
          openedSimTs: new Date(openedAt),
          faultAtOpen: fault,
          faultLatest: fault,
          maxLevel: "ticket",
        },
      ],
      bound.benignFaultIds,
    );
    const alarms = firstAlarmByWindow(
      bound.windows,
      RAISES[id],
      codes ?? byId(id).native_alarm_codes ?? [],
    );
    const [row] = leadTimes(match, alarms);
    if (row === undefined) throw new Error(`${id}: the ticket at ${openedAt} detected nothing`);
    return { window, row };
  }

  /** What the search over `[leadFrom, to)` found, the reference before the amendment. */
  function fromLeadFrom(id: Id, window: ScoringWindow) {
    return RAISES[id].find(
      (entry) =>
        entry.simTs.getTime() >= window.leadFrom.getTime() &&
        entry.simTs.getTime() < window.to.getTime(),
    );
  }

  it("measures a correct F3 ticket after 09:51:19 against W103 at 09:51:19", () => {
    const { window, row } = leadRow("f3_air_leak_jun05", "2020-06-05T09:53:00.000Z");
    expect(spanFrom(window).toISOString()).toBe("2020-06-05T09:48:30.000Z");
    // Before the amendment was applied the search opened at 10:00 and found nothing.
    expect(fromLeadFrom("f3_air_leak_jun05", window)).toBeUndefined();
    expect(row).toMatchObject({
      windowId: "F3",
      nativeCode: "W103",
      nativeFirst: new Date("2020-06-05T09:51:19.000Z"),
      leadMinutes: -101 / 60,
      // Latency still runs from the onset, and the LPS reference is the failure table's.
      latencyMinutes: 4.5,
      qualifier: "",
      lpsFirst: new Date("2020-06-06T19:42:19.000Z"),
    });
  });

  it("measures a correct F3 ticket after the start against the same W103", () => {
    const { row } = leadRow("f3_air_leak_jun05", "2020-06-05T10:05:00.000Z");
    expect(row).toMatchObject({
      nativeCode: "W103",
      nativeFirst: new Date("2020-06-05T09:51:19.000Z"),
      leadMinutes: -821 / 60,
      latencyMinutes: 16.5,
    });
  });

  it("brings F2's W102 at 23:25:00, and the W103 raised at 23:16:35 before it, into the reference", () => {
    const opened = "2020-05-29T23:20:00.000Z";
    const w102 = leadRow("f2_air_leak_may30", opened, ["W102"]);
    expect(spanFrom(w102.window).toISOString()).toBe("2020-05-29T23:14:56.000Z");
    expect(fromLeadFrom("f2_air_leak_may30", w102.window)).toBeUndefined();
    expect(w102.row).toMatchObject({
      windowId: "F2",
      nativeCode: "W102",
      nativeFirst: new Date("2020-05-29T23:25:00.000Z"),
      leadMinutes: 5,
      latencyMinutes: 304 / 60,
    });

    // With the scenario's own codes the first raise in the span is the W103 at 23:16:35; the
    // 21:35:58 and 22:51:18 raises stay before the onset, outside the span: the committed
    // labels read those blips as negative time.
    const scenarioCodes = leadRow("f2_air_leak_may30", opened);
    expect(scenarioCodes.row).toMatchObject({
      nativeCode: "W103",
      nativeFirst: new Date("2020-05-29T23:16:35.000Z"),
      leadMinutes: -205 / 60,
    });
    expect(scenarioCodes.row.lpsFirst).toBeUndefined();
  });

  it.each([
    ["f1_air_leak_apr18", "2020-04-18T00:30:00.000Z", "W103", "2020-04-18T00:25:08.000Z"],
    ["f4_precursor_jul14", "2020-07-14T21:30:00.000Z", "W101", "2020-07-14T21:28:15.000Z"],
    ["f4_air_leak_jul15", "2020-07-15T14:40:00.000Z", "W102", "2020-07-15T14:35:27.000Z"],
    ["f4b_recurrence_jul17", "2020-07-17T01:00:00.000Z", "W101", "2020-07-17T00:56:10.000Z"],
  ] as const)("leaves %s's reference where it was", (id, opened, code, nativeFirst) => {
    const { window, row } = leadRow(id, opened);
    expect(spanFrom(window).getTime()).toBe(window.leadFrom.getTime());
    expect(fromLeadFrom(id, window)).toEqual(raise(code, nativeFirst));
    expect(row).toMatchObject({ nativeCode: code, nativeFirst: new Date(nativeFirst) });
  });
});

describe("injection windows", () => {
  it("runs from the scheduled instant for the definition's duration", () => {
    const definition = getInjection("oil_cooler_fouling");
    expect(definition).toBeDefined();

    const window = onlyWindow("inject_oil_cooler_fouling");
    const bound = bind("inject_oil_cooler_fouling");
    const instance = bound.injections[0];

    expect(instance?.injection_id).toBe("oil_cooler_fouling");
    expect(instance?.durationMin).toBe(definition?.default_duration_sim_min);
    expect(window.from.toISOString()).toBe("2020-02-03T02:00:00.000Z");
    expect(window.to.getTime() - window.from.getTime()).toBe(
      (definition?.default_duration_sim_min ?? 0) * 60_000,
    );
    expect(window.accepted).toEqual([definition?.fault_id]);
    expect(window.benign).toBe(definition?.benign);
  });

  it("is not one of the MetroPT-3 headline failures the in-sample check scores", () => {
    expect(onlyWindow("inject_oil_cooler_fouling").headline).toBe(false);
    expect(onlyWindow("inject_air_leak_downstream").headline).toBe(false);
  });

  it("binds the leak's dev twin to 02:00–06:00 of 5 July, accepting only the leak", () => {
    const definition = getInjection("air_leak_downstream");
    const bound = bind("inject_air_leak_downstream_jul05", "dev");
    expect(bound.windows).toHaveLength(1);
    const window = bound.windows[0];

    expect(bound.scenario.split).toBe("dev");
    expect(bound.injections[0]?.injection_id).toBe("air_leak_downstream");
    expect(bound.injections[0]?.durationMin).toBe(definition?.default_duration_sim_min);
    expect(window?.from.toISOString()).toBe("2020-07-05T02:00:00.000Z");
    expect(window?.to.toISOString()).toBe("2020-07-05T06:00:00.000Z");
    expect(window?.accepted).toEqual(["downstream_air_leak"]);
    expect(window?.headline).toBe(false);
  });

  it("makes the twin mirror the core leak in everything but the day it replays", () => {
    // What the twin is for: the same injection, at the same time of day, with the same
    // expectation, on a day no core-10 scenario replays. Only the scenario definitions are
    // compared here; nothing of the core leak is replayed.
    const twin = byId("inject_air_leak_downstream_jul05");
    const core = byId("inject_air_leak_downstream");
    const timeOfDay = (iso: string | undefined): string => iso?.slice(10) ?? "";

    expect(twin.injections?.map((entry) => [entry.injection_id, entry.params])).toEqual(
      core.injections?.map((entry) => [entry.injection_id, entry.params]),
    );
    expect(timeOfDay(twin.injections?.[0]?.at)).toBe(timeOfDay(core.injections?.[0]?.at));
    expect(timeOfDay(twin.replay.from)).toBe(timeOfDay(core.replay.from));
    expect(timeOfDay(twin.replay.to)).toBe(timeOfDay(core.replay.to));
    expect(twin.expect).toEqual(core.expect);
    expect(twin.warmup_min).toBe(core.warmup_min);
    expect([twin.group, twin.positive, twin.ground_truth]).toEqual([
      core.group,
      core.positive,
      core.ground_truth,
    ]);

    expect(twin.source).toEqual({ kind: "slice", name: "summer-jul05" });
    expect(twin.split).toBe("dev");
    expect(twin.profiles).toEqual(["dev"]);
    const coreSlices = scenarios
      .filter((scenario) => scenario.split === "test" && scenario.source.kind === "slice")
      .map((scenario) => (scenario.source.kind === "slice" ? scenario.source.name : ""));
    expect(coreSlices).not.toContain("summer-jul05");
  });

  it("clips the window to a shortened smoke range", () => {
    const smoke = bind("inject_oil_cooler_fouling", "smoke");
    expect(smoke.replay.to.toISOString()).toBe("2020-02-03T10:00:00.000Z");
    expect(smoke.windows[0]?.to.getTime()).toBe(smoke.replay.to.getTime());
  });

  it("opens no positive window for an abstention, but still resolves the instance", () => {
    const bound = bind("inject_high_ambient_benign");
    expect(bound.windows).toEqual([]);
    expect(bound.injections[0]?.fault_id).toBe(getInjection("high_ambient_temperature")?.fault_id);
    expect(bound.benignFaultIds.has("high_ambient_temperature")).toBe(true);
  });
});

describe("excluded windows", () => {
  it("attaches the July repair to the acute F4 scenario", () => {
    const { excluded } = bind("f4_air_leak_jul15");
    const repair = excluded.find((window) => window.reason === "repair");
    expect(repair?.from.toISOString()).toBe("2020-07-15T19:00:00.000Z");
    expect(repair?.to.toISOString()).toBe("2020-07-16T01:00:00.000Z");
  });

  it("attaches the frozen block F1's replay starts inside", () => {
    const { excluded, replay } = bind("f1_air_leak_apr18");
    const frozen = excluded.find((window) => window.reason === "frozen_logger");
    expect(frozen?.from.getTime()).toBe(replay.from.getTime());
    expect(frozen?.to.toISOString()).toBe("2020-04-18T00:18:07.000Z");
  });

  it("agrees with isExcluded() at the midpoint of every window it attaches", () => {
    // The reasons are not compared: the table's windows overlap — the June repair runs across
    // a depot depressurisation — and `isExcluded` answers with the first window that matches,
    // which need not be the one this window came from. That an instant inside an attached
    // window is excluded at all is the invariant.
    for (const bound of scenarios.map((scenario) =>
      bindScenario(scenario, { profile: scenario.profiles[0], path: `${scenario.id}.json` }),
    )) {
      for (const window of bound.excluded) {
        if (window.reason === "gap") continue;
        const middle = new Date((window.from.getTime() + window.to.getTime()) / 2);
        expect(isExcluded(middle).excluded).toBe(true);
      }
    }
  });

  it("attaches nothing outside the replayed range", () => {
    for (const bound of scenarios.map((scenario) => bindScenario(scenario))) {
      for (const window of bound.excluded) {
        expect(window.from.getTime()).toBeGreaterThanOrEqual(bound.replay.from.getTime());
        expect(window.to.getTime()).toBeLessThanOrEqual(bound.replay.to.getTime());
      }
    }
  });
});

describe("unresolved references", () => {
  it.each([
    ["source", { source: { kind: "slice", name: "no-such-slice" } }],
    ["source", { replay: { from: "2019-01-01T00:00:00.000Z", to: "2019-01-02T00:00:00.000Z" } }],
    ["ground_truth", { ground_truth: { kind: "failure", failure_id: "F9" } }],
  ] as const)("fails with code %s", (code, patch) => {
    expect(() => bindScenario(mutated("f1_air_leak_apr18", patch))).toThrow(
      expect.objectContaining({ name: "ScenarioError", code }) as Error,
    );
  });

  it("fails with code injection for an injection id nothing defines", () => {
    const patched = mutated("inject_oil_cooler_fouling", {
      injections: [{ injection_id: "no_such_injection", at: "2020-02-03T02:00:00.000Z" }],
    });
    expect(() => bindScenario(patched)).toThrow(
      expect.objectContaining({ name: "ScenarioError", code: "injection" }) as Error,
    );
  });

  it("fails with code injection for a parameter outside its bounds", () => {
    const patched = mutated("inject_oil_cooler_fouling", {
      injections: [
        {
          injection_id: "oil_cooler_fouling",
          at: "2020-02-03T02:00:00.000Z",
          params: { magnitude: 9 },
        },
      ],
    });
    expect(() => bindScenario(patched)).toThrow(/outside \[0\.25, 2\]/);
  });

  it("carries the offending file in the error", () => {
    try {
      bindScenario(
        mutated("f1_air_leak_apr18", { ground_truth: { kind: "failure", failure_id: "F9" } }),
        {
          path: "scenarios/broken.json",
        },
      );
      expect.unreachable("bindScenario should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioError);
      expect((error as ScenarioError).path).toBe("scenarios/broken.json");
    }
  });
});

describe("the design target", () => {
  it("is carried by unlabelled_leak_may19 alone, the signature-A pair, unverified", () => {
    const carriers = scenarios.filter((scenario) => scenario.design_target !== undefined);
    expect(carriers.map((scenario) => scenario.id)).toEqual(["unlabelled_leak_may19"]);
    expect(byId("unlabelled_leak_may19").design_target).toEqual({
      accepted: ["dryer_purge_leak", "downstream_air_leak"],
      provenance: expect.stringContaining("inferred from the signature-A analysis, unverified"),
    });
  });

  it("names causes the failure table's signature-A windows accept, and no timestamp", () => {
    const signatureA = loadFailureTable().failures.find((failure) => failure.id === "F3");
    expect(byId("unlabelled_leak_may19").design_target?.accepted).toEqual(
      signatureA?.accepted_fault_ids,
    );
    // The episode comes from the failure table: the target carries no instant of its own.
    expect(JSON.stringify(byId("unlabelled_leak_may19").design_target)).not.toMatch(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );
  });

  it("applies to the unlabelled episode the binder resolves from the failure table", () => {
    const bound = bind("unlabelled_leak_may19", "dev");
    const episodes = bound.excluded.filter((window) => window.reason === "unlabelled_positive");
    expect(episodes).toHaveLength(1);
    expect(bound.windows).toEqual([]);
  });

  it("leaves the binding the scorer reads without it", () => {
    const bound = bind("unlabelled_leak_may19", "dev");
    const copy = { ...byId("unlabelled_leak_may19") };
    delete copy.design_target;
    const without = bindScenario(copy, { profile: "dev" });
    expect(bound.windows).toEqual(without.windows);
    expect(bound.excluded).toEqual(without.excluded);
    expect(bound.benignFaultIds).toEqual(without.benignFaultIds);
  });

  it("refuses a cause the ground-truth data does not name", () => {
    const patched = mutated("unlabelled_leak_may19", {
      design_target: { accepted: ["dryer_purge_leak", "no_such_cause"], provenance: "a test" },
    });
    expect(() => bindScenario(patched, { profile: "dev" })).toThrow(
      expect.objectContaining({ name: "ScenarioError", code: "ground_truth" }) as Error,
    );
    expect(() => bindScenario(patched, { profile: "dev" })).toThrow(/no_such_cause/);
  });

  it("refuses a replayed range that holds no unlabelled episode to apply to", () => {
    const patched = mutated("unlabelled_leak_may19", {
      replay: { from: "2020-05-19T20:00:00.000Z", to: "2020-05-19T22:00:00.000Z" },
    });
    expect(() => bindScenario(patched, { profile: "dev" })).toThrow(/holds none/);
  });
});

describe("profiles and splits", () => {
  const core = scenarios.filter((scenario) => scenario.profiles.includes("core"));
  const dev = scenarios.filter((scenario) => scenario.profiles.includes("dev"));

  it("holds the core-10 in the core profile", () => {
    expect(core.map((scenario) => scenario.id).sort()).toEqual([
      "baseline_feb03_normal",
      "depot_lps_jul31",
      "f1_air_leak_apr18",
      "f2_air_leak_may30",
      "f3_air_leak_jun05",
      "f4_air_leak_jul15",
      "inject_air_leak_downstream",
      "inject_high_ambient_benign",
      "inject_oil_cooler_fouling",
      "inject_oil_temperature_sensor_fault",
    ]);
  });

  it("makes the core profile exactly the test split", () => {
    expect(core.every((scenario) => scenario.split === "test")).toBe(true);
    expect(scenarios.filter((scenario) => scenario.split === "test")).toEqual(core);
  });

  it("keeps the dev profile disjoint from it", () => {
    const coreIds = new Set(core.map((scenario) => scenario.id));
    expect(dev.some((scenario) => coreIds.has(scenario.id))).toBe(false);
    // The held-out set is in neither: its own split, its own profile.
    const heldout = scenarios.filter((scenario) => scenario.split === "heldout");
    expect(dev).toHaveLength(scenarios.length - core.length - heldout.length);
  });

  it("counts six positives in the test split, which is what the 5/6 rule needs", () => {
    expect(core.filter((scenario) => scenario.positive)).toHaveLength(6);
  });

  it("runs the five smoke scenarios, all of them inside core", () => {
    const smoke = scenarios.filter((scenario) => scenario.profiles.includes("smoke"));
    expect(smoke.map((scenario) => scenario.id).sort()).toEqual([
      "baseline_feb03_normal",
      "depot_lps_jul31",
      "f3_air_leak_jun05",
      "inject_oil_cooler_fouling",
      "inject_oil_temperature_sensor_fault",
    ]);
    expect(smoke.every((scenario) => scenario.profiles.includes("core"))).toBe(true);
  });

  it("shortens the range a profile overrides and leaves the others alone", () => {
    const scenario = byId("f3_air_leak_jun05");
    expect(applyProfile(scenario, "smoke").to.toISOString()).toBe("2020-06-05T14:00:00.000Z");
    expect(applyProfile(scenario, "core").to.toISOString()).toBe(scenario.replay.to);
    expect(applyProfile(scenario, "smoke").from.toISOString()).toBe(scenario.replay.from);
  });
});

describe("sources", () => {
  it("resolves every slice the committed scenarios name", () => {
    for (const scenario of scenarios) {
      const bound = bindScenario(scenario, { path: `${scenario.id}.json` });
      if (bound.source.kind !== "slice") continue;
      expect(bound.source.definition.name).toBe(bound.source.name);
      expect(bound.source.definition.rows).toBeGreaterThan(0);
    }
  });

  it("reads the whole recording from the CSV rather than from a slice", () => {
    expect(bind("metropt3_full", "full").source.kind).toBe("csv");
  });

  it("loads the committed directory in id order", () => {
    expect(loadAll(SCENARIOS_DIR).map((scenario) => scenario.id)).toEqual(
      scenarios.map((scenario) => scenario.id),
    );
    expect(loadScenario(`${SCENARIOS_DIR}f1_air_leak_apr18.json`).id).toBe("f1_air_leak_apr18");
  });
});
