// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The words the database-free full-text stand-in compares (stage 2 of
 * retrieval).
 *
 * Production ranks with `ts_rank_cd` over `to_tsvector('english', …)`, which
 * drops PostgreSQL's english stop words and stems what is left, so `rises`,
 * `rising` and `rise` are one lexeme and `the`, `while` and `for` are none. A
 * stand-in that compared raw words instead scored every text by how many
 * function words it shared with the query and never matched `rises` with
 * `rising`. {@link lexemes} reads a text the way the `english` configuration
 * does, as far as a keyword overlap can use it:
 *
 * 1. lowercase, and split on everything that is not a letter (the query has
 *    no digits, and `stripDigits` leaves single letters behind);
 * 2. drop words shorter than two letters, as `fullTextQuery` does before the
 *    production query reaches `websearch_to_tsquery`;
 * 3. drop PostgreSQL's english stop words ({@link ENGLISH_STOP_WORDS});
 * 4. stem with {@link stem}, the English (Porter2) algorithm of the Snowball
 *    project in the revision PostgreSQL 18's `english_stem` dictionary runs.
 *
 * `test/integration/retrieval.test.ts` checks every word of its fixture
 * catalog, symptoms and manual chunks against `ts_lexize('english_stem', …)`
 * of the pgvector image, so a difference from production shows as a failing
 * test rather than as a quietly different ranking.
 */

import { ENGLISH_STOP_WORDS } from "./english-stop.ts";

/** Shorter words never enter the production query (`hybrid.ts`), so never here either. */
export const MIN_WORD_LENGTH = 2;

/** The distinct lexemes of a text: lowercased, stop words dropped, stemmed. */
export function lexemes(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word.length < MIN_WORD_LENGTH || ENGLISH_STOP_WORDS.has(word)) continue;
    found.add(stem(word));
  }
  return found;
}

// ---------------------------------------------------------------------------
// The English (Porter2) stemmer
//
// Written from the algorithm's published definition (snowballstem.org,
// "The English (Porter2) stemming algorithm"), in the revision whose double
// consonants stay after exactly one `a`, `e` or `o` (`added` → `add`) and
// which predates Snowball 3.0's further exceptions (`evening` → `even`,
// `geologist` unchanged), because that is what PostgreSQL 18 answers. The
// word is lowercase ASCII; `Y` marks a `y` that acts as a consonant.
// ---------------------------------------------------------------------------

/** `y` is a vowel; `Y`, a consonant `y`, is not. */
const VOWELS: ReadonlySet<string> = new Set(["a", "e", "i", "o", "u", "y"]);

const DOUBLES: ReadonlySet<string> = new Set([
  "bb",
  "dd",
  "ff",
  "gg",
  "mm",
  "nn",
  "pp",
  "rr",
  "tt",
]);

/** The letters an `-li` suffix may follow for step 2 to delete it. */
const VALID_LI: ReadonlySet<string> = new Set(["c", "d", "e", "g", "h", "k", "m", "n", "r", "t"]);

/** Whole words the algorithm maps directly, before anything else. */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ["skis", "ski"],
  ["skies", "sky"],
  ["dying", "die"],
  ["lying", "lie"],
  ["tying", "tie"],
  ["idly", "idl"],
  ["gently", "gentl"],
  ["ugly", "ugli"],
  ["early", "earli"],
  ["only", "onli"],
  ["singly", "singl"],
  ["sky", "sky"],
  ["news", "news"],
  ["howe", "howe"],
  ["atlas", "atlas"],
  ["cosmos", "cosmos"],
  ["bias", "bias"],
  ["andes", "andes"],
]);

/** Words left as they are once step 1a has run. */
const INVARIANT_AFTER_1A: ReadonlySet<string> = new Set([
  "inning",
  "outing",
  "canning",
  "herring",
  "earring",
  "proceed",
  "exceed",
  "succeed",
]);

/** Prefixes after which R1 starts, whatever the letters say. */
const R1_PREFIXES: readonly string[] = ["gener", "commun", "arsen"];

