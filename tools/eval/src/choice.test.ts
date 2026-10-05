// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The committed record of the pre-registered choice: what
// `fdp-eval sweep --preregistered --record-choice` writes to
// tools/eval/records/von-thresholds-choice.md, and what the held-out set's one run reads back.
// Every record here is synthetic and written to a temporary directory; no sweep is replayed and
// no Von figure appears.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  CHOICE_RECORD_FILE,
  ChoiceRecordError,
  choiceRecordPath,
  parseChoiceRecord,
  readChoiceRecord,
  renderChoiceRecord,
} from "./choice.ts";
import type { ChoiceRecordInput } from "./choice.ts";
import { REPO_ROOT } from "./slices.ts";

const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "fdp-choice-"));
  temporary.push(directory);
  return directory;
}

const INPUT: ChoiceRecordInput = {
  triple: { persistSimMin: 0, reviewMin: 0.55, ticketMin: 0.9 },
  outcome: "change",
  recordedAt: new Date("2026-09-26T08:00:00.000Z"),
  preregistrationCommit: "0123456789abcdef0123456789abcdef01234567",
  report: "reports/eval/sweep/preregistered-sweep.md",
  recordings: [
    { persistSimMin: 0, runs: ["20260926-070000-tuning"], gitSha: "a".repeat(40) },
    {
      persistSimMin: 1,
      runs: ["20260926-070100-tuning", "20260926-070200-tuning"],
      gitSha: "a".repeat(40),
    },
  ],
  catalog: { name: "reference", sha256: "c".repeat(64) },
};

describe("the choice record", () => {
  it("lives at tools/eval/records/von-thresholds-choice.md", () => {
    expect(CHOICE_RECORD_FILE).toBe("tools/eval/records/von-thresholds-choice.md");
    expect(choiceRecordPath()).toBe(join(REPO_ROOT, CHOICE_RECORD_FILE));
  });

  it("writes the triple as the three variables the held-out run sets, and reads it back", () => {
    const text = renderChoiceRecord(INPUT);
    expect(text).toContain("GATE_PERSIST_SIM_MIN=0\n");
    expect(text).toContain("VON_GATE_REVIEW_MIN_CONFIDENCE=0.55\n");
    expect(text).toContain("VON_GATE_TICKET_MIN_CONFIDENCE=0.90\n");
    /* REUSE-IgnoreStart */
    expect(text).toContain("SPDX-License-Identifier: CC-BY-4.0");
    /* REUSE-IgnoreEnd */
    expect(text).toContain("20260926-070200-tuning");
    expect(text).toContain(INPUT.preregistrationCommit ?? "");
    expect(text).toContain("tools/eval/records/von-thresholds-preregistration.md");
    expect(text).toContain("after the E3 and E4 results had been seen");
    expect(parseChoiceRecord(text, "choice.md")).toEqual(INPUT.triple);
  });

  it("carries no figure of Von's, only the triple and where it came from", () => {
    const text = renderChoiceRecord(INPUT);
    expect(text).not.toMatch(/positives? passed|false tickets? per|per negative machine-day/);
    // Every clause of the rule is a statement about Von's figures, so none is written down.
    expect(text).not.toMatch(/decided by|clause \d|constraint/i);
  });

  it("reads a kept incumbent the same way", () => {
    const text = renderChoiceRecord({
      ...INPUT,
      outcome: "keep",
      triple: { persistSimMin: 1, reviewMin: 0.6, ticketMin: 0.85 },
    });
    expect(text).toContain("keep");
    expect(parseChoiceRecord(text, "choice.md")).toEqual({
      persistSimMin: 1,
      reviewMin: 0.6,
      ticketMin: 0.85,
    });
  });

  it.each([
    ["a variable missing", (text: string) => text.replace(/^GATE_PERSIST_SIM_MIN=.*\n/m, "")],
    ["a variable given twice", (text: string) => `${text}\nVON_GATE_TICKET_MIN_CONFIDENCE=0.95\n`],
    [
      "a value that is not a number",
      (text: string) =>
        text.replace(/^VON_GATE_REVIEW_MIN_CONFIDENCE=.*$/m, "VON_GATE_REVIEW_MIN_CONFIDENCE=high"),
    ],
    [
      "a review threshold above the ticket threshold",
      (text: string) =>
        text.replace(/^VON_GATE_REVIEW_MIN_CONFIDENCE=.*$/m, "VON_GATE_REVIEW_MIN_CONFIDENCE=0.95"),
    ],
  ])("refuses a record with %s, naming it", (_name, change) => {
    expect(() => parseChoiceRecord(change(renderChoiceRecord(INPUT)), "bad.md")).toThrow(
      ChoiceRecordError,
    );
    expect(() => parseChoiceRecord(change(renderChoiceRecord(INPUT)), "bad.md")).toThrow(
      /^bad\.md: /,
    );
  });

  it("reads nothing from a record that does not exist, and the triple from one that does", () => {
    const directory = scratch();
    const path = join(directory, "von-thresholds-choice.md");
    expect(readChoiceRecord(path)).toBeUndefined();
    writeFileSync(path, renderChoiceRecord(INPUT), "utf8");
    expect(readChoiceRecord(path)).toEqual(INPUT.triple);
  });
});
