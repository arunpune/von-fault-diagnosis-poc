// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The query embedder, on `onnxruntime-node`.
 *
 * Init embeds the manual in Python and the backend embeds the query here, and
 * the two vectors have to live in the same space or the third retrieval stage
 * is noise. That is a numerical contract, not an interface one, so this module
 * is deliberately a translation of `tools/init/src/fdp_init/embed/embedder.py`
 * rather than an independent implementation: the same ONNX graph, the same
 * `tokenizer.json`, the same pooling over the attention mask, the same L2
 * normalisation. `test/integration/embedder-parity.test.ts` holds both sides to
 * a cosine of 0.9999 against the contracts fixture computed in Python.
 *
 * Nothing about the model is written down here. `embedding.json` (the contracts
 * `EMBEDDING` pin) names the repository, the commit, the two files and their
 * digests, the pooling mode, whether vectors are normalised, the token ceiling,
 * the prefix a query carries and the input and output names of the graph.
 * Swapping the model is a change to that file and a re-ingestion, never a
 * change to this one.
 *
 * ## Where the files come from
 *
 * Init fills a shared volume; the backend mounts it read-only and finds the
 * files by init's own rule:
 *
 * ```text
 * MODEL_CACHE_DIR/<model_id with "/" → "--">/<revision>/<path>
 * MODEL_CACHE_DIR/<model_id with "/" → "--">/<revision>/<path>.sha256.json
 * ```
 *
 * Every file is verified before it is loaded: the sidecar is trusted while the
 * size and the modification time it was written for still match, and the whole
 * file is hashed otherwise. A digest that disagrees with the pin is a hard
 * failure — a wrong graph produces plausible vectors in the wrong space, which
 * no later check would catch. A missing file is a hard failure too, naming the
 * path, unless `EMBEDDER_ALLOW_DOWNLOAD=true` lets this process fetch it from
 * the pinned revision and verify it into the same layout (tests and a
 * developer's first run; the image starts offline).
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Tokenizer } from "@huggingface/tokenizers";
import { EMBEDDING } from "@fdp/contracts";
import { InferenceSession, Tensor } from "onnxruntime-node";

/** Texts per forward pass. One query is one text; a test batches. */
export const EMBED_BATCH_SIZE = 8;

/** The padding piece of the pinned WordPiece vocabulary. */
const PAD_TOKEN = "[PAD]";

/** Floor of the mask sum, so an all-padding row cannot divide by zero. */
const MEAN_EPSILON = 1e-9;

/** Floor of the L2 norm, same reason. */
const NORM_EPSILON = 1e-12;

/** The sidecar init writes beside a cached file. */
const SIDECAR_SUFFIX = ".sha256.json";

/** Download URL template; the only place a host name appears. */
const RESOLVE_URL = "https://huggingface.co/{model_id}/resolve/{revision}/{path}";

/** One pinned artefact of `embedding.json`. */
export interface ModelFilePin {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * `embedding.json`, structurally.
 *
 * The contracts package exports the pin as a frozen literal; this is the shape
 * this module needs from it, so a test can pass a smaller pin without building
 * a whole contracts value.
 */
export interface EmbeddingPin {
  readonly model_id: string;
  readonly revision: string;
  readonly dimension: number;
  readonly pooling: string;
  readonly normalize: boolean;
  readonly max_tokens: number;
  readonly query_prefix: string;
  readonly onnx: { readonly inputs: readonly string[]; readonly output: string };
  readonly files: readonly ModelFilePin[];
}

/** What retrieval asks of an embedder; the pg retriever holds one. */
export interface Embedder {
  readonly dimension: number;
  /** One vector per text, in the order the texts came in. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** The subset of `fetch` this module uses, so a test can hand over its own. */
export type FetchLike = (url: string) => Promise<Response>;

export interface CreateEmbedderOptions {
  /** The pin; the contracts `EMBEDDING` by default. */
  readonly embedding?: EmbeddingPin;
  /** `MODEL_CACHE_DIR`: the root of init's layout. */
  readonly cacheDir: string;
  /** Whether a missing file may be downloaded. `EMBEDDER_ALLOW_DOWNLOAD`. */
  readonly allowDownload?: boolean;
  /** Injected for the tests; `globalThis.fetch` otherwise. */
  readonly fetch?: FetchLike;
  /** Texts per forward pass; {@link EMBED_BATCH_SIZE}. */
  readonly batchSize?: number;
}

/** Thrown when the model cannot be found, verified, loaded or run. */
export class EmbedderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbedderError";
  }
}

