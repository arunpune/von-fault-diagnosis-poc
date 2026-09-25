// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The embedding pin. `embedding.json` is the only place that says which model init and the backend
// embed with, and a silent change here means a column of 384-wide vectors that no longer means
// anything: init writes chunk vectors in Python, the backend writes query vectors in Node, and
// pgvector compares them with a dimension frozen in `db/migrations/0003_manual_chunks.sql`. These
// tests hold the four together, and `scripts/embed_fixture.py check` holds the numbers to the real
// model.

import type { AnySchemaObject } from "ajv";
import _Ajv2020 from "ajv/dist/2020.js";
import _addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EMBEDDING } from "../src/generated/embedding.ts";
import { AJV_OPTIONS } from "../src/generated/validators.ts";
import { contractsDir } from "../src/testing.ts";

// ajv and ajv-formats ship CommonJS with a default export, which Node's ESM interop hands
// back as the module object itself. The casts restore the declared class and plugin types.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** One downloadable model file with the hash init verifies the download against. */
interface ModelFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
}

/** The committed pin, exactly as `embedding.json` spells it. */
interface EmbeddingConfig {
  readonly model_id: string;
  readonly revision: string;
  readonly license: string;
  readonly dimension: number;
  readonly pooling: string;
  readonly normalize: boolean;
  readonly max_tokens: number;
  readonly query_prefix: string;
  readonly passage_prefix: string;
  readonly onnx: { readonly inputs: readonly string[]; readonly output: string };
  readonly runtime: Readonly<Record<string, string>>;
  readonly files: readonly ModelFile[];
  readonly fixture: string;
}

/** One reference sentence and the vector the Python script computed for it. */
interface FixtureSentence {
  readonly text: string;
  readonly vector: readonly number[];
}

/** The reference fixture both languages assert parity against. */
interface EmbeddingFixture {
  readonly model_id: string;
  readonly revision: string;
  readonly dimension: number;
  readonly pooling: string;
  readonly normalize: boolean;
  readonly sentences: readonly FixtureSentence[];
}

const repoRoot = join(contractsDir, "..", "..");
const configPath = join(contractsDir, "embedding.json");
const metaSchemaPath = join(contractsDir, "schemas", "meta", "embedding-config.schema.json");
const migrationPath = join(repoRoot, "db", "migrations", "0003_manual_chunks.sql");

/** The file itself, not the generated copy: the file is the contract. */
const config = JSON.parse(readFileSync(configPath, "utf8")) as EmbeddingConfig;
const fixturePath = join(contractsDir, config.fixture);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EmbeddingFixture;

/** The number of reference sentences the fixture carries. */
const SENTENCE_COUNT = 8;

/** How far a committed vector may be from unit length before it is a different vector. */
const UNIT_NORM_TOLERANCE = 1e-4;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function euclideanNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

/** The URL init and the backend both build from the pin. */
function derivedUrl(file: ModelFile): string {
  return `https://huggingface.co/${config.model_id}/resolve/${config.revision}/${file.path}`;
}

describe("embedding.json", () => {
  it("validates against schemas/meta/embedding-config.schema.json", () => {
    const ajv = new Ajv2020({ ...AJV_OPTIONS });
    addFormats(ajv);
    const meta = JSON.parse(readFileSync(metaSchemaPath, "utf8")) as AnySchemaObject;
    const validate = ajv.compile(meta);
    const ok = validate(config);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("pins the embedding model at a full commit sha", () => {
    expect(config.model_id).toBe("sentence-transformers/all-MiniLM-L6-v2");
    expect(config.license).toBe("Apache-2.0");
    expect(config.revision).toMatch(COMMIT_SHA);
    expect({
      dimension: config.dimension,
      pooling: config.pooling,
      normalize: config.normalize,
      max_tokens: config.max_tokens,
      query_prefix: config.query_prefix,
      passage_prefix: config.passage_prefix,
    }).toEqual({
      dimension: 384,
      pooling: "mean",
      normalize: true,
      max_tokens: 256,
      query_prefix: "",
      passage_prefix: "",
    });
  });

  it("names the two files both runtimes load, hashed and sized", () => {
    expect(config.files.map((file) => file.path)).toEqual(["onnx/model.onnx", "tokenizer.json"]);
    for (const file of config.files) {
      expect({
        path: file.path,
        sha256: SHA256.test(file.sha256),
        positive: file.bytes > 0,
      }).toEqual({ path: file.path, sha256: true, positive: true });
    }
  });

  it("derives every files[].url from model_id, revision and path", () => {
    expect(config.files.map((file) => file.url)).toEqual(config.files.map(derivedUrl));
  });

  it("records the four runtime pins", () => {
    expect(config.runtime).toEqual({
      onnxruntime: "1.30.0",
      onnxruntime_node: "1.30.0",
      tokenizers: "0.23.2",
      huggingface_tokenizers: "0.2.0",
    });
  });

  it("reads the graph input and output names off the real ONNX file", () => {
    expect(config.onnx.inputs).toEqual(["input_ids", "attention_mask", "token_type_ids"]);
    expect(config.onnx.output).toBe("last_hidden_state");
  });

  it("is exported from the package as EMBEDDING", () => {
    expect(EMBEDDING).toEqual(config);
  });
});

describe("dimension consistency", () => {
  it("matches the single vector(N) of the manual-chunk migration", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const matches = [...sql.matchAll(/vector\((\d+)\)/g)];
    expect(matches.length).toBe(1);
    expect(Number(matches[0]?.[1])).toBe(config.dimension);
  });

  it("matches the length of every fixture vector", () => {
    const lengths = new Set(fixture.sentences.map((sentence) => sentence.vector.length));
    expect([...lengths]).toEqual([config.dimension]);
  });
});

describe("fixtures/embeddings/all-minilm-l6-v2.json", () => {
  it("was produced by the pinned model and settings", () => {
    expect({
      model_id: fixture.model_id,
      revision: fixture.revision,
      dimension: fixture.dimension,
      pooling: fixture.pooling,
      normalize: fixture.normalize,
    }).toEqual({
      model_id: config.model_id,
      revision: config.revision,
      dimension: config.dimension,
      pooling: config.pooling,
      normalize: config.normalize,
    });
  });

  it("carries the eight reference sentences, each of them non-empty and unique", () => {
    expect(fixture.sentences).toHaveLength(SENTENCE_COUNT);
    const texts = fixture.sentences.map((sentence) => sentence.text.trim());
    expect(texts.filter((text) => text.length > 0)).toHaveLength(SENTENCE_COUNT);
    expect(new Set(texts).size).toBe(SENTENCE_COUNT);
  });

  it("holds every vector to unit norm", () => {
    const strays = fixture.sentences
      .map((sentence, index) => ({ index, norm: euclideanNorm(sentence.vector) }))
      .filter((entry) => Math.abs(entry.norm - 1) > UNIT_NORM_TOLERANCE);
    expect(strays).toEqual([]);
  });

  it("holds every component to a finite number", () => {
    const strays = fixture.sentences
      .flatMap((sentence, index) => sentence.vector.map((value) => ({ index, value })))
      .filter((entry) => !Number.isFinite(entry.value));
    expect(strays).toEqual([]);
  });
});
