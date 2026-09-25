// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence before the ticket: an episode's first decision waits for its
 * evidence to persist.
 *
 * A review or a ticket may be created for an episode only once the evidence
 * behind it has held without a break for `GATE_PERSIST_SIM_MIN` sim minutes.
 * The episode still opens on the first suspect event and the event is still
 * emitted; the decision of an episode that could create a ticket waits, and a
 * blip that ends sooner is never decided, so it costs no call and opens
 * nothing. An episode that owns a ticket, or is merged into one, is decided as
 * before.
 *
 * Everything here is synthetic telemetry: first-month cycles from
 * `test/fixtures/synthetic/`, and a drain-side run — a loaded phase whose purge
 * side holds pressure, the signature `purge_pressure_high` watches — as long as
 * each case needs. No labelled window is encoded. Samples sit on the ten-second
 * grid and each run starts on a sim minute, so the frames detection evaluates
 * the rules on fall on whole minutes and every instant below is exact.
 *
 * The backend is a stand-in that names one cause, whenever retrieval offers
 * it, at a confidence above the ticket threshold: the persistence rule is the
 * only thing between a suspect event and a ticket, which is what these tests
 * measure. It counts its calls, because a blip that is never decided must
 * never be paid for.
 */

import { simMinutesBetween, validate } from "@fdp/contracts";
import type { Decision, TelemetrySamples, Ticket } from "@fdp/contracts";
import { describe, expect, it } from "vitest";

import { fixedClock } from "../clock.ts";
import { FIXTURE_CATALOG } from "../../test/fixtures/catalog/index.ts";
import {
  BASELINE_CYCLE,
  CUT_IN_BAR,
  NORMAL_DECAY_BAR_PER_MIN,
  cycles,
  runRows,
  type Phase,
} from "../../test/fixtures/synthetic/index.ts";
import { toBatches } from "../../test/fixtures/telemetry/rows.ts";
import {
  DEFAULT_PIPELINE_CONFIG,
  createCatalogRetriever,
  createPipeline,
  createRulesBackend,
} from "./index.ts";
import type { DecisionBackend, PipelineConfig, PipelineOutput } from "./index.ts";

/** Where every run starts in the data clock: a sim minute. */
const START = "2020-02-03T00:00:00.000Z";

/** The confidence the stand-in answers with: above the ticket threshold. */
const CONFIDENT = 0.95;

/** The cause the stand-in names; the fixture catalog files it under both keys used here. */
const FAULT = "dryer_purge_leak";

interface CountingBackend extends DecisionBackend {
  /** The sim instants of the events the backend was asked about, in order. */
  readonly asked: string[];
}

/**
 * A backend that names {@link FAULT} whenever it is offered, else the first
 * candidate, always at {@link CONFIDENT}.
 *
 * The rules twin supplies a well-formed answer; only the choice, the
 * confidence and the probabilities are replaced.
 */
function confidentBackend(): CountingBackend {
  const twin = createRulesBackend();
  const asked: string[] = [];
  return {
    name: twin.name,
    model: twin.model,
    asked,
    async decide(input) {
      asked.push(input.event.sim_ts);
      const answer = await twin.decide(input);
      const offered = input.candidates.map((candidate) => candidate.fault_id);
      const choice = offered.includes(FAULT) ? FAULT : (offered[0] ?? answer.choice);
      const labels = Object.keys(answer.probabilities);
      const probabilities = Object.fromEntries(
        labels.map((label) => [
          label,
          label === choice ? CONFIDENT : (1 - CONFIDENT) / Math.max(1, labels.length - 1),
        ]),
      );
      return { ...answer, choice, confidence: CONFIDENT, probabilities };
    },
  };
}

function pipelineWith(backend: DecisionBackend, cfg: Partial<PipelineConfig> = {}) {
  return createPipeline(
    {
      wall: fixedClock("2026-09-23T08:00:00.000Z"),
      retriever: createCatalogRetriever(FIXTURE_CATALOG),
      decision: backend,
    },
    cfg,
  );
}

