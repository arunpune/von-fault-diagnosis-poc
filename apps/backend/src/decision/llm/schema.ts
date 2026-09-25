// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The structured answer the LLM backend asks for.
 *
 * It is one object rather than three calls because the three questions share
 * one state, and asking them separately would pay for that state three times
 * and let the answers disagree with each other.
 *
 * The schema is deliberately loose about ids: `choice` and every entry's `id`
 * are plain strings, so a model that invents a fault id produces a valid
 * object that `index.ts` then rejects with a message naming the id. Encoding
 * the candidate ids as an enum would move that failure into the provider,
 * where it would arrive as "the answer did not parse" and say nothing about
 * what the model actually answered.
 *
 * ## Lists of entries, not maps
 *
 * `probabilities` and `support` are arrays of `{ id, probability }` and
 * `{ id, support }` objects, not `z.record` maps (an earlier design wrote them
 * as maps). Structured outputs cannot express a map: every object of the schema
 * must be closed (`additionalProperties: false`), and the SDK's
 * `zodOutputFormat` enforces that by rewriting a record's
 * `additionalProperties: { type: "number" }` to `false` while giving it no
 * `properties`. The maps then reached the API as objects that admit only `{}`,
 * so the model's constrained answer could carry no probability at all and every
 * live decision failed with "no mass". A list of closed objects is a shape the
 * API constrains faithfully, and the schema stays one constant for every
 * decision, so the API compiles it once. `index.ts` turns the lists back into
 * the maps `DecisionOutput` carries and rejects an id listed twice.
 *
 * zod 4.6.5 is the schema language because `@anthropic-ai/sdk/helpers/zod`
 * turns it into the JSON Schema the Messages API takes: the wire
 * shape is `output_config.format = { type: "json_schema", schema: … }`, the
 * same one the catalog structurer sends from Python.
 */

import * as z from "zod";

import { NONE_OF_THESE } from "../types.ts";

/** The four severity levels, in the order the decision message's `score` uses. */
export const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;

/**
 * How long a rationale may be.
 *
 * It exists for the decision sheet, not for the pipeline: nothing downstream
 * parses it, and it is stored in `app.decisions.response` and nowhere else.
 * The cap keeps a model from spending the output budget — and the ledger — on
 * prose.
 */
export const RATIONALE_MAX_CHARS = 280;

/** One option's share of the evidence: an entry of `probabilities`. */
export const ProbabilityEntrySchema = z.object({
  id: z.string().describe(`A candidate id, or "${NONE_OF_THESE}"`),
  probability: z.number().describe("Between 0 and 1: this option's share of the evidence"),
});

/** One candidate's judged defining movement: an entry of `support`. */
export const SupportEntrySchema = z.object({
  id: z.string().describe("A candidate id"),
  support: z
    .number()
    .describe("Between 0 and 1: how much of the candidate's defining movement is observed"),
});

/** The answer to the three questions, in one object. */
export const DecisionSchema = z.object({
  choice: z
    .string()
    .describe(`The id of the candidate that fits, or "${NONE_OF_THESE}" when none of them does`),
  probabilities: z
    .array(ProbabilityEntrySchema)
    .describe(
      `How the evidence divides: one entry per candidate id and one for "${NONE_OF_THESE}"`,
    ),
  support: z.array(SupportEntrySchema).describe("One entry per candidate id"),
  severity_level: z.enum(SEVERITY_LEVELS).describe("How serious the situation is right now"),
  severity_confidence: z.number().describe("Between 0 and 1: how sure the severity level is"),
  rationale: z
    .string()
    .max(RATIONALE_MAX_CHARS)
    .describe("One sentence naming the movements that decided the choice"),
});

/** The answer as the backend reads it once the provider parsed it. */
export type DecisionAnswer = z.infer<typeof DecisionSchema>;
