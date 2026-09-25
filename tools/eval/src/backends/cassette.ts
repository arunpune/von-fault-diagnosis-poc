// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Recorded Jev answers on disk (tools/eval/CASSETTES.md).
//
// A cassette is one request to the live API and what the model answered it —
// filed under the digest of the request (`digest.ts`), one directory per
// pinned model:
//
//   fixtures/cassettes/jev-1.13.0/<request_digest>.json
//
// The same request can be sent more than once in a run: an episode whose
// state has not moved is decided again every interval with byte-identical
// state and questions. The live model does not answer such a request the
// same way each time, so a cassette that kept one answer could not replay
// the run it recorded. It keeps every answer of its recording run, in order:
// the first in `response`, the others in `repeat_responses`, and the replay
// serves the n-th answer to the n-th arrival (`cassette-server.ts`). A
// cassette recorded before kept only its last answer; it still loads, as one.
//
// **One recording per GATE_PERSIST_SIM_MIN.** The Jev thresholds
// pre-registration's amendment of 2026-09-24 records the tuning list twice,
// at N = 0 and at N = 1, into this one store, and each N is judged on its own
// recording. The two recordings send many of the same requests (the state is
// words, and an episode's steady state reads the same whichever frame its
// first decision took), so a cassette that a second recording replaced would
// serve the first one's replay another run's answers. A cassette therefore
// says at which value its answers were recorded (`persist_sim_min`) and keeps
// the recordings made at other values beside them (`other_recordings`), one
// per value. A recording run replaces the recording at its own value and
// keeps the others (`withRecording`); a replay at N is served N's
// (`responsesAt`). A cassette recorded before recordings were told apart
// carries no value and serves any, except to a replay that asks for N's own
// recording only (`ownRecordingOnly`): the pre-registered sweep reads each N
// on the recording made at N "and on no other", and such a cassette cannot
// show it is N's, so there it is a miss.
//
// The store is deliberately strict. Every document is checked against
// `schemas/cassette.schema.json` on the way in and on the way out, its digest
// is recomputed from the request it carries, and its file name must be that
// digest: a hand-edited state, a renamed file or a cassette of another model
// is an error that names the file, never a silent miss that would make a
// cassette run quietly fall back to the mock's answers.
//
// Writes are atomic (a temporary file in the same directory, then a rename),
// so a recording interrupted mid-write leaves no half-written cassette for a
// later replay to trip on.
//
// Cassettes stay gitignored until the vendor's publication terms allow
// committing them; nothing here commits or publishes anything.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";

import { requestDigest } from "./digest.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** The `$id` every cassette names in its `schema` member. */
export const CASSETTE_SCHEMA_ID = "urn:fdp:eval:cassette:v1";

/** Absolute path of the cassette schema. */
export const CASSETTE_SCHEMA_PATH: string = fileURLToPath(
  new URL("../../schemas/cassette.schema.json", import.meta.url),
);

/**
 * Where recorded Jev answers live, one directory per model; gitignored until the vendor's
 * publication terms allow committing them.
 */
export const CASSETTES_DIR: string = fileURLToPath(
  new URL("../../fixtures/cassettes/", import.meta.url),
);

/** A cassette's file name: its digest and `.json`. */
const CASSETTE_FILE = /^[0-9a-f]{64}\.json$/;

/** The request half of a cassette: the body of `POST /v1/systemone`. */
export interface CassetteRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, unknown>>;
}

/** The response half: what the model answered and what it billed. */
export interface CassetteResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/** One recording run's answers to a request: at which GATE_PERSIST_SIM_MIN, when, and in order. */
export interface CassetteRecording {
  /** The run's GATE_PERSIST_SIM_MIN; absent for a recording made before recordings were told apart. */
  readonly persist_sim_min?: number;
  readonly recorded_wall_ts: string;
  readonly backend_version: string;
  /** The answer to the first time the run sent the request. */
  readonly response: CassetteResponse;
  /** The answers to every further time it sent it, in order; absent when it sent it once. */
  readonly repeat_responses?: readonly CassetteResponse[];
}

/** A recording kept beside a cassette's own, which always says its value. */
export type OtherRecording = CassetteRecording & { readonly persist_sim_min: number };