/** `sentence-transformers/all-MiniLM-L6-v2` → `sentence-transformers--all-MiniLM-L6-v2`. */
export function cacheSubdir(embedding: Pick<EmbeddingPin, "model_id" | "revision">): string {
  return join(embedding.model_id.replaceAll("/", "--"), embedding.revision);
}

/** Where one pinned file sits in the cache, by init's layout. */
export function modelFilePath(
  embedding: Pick<EmbeddingPin, "model_id" | "revision">,
  cacheDir: string,
  path: string,
): string {
  return join(cacheDir, cacheSubdir(embedding), path);
}

/** The resolve URL of one pinned file. */
export function modelFileUrl(
  embedding: Pick<EmbeddingPin, "model_id" | "revision">,
  path: string,
): string {
  return RESOLVE_URL.replace("{model_id}", embedding.model_id)
    .replace("{revision}", embedding.revision)
    .replace("{path}", path);
}

/** A pgvector literal, the form both stages write a vector in. */
export function toVectorLiteral(vector: Float32Array | readonly number[]): string {
  return `[${Array.from(vector).join(",")}]`;
}

/** A flat `last_hidden_state` with the shape and mask that go with it. */
export interface TokenTensor {
  /** `batch × tokens × dim`, row-major, as the graph returns it. */
  readonly hidden: Float32Array;
  readonly batch: number;
  readonly tokens: number;
  readonly dim: number;
  /** The attention mask, `batch × tokens`. */
  readonly mask: readonly number[];
}

/**
 * Mean of the token vectors the mask keeps.
 *
 * Averaging over the real tokens only is what makes a vector independent of how
 * the batch was padded: the same sentence embedded alone and embedded beside a
 * long one must come out identical, or two runs of the same query would not
 * agree with each other, let alone with Python.
 */
export function meanPool(input: TokenTensor): Float32Array[] {
  const { hidden, batch, tokens, dim, mask } = input;
  const pooled: Float32Array[] = [];
  for (let row = 0; row < batch; row += 1) {
    const vector = new Float32Array(dim);
    let kept = 0;
    for (let token = 0; token < tokens; token += 1) {
      const weight = mask[row * tokens + token] ?? 0;
      if (weight === 0) continue;
      kept += weight;
      const base = (row * tokens + token) * dim;
      for (let index = 0; index < dim; index += 1) {
        vector[index] = (vector[index] ?? 0) + weight * (hidden[base + index] ?? 0);
      }
    }
    const divisor = Math.max(kept, MEAN_EPSILON);
    for (let index = 0; index < dim; index += 1) vector[index] = (vector[index] ?? 0) / divisor;
    pooled.push(vector);
  }
  return pooled;
}

/** The first token's vector, for a pin whose `pooling` is `cls`. */
export function clsPool(input: TokenTensor): Float32Array[] {
  const { hidden, batch, tokens, dim } = input;
  const pooled: Float32Array[] = [];
  for (let row = 0; row < batch; row += 1) {
    const base = row * tokens * dim;
    pooled.push(hidden.slice(base, base + dim));
  }
  return pooled;
}