function isVowel(letter: string | undefined): boolean {
  return letter !== undefined && VOWELS.has(letter);
}

function hasVowel(part: string): boolean {
  return [...part].some((letter) => isVowel(letter));
}

/** The longest of `suffixes` the word ends with. */
function longestSuffix(word: string, suffixes: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && (found === undefined || suffix.length > found.length)) {
      found = suffix;
    }
  }
  return found;
}

/** An initial `y`, and a `y` after a vowel, become the consonant `Y`. */
function markConsonantY(word: string): string {
  const letters = [...word];
  if (letters[0] === "y") letters[0] = "Y";
  for (let index = 0; index + 1 < letters.length; index += 1) {
    if (isVowel(letters[index]) && letters[index + 1] === "y") {
      letters[index + 1] = "Y";
      index += 1;
    }
  }
  return letters.join("");
}

/** Where the region after the first non-vowel following a vowel, from `from`, starts. */
function regionAfter(word: string, from: number): number {
  let index = from;
  while (index < word.length && !isVowel(word[index])) index += 1;
  while (index < word.length && isVowel(word[index])) index += 1;
  return Math.min(index + 1, word.length);
}

/** R1 and R2, as offsets into the word. */
function regions(word: string): { readonly r1: number; readonly r2: number } {
  const prefix = R1_PREFIXES.find((candidate) => word.startsWith(candidate));
  const r1 = prefix === undefined ? regionAfter(word, 0) : prefix.length;
  return { r1, r2: regionAfter(word, r1) };
}

/**
 * Whether the word ends in a short syllable: a vowel between a non-vowel and a
 * final non-vowel other than `w`, `x` or `Y`, or a two-letter word of a vowel
 * and a non-vowel.
 */
function endsInShortSyllable(word: string): boolean {
  const last = word.at(-1);
  if (last === undefined || isVowel(last) || !isVowel(word.at(-2))) return false;
  if (word.length === 2) return true;
  return !["w", "x", "Y"].includes(last) && !isVowel(word.at(-3));
}

function step1a(word: string): string {
  const suffix = longestSuffix(word, ["sses", "ied", "ies", "us", "ss", "s"]);
  switch (suffix) {
    case "sses":
      return word.slice(0, -2);
    case "ied":
    case "ies":
      return word.length > 4 ? word.slice(0, -2) : word.slice(0, -1);
    case "s":
      return hasVowel(word.slice(0, -2)) ? word.slice(0, -1) : word;
    default:
      return word;
  }
}

function step1b(word: string, r1: number): string {
  const suffix = longestSuffix(word, ["eed", "eedly", "ed", "edly", "ing", "ingly"]);
  if (suffix === undefined) return word;
  const stemmed = word.slice(0, word.length - suffix.length);
  if (suffix === "eed" || suffix === "eedly") return stemmed.length >= r1 ? `${stemmed}ee` : word;
  if (!hasVowel(stemmed)) return word;
  if (["at", "bl", "iz"].some((ending) => stemmed.endsWith(ending))) return `${stemmed}e`;
  if (DOUBLES.has(stemmed.slice(-2))) {
    const afterOneOf = stemmed.length === 3 && ["a", "e", "o"].includes(stemmed[0] ?? "");
    return afterOneOf ? stemmed : stemmed.slice(0, -1);
  }
  return stemmed.length <= r1 && endsInShortSyllable(stemmed) ? `${stemmed}e` : stemmed;
}

function step1c(word: string): string {
  const last = word.at(-1);
  if (word.length > 2 && (last === "y" || last === "Y") && !isVowel(word.at(-2))) {
    return `${word.slice(0, -1)}i`;
  }
  return word;
}

/** A suffix of steps 2 to 4, what replaces it, and what must precede it. */
interface Rule {
  readonly suffix: string;
  readonly replacement: string;
  readonly after?: (letter: string | undefined) => boolean;
}

function rule(suffix: string, replacement: string, after?: Rule["after"]): Rule {
  return after === undefined ? { suffix, replacement } : { suffix, replacement, after };
}

