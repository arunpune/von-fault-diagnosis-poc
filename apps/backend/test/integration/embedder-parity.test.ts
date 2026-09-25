// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Node embedder against the vectors Python computed.
 *
 * Init embeds the manual in Python and the backend embeds the query here, so
 * the two must agree to the fourth decimal of a cosine or the vector stage
 * searches the wrong space. `packages/contracts/fixtures/embeddings/` holds
 * eight sentences embedded by the contracts' reference script; every one of them must
 * come back from this process at cosine ≥ 0.9999.
 *
 * The model is the pinned 90 MB graph, so this suite needs it on disk:
 * `MODEL_CACHE_DIR` pointing at init's cache (default: `<tmp>/fdp-models`),
 * or `EMBEDDER_ALLOW_DOWNLOAD=true` to fetch it there through the same
 * hash-verifying path the backend uses. Without either the suite skips and
 * says why; with `FDP_REQUIRE_MODEL=1`, as CI sets it, the skip is a failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { EMBEDDING } from "@fdp/contracts";
import { beforeAll, describe, expect, it } from "vitest";

import {
  cosine,
  createEmbedder,
  ensureModelFile,
  modelFilePath,
  type Embedder,
} from "../../src/retrieval/embedder.ts";
import { REPO_ROOT } from "../helpers/fixtures.ts";

/** The parity bound between the Python and the Node embedder. */
const MIN_COSINE = 0.9999;

interface FixtureSentence {
  readonly text: string;
  readonly vector: readonly number[];
}

interface EmbeddingFixture {
  readonly model_id: string;
  readonly revision: string;
  readonly dimension: number;
  readonly pooling: string;
  readonly normalize: boolean;
  readonly sentences: readonly FixtureSentence[];
}

const FIXTURE: EmbeddingFixture = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "contracts", EMBEDDING.fixture), "utf8"),
) as EmbeddingFixture;

const cacheDir = process.env.MODEL_CACHE_DIR ?? join(tmpdir(), "fdp-models");
const allowDownload = process.env.EMBEDDER_ALLOW_DOWNLOAD === "true";
const requireModel = process.env.FDP_REQUIRE_MODEL === "1";
const cached = EMBEDDING.files.every((file) =>
  existsSync(modelFilePath(EMBEDDING, cacheDir, file.path)),
);
const available = cached || allowDownload;

const unavailable =
  `the pinned model is not in ${cacheDir} and EMBEDDER_ALLOW_DOWNLOAD is not true; ` +
  "run `fdp-init model` or set MODEL_CACHE_DIR, or allow the download, to run the parity check";

if (!available) process.stdout.write(`embedder-parity.test.ts: skipped: ${unavailable}\n`);

describe.runIf(!available && requireModel)("the model under FDP_REQUIRE_MODEL=1", () => {
  it("is available", () => {
    throw new Error(`FDP_REQUIRE_MODEL=1: ${unavailable}`);
  });
});

describe.runIf(available)(`${EMBEDDING.model_id} in Node against the Python fixture`, () => {
  let embedder: Embedder;
  let batched: Float32Array[];

  beforeAll(async () => {
    embedder = await createEmbedder({ cacheDir, allowDownload });
    batched = await embedder.embed(FIXTURE.sentences.map((sentence) => sentence.text));
  });

  it("was computed for the model the contracts pin", () => {
    expect(FIXTURE.model_id).toBe(EMBEDDING.model_id);
    expect(FIXTURE.revision).toBe(EMBEDDING.revision);
    expect(FIXTURE.pooling).toBe(EMBEDDING.pooling);
    expect(FIXTURE.normalize).toBe(EMBEDDING.normalize);
    expect(FIXTURE.sentences.length).toBeGreaterThan(0);
  });

  it("finds every pinned file verified in init's cache layout", async () => {
    for (const file of EMBEDDING.files) {
      await expect(
        ensureModelFile(EMBEDDING, cacheDir, file, { allowDownload: false }),
      ).resolves.toBe(modelFilePath(EMBEDDING, cacheDir, file.path));
    }
  });

  it("produces vectors of the pinned dimension, normalised", () => {
    expect(embedder.dimension).toBe(EMBEDDING.dimension);
    expect(batched).toHaveLength(FIXTURE.sentences.length);
    for (const vector of batched) {
      expect(vector).toHaveLength(EMBEDDING.dimension);
      expect(FIXTURE.dimension).toBe(EMBEDDING.dimension);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    }
  });

  it.each(FIXTURE.sentences.map((sentence, index) => [index, sentence] as const))(
    "sentence %i reaches cosine >= 0.9999 against Python",
    (index, sentence) => {
      const vector = batched[index];
      if (vector === undefined) throw new Error(`no vector for sentence ${index}`);
      expect(cosine(vector, sentence.vector)).toBeGreaterThanOrEqual(MIN_COSINE);
    },
  );

  it("gives a sentence the same vector alone as inside a padded batch", async () => {
    for (const [index, sentence] of FIXTURE.sentences.entries()) {
      const [alone] = await embedder.embed([sentence.text]);
      const inBatch = batched[index];
      if (alone === undefined || inBatch === undefined) throw new Error("missing vector");
      expect(cosine(alone, inBatch)).toBeGreaterThan(0.999999);
    }
  });

  it("truncates at max_tokens: nothing past the ceiling moves the vector", async () => {
    const long = Array.from({ length: EMBEDDING.max_tokens }, (_, index) =>
      index % 2 === 0 ? "pressure" : "valve",
    ).join(" ");
    const [cut, longer] = await embedder.embed([long, `${long} the oil runs hot in summer`]);
    if (cut === undefined || longer === undefined) throw new Error("missing vector");
    expect(Array.from(longer)).toEqual(Array.from(cut));
  });
});