/** One recorded request and its answers (`urn:fdp:eval:cassette:v1`). */
export interface Cassette {
  readonly schema: typeof CASSETTE_SCHEMA_ID;
  readonly model: string;
  readonly request_digest: string;
  readonly recorded_wall_ts: string;
  readonly scenario_id?: string;
  readonly backend_version: string;
  readonly request: CassetteRequest;
  /**
   * The GATE_PERSIST_SIM_MIN of the recording run whose answers `response` and `repeat_responses`
   * hold; absent on a cassette recorded before recordings were told apart.
   */
  readonly persist_sim_min?: number;
  /** The answer to the first time the recording run sent the request. */
  readonly response: CassetteResponse;
  /** The answers to every further time it sent it, in order; absent when it sent it once. */
  readonly repeat_responses?: readonly CassetteResponse[];
  /** The recordings made at other GATE_PERSIST_SIM_MIN values, one per value, by value. */
  readonly other_recordings?: readonly OtherRecording[];
}

/** Two GATE_PERSIST_SIM_MIN values closer than this are the same value. */
const SAME_VALUE = 1e-9;

function sameValue(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) < SAME_VALUE;
}

/** Every answer of one recording, in the order its run received them. */
function answersOf(recording: CassetteRecording): readonly CassetteResponse[] {
  return [recording.response, ...(recording.repeat_responses ?? [])];
}

/** The cassette's own recording: its value, when and by what, and its answers. */
function ownRecording(cassette: Cassette): CassetteRecording {
  return {
    ...(cassette.persist_sim_min === undefined
      ? {}
      : { persist_sim_min: cassette.persist_sim_min }),
    recorded_wall_ts: cassette.recorded_wall_ts,
    backend_version: cassette.backend_version,
    response: cassette.response,
    ...(cassette.repeat_responses === undefined
      ? {}
      : { repeat_responses: cassette.repeat_responses }),
  };
}

/** Every recording a cassette holds: its own first, then the others by value. */
export function recordingsOf(cassette: Cassette): readonly CassetteRecording[] {
  return [ownRecording(cassette), ...(cassette.other_recordings ?? [])];
}

/** Every answer of the cassette's own recording, in the order its run received them. */
export function responsesOf(cassette: Cassette): readonly CassetteResponse[] {
  return answersOf(ownRecording(cassette));
}

/** How a replay reads a cassette's recordings. */
export interface ResponsesAtOptions {
  /**
   * Serve only a recording that says it was made at the replay's value: a cassette recorded
   * before recordings were told apart, which carries no value, is then served at none. The Jev
   * thresholds pre-registration reads each N on the recording made at N "and on no other".
   */
  readonly ownRecordingOnly?: boolean;
}

/**
 * The answers a replay at `persistSimMin` is served: those of the recording made at that
 * GATE_PERSIST_SIM_MIN, in the order its run received them. A cassette recorded before recordings
 * were told apart serves its answers at any value, unless `ownRecordingOnly` is set.
 *
 * @returns `undefined` when the cassette holds no recording at that value.
 */
export function responsesAt(
  cassette: Cassette,
  persistSimMin: number,
  options: ResponsesAtOptions = {},
): readonly CassetteResponse[] | undefined {
  if (cassette.persist_sim_min === undefined) {
    return options.ownRecordingOnly === true ? undefined : responsesOf(cassette);
  }
  const recording = recordingsOf(cassette).find((entry) =>
    sameValue(entry.persist_sim_min, persistSimMin),
  );
  return recording === undefined ? undefined : answersOf(recording);
}

/** `persist_sim_min` as a message names it. */
function valueName(persistSimMin: number | undefined): string {
  return persistSimMin === undefined ? "no value" : String(persistSimMin);
}

/** A cassette that cannot be used, named by the file or exchange it came from. */
export class CassetteError extends Error {
  readonly source: string;

  constructor(source: string, problem: string) {
    super(`${source}: ${problem}`);
    this.name = "CassetteError";
    this.source = source;
  }
}

function compile(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  const document = JSON.parse(readFileSync(CASSETTE_SCHEMA_PATH, "utf8")) as AnySchemaObject;
  return ajv.compile(document);
}

const validator: ValidateFunction = compile();