/** Scale a vector to unit L2 length; a zero vector is returned unchanged. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.max(Math.sqrt(sum), NORM_EPSILON);
  const scaled = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    scaled[index] = (vector[index] ?? 0) / norm;
  }
  return scaled;
}

/** Cosine of two vectors of the same width; the parity test's measure. */
export function cosine(
  left: Float32Array | readonly number[],
  right: Float32Array | readonly number[],
): number {
  if (left.length !== right.length) {
    throw new EmbedderError(
      `cosine needs two vectors of one width, got ${left.length} and ${right.length}`,
    );
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * A sidecar as init writes it: the digest plus the file state it was computed
 * for (`fdp_init.util.hashing.Sidecar`).
 *
 * `size` and `mtime_ns` are `bigint` because a nanosecond timestamp of this
 * century is about 1.7 × 10¹⁸, well past the 2⁵³ a `number` holds exactly; read
 * as a double it would round, and a sidecar Python wrote would never match the
 * file it describes.
 */
export interface Sidecar {
  readonly sha256: string;
  readonly size: bigint;
  readonly mtime_ns: bigint;
}

/** `<file>.sha256.json`, beside the file it describes. */
export function sidecarPath(target: string): string {
  return `${target}${SIDECAR_SUFFIX}`;
}

/** A JSON integer, as its source text, so it can become an exact `bigint`. */
const JSON_INTEGER = /^\d+$/;

/** The optional third argument V8 passes a reviver: the value's source text. */
interface ReviverContext {
  readonly source?: string;
}

/**
 * Parse a sidecar, or return `null` when it is not one.
 *
 * The two integers are read from their source text rather than from the parsed
 * double, which is what keeps `mtime_ns` exact (see {@link Sidecar}).
 */
export function parseSidecar(text: string): Sidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key: string, value: unknown, context?: ReviverContext) => {
      if (key !== "size" && key !== "mtime_ns") return value;
      const source = context?.source;
      return source !== undefined && JSON_INTEGER.test(source) ? BigInt(source) : value;
    });
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { sha256, size, mtime_ns: mtime } = parsed as Record<string, unknown>;
  if (typeof sha256 !== "string" || typeof size !== "bigint" || typeof mtime !== "bigint") {
    return null;
  }
  return { sha256, size, mtime_ns: mtime };
}

/**
 * A sidecar in exactly the bytes init writes: `json.dumps(…, sort_keys=True)`
 * plus a newline, with Python's default `", "` and `": "` separators. Either
 * side can then read, trust and rewrite the other's file.
 */
export function formatSidecar(sidecar: Sidecar): string {
  return (
    `{"mtime_ns": ${sidecar.mtime_ns.toString()}, ` +
    `"sha256": ${JSON.stringify(sidecar.sha256)}, ` +
    `"size": ${sidecar.size.toString()}}\n`
  );
}

async function readSidecar(target: string): Promise<Sidecar | null> {
  try {
    return parseSidecar(await readFile(sidecarPath(target), "utf8"));
  } catch {
    // A missing or unreadable sidecar is not an error: the file is hashed
    // again instead, exactly as init does.
    return null;
  }
}

async function writeSidecar(target: string, sha256: string): Promise<void> {
  try {
    const info = await stat(target, { bigint: true });
    await writeFile(
      sidecarPath(target),
      formatSidecar({ sha256, size: info.size, mtime_ns: info.mtimeNs }),
      "utf8",
    );
  } catch {
    // A read-only cache mount still holds the right bytes; the digest was
    // already checked and the next start simply hashes the file again.
  }
}

