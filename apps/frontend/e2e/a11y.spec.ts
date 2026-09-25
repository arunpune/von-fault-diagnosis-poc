// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Accessibility checks with axe: three states of the page in both themes, six checks, and none
// may report a serious or critical violation. Nothing is excluded from the scan.
//
//   1. the main page after Play, with the recorder drawing;
//   2. the decision sheet of the air-leak decision;
//   3. the ticket sheet that decision links to.
//
// The theme is set the way a user's choice persists, in the `fdp.ui:v1` preference that
// index.html reads before the first paint, and the browser's colour scheme is emulated to
// match. The dark tokens are the half most likely to miss the 4.5:1 and 3:1 targets. Each state
// is a soft assertion, so one failing state does not hide the others.
//
// Every scan sees the page at rest. A half-faded sheet or toast has a lower contrast than the
// settled one, and a toast may start fading out in the middle of a scan, so the browser asks
// for reduced motion: index.css then cuts every animation and transition to nothing, and an
// element is either there or not. The pointer moves to the status bar's empty corner before each
// scan, so no control is scanned in its hover state just because the last click left the pointer
// on it.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./helpers.ts";

import { tid } from "@/lib/testids";

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

/** The impacts that fail a check; minor and moderate ones do not. */
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(["serious", "critical"]);

/** The key src/store/ui-prefs.ts and index.html read the theme from. */
const UI_PREFS_KEY = "fdp.ui:v1";

const F3_PRESET = "Air leak – 5 Jun 2020";
/** The fastest replay: the air-leak decision follows the jump within two seconds of wall time. */
const FASTEST_SPEED = 3600;
/** Where the pointer rests during a scan: the status bar's padding, which nothing reacts to. */
const RESTING_POINTER = { x: 2, y: 2 } as const;

/** How many offending nodes a failure message lists per rule, and how much of each one's HTML. */
const NODES_SHOWN = 3;
const HTML_SHOWN = 160;

type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

/** Runs in the page before any of its scripts (page.addInitScript). */
function seedTheme({ key, theme }: { key: string; theme: Theme }): void {
  window.localStorage.setItem(key, JSON.stringify({ theme }));
}

/** One line per rule: impact, id, what it asks for and the first offending nodes. */
function describeViolation(violation: AxeViolation): string {
  const nodes = violation.nodes
    .slice(0, NODES_SHOWN)
    .map((node) =>
      `${node.target.join(" ")} ${node.html.slice(0, HTML_SHOWN)}: ${node.failureSummary ?? ""}`.replace(
        /\s+/g,
        " ",
      ),
    )
    .join(" | ");
  return `${violation.impact ?? "unknown"} ${violation.id} (${violation.help}), ${violation.nodes.length} node(s): ${nodes}`;
}

/**
 * Scans the page at rest and returns its serious and critical violations; the moderate and minor
 * ones become annotations of the test, so the report still lists them.
 */
async function blockingViolations(page: Page, state: string): Promise<string[]> {
  await page.mouse.move(RESTING_POINTER.x, RESTING_POINTER.y);
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking: string[] = [];
  for (const violation of violations) {
    if (BLOCKING_IMPACTS.has(violation.impact ?? "")) {
      blocking.push(describeViolation(violation));
    } else {
      test.info().annotations.push({
        type: `axe, not blocking (${state})`,
        description: describeViolation(violation),
      });
    }
  }
  return blocking;
}

for (const theme of THEMES) {
  test.describe(`the ${theme} theme`, () => {
    test.use({ colorScheme: theme, reducedMotion: "reduce" });

    test.beforeEach(async ({ page, fakeBackend }) => {
      await fakeBackend?.reset();
      await page.addInitScript(seedTheme, { key: UI_PREFS_KEY, theme });
    });

    test("has no serious or critical axe violation after Play and with either sheet open", async ({
      page,
      profile,
    }) => {
      await page.goto("/");
      await expect(page.getByTestId(tid.status.theme)).toHaveAccessibleName(
        new RegExp(`^Theme: ${theme}\\.`),
      );
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
        theme === "dark",
      );

      await test.step("the main page after Play", async () => {
        const speed = await page.request.post("/api/sim/speed", {
          data: { args: { speed: FASTEST_SPEED } },
        });
        expect(speed.ok()).toBe(true);
        await page.getByRole("button", { name: "Play", exact: true }).click();
        await expect(page.getByTestId(tid.status.state)).toContainText("playing");
        await expect(page.getByTestId(tid.recorder.lane("TP3"))).toBeVisible();
        const state = `${theme}: main page after Play`;
        expect.soft(await blockingViolations(page, state), state).toEqual([]);
      });

      const decisionSheet = page.getByTestId(tid.decision.sheet);

      await test.step("the decision sheet", async () => {
        await page.getByRole("button", { name: "Jump to" }).click();
        await page.getByRole("menuitem", { name: F3_PRESET }).click();
        const decision = page
          .getByTestId(tid.alerts.list)
          .getByTestId(new RegExp(`^${tid.alerts.item("decision-")}`))
          .first();
        await expect(decision).toBeVisible({ timeout: profile.decisionTimeoutMs });
        await decision.getByRole("link").click();
        await expect(decisionSheet.getByTestId(tid.decision.ticketLink)).toBeVisible();
        const state = `${theme}: decision sheet`;
        expect.soft(await blockingViolations(page, state), state).toEqual([]);
      });

      await test.step("the ticket sheet", async () => {
        await decisionSheet.getByTestId(tid.decision.ticketLink).click();
        const ticketSheet = page.getByTestId(tid.tickets.sheet);
        await expect(ticketSheet.getByRole("button", { name: "Close ticket" })).toBeVisible();
        const state = `${theme}: ticket sheet`;
        expect.soft(await blockingViolations(page, state), state).toEqual([]);
      });
    });
  });
}
