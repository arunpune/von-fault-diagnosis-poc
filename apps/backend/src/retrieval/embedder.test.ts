// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The embedder's arithmetic and its model cache.
 *
 * Nothing here loads the real model: the pooling and normalisation are pure
 * functions checked on hand-made tensors, and the cache is exercised with a
 * small pin over files this test writes, so the suite stays offline and fast.
 * The real graph, and its parity with Python, is
 * `test/integration/embedder-parity.test.ts`.
 *
 * The last block reads the workspace lockfile: the embedder runs on
 * `onnxruntime-node`, not on `@huggingface/transformers` (and the LGPL `sharp`
 * binaries it pulls in) or `fastembed`, and the only proof that none crept back
 * in is the resolved tree.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { EMBEDDING } from "@fdp/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../test/helpers/fixtures.ts";
import {
  clsPool,
  cosine,
  createEmbedder,
  EmbedderError,
  ensureModelFile,
  formatSidecar,
  l2Normalize,
  meanPool,
  modelFilePath,
  modelFileUrl,
  parseSidecar,
  sidecarPath,
  toVectorLiteral,
  truncateEncoding,
  type EmbeddingPin,
  type FetchLike,
  type ModelFilePin,
  type TokenTensor,
} from "./embedder.ts";

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Two rows of three tokens over two dimensions; the second row is half padding. */
const TENSOR: TokenTensor = {
  hidden: Float32Array.from([
    // row 0: three real tokens
    1, 2, 3, 4, 5, 6,
    // row 1: two real tokens, then one padding position holding garbage
    10, 20, 30, 40, 999, 999,
  ]),
  batch: 2,
  tokens: 3,
  dim: 2,
  mask: [1, 1, 1, 1, 1, 0],
};

describe("meanPool", () => {
  it("averages the tokens the attention mask keeps", () => {
    const [first, second] = meanPool(TENSOR);
    expect(Array.from(first ?? [])).toEqual([3, 4]);
    expect(Array.from(second ?? [])).toEqual([20, 30]);
  });

  it("gives a row the same vector however much padding the batch added", () => {
    const alone: TokenTensor = {
      hidden: Float32Array.from([10, 20, 30, 40]),
      batch: 1,
      tokens: 2,
      dim: 2,
      mask: [1, 1],
    };
    expect(Array.from(meanPool(alone)[0] ?? [])).toEqual(Array.from(meanPool(TENSOR)[1] ?? []));
  });

  it("returns a zero vector rather than NaN for a row with no real token", () => {
    const empty: TokenTensor = {
      hidden: Float32Array.from([5, 5]),
      batch: 1,
      tokens: 1,
      dim: 2,
      mask: [0],
    };
    expect(Array.from(meanPool(empty)[0] ?? [])).toEqual([0, 0]);
  });
});

describe("clsPool", () => {
  it("takes the first token of every row", () => {
    const pooled = clsPool(TENSOR).map((vector) => Array.from(vector));
    expect(pooled).toEqual([
      [1, 2],
      [10, 20],
    ]);
  });
});