/** The SHA-256 of a file, streamed so a 90 MB graph never sits in memory twice. */
export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(path, "r");
  try {
    await pipeline(handle.createReadStream(), digest);
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

/**
 * Check a cached file against its pin: `missing`, `verified`, or a thrown
 * {@link EmbedderError} naming both sides of the disagreement.
 *
 * The size is compared first, as init does, because a truncated graph is the
 * common corruption and costs nothing to spot. The digest then comes from the
 * sidecar while it still describes this exact file (same size, same mtime),
 * and from hashing the whole file otherwise.
 */
async function verifyCached(target: string, file: ModelFilePin): Promise<"missing" | "verified"> {
  let info;
  try {
    info = await stat(target, { bigint: true });
  } catch {
    return "missing";
  }
  if (info.size !== BigInt(file.bytes)) {
    throw new EmbedderError(
      `${target} is ${info.size.toString()} bytes but embedding.json pins ${file.bytes}; ` +
        "the model cache and the contracts have drifted apart",
    );
  }
  const sidecar = await readSidecar(target);
  const trusted =
    sidecar !== null && sidecar.size === info.size && sidecar.mtime_ns === info.mtimeNs;
  const digest = trusted ? sidecar.sha256 : await sha256File(target);
  if (digest !== file.sha256) {
    throw new EmbedderError(
      `${target} hashes to ${digest} but embedding.json pins ${file.sha256}; ` +
        "the model cache and the contracts have drifted apart",
    );
  }
  return "verified";
}

async function download(
  url: string,
  target: string,
  expected: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const temporary = `${target}.download`;
  await mkdir(dirname(target), { recursive: true });
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new EmbedderError(`cannot download ${url}: ${String(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new EmbedderError(`cannot download ${url}: HTTP ${response.status}`);
  }
  if (response.body === null) {
    throw new EmbedderError(`cannot download ${url}: the response carried no body`);
  }
  try {
    const handle = await open(temporary, "w");
    try {
      await pipeline(Readable.fromWeb(response.body), handle.createWriteStream());
    } finally {
      await handle.close();
    }
    const digest = await sha256File(temporary);
    if (digest !== expected) {
      throw new EmbedderError(
        `${url} hashes to ${digest} but embedding.json pins ${expected}; the download was discarded`,
      );
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error instanceof EmbedderError
      ? error
      : new EmbedderError(`cannot store ${url} at ${target}: ${String(error)}`, { cause: error });
  }
  await writeSidecar(target, expected);
}

/**
 * Make sure one pinned file is in the cache, verified, and return its path.
 *
 * Exported because the startup sequence wants the model
 * ready before the retriever is built, and because the tests drive the three
 * outcomes — warm cache, download, refusal — one at a time.
 */
export async function ensureModelFile(
  embedding: Pick<EmbeddingPin, "model_id" | "revision">,
  cacheDir: string,
  file: ModelFilePin,
  options: { readonly allowDownload: boolean; readonly fetch?: FetchLike },
): Promise<string> {
  const target = modelFilePath(embedding, cacheDir, file.path);
  if ((await verifyCached(target, file)) === "verified") return target;
  if (!options.allowDownload) {
    throw new EmbedderError(
      `the model file ${target} is missing; run init to fill MODEL_CACHE_DIR, ` +
        "or set EMBEDDER_ALLOW_DOWNLOAD=true to fetch it here",
    );
  }

  const fetchImpl = options.fetch ?? ((url: string) => globalThis.fetch(url));
  await download(modelFileUrl(embedding, file.path), target, file.sha256, fetchImpl);
  return target;
}

/** The single `files[]` entry matching `matches`, or a named failure. */
function onlyFile(
  files: readonly ModelFilePin[],
  matches: (file: ModelFilePin) => boolean,
  what: string,
): ModelFilePin {
  const found = files.filter(matches);
  if (found.length === 0) throw new EmbedderError(`embedding.json: files[] lists no ${what}`);
  if (found.length > 1) {
    throw new EmbedderError(
      `embedding.json: files[] lists ${what} more than once: ${found.map((file) => file.path).join(", ")}`,
    );
  }
  return found[0] as ModelFilePin;
}

/** One encoded text, before padding. */
export interface Encoded {
  readonly ids: number[];
  readonly attention_mask: number[];
  readonly token_type_ids: number[];
}

/**
 * Truncate an encoding to the pin's ceiling, keeping the closing special token.
 *
 * Python's `enable_truncation(max_length=n)` cuts the *content* to
 * `n − <special tokens>` and lets the post-processor wrap it, so the result is
 * `[CLS] content… [SEP]`. This tokenizer post-processes first, so the same
 * sequence is the first `n − 1` ids followed by the last one — which is that
 * closing `[SEP]`. Doing it this way rather than a plain `slice` is what keeps
 * a long query byte-identical between the two languages.
 */
export function truncateEncoding(encoded: Encoded, maxTokens: number): Encoded {
  if (encoded.ids.length <= maxTokens) return encoded;
  const keep = maxTokens - 1;
  const last = encoded.ids.length - 1;
  return {
    ids: [...encoded.ids.slice(0, keep), encoded.ids[last] as number],
    attention_mask: [
      ...encoded.attention_mask.slice(0, keep),
      encoded.attention_mask[last] as number,
    ],
    token_type_ids: [
      ...encoded.token_type_ids.slice(0, keep),
      encoded.token_type_ids[last] as number,
    ],
  };
}

/** One `int64` model input, padded to the batch's longest row. */
function column(rows: readonly number[][], width: number, pad: number): BigInt64Array {
  const data = new BigInt64Array(rows.length * width);
  rows.forEach((row, index) => {
    for (let token = 0; token < width; token += 1) {
      data[index * width + token] = BigInt(token < row.length ? (row[token] as number) : pad);
    }
  });
  return data;
}

/**
 * Build the embedder from the pin and the cache.
 *
 * Every failure here is a start-up failure that names its cause: a missing
 * file names the path, a wrong digest names both hashes, a graph that asks for
 * an input the pin does not list names the input.
 */
export async function createEmbedder(options: CreateEmbedderOptions): Promise<Embedder> {
  const embedding: EmbeddingPin = options.embedding ?? EMBEDDING;
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  if (batchSize < 1)
    throw new EmbedderError(`the embedding batch size must be >= 1, got ${batchSize}`);
  if (embedding.pooling !== "mean" && embedding.pooling !== "cls") {
    throw new EmbedderError(`embedding.json: unknown pooling ${embedding.pooling}`);
  }

  const graphPin = onlyFile(embedding.files, (file) => file.path.endsWith(".onnx"), "*.onnx graph");
  const tokenizerPin = onlyFile(
    embedding.files,
    (file) => file.path.split("/").at(-1) === "tokenizer.json",
    "tokenizer.json",
  );

  const ensure = { allowDownload: options.allowDownload ?? false, fetch: options.fetch };
  const graphPath = await ensureModelFile(embedding, options.cacheDir, graphPin, ensure);
  const tokenizerPath = await ensureModelFile(embedding, options.cacheDir, tokenizerPin, ensure);

  const tokenizer = await loadTokenizer(tokenizerPath);
  const padId = tokenizer.token_to_id(PAD_TOKEN);
  if (padId === undefined) {
    throw new EmbedderError(`${tokenizerPath}: no ${PAD_TOKEN} token to pad a batch with`);
  }

  const session = await loadSession(graphPath);
  const inputs = resolveInputs(session, embedding);
  if (!session.outputNames.includes(embedding.onnx.output)) {
    throw new EmbedderError(
      `the graph has no output ${embedding.onnx.output}; it offers ${session.outputNames.join(", ")}`,
    );
  }

  function encode(text: string): Encoded {
    const encoding = tokenizer.encode(embedding.query_prefix + text, {
      return_token_type_ids: true,
    });
    return truncateEncoding(
      {
        ids: encoding.ids,
        attention_mask: encoding.attention_mask,
        token_type_ids: encoding.token_type_ids,
      },
      embedding.max_tokens,
    );
  }

  async function runBatch(batch: readonly string[]): Promise<Float32Array[]> {
    const encodings = batch.map(encode);
    const width = Math.max(...encodings.map((encoding) => encoding.ids.length));
    const dims = [encodings.length, width];
    const feeds: Record<string, Tensor> = {};
    for (const name of inputs) {
      const rows = encodings.map((encoding) => pick(encoding, name));
      const pad = name === "input_ids" ? padId : 0;
      feeds[name] = new Tensor("int64", column(rows, width, pad), dims);
    }

    const output = (await session.run(feeds))[embedding.onnx.output];
    if (output === undefined) {
      throw new EmbedderError(`the graph returned no ${embedding.onnx.output}`);
    }
    const hidden = output.data;
    if (!(hidden instanceof Float32Array)) {
      throw new EmbedderError(`${embedding.onnx.output} is not float32; got ${output.type}`);
    }
    const dim = output.dims[2];
    if (dim !== embedding.dimension) {
      throw new EmbedderError(
        `the graph produced ${String(dim)}-wide vectors, but the pin promises ${embedding.dimension}`,
      );
    }

    const tensor: TokenTensor = {
      hidden,
      batch: encodings.length,
      tokens: width,
      dim,
      mask: encodings.flatMap((encoding) =>
        Array.from({ length: width }, (_, token) => encoding.attention_mask[token] ?? 0),
      ),
    };
    const pooled = embedding.pooling === "cls" ? clsPool(tensor) : meanPool(tensor);
    return embedding.normalize ? pooled.map(l2Normalize) : pooled;
  }

  return {
    dimension: embedding.dimension,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        vectors.push(...(await runBatch(texts.slice(start, start + batchSize))));
      }
      return vectors;
    },
  };
}

/** One column of an encoding, by the input name the graph asked for. */
function pick(encoded: Encoded, name: string): number[] {
  switch (name) {
    case "input_ids":
      return encoded.ids;
    case "attention_mask":
      return encoded.attention_mask;
    case "token_type_ids":
      return encoded.token_type_ids;
    default:
      throw new EmbedderError(`the graph asks for an input this embedder cannot build: ${name}`);
  }
}

/**
 * The pinned tokenizer.
 *
 * `tokenizer_config.json` is not in `files[]` and is not needed: everything the
 * encoder does — normalisation, pre-tokenisation, the WordPiece vocabulary and
 * the `[CLS]`/`[SEP]` template — is inside `tokenizer.json`, and the config only
 * carries decode-time preferences this module never uses.
 */
async function loadTokenizer(path: string): Promise<Tokenizer> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new EmbedderError(`cannot load the tokenizer ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  try {
    return new Tokenizer(document as object, {});
  } catch (error) {
    throw new EmbedderError(`cannot build the tokenizer from ${path}: ${String(error)}`, {
      cause: error,
    });
  }
}

/** A CPU session with every graph optimisation on, as init runs it. */
async function loadSession(path: string): Promise<InferenceSession> {
  try {
    return await InferenceSession.create(path, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });
  } catch (error) {
    throw new EmbedderError(`cannot load the ONNX graph ${path}: ${String(error)}`, {
      cause: error,
    });
  }
}

/**
 * The inputs to feed: the ones the graph declares, checked against the pin.
 *
 * A graph that wants an input `embedding.json` does not list means the cached
 * file and the contracts have drifted apart, which is worth failing over rather
 * than feeding zeros into it.
 */
function resolveInputs(session: InferenceSession, embedding: EmbeddingPin): readonly string[] {
  const unexpected = session.inputNames.filter((name) => !embedding.onnx.inputs.includes(name));
  if (unexpected.length > 0) {
    throw new EmbedderError(
      `the graph declares input(s) the pin does not list: ${unexpected.join(", ")}; ` +
        `embedding.json names ${embedding.onnx.inputs.join(", ")}`,
    );
  }
  return session.inputNames;
}