function issues(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined) return "/ is invalid";
  return errors
    .map(
      (error) =>
        `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

/**
 * Checks one cassette document: the schema, then that its digest is the digest of its own
 * request and that the request asked for the model the cassette is filed under.
 *
 * @param source the file or exchange the document came from, for the error message.
 * @throws CassetteError naming `source` and every problem found.
 */
export function validateCassette(document: unknown, source: string): Cassette {
  if (!validator(document)) {
    throw new CassetteError(
      source,
      `is not a ${CASSETTE_SCHEMA_ID} document: ${issues(validator.errors)}`,
    );
  }
  const cassette = document as Cassette;
  const digest = requestDigest(cassette.request);
  if (digest !== cassette.request_digest) {
    throw new CassetteError(
      source,
      `request_digest ${cassette.request_digest} is not the digest of its request (${digest}); a cassette's request is never edited, it is re-recorded`,
    );
  }
  if (cassette.request.model !== cassette.model) {
    throw new CassetteError(
      source,
      `the request asked for ${cassette.request.model}, but the cassette is filed under ${cassette.model}`,
    );
  }
  const values = recordingsOf(cassette).map((recording) => recording.persist_sim_min);
  const twice = values.find((value, index) =>
    values.slice(0, index).some((earlier) => sameValue(earlier, value)),
  );
  if (values.length > 1 && twice !== undefined) {
    throw new CassetteError(
      source,
      `holds two recordings at GATE_PERSIST_SIM_MIN ${valueName(twice)}; a recording run replaces its own value's`,
    );
  }
  return cassette;
}

/** What a recording knows beside the exchange itself. */
export interface RecordingContext {
  /** The pinned model the run asked for; the cassette directory is named after it. */
  readonly model: string;
  readonly recordedAt: Date;
  /** The `@fdp/backend` version whose builders made the request. */
  readonly backendVersion: string;
  readonly scenarioId?: string;
  /** The recording run's GATE_PERSIST_SIM_MIN, which the cassette keeps its answers under. */
  readonly persistSimMin?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The cassette of one answered live call, built from the provider bodies the Jev backend keeps
 * in `DecisionOutput.raw` (the request it handed the SDK and the response body, no headers).
 *
 * @throws CassetteError when either body is missing or is not the cassette shape.
 */
export function cassetteOf(
  raw: { readonly request?: unknown; readonly response?: unknown },
  context: RecordingContext,
): Cassette {
  const { request, response } = raw;
  if (!isRecord(request) || !isRecord(response)) {
    throw new CassetteError(
      "live exchange",
      "the decision carries no request or no response body to record",
    );
  }
  const document = {
    schema: CASSETTE_SCHEMA_ID,
    model: context.model,
    request_digest: requestDigest({
      model: String(request["model"]),
      state: request["state"],
      questions: request["questions"],
    }),
    recorded_wall_ts: context.recordedAt.toISOString(),
    ...(context.scenarioId === undefined ? {} : { scenario_id: context.scenarioId }),
    backend_version: context.backendVersion,
    request: { model: request["model"], state: request["state"], questions: request["questions"] },
    ...(context.persistSimMin === undefined ? {} : { persist_sim_min: context.persistSimMin }),
    response: { model: response["model"], answers: response["answers"], usage: response["usage"] },
  };
  return validateCassette(JSON.parse(JSON.stringify(document)), "live exchange");
}

/** A recording with one more answer appended. */
function appended<R extends CassetteRecording>(recording: R, answer: CassetteResponse): R {
  return { ...recording, repeat_responses: [...(recording.repeat_responses ?? []), answer] };
}

/**
 * `earlier` with the answer of `again` appended to the recording made at `again`'s
 * GATE_PERSIST_SIM_MIN: the cassette of a request the recording run sent once more. Everything
 * else — the digest, the request, when each recording was first made, the other values'
 * recordings — stays `earlier`'s.
 *
 * @throws CassetteError when the two cassettes are not of the same request and model, or
 * `earlier` holds no recording at `again`'s value.
 */
export function withRepeat(earlier: Cassette, again: Cassette): Cassette {
  if (again.request_digest !== earlier.request_digest || again.model !== earlier.model) {
    throw new CassetteError(
      `cassette ${again.request_digest}`,
      `is not a repeat of ${earlier.request_digest} (${earlier.model})`,
    );
  }
  const source = `cassette ${earlier.request_digest}`;
  const value = again.persist_sim_min;
  if (sameValue(earlier.persist_sim_min, value)) {
    return validateCassette(
      {
        ...earlier,
        repeat_responses: [...(earlier.repeat_responses ?? []), again.response],
      },
      source,
    );
  }
  const others = earlier.other_recordings ?? [];
  if (!others.some((recording) => sameValue(recording.persist_sim_min, value))) {
    throw new CassetteError(
      source,
      `holds no recording at GATE_PERSIST_SIM_MIN ${valueName(value)} to append the answer of a repeat to`,
    );
  }
  return validateCassette(
    {
      ...earlier,
      other_recordings: others.map((recording) =>
        sameValue(recording.persist_sim_min, value)
          ? appended(recording, again.response)
          : recording,
      ),
    },
    source,
  );
}

/**
 * The cassette after a recording run's first answer to its request: `fresh`, with the recordings
 * `existing` holds at other GATE_PERSIST_SIM_MIN values kept beside it. The recording `existing`
 * holds at `fresh`'s value — an earlier run's at the same value — is replaced, never mixed with.
 * So is the whole of `existing` when either carries no value (a cassette recorded before
 * recordings were told apart, or a run that does not say its value).
 *
 * @throws CassetteError when the two cassettes are not of the same request and model.
 */
export function withRecording(existing: Cassette | undefined, fresh: Cassette): Cassette {
  if (existing === undefined) return fresh;
  if (existing.request_digest !== fresh.request_digest || existing.model !== fresh.model) {
    throw new CassetteError(
      `cassette ${fresh.request_digest}`,
      `is not a recording of ${existing.request_digest} (${existing.model})`,
    );
  }
  if (existing.persist_sim_min === undefined || fresh.persist_sim_min === undefined) return fresh;
  const kept = recordingsOf(existing).filter(
    (recording): recording is OtherRecording =>
      recording.persist_sim_min !== undefined &&
      !sameValue(recording.persist_sim_min, fresh.persist_sim_min),
  );
  if (kept.length === 0) return fresh;
  return validateCassette(
    {
      ...fresh,
      other_recordings: [...kept].sort(
        (left, right) => left.persist_sim_min - right.persist_sim_min,
      ),
    },
    `cassette ${fresh.request_digest}`,
  );
}

/**
 * The cassettes of one model, in one directory.
 *
 * Reads and writes go straight to disk; the cassette server loads the whole set once when it
 * starts, and a recording run only writes.
 */
export class CassetteStore {
  /** The model's directory, `<root>/<model>`. */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The store of `model` under `root` (`CASSETTES_DIR` by default). */
  static forModel(model: string, root: string = CASSETTES_DIR): CassetteStore {
    return new CassetteStore(join(root, model));
  }

