// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The README's "Try it in five minutes" as an end-to-end test, step by step, with role and name
// locators and the test ids of src/lib/testids.ts only — no CSS selector, no DOM structure:
//
//   1. Play: the replay plays at 600×, the recorder draws its lanes, the sim clock moves and the
//      status bar names the decision backend, Jev with jev-1.13.0.
//   2. Jump to "Air leak – 5 Jun 2020": a toast, the jump marker, the recorder re-anchored on
//      5 June, signature A (the unit stays loaded, purge pressure far above its resting value)
//      and, once the replay passes 10:00, the band of dataset failure F3.
//   3. Alerts: a suspect event, then a decision with its severity badge and confidence.
//   4. The decision sheet: the backend and model, candidates with probabilities, the manual
//      section, the ticket link, and the open ticket it leads to.
//   5. Inject fault → "Oil cooler fouling": a toast, the running-injection badge, the injected
//      band and a decision that weighs the injected fault; then the replay pauses, so nothing
//      ends an episode while the tour reads the cost and closes a ticket.
//   6. Cost: a ledger row per decision, the running total, the prices' date.
//
// Then a ticket is closed as correct. Two more tests need the fake backend's control API and are
// skipped against the stack: the same air leak under the rules backend opens a ticket in review
// that takes a verdict, and a WebSocket restart flips the link lamp to reconnecting and back.
//
// The `mode` fixture of helpers.ts carries the timeouts and the fake's control API; `EXPECTED`
// below carries what the two backends answer differently. The Compose stack also keeps the
// records of earlier runs (`make smoke`'s own tour, an earlier `make e2e`), so the tour finds its
// decisions by the ids that were not there before it acted, never by their place in the feed.

import type { APIRequestContext, Locator, Page } from "@playwright/test";

import {
  expect,
  listDecisions,
  test,
  timingSlack,
  type E2EMode,
  type ModeProfile,
} from "./helpers.ts";

import type { ApiCost, CatalogEntry, Decision, OverlayInjectionActive } from "@/api/types";
import { tid } from "@/lib/testids";

/** The README's replay speed: ten simulated minutes per wall second. */
const README_SPEED = 600;

/** Both backends answer the tour with Jev: the fake by script, the stack through its mock. */
const DECISION_BACKEND = "Jev · jev-1.13.0";

const F3_PRESET = "Air leak – 5 Jun 2020";
const F3_DAY = "2020-06-05";
/** Where the jump lands: the preset's 10:00 minus its four-hour lead-in. */
const F3_LANDING = "2020-06-05T06:00";
/** Minutes from the landing to the start of dataset failure F3, where its band begins. */
const F3_WINDOW_AFTER_MIN = 240;

const OIL_COOLER = "Oil cooler fouling";
const OIL_COOLER_INJECTION = "oil_cooler_fouling";
const OIL_COOLER_FAULT = "oil_cooler_fouled";
/** Simulated minutes an injection may take to be decided: the stack's took 150. */
const INJECTION_DECIDED_WITHIN_MIN = 240;

/** Signature A as scripts/smoke.sh words it: loaded without a break for half an hour… */
const STUCK_LOADED_MIN = 30;
/** …with the dryer purge pressure above a bar (it rests at −0.02 bar). */
const PURGE_HIGH_BAR = 1;
const PURGE_SIGNAL = "Dryer purge pressure";

const LANES = ["TP3", "H1", "Oil_temperature", "Motor_current", "state"] as const;

/** fmtUsd rounds to six decimals, so each ledger row may be off by half a micro-dollar. */
const USD_ROUNDING = 0.5e-6;

interface TourExpectations {
  /** The first decision's severity badge and confidence, as the alerts feed shows them. */
  readonly severity: string | RegExp;
  readonly confidence: string | RegExp;
  /** The candidate causes the first decision weighed; null when the backend decides. */
  readonly candidates: number | null;
  /**
   * Ledger rows after the tour, all of them billed by this run; null when the backend holds the
   * decisions of earlier runs too, and the ledger shows only the newest.
   */
  readonly ledgerRows: number | null;
  /** The preset the replay jumps to before the injection; null to inject where it plays. */
  readonly injectionPreset: string | null;
  /** Whether the injection runs at its largest magnitude instead of the dialog's default. */
  readonly injectionAtMaximum: boolean;
  /** Whether the injected fault is the chosen cause, or only one the decision weighed. */
  readonly injectedChosen: boolean;
}