/** Two first-month cycles (61 sim minutes): the warm-up guard has long passed. */
const leadIn = (): Phase[] => cycles(BASELINE_CYCLE, 2);

/**
 * A loaded run of `loadedS` seconds whose purge side holds `purgeBar`, then
 * the run-on and a rest back to cut-in.
 *
 * `purge_pressure_high` fires on the first frame after six such samples — the
 * minute boundary one minute into the run — and stops on the frame of the
 * unload, so it fires for `loadedS / 60 − 1` minutes.
 */
function drainSide(loadedS: number, purgeBar = 1): Phase[] {
  return [
    { mode: "loaded", seconds: loadedS, fromBar: CUT_IN_BAR, toBar: 9.2, purgeBar },
    { mode: "unloaded", seconds: 400, fromBar: 9.2, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
    { mode: "off", seconds: 600, fromBar: 8.74, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
  ];
}

/**
 * The first frame `purge_pressure_high` fires on: one minute into the loaded
 * run of {@link drainSide}, which starts 61 sim minutes in, on 01:01:00.
 */
const FIRST_FIRING = "2020-02-03T01:02:00.000Z";

function batchesOf(phases: readonly Phase[]): TelemetrySamples[] {
  return toBatches(runRows(phases, { startSimTs: START }), {
    unitId: "cau-7",
    wallStartMs: Date.parse("2026-09-23T00:00:00.000Z"),
  });
}

async function replay(
  pipeline: ReturnType<typeof createPipeline>,
  batches: readonly TelemetrySamples[],
): Promise<PipelineOutput[]> {
  const outputs: PipelineOutput[] = [];
  for (const batch of batches) outputs.push(...(await pipeline.push(batch)));
  return outputs;
}

type OutputOf<T extends PipelineOutput["type"]> = Extract<PipelineOutput, { type: T }>;

function ofType<T extends PipelineOutput["type"]>(
  outputs: readonly PipelineOutput[],
  type: T,
): OutputOf<T>[] {
  return outputs.filter((output): output is OutputOf<T> => output.type === type);
}

const decisions = (outputs: readonly PipelineOutput[]): Decision[] =>
  ofType(outputs, "decision").map((output) => output.decision);

const tickets = (outputs: readonly PipelineOutput[]): Ticket[] =>
  ofType(outputs, "ticket").map((output) => output.ticket);

/** Each output as `type` or `type:action`, in order, for comparing histories. */
function shape(outputs: readonly PipelineOutput[]): string[] {
  return outputs.map((output) => {
    if (output.type === "episode") return `episode:${output.action}`;
    if (output.type === "ticket") return `ticket:${output.ticket.action}`;
    return output.type;
  });
}

/** Every decision, suspect event and ticket fits its contract. */
function onContract(outputs: readonly PipelineOutput[]): boolean {
  return outputs.every((output) => {
    if (output.type === "decision") return validate("decision", output.decision).ok;
    if (output.type === "suspect") return validate("suspect-event", output.event).ok;
    if (output.type === "ticket") return validate("ticket", output.ticket).ok;
    return true;
  });
}

/** A persistence long enough for the delay to show on the whole-minute frames. */
const TWO_MINUTES: Partial<PipelineConfig> = { persistSimMin: 2 };

describe("persistence before the ticket", () => {
  it("defaults to one sim minute", () => {
    expect(DEFAULT_PIPELINE_CONFIG.persistSimMin).toBe(1);
  });

  it("announces a blip shorter than GATE_PERSIST_SIM_MIN, never decides it and opens nothing", async () => {
    // A two-minute loaded run with the purge side up — the rule fires on one
    // frame only — then five quiet cycles: the episode falls silent after 120
    // sim minutes. The pipeline runs with its defaults.
    const telemetry = batchesOf([...leadIn(), ...drainSide(120), ...cycles(BASELINE_CYCLE, 5)]);
    const backend = confidentBackend();
    const outputs = await replay(pipelineWith(backend), telemetry);

    expect(shape(outputs)).toEqual(["suspect", "episode:opened", "episode:closed"]);
    const [suspect, opened, closed] = outputs as [
      OutputOf<"suspect">,
      OutputOf<"episode">,
      OutputOf<"episode">,
    ];
    expect(suspect.event).toMatchObject({
      symptom_key: "purge_pressure_high",
      sim_ts: FIRST_FIRING,
    });
    expect(opened.episode).toMatchObject({
      status: "open",
      first_event_id: suspect.event.event_id,
      decision_count: 0,
      last_decision_sim_ts: null,
      ticket_id: null,
    });
    expect(closed.episode).toMatchObject({ status: "closed", close_reason: "silence" });
    // Never decided, so never paid for.
    expect(backend.asked).toEqual([]);
    expect(onContract(outputs)).toBe(true);
  });

  it("would have opened a ticket on the same blip without persistence (GATE_PERSIST_SIM_MIN=0)", async () => {
    const telemetry = batchesOf([...leadIn(), ...drainSide(120), ...cycles(BASELINE_CYCLE, 5)]);
    const backend = confidentBackend();
    const outputs = await replay(pipelineWith(backend, { persistSimMin: 0 }), telemetry);

    expect(shape(outputs).slice(0, 4)).toEqual([
      "suspect",
      "decision",
      "episode:opened",
      "ticket:opened",
    ]);
    expect(tickets(outputs)[0]).toMatchObject({ status: "open", opened_sim_ts: FIRST_FIRING });
    expect(decisions(outputs)[0]?.gate.persist_sim_min).toBe(0);
    expect(backend.asked).toEqual([FIRST_FIRING]);
  });

  it("decides sustained evidence on the frame it has persisted, and opens the ticket then", async () => {
    // Eight loaded minutes of drain-side evidence: it fires from 01:02 to 01:09.
    const telemetry = batchesOf([...leadIn(), ...drainSide(480), ...cycles(BASELINE_CYCLE, 1)]);
    const backend = confidentBackend();
    const outputs = await replay(pipelineWith(backend, TWO_MINUTES), telemetry);

    expect(shape(outputs).slice(0, 5)).toEqual([
      "suspect",
      "episode:opened",
      "suspect",
      "decision",
      "ticket:opened",
    ]);
    const [first, opened, again, decided, ticketed] = outputs as [
      OutputOf<"suspect">,
      OutputOf<"episode">,
      OutputOf<"suspect">,
      OutputOf<"decision">,
      OutputOf<"ticket">,
    ];
    const since = first.event.rules_fired[0]?.since_sim_ts ?? "";
    expect(since).toBe(FIRST_FIRING);
    expect(opened.episode.decision_count).toBe(0);
    // Two minutes of evidence, measured from the rule's own start: the first
    // frame at which it has lasted that long is the decision's.
    expect(again.event.sim_ts).toBe("2020-02-03T01:04:00.000Z");
    expect(simMinutesBetween(since, decided.decision.sim_ts)).toBe(2);
    // The output says how long the evidence had held, for the offline sweep to respect.
    expect(decided.persistedSimMin).toBe(2);
    expect(decided.decision).toMatchObject({
      episode_id: opened.episode.episode_id,
      event_id: again.event.event_id,
      choice: FAULT,
      gate: { outcome: "ticket", persist_sim_min: 2 },
    });
    expect(ticketed.ticket).toMatchObject({
      action: "opened",
      status: "open",
      episode_id: opened.episode.episode_id,
      opened_sim_ts: decided.decision.sim_ts,
      latest_decision_id: decided.decision.decision_id,
    });
    // One call: the first event was never decided on its own.
    expect(backend.asked).toEqual(["2020-02-03T01:04:00.000Z"]);
    expect(onContract(outputs)).toBe(true);
  });

  it("decides at exactly GATE_PERSIST_SIM_MIN of evidence, and not a second short of it", async () => {
    // Three loaded minutes: the rule fires on the frames of 01:02 and 01:03,
    // so the evidence has lasted exactly one minute on its last frame.
    const telemetry = batchesOf([...leadIn(), ...drainSide(180), ...cycles(BASELINE_CYCLE, 1)]);

    const exact = confidentBackend();
    const atBoundary = await replay(pipelineWith(exact, { persistSimMin: 1 }), telemetry);
    expect(exact.asked).toEqual(["2020-02-03T01:03:00.000Z"]);
    expect(tickets(atBoundary)[0]).toMatchObject({
      action: "opened",
      opened_sim_ts: "2020-02-03T01:03:00.000Z",
    });

    const short = confidentBackend();
    const past = await replay(pipelineWith(short, { persistSimMin: 1 + 1 / 60 }), telemetry);
    expect(short.asked).toEqual([]);
    expect(tickets(past)).toEqual([]);
    expect(decisions(past)).toEqual([]);
  });

  it("keeps updating a ticket that exists with evidence that does not persist", async () => {
    // A sustained run opens the ticket; 52 minutes after that decision the
    // same key blips for one minute while the episode is still open.
    const telemetry = batchesOf([
      ...leadIn(),
      ...drainSide(480),
      ...cycles(BASELINE_CYCLE, 1),
      ...drainSide(120),
      ...cycles(BASELINE_CYCLE, 1),
    ]);
    const backend = confidentBackend();
    const outputs = await replay(pipelineWith(backend), telemetry);

    const [opening, update] = tickets(outputs);
    expect(opening).toMatchObject({ action: "opened", status: "open" });
    expect(update).toMatchObject({
      action: "updated",
      ticket_id: opening?.ticket_id,
      update_count: 1,
    });
    const blip = decisions(outputs).find(
      (decision) => decision.decision_id === update?.latest_decision_id,
    );
    expect(blip?.episode_id).toBe(opening?.episode_id);
    // The blip was decided on its own first frame, zero minutes into its run.
    const blipEvent = ofType(outputs, "suspect").find(
      (output) => output.event.event_id === blip?.event_id,
    );
    expect(blipEvent?.event.rules_fired[0]?.since_sim_ts).toBe(blip?.sim_ts);
    // And its output says so: a decision a ticketless episode could not have taken, which
    // the offline sweep therefore never lets open a ticket.
    const blipOutput = ofType(outputs, "decision").find(
      (output) => output.decision.decision_id === blip?.decision_id,
    );
    expect(blipOutput?.persistedSimMin).toBe(0);
    expect(
      simMinutesBetween(opening?.opened_sim_ts ?? "", blip?.sim_ts ?? ""),
    ).toBeGreaterThanOrEqual(30);
    expect(ofType(outputs, "episode").map((output) => output.action)).toEqual(["opened"]);
    expect(onContract(outputs)).toBe(true);
  });

  it("merges a second symptom into the ticket only once that symptom's evidence has persisted", async () => {
    // Twenty loaded minutes at a flat line pressure with the purge side up:
    // `purge_pressure_high` fires from 01:02, and `stuck_loaded`
    // (continuous_load, first in the registry) takes over the primary key once
    // the run passes ten minutes.
    const telemetry = batchesOf([
      ...leadIn(),
      { mode: "loaded", seconds: 1200, fromBar: CUT_IN_BAR, toBar: 8.3, purgeBar: 1.5 },
      { mode: "unloaded", seconds: 400, fromBar: 8.3, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
      ...cycles(BASELINE_CYCLE, 1),
    ]);
    const backend = confidentBackend();
    const outputs = await replay(pipelineWith(backend, TWO_MINUTES), telemetry);

    const opened = ofType(outputs, "episode").filter((output) => output.action === "opened");
    expect(opened.map((output) => output.episode.symptom_key)).toEqual([
      "purge_pressure_high",
      "continuous_load",
    ]);
    const [owner, follower] = opened.map((output) => output.episode);
    expect(follower?.decision_count).toBe(0);

    // The follower's first event, and the decision that waited for it to persist.
    const followerEvent = ofType(outputs, "suspect").find(
      (output) => output.event.symptom_key === "continuous_load",
    );
    const followerSince =
      followerEvent?.event.rules_fired.find((hit) => hit.rule_id === "stuck_loaded")
        ?.since_sim_ts ?? "";
    const followerDecisions = decisions(outputs).filter(
      (decision) => decision.episode_id === follower?.episode_id,
    );
    expect(followerDecisions.length).toBeGreaterThan(0);
    expect(
      simMinutesBetween(followerSince, followerDecisions[0]?.sim_ts ?? ""),
    ).toBeGreaterThanOrEqual(2);
    expect(simMinutesBetween(followerSince, followerDecisions[0]?.sim_ts ?? "")).toBeLessThan(3);

    // That decision linked it, and it updated the owner's ticket: still one ticket.
    const merged = ofType(outputs, "episode").filter((output) => output.action === "merged");
    expect(merged.map((output) => output.episode)).toEqual([
      expect.objectContaining({
        episode_id: follower?.episode_id,
        merged_into: owner?.episode_id,
        ticket_id: null,
      }),
    ]);
    expect(new Set(tickets(outputs).map((ticket) => ticket.ticket_id)).size).toBe(1);
    const update = tickets(outputs).find(
      (ticket) => ticket.latest_decision_id === followerDecisions[0]?.decision_id,
    );
    expect(update).toMatchObject({ action: "updated", episode_id: owner?.episode_id });
    expect(onContract(outputs)).toBe(true);
  });

  it("starts the evidence over after a discontinuity", async () => {
    // Before the jump the purge side is up for 150 loaded seconds, the rule
    // firing for one minute (01:02–01:03) when the recording breaks off. Three
    // sim hours later, after a rest the warm-up guard needs, it is up again
    // for eight minutes.
    const before = runRows(
      [...leadIn(), { mode: "loaded", seconds: 150, fromBar: CUT_IN_BAR, toBar: 9.2, purgeBar: 1 }],
      { startSimTs: START },
    );
    const after = runRows(
      [
        { mode: "unloaded", seconds: 400, fromBar: 9.2, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
        { mode: "off", seconds: 200, fromBar: 8.74, decayBarPerMin: NORMAL_DECAY_BAR_PER_MIN },
        ...drainSide(480),
        ...cycles(BASELINE_CYCLE, 1),
      ],
      { startSimTs: "2020-02-03T04:00:00.000Z" },
    );
    const telemetry = toBatches([...before, ...after], {
      unitId: "cau-7",
      wallStartMs: Date.parse("2026-09-23T00:00:00.000Z"),
    });
    const backend = confidentBackend();
    // One minute of evidence either side would be enough if the jump bridged it.
    const outputs = await replay(pipelineWith(backend, { persistSimMin: 1.5 }), telemetry);

    const episodes = ofType(outputs, "episode");
    expect(episodes.map((output) => output.action)).toEqual(["opened", "aborted", "opened"]);
    const [first, aborted, second] = episodes.map((output) => output.episode);
    expect(aborted).toMatchObject({
      episode_id: first?.episode_id,
      decision_count: 0,
      ticket_id: null,
    });

    const [decided] = decisions(outputs);
    expect(decided?.episode_id).toBe(second?.episode_id);
    const secondEvent = ofType(outputs, "suspect").find(
      (output) => output.event.event_id === second?.first_event_id,
    );
    const since = secondEvent?.event.rules_fired[0]?.since_sim_ts ?? "";
    expect(simMinutesBetween(since, decided?.sim_ts ?? "")).toBeGreaterThanOrEqual(1.5);
    expect(tickets(outputs).map((ticket) => ticket.episode_id)).toEqual([second?.episode_id]);
    expect(backend.asked).toEqual([decided?.sim_ts]);
    expect(onContract(outputs)).toBe(true);
  });

  it("repeats GATE_PERSIST_SIM_MIN in every decision's gate block", async () => {
    const telemetry = batchesOf([...leadIn(), ...drainSide(480), ...cycles(BASELINE_CYCLE, 1)]);
    const outputs = await replay(pipelineWith(confidentBackend(), { persistSimMin: 3 }), telemetry);
    expect(decisions(outputs).length).toBeGreaterThan(0);
    for (const decision of decisions(outputs)) {
      expect(decision.gate.persist_sim_min).toBe(3);
      expect(simMinutesBetween(FIRST_FIRING, decision.sim_ts)).toBeGreaterThanOrEqual(3);
    }
  });
});