const STEP_2: readonly Rule[] = [
  rule("tional", "tion"),
  rule("enci", "ence"),
  rule("anci", "ance"),
  rule("abli", "able"),
  rule("entli", "ent"),
  rule("izer", "ize"),
  rule("ization", "ize"),
  rule("ational", "ate"),
  rule("ation", "ate"),
  rule("ator", "ate"),
  rule("alism", "al"),
  rule("aliti", "al"),
  rule("alli", "al"),
  rule("fulness", "ful"),
  rule("ousli", "ous"),
  rule("ousness", "ous"),
  rule("iveness", "ive"),
  rule("iviti", "ive"),
  rule("biliti", "ble"),
  rule("bli", "ble"),
  rule("ogi", "og", (letter) => letter === "l"),
  rule("fulli", "ful"),
  rule("lessli", "less"),
  rule("li", "", (letter) => letter !== undefined && VALID_LI.has(letter)),
];

const STEP_3: readonly Rule[] = [
  rule("tional", "tion"),
  rule("ational", "ate"),
  rule("alize", "al"),
  rule("icate", "ic"),
  rule("iciti", "ic"),
  rule("ical", "ic"),
  rule("ful", ""),
  rule("ness", ""),
];

/** `-ative` is deleted by step 3 only inside R2. */
const STEP_3_R2 = "ative";

const STEP_4: readonly Rule[] = [
  ...[
    "al",
    "ance",
    "ence",
    "er",
    "ic",
    "able",
    "ible",
    "ant",
    "ement",
    "ment",
    "ent",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
  ].map((suffix) => rule(suffix, "")),
  rule("ion", "", (letter) => letter === "s" || letter === "t"),
];

/**
 * Apply the rule of the longest suffix the word ends with, when that suffix
 * starts inside the region; a shorter suffix is never tried instead.
 */
function applyLongest(word: string, rules: readonly Rule[], region: number): string {
  const found = longestSuffix(
    word,
    rules.map((candidate) => candidate.suffix),
  );
  const chosen = rules.find((candidate) => candidate.suffix === found);
  if (chosen === undefined) return word;
  const start = word.length - chosen.suffix.length;
  if (start < region) return word;
  if (chosen.after !== undefined && !chosen.after(word[start - 1])) return word;
  return word.slice(0, start) + chosen.replacement;
}

function step3(word: string, r1: number, r2: number): string {
  const found = longestSuffix(word, [...STEP_3.map((candidate) => candidate.suffix), STEP_3_R2]);
  if (found !== STEP_3_R2) return applyLongest(word, STEP_3, r1);
  return word.length - STEP_3_R2.length >= r2 ? word.slice(0, -STEP_3_R2.length) : word;
}

function step5(word: string, r1: number, r2: number): string {
  const start = word.length - 1;
  if (word.endsWith("e")) {
    const rest = word.slice(0, -1);
    const deletable = start >= r2 || (start >= r1 && !endsInShortSyllable(rest));
    return deletable ? rest : word;
  }
  if (word.endsWith("l") && start >= r2 && word.at(-2) === "l") return word.slice(0, -1);
  return word;
}

/**
 * The English (Porter2) stem of one lowercase word.
 *
 * Words of one or two letters, and the algorithm's own exceptions, come back
 * as they are or as the exception says.
 */
export function stem(word: string): string {
  const exception = EXCEPTIONS.get(word);
  if (exception !== undefined) return exception;
  if (word.length < 3) return word;

  const marked = markConsonantY(word);
  const { r1, r2 } = regions(marked);

  let current = step1a(marked);
  if (INVARIANT_AFTER_1A.has(current)) return current;

  current = step1b(current, r1);
  current = step1c(current);
  current = applyLongest(current, STEP_2, r1);
  current = step3(current, r1, r2);
  current = applyLongest(current, STEP_4, r2);
  current = step5(current, r1, r2);
  return current.replaceAll("Y", "y");
}