const EXPECTED: Readonly<Record<E2EMode, TourExpectations>> = {
  // The fake's scripted decisions.
  mock: {
    severity: "high",
    confidence: "91 %",
    candidates: 3,
    ledgerRows: 2,
    injectionPreset: null,
    injectionAtMaximum: false,
    injectedChosen: true,
  },
  // The stack's mock Jev answers by best overlap at 0.9, and an open episode is decided again at
  // every decision interval. Its fixture slice holds 06:00–14:00 of 5 June, where the injected
  // oil temperature never trips a rule before the segment ends, and six hours of February, where
  // it does at full magnitude after about 150 simulated minutes: the choice scripts/smoke.sh
  // makes too. Best overlap then ties oil_cooler_fouled with cooling_fan_failure, whose expected
  // moves differ only in words no observation carries, and gives the tie to the smaller id.
  stack: {
    severity: /^(low|medium|high|critical)$/,
    confidence: "90 %",
    candidates: null,
    ledgerRows: null,
    injectionPreset: "Normal operation – 1 Feb 2020",
    injectionAtMaximum: true,
    injectedChosen: false,
  },
};

/** A test id pattern for the ids that start with `prefix` (built from the registry). */
function testIdStartingWith(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/** Wall time for the replay to cover `simMinutes` at the README's speed, plus the mode's bound. */
function afterSim(profile: ModeProfile, simMinutes: number): number {
  return profile.decisionTimeoutMs + ((simMinutes * 60_000) / README_SPEED) * timingSlack();
}

/** The alerts feed's items of one kind, newest first (keys `<kind>-<id>`). */
function feedItems(page: Page, kind: "suspect" | "decision" | "ticket"): Locator {
  return page
    .getByTestId(tid.alerts.list)
    .getByTestId(testIdStartingWith(tid.alerts.item(`${kind}-`)));
}

/** One record's item in the alerts feed. */
function feedItem(page: Page, kind: "suspect" | "decision", id: string): Locator {
  return page.getByTestId(tid.alerts.list).getByTestId(tid.alerts.item(`${kind}-${id}`));
}

/** The ids of every decision the backend holds right now. */
async function decisionIds(request: APIRequestContext): Promise<ReadonlySet<string>> {
  return new Set((await listDecisions(request)).map((decision) => decision.decision_id));
}

/**
 * The earliest decision in data time that `known` does not hold and `accept` takes, or null while
 * there is none: the first answer to what the tour just did.
 */
async function firstNewDecision(
  request: APIRequestContext,
  known: ReadonlySet<string>,
  accept: (decision: Decision) => boolean,
): Promise<Decision | null> {
  const fresh = (await listDecisions(request)).filter(
    (decision) => !known.has(decision.decision_id) && accept(decision),
  );
  return fresh.at(-1) ?? null;
}

/** Polls until `find` returns a decision, then returns it. */
async function waitForDecision(
  find: () => Promise<Decision | null>,
  timeout: number,
  what: string,
): Promise<Decision> {
  const last: { decision: Decision | null } = { decision: null };
  await expect
    .poll(
      async () => {
        last.decision = await find();
        return last.decision !== null;
      },
      { timeout, message: `waiting for ${what}` },
    )
    .toBe(true);
  if (last.decision === null) {
    throw new Error(`no ${what}`);
  }
  return last.decision;
}

/** The UTC day of the recorder's newest point (`data-sim-now`, epoch ms), or null before data. */
async function recorderDay(recorder: Locator): Promise<string | null> {
  const simNow = await recorder.getAttribute("data-sim-now");
  return simNow === null ? null : new Date(Number(simNow)).toISOString().slice(0, 10);
}

const STATE_SEGMENT =
  /(Loaded|Unloaded|Off), (?:\d\d-\d\d )?(\d\d):(\d\d)–(?:\d\d-\d\d )?(\d\d):(\d\d)/g;

/**
 * How long the unit has been loaded without a break: the newest segment of the state row, read
 * from its native tooltip ("Loaded, 06:00–07:12"); 0 while the newest segment is not "Loaded".
 */
async function loadedRunMinutes(stateRow: Locator): Promise<number> {
  const segments = [...((await stateRow.textContent()) ?? "").matchAll(STATE_SEGMENT)];
  const newest = segments.at(-1);
  if (newest?.[1] !== "Loaded") {
    return 0;
  }
  const [fromH, fromM, toH, toM] = newest.slice(2).map(Number);
  const minutes = (toH ?? 0) * 60 + (toM ?? 0) - ((fromH ?? 0) * 60 + (fromM ?? 0));
  return minutes < 0 ? minutes + 24 * 60 : minutes;
}

/** A lane header's readout for one series, e.g. "Dryer purge pressure 2.10"; null when absent. */
async function readout(lane: Locator, series: string): Promise<number | null> {
  const text = (await lane.textContent()) ?? "";
  const match = new RegExp(`${series}\\s*([−-]?\\d+(?:\\.\\d+)?)`).exec(text);
  return match?.[1] === undefined ? null : Number(match[1].replace("−", "-"));
}

/** "$0.000252" → 0.000252. */
function usd(text: string | null): number {
  return Number((text ?? "").replace(/[$,\s]/g, "").replace("−", "-"));
}

/** What the ledger's rows cost together, read from their last cells. */
async function ledgerSum(rows: Locator): Promise<{ sum: number; count: number }> {
  const all = await rows.all();
  let sum = 0;
  for (const row of all) {
    sum += usd(await row.getByRole("cell").last().textContent());
  }
  return { sum, count: all.length };
}

/**
 * True when the running total equals the sum of the ledger's cost column within the rounding of
 * the rows, and something was spent: every billed decision is a row.
 */
async function totalIsLedgerSum(rows: Locator, total: Locator): Promise<boolean> {
  const { sum, count } = await ledgerSum(rows);
  const running = usd(await total.textContent());
  return running > 0 && Math.abs(sum - running) <= count * USD_ROUNDING;
}

/**
 * True when the running total is the backend's and covers the ledger's rows: on the stack the
 * ledger shows the newest billed decisions only, the total every one of them.
 */
async function totalCoversLedger(
  rows: Locator,
  total: Locator,
  request: APIRequestContext,
): Promise<boolean> {
  const { sum, count } = await ledgerSum(rows);
  const running = usd(await total.textContent());
  const { totals } = (await (await request.get("/api/cost")).json()) as ApiCost;
  return (
    running > 0 &&
    Math.abs(running - totals.usd) <= USD_ROUNDING &&
    sum <= running + count * USD_ROUNDING
  );
}

declare global {
  interface Window {
    /** Bound by `recordLampText`: the link lamp's text after each change. */
    fdpRecordLinkLamp?: (text: string) => Promise<void>;
  }
}

/**
 * Records the link lamp's text after every change from now on. The lamp says "reconnecting"
 * for about half a second after a restart, less than a polling assertion may need to see it.
 */
async function recordLampText(page: Page, lamp: Locator): Promise<readonly string[]> {
  const seen: string[] = [];
  await page.exposeFunction("fdpRecordLinkLamp", (text: string) => {
    seen.push(text);
  });
  await lamp.evaluate((element) => {
    new MutationObserver(() => {
      void window.fdpRecordLinkLamp?.(element.textContent ?? "");
    }).observe(element, { attributes: true, characterData: true, childList: true, subtree: true });
  });
  return seen;
}

async function play(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Play", exact: true }).click();
}

async function jumpTo(page: Page, preset: string): Promise<void> {
  await page.getByRole("button", { name: "Jump to" }).click();
  await page.getByRole("menuitem", { name: preset }).click();
  await expect(page.getByText(`Jumped to ${preset}`)).toBeVisible();
}

/** The instance id of the running injection of `injectionId`, as the overlay reports it. */
async function runningInstance(page: Page, injectionId: string): Promise<string | null> {
  const response = await page.request.get("/api/overlay/active");
  const { active } = (await response.json()) as OverlayInjectionActive;
  return active.find((running) => running.injection_id === injectionId)?.instance_id ?? null;
}

/** Follows the decision sheet's ticket link and returns the ticket's short id. */
async function openLinkedTicket(page: Page, decisionSheet: Locator): Promise<string> {
  const link = decisionSheet.getByTestId(tid.decision.ticketLink);
  await expect(link).toHaveText(/^Ticket #\S+$/);
  const ticketId = ((await link.textContent()) ?? "").replace(/^Ticket #/, "");
  await link.click();
  await expect(page.getByTestId(tid.tickets.sheet)).toBeVisible();
  await expect(decisionSheet).toBeHidden();
  return ticketId;
}

async function closeTicketAsCorrect(sheet: Locator): Promise<void> {
  await sheet.getByRole("radio", { name: "Correct" }).check();
  await sheet.getByRole("button", { name: "Close ticket" }).click();
}

test.beforeEach(async ({ fakeBackend }) => {
  // The fake holds one scenario for the whole run; the stack is reset by stack.setup.ts.
  await fakeBackend?.reset();
});

test("the README tour, step by step, ends with a ticket closed as correct", async ({
  page,
  mode,
  profile,
}) => {
  test.slow(mode === "mock", "the tour waits for four simulated hours at 600× and more");
  const expected = EXPECTED[mode];
  const recorder = page.getByTestId(tid.recorder.root);
  const decisionSheet = page.getByTestId(tid.decision.sheet);
  const ticketSheet = page.getByTestId(tid.tickets.sheet);

  await page.goto("/");

  await test.step("1. Play: the replay plays at 600× and the recorder draws", async () => {
    await play(page);
    const state = page.getByTestId(tid.status.state);
    await expect(state).toContainText("playing");
    await expect(state).toContainText(`${README_SPEED}×`);
    await expect(page.getByTestId(tid.status.backend)).toHaveText(DECISION_BACKEND);
    for (const lane of LANES) {
      await expect(page.getByTestId(tid.recorder.lane(lane))).toBeVisible();
    }
    const clock = page.getByTestId(tid.status.clock);
    const started = (await clock.textContent()) ?? "";
    await expect(clock).not.toHaveText(started);
  });

  // The decisions taken before the jump: an earlier run's, on the stack.
  const beforeJump =
    await test.step(`2. Jump to ${F3_PRESET}: the recorder re-anchors on signature A`, async () => {
      const known = await decisionIds(page.request);
      await jumpTo(page, F3_PRESET);
      // A vertical line has an empty bounding box, so the marker is drawn when it is attached.
      await expect(
        recorder.getByTestId(testIdStartingWith(tid.recorder.marker(`jump-${F3_LANDING}`))),
      ).toBeAttached();
      await expect.poll(() => recorderDay(recorder)).toBe(F3_DAY);
      await expect(page.getByTestId(tid.status.clock)).toContainText(F3_DAY);

      // The time under the pointer, as the lane's tooltip reads it, is on the day of the jump.
      const pressure = page.getByTestId(tid.recorder.lane("TP3"));
      const box = await pressure.boundingBox();
      await pressure.hover({
        position: { x: (box?.width ?? 0) * 0.9, y: (box?.height ?? 0) - 30 },
      });
      await expect(pressure).toContainText(`${F3_DAY} `);
      await page.mouse.move(0, 0);

      const stuckBy = afterSim(profile, F3_WINDOW_AFTER_MIN + STUCK_LOADED_MIN);
      await expect
        .poll(() => loadedRunMinutes(page.getByTestId(tid.recorder.lane("state"))), {
          timeout: stuckBy,
        })
        .toBeGreaterThanOrEqual(STUCK_LOADED_MIN);
      await expect
        .poll(() => readout(page.getByTestId(tid.recorder.lane("H1")), PURGE_SIGNAL), {
          timeout: stuckBy,
        })
        .toBeGreaterThan(PURGE_HIGH_BAR);

      await expect(recorder.getByTestId(tid.recorder.band("F3"))).toBeVisible({
        timeout: afterSim(profile, F3_WINDOW_AFTER_MIN),
      });
      return known;
    });

  const airLeak = await test.step("3. Alerts: a suspect event, then a decision", async () => {
    const decision = await waitForDecision(
      () => firstNewDecision(page.request, beforeJump, (found) => found.sim_ts >= F3_LANDING),
      profile.decisionTimeoutMs,
      "the first decision after the jump",
    );
    const suspect = feedItem(page, "suspect", decision.event_id);
    await expect(suspect).toBeVisible();
    await expect(suspect).toContainText("Suspect: ");
    const item = feedItem(page, "decision", decision.decision_id);
    await expect(item).toBeVisible();
    await expect(item.getByTitle(/^Severity: /)).toHaveText(expected.severity);
    await expect(item).toContainText(expected.confidence);
    return decision;
  });

  const airLeakTicket =
    await test.step("4. Open the alert: candidates, the manual and the ticket", async () => {
      await feedItem(page, "decision", airLeak.decision_id).getByRole("link").click();
      await expect(decisionSheet).toBeVisible();
      await expect(decisionSheet.getByText(DECISION_BACKEND, { exact: true })).toBeVisible();
      const probabilities = decisionSheet
        .getByRole("list", { name: "Candidate causes" })
        .getByRole("progressbar", { name: /^Probability of / });
      if (expected.candidates === null) {
        await expect(probabilities.first()).toBeVisible();
      } else {
        // Every candidate, and "none of these" last.
        await expect(probabilities).toHaveCount(expected.candidates + 1);
      }
      for (const bar of await probabilities.all()) {
        await expect(bar).toHaveAttribute("aria-valuetext", /^\d{1,3} %$/);
      }
      await expect(decisionSheet.getByText(/^§8\./).first()).toBeVisible();

      const ticket = await openLinkedTicket(page, decisionSheet);
      await expect(ticketSheet.getByTitle("Status: open")).toBeVisible();
      await expect(ticketSheet.getByRole("heading", { name: "Checks" })).toBeVisible();
      await expect(ticketSheet.getByText(/^§8\./)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(ticketSheet).toBeHidden();
      return ticket;
    });

  const injected =
    await test.step(`5. Inject fault → ${OIL_COOLER}: a decision for the injected fault`, async () => {
      const beforeInjection = await decisionIds(page.request);
      if (expected.injectionPreset !== null) {
        await jumpTo(page, expected.injectionPreset);
      }
      await page.getByRole("button", { name: "Inject fault" }).click();
      await page.getByRole("menuitemcheckbox", { name: OIL_COOLER }).click();
      const dialog = page.getByRole("dialog", { name: `Inject ${OIL_COOLER}` });
      if (expected.injectionAtMaximum) {
        await dialog.getByRole("slider", { name: "Magnitude" }).press("End");
      }
      await dialog.getByRole("button", { name: "Inject", exact: true }).click();
      await expect(page.getByText(`Injected ${OIL_COOLER}`)).toBeVisible();
      await expect(page.getByTestId(tid.sim.active)).toContainText(`${OIL_COOLER} since`);
      await expect.poll(() => runningInstance(page, OIL_COOLER_INJECTION)).not.toBeNull();
      const band = recorder.getByTestId(
        tid.recorder.band((await runningInstance(page, OIL_COOLER_INJECTION)) ?? ""),
      );
      await expect(band).toBeVisible();
      await expect(band).toContainText(`Injected fault: ${OIL_COOLER}`);

      const decision = await waitForDecision(
        () =>
          firstNewDecision(page.request, beforeInjection, (found) =>
            found.candidates.some((candidate) => candidate.fault_id === OIL_COOLER_FAULT),
          ),
        afterSim(profile, INJECTION_DECIDED_WITHIN_MIN),
        `a decision that weighs ${OIL_COOLER_FAULT}`,
      );
      const item = feedItem(page, "decision", decision.decision_id);
      await expect(item).toBeVisible();
      if (expected.injectedChosen) {
        // The feed names a decision by its cause, which the catalog holds under the fault id.
        const catalog = await page.request.get(`/api/catalog/faults/${OIL_COOLER_FAULT}`);
        expect(catalog.ok()).toBe(true);
        const { name } = (await catalog.json()) as CatalogEntry;
        await expect(item).toContainText(name);
      }
      await item.getByRole("link").click();
      const candidate = decisionSheet.getByTestId(tid.decision.candidate(OIL_COOLER_FAULT));
      await expect(candidate).toBeVisible();
      if (expected.injectedChosen) {
        await expect(candidate).toContainText("Chosen");
      }
      const ticket = await openLinkedTicket(page, decisionSheet);
      await expect(ticketSheet.getByTitle("Status: open")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(ticketSheet).toBeHidden();

      // Nothing may end an episode while the tour reads the cost and closes a ticket.
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByTestId(tid.status.state)).toContainText("paused");
      return { decision, ticket };
    });

  await test.step("6. Cost: a row per decision, and the running total", async () => {
    await page.getByTestId(tid.cost.tab).click();
    const rows = page
      .getByRole("table", { name: "Cost per decision, newest first" })
      .getByRole("row")
      .filter({ has: page.getByRole("cell") });
    const total = page.getByTestId(tid.cost.total);
    for (const { decision_id: id } of [airLeak, injected.decision]) {
      await expect(page.getByTestId(tid.cost.row(id))).toBeVisible();
    }
    if (expected.ledgerRows === null) {
      await expect.poll(() => totalCoversLedger(rows, total, page.request)).toBe(true);
    } else {
      await expect(rows).toHaveCount(expected.ledgerRows);
      await expect.poll(() => totalIsLedgerSum(rows, total)).toBe(true);
    }
    await expect(page.getByTestId(tid.cost.prices)).toContainText(/prices as of \d{4}-\d{2}-\d{2}/);
  });

  // A jump ends the air-leak episode and resolves its ticket, so after one the tour closes the
  // injected fault's ticket instead.
  const closing = expected.injectionPreset === null ? airLeakTicket : injected.ticket;

  await test.step(`Close ticket #${closing} as correct`, async () => {
    await page.getByTestId(tid.tickets.tab).click();
    await page.getByRole("link", { name: `Open ticket #${closing}` }).click();
    await closeTicketAsCorrect(ticketSheet);
    await expect(page.getByText(`Ticket #${closing} closed as correct`)).toBeVisible();
    await expect(ticketSheet.getByTitle("Verdict: correct")).toBeVisible();
  });
});

test("rules backend: the air leak opens a ticket in review that takes a verdict", async ({
  page,
  fakeBackend,
  profile,
}) => {
  test.skip(fakeBackend === null, "choosing the decision backend needs the fake's control API");
  await fakeBackend?.reset("rules");
  await page.goto("/");
  await expect(page.getByTestId(tid.status.backend)).toHaveText("Rules");

  await play(page);
  await jumpTo(page, F3_PRESET);
  const decision = feedItems(page, "decision").first();
  await expect(decision).toContainText("Review", { timeout: profile.decisionTimeoutMs });
  await expect(feedItems(page, "ticket").first()).toContainText("In review");

  await page.getByTestId(tid.review.tab).click();
  const row = page.getByTestId(testIdStartingWith(tid.review.row("")));
  await expect(row).toHaveCount(1);
  await row.getByRole("link").click();
  const sheet = page.getByTestId(tid.tickets.sheet);
  await expect(sheet.getByTitle("Status: review")).toBeVisible();
  await closeTicketAsCorrect(sheet);
  await expect(page.getByText(/^Ticket #\S+ closed as correct$/)).toBeVisible();
  await expect(sheet.getByTitle("Status: closed")).toBeVisible();
  await expect(sheet.getByTitle("Verdict: correct")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(0);
  await expect(page.getByText(/^Nothing to review\./)).toBeVisible();
});

test("a WebSocket restart flips the link lamp to reconnecting and back to open", async ({
  page,
  fakeBackend,
  profile,
}) => {
  test.skip(fakeBackend === null, "restarting the sockets needs the fake's control API");
  await page.goto("/");
  const lamp = page.getByTestId(tid.status.link);
  await expect(lamp).toHaveAttribute("data-lamp", "ok");

  const seen = await recordLampText(page, lamp);
  const deadline = Date.now() + profile.reconnectTimeoutMs;
  await fakeBackend?.restartWs();
  await expect
    .poll(() => seen.some((text) => text.includes("reconnecting")), {
      timeout: profile.reconnectTimeoutMs,
    })
    .toBe(true);
  // A timeout of 0 would mean no limit at all.
  await expect(lamp).toHaveAttribute("data-lamp", "ok", {
    timeout: Math.max(deadline - Date.now(), 1),
  });
  await expect(lamp).toContainText("open");
});