describe("l2Normalize and cosine", () => {
  it("scales a vector to unit length without changing its direction", () => {
    const unit = l2Normalize(Float32Array.from([3, 4]));
    expect(Array.from(unit)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Math.hypot(...unit)).toBeCloseTo(1, 6);
  });

  it("leaves a zero vector at zero", () => {
    expect(Array.from(l2Normalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });

  it("measures the angle between two vectors, whatever their length", () => {
    expect(cosine([1, 0], [5, 0])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0, 12);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it("refuses two vectors of different widths", () => {
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(EmbedderError);
  });
});

describe("truncateEncoding", () => {
  // [CLS] a b c d e [SEP], as the BERT template post-processes a single text.
  const encoded = {
    ids: [101, 1, 2, 3, 4, 5, 102],
    attention_mask: [1, 1, 1, 1, 1, 1, 1],
    token_type_ids: [0, 0, 0, 0, 0, 0, 0],
  };

  it("keeps the opening token, the first content tokens and the closing [SEP]", () => {
    const cut = truncateEncoding(encoded, 5);
    expect(cut.ids).toEqual([101, 1, 2, 3, 102]);
    expect(cut.attention_mask).toHaveLength(5);
    expect(cut.token_type_ids).toHaveLength(5);
  });

  it("leaves an encoding inside the ceiling untouched", () => {
    expect(truncateEncoding(encoded, 7)).toBe(encoded);
    expect(truncateEncoding(encoded, 256)).toBe(encoded);
  });
});

describe("toVectorLiteral", () => {
  it("writes the pgvector text form", () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe("[0.5,-1,0]");
    expect(toVectorLiteral(Float32Array.from([0.25, 2]))).toBe("[0.25,2]");
  });
});

describe("the cache layout init writes", () => {
  it("places each pinned file under <model_id with -- for />/<revision>/<path>", () => {
    expect(modelFilePath(EMBEDDING, "/models", "onnx/model.onnx")).toBe(
      `/models/sentence-transformers--all-MiniLM-L6-v2/${EMBEDDING.revision}/onnx/model.onnx`,
    );
    expect(sidecarPath("/models/x/tokenizer.json")).toBe("/models/x/tokenizer.json.sha256.json");
  });

  it("downloads from the pinned revision, the URL embedding.json records", () => {
    for (const file of EMBEDDING.files) {
      expect(modelFileUrl(EMBEDDING, file.path)).toBe(file.url);
    }
  });
});

describe("sidecars written by either side", () => {
  // A nanosecond timestamp past 2^53: the case a double would round.
  const sidecar = {
    sha256: "ab".repeat(32),
    size: 90_405_214n,
    mtime_ns: 1_758_000_000_123_456_789n,
  };

  it("are formatted exactly as Python's json.dumps(sort_keys=True) writes them", () => {
    expect(formatSidecar(sidecar)).toBe(
      `{"mtime_ns": 1758000000123456789, "sha256": "${"ab".repeat(32)}", "size": 90405214}\n`,
    );
  });

  it("parse back without losing a nanosecond", () => {
    expect(parseSidecar(formatSidecar(sidecar))).toEqual(sidecar);
    expect(
      parseSidecar(`{"sha256":"${sidecar.sha256}","size":90405214,"mtime_ns":1758000000123456789}`),
    ).toEqual(sidecar);
  });

  it("are ignored when truncated, hand-edited or of the wrong shape", () => {
    expect(parseSidecar("{")).toBeNull();
    expect(parseSidecar("[]")).toBeNull();
    expect(parseSidecar(`{"sha256": "x", "size": "1", "mtime_ns": 2}`)).toBeNull();
    expect(parseSidecar(`{"sha256": "x", "size": 1.5, "mtime_ns": 2}`)).toBeNull();
    expect(parseSidecar(`{"size": 1, "mtime_ns": 2}`)).toBeNull();
  });
});

describe("ensureModelFile", () => {
  const CONTENT = "a pinned artefact of the test model\n";
  const PIN = { model_id: "fdp-test/tiny-encoder", revision: "0123abcd" };
  const FILE: ModelFilePin = {
    path: "onnx/model.onnx",
    sha256: sha256(CONTENT),
    bytes: Buffer.byteLength(CONTENT),
  };

  let cacheDir: string;
  let target: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "fdp-embedder-"));
    target = modelFilePath(PIN, cacheDir, FILE.path);
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  async function place(content: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  /** A fetch that serves `body` and records every URL it was asked for. */
  function fakeFetch(body: string, status = 200): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      fetch: (url: string) => {
        urls.push(url);
        return Promise.resolve(new Response(status === 200 ? body : "not found", { status }));
      },
    };
  }

  it("refuses a missing file without a download, naming the path it looked at", async () => {
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).rejects.toThrow(
      target,
    );
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).rejects.toThrow(
      /EMBEDDER_ALLOW_DOWNLOAD=true/,
    );
  });

  it("accepts a cached file whose full hash matches the pin", async () => {
    await place(CONTENT);
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).resolves.toBe(
      target,
    );
  });

  it("refuses a cached file whose hash does not match, naming both digests", async () => {
    const other = CONTENT.replace("pinned", "forged");
    await place(other);
    const refusal = ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true });
    await expect(refusal).rejects.toThrow(EmbedderError);
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true })).rejects.toThrow(
      new RegExp(`${sha256(other)}.*${FILE.sha256}`),
    );
  });

  it("refuses a cached file of the wrong size before hashing it", async () => {
    await place(`${CONTENT}more`);
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).rejects.toThrow(
      /bytes but embedding\.json pins/,
    );
  });

  it("trusts a sidecar only while it describes the file's exact size and mtime", async () => {
    // Same size as the pin, different bytes: only the sidecar can vouch for it.
    const forged = CONTENT.replace("pinned", "forged");
    await place(forged);
    const info = await stat(target, { bigint: true });
    await writeFile(
      sidecarPath(target),
      formatSidecar({ sha256: FILE.sha256, size: info.size, mtime_ns: info.mtimeNs }),
    );
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).resolves.toBe(
      target,
    );

    // Touch the file: the sidecar no longer describes it, the file is hashed and fails.
    await utimes(target, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await expect(ensureModelFile(PIN, cacheDir, FILE, { allowDownload: false })).rejects.toThrow(
      /hashes to/,
    );
  });

  it("downloads a missing file from the pinned revision into init's layout, with a sidecar", async () => {
    const served = fakeFetch(CONTENT);
    await expect(
      ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true, fetch: served.fetch }),
    ).resolves.toBe(target);

    expect(served.urls).toEqual([
      "https://huggingface.co/fdp-test/tiny-encoder/resolve/0123abcd/onnx/model.onnx",
    ]);
    expect(await readFile(target, "utf8")).toBe(CONTENT);
    const sidecar = parseSidecar(await readFile(sidecarPath(target), "utf8"));
    const info = await stat(target, { bigint: true });
    expect(sidecar).toEqual({ sha256: FILE.sha256, size: info.size, mtime_ns: info.mtimeNs });

    // A second start finds it warm and never touches the network.
    const again = fakeFetch("unused");
    await ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true, fetch: again.fetch });
    expect(again.urls).toEqual([]);
  });

  it("discards a download whose digest is not the pinned one", async () => {
    const served = fakeFetch("a different file entirely");
    await expect(
      ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true, fetch: served.fetch }),
    ).rejects.toThrow(/the download was discarded/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.download`)).toBe(false);
    expect(existsSync(sidecarPath(target))).toBe(false);
  });

  it("reports an HTTP failure with the URL and the status", async () => {
    const served = fakeFetch("", 404);
    await expect(
      ensureModelFile(PIN, cacheDir, FILE, { allowDownload: true, fetch: served.fetch }),
    ).rejects.toThrow(/resolve\/0123abcd\/onnx\/model\.onnx: HTTP 404/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("createEmbedder", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "fdp-embedder-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("fails at start-up on an empty cache, naming the graph it could not find", async () => {
    const graph = modelFilePath(EMBEDDING, cacheDir, "onnx/model.onnx");
    await expect(createEmbedder({ cacheDir, allowDownload: false })).rejects.toThrow(graph);
  });

  it("refuses a pin whose pooling mode it does not implement", async () => {
    const pin: EmbeddingPin = { ...EMBEDDING, pooling: "max" };
    await expect(createEmbedder({ embedding: pin, cacheDir })).rejects.toThrow(
      /unknown pooling max/,
    );
  });

  it("refuses a pin that lists no tokenizer", async () => {
    const pin: EmbeddingPin = {
      ...EMBEDDING,
      files: EMBEDDING.files.filter((file) => file.path.endsWith(".onnx")),
    };
    await expect(createEmbedder({ embedding: pin, cacheDir })).rejects.toThrow(
      /lists no tokenizer\.json/,
    );
  });
});

describe("the resolved dependency tree", () => {
  /** Every package name the lockfile resolves, from its `packages:` section. */
  function lockedPackages(): Set<string> {
    const text = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    const start = text.indexOf("\npackages:\n");
    const end = text.indexOf("\nsnapshots:\n");
    expect(start).toBeGreaterThan(0);
    const names = new Set<string>();
    for (const line of text.slice(start, end === -1 ? undefined : end).split("\n")) {
      const match = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@/.exec(line);
      if (match?.[1] !== undefined) names.add(match[1]);
    }
    return names;
  }

  it("resolves the two packages the embedder is built on", () => {
    const names = lockedPackages();
    expect(names).toContain("onnxruntime-node");
    expect(names).toContain("@huggingface/tokenizers");
  });

  it("contains no @huggingface/transformers, sharp or fastembed", () => {
    const forbidden = [...lockedPackages()].filter(
      (name) =>
        name === "@huggingface/transformers" ||
        name === "sharp" ||
        name.startsWith("@img/sharp") ||
        name.includes("fastembed"),
    );
    expect(forbidden).toEqual([]);
  });
});