  /** Where the cassette of `digest` is, whether or not it exists. */
  pathOf(digest: string): string {
    return join(this.dir, `${digest}.json`);
  }

  /** The `.json` files of the directory, sorted; none when the directory does not exist. */
  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  }

  /** How many cassette files the directory holds. */
  get count(): number {
    return this.files().length;
  }

  private read(name: string): Cassette {
    const path = join(this.dir, name);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new CassetteError(path, `is not a readable JSON document (${String(error)})`);
    }
    const cassette = validateCassette(document, path);
    if (!CASSETTE_FILE.test(name) || name !== `${cassette.request_digest}.json`) {
      throw new CassetteError(
        path,
        `is not named after its request_digest ${cassette.request_digest}`,
      );
    }
    return cassette;
  }

  /**
   * Every cassette of the directory, in file-name order.
   *
   * @throws CassetteError on the first file that is not a valid cassette filed under its digest.
   */
  list(): Cassette[] {
    return this.files().map((name) => this.read(name));
  }

  /** The cassette of `digest`, or `undefined` when none was recorded. */
  get(digest: string): Cassette | undefined {
    const name = `${digest}.json`;
    if (!CASSETTE_FILE.test(name) || !existsSync(join(this.dir, name))) return undefined;
    return this.read(name);
  }

  /**
   * Writes one cassette as `<digest>.json`, replacing the file of the same request. A recording
   * run appends a repeated request's answers itself (`withRepeat`) before it puts the cassette
   * again, and folds its first answer into what the file held (`withRecording`), so a new run's
   * first answer replaces an older run's at the same GATE_PERSIST_SIM_MIN, never mixes with it,
   * and leaves the recordings of other values in place.
   *
   * @returns the path written.
   * @throws CassetteError when the document is not a valid cassette of this store's directory.
   */
  put(cassette: Cassette): string {
    const valid = validateCassette(cassette, `cassette ${cassette.request_digest}`);
    mkdirSync(this.dir, { recursive: true });
    const path = this.pathOf(valid.request_digest);
    const temporary = join(this.dir, `.${valid.request_digest}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return path;
  }
}
