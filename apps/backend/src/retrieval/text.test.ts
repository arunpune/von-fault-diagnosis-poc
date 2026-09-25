// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stand-in's words (stage 2 of retrieval).
 *
 * Every expected stem below is what PostgreSQL 18's `ts_lexize('english_stem',
 * …)` answers in the pgvector image, so the table pins the algorithm's
 * revision as well as its rules; `test/integration/retrieval.test.ts` asks the
 * database itself about every word of its fixture texts. One or two words per
 * rule is enough here: the published algorithm, not a word list, is what is
 * being tested.
 */

import { describe, expect, it } from "vitest";

import { ENGLISH_STOP_WORDS } from "./english-stop.ts";
import { MIN_WORD_LENGTH, lexemes, stem } from "./text.ts";

/** Word → the lexeme PostgreSQL 18's `english_stem` gives it. */
const POSTGRES_STEMS: readonly (readonly [string, string])[] = [
  // Step 1a: plurals.
  ["pressures", "pressur"],
  ["valves", "valv"],
  ["cries", "cri"],
  ["ties", "tie"],
  ["gaps", "gap"],
  ["gas", "gas"],
  ["kiwis", "kiwi"],
  ["bus", "bus"],
  // Step 1b: -ed and -ing, with the e restored and the double undone.
  ["loaded", "load"],
  ["rising", "rise"],
  ["rises", "rise"],
  ["hoping", "hope"],
  ["hopping", "hop"],
  ["filing", "file"],
  ["agreed", "agre"],
  ["feed", "feed"],
  ["added", "add"],
  ["exceedingly", "exceed"],
  // Step 1c and the consonant y.
  ["happy", "happi"],
  ["steadily", "steadili"],
  ["yellow", "yellow"],
  ["boys", "boy"],
  // Steps 2 to 5.
  ["conditional", "condit"],
  ["operational", "oper"],
  ["classification", "classif"],
  ["carefully", "care"],
  ["logically", "logic"],
  ["geology", "geolog"],
  ["fluently", "fluentli"],
  ["changeover", "changeov"],
  ["temperature", "temperatur"],
  ["controll", "control"],
  // Regions that start after a prefix.
  ["generously", "generous"],
  ["communism", "communism"],
  ["arsenal", "arsenal"],
  // The exceptions, and the revision PostgreSQL 18 runs.
  ["skies", "sky"],
  ["dying", "die"],
  ["news", "news"],
  ["innings", "inning"],
  ["proceeds", "proceed"],
  ["evening", "even"],
  ["geologist", "geologist"],
  ["university", "univers"],
];

describe("stem", () => {
  it.each(POSTGRES_STEMS)("%s → %s, as PostgreSQL's english_stem", (word, expected) => {
    expect(stem(word)).toBe(expected);
  });

  it("leaves a word of one or two letters as it is", () => {
    expect(stem("pm")).toBe("pm");
    expect(stem("x")).toBe("x");
  });

  it("conflates the inflections of one word", () => {
    const forms = ["rise", "rises", "rising"].map(stem);
    expect(new Set(forms).size).toBe(1);
    expect(new Set(["fouled", "fouling", "foul"].map(stem))).toEqual(new Set(["foul"]));
  });
});

describe("lexemes", () => {
  it("drops the stop words and stems what is left", () => {
    expect(lexemes("The oil temperature has been rising while the load stays normal")).toEqual(
      new Set(["oil", "temperatur", "rise", "load", "stay", "normal"]),
    );
  });

  it("splits on anything that is not a letter and drops single letters", () => {
    expect(MIN_WORD_LENGTH).toBe(2);
    expect(lexemes("Purge pressure (P) above cut-out; W")).toEqual(
      new Set(["purg", "pressur", "cut"]),
    );
  });

  it("gives nothing for a text of stop words", () => {
    expect(lexemes("It is not what it was, and so on.").size).toBe(0);
  });
});

describe("ENGLISH_STOP_WORDS", () => {
  it("is PostgreSQL's english list: 127 lowercase words", () => {
    expect(ENGLISH_STOP_WORDS.size).toBe(127);
    for (const word of ENGLISH_STOP_WORDS) expect(word).toMatch(/^[a-z]+$/);
    for (const word of ["the", "while", "for", "above", "below", "out"]) {
      expect(ENGLISH_STOP_WORDS.has(word)).toBe(true);
    }
  });
});
