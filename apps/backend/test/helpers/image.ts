// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * The backend image, built and taken apart.
 *
 * Two suites need the image the Dockerfile builds: `secrets.test.ts`, which
 * searches every layer for a planted secret, and `image.test.ts`, which starts
 * it against the test stack. Both build it here from the repository root —
 * the context the Compose file uses — under a tag of their own, and remove the
 * tag afterwards. The second build of a run is a cache hit.
 *
 * `docker save` writes either the classic layout (`<id>/layer.tar`) or the
 * OCI one (`blobs/sha256/<digest>`, layers possibly compressed); the reader
 * below walks both, decompressing gzip and zstd layers, and never unpacks
 * anything to disk.
 */

import { execFile, execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { REPO_ROOT } from "./fixtures.ts";

const run = promisify(execFile);

/** The Dockerfile of the backend, relative to the repository root. */
export const BACKEND_DOCKERFILE = "apps/backend/Dockerfile";

/** A cold build installs every dependency; a warm one takes seconds. */
export const BUILD_TIMEOUT_MS = 900_000;

/** Build the backend image from the repository root under `tag`. */
export async function buildBackendImage(tag: string): Promise<void> {
  await run("docker", ["build", "--quiet", "-f", BACKEND_DOCKERFILE, "-t", tag, "."], {
    cwd: REPO_ROOT,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Remove a tag this suite created; a missing one is not an error. */
export function removeImage(tag: string): void {
  try {
    execFileSync("docker", ["image", "rm", "--force", tag], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

/** A way to read bytes out of a tar, whether it sits in a file or in memory. */
interface TarSource {
  readonly size: number;
  read(offset: number, length: number): Buffer;
}

interface TarEntry {
  readonly name: string;
  readonly type: string;
  readonly dataOffset: number;
  readonly size: number;
}

const BLOCK = 512;

/** A NUL-terminated field of a tar header. */
function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function octal(header: Buffer, start: number, length: number): number {
  const text = field(header, start, length).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function isUstar(header: Buffer): boolean {
  return header.subarray(257, 262).toString("ascii") === "ustar";
}

/** Every entry of a tar, long names (GNU `L`, pax `path`) resolved. */
function* tarEntries(source: TarSource): Generator<TarEntry> {
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= source.size) {
    const header = source.read(offset, BLOCK);
    if (header.every((byte) => byte === 0)) return;
    const size = octal(header, 124, 12);
    const type =
      header[156] === 0 || header[156] === undefined ? "0" : String.fromCharCode(header[156]);
    const dataOffset = offset + BLOCK;
    if (type === "L") {
      longName = field(source.read(dataOffset, size), 0, size);
    } else if (type === "x") {
      const path = /\d+ path=([^\n]*)\n/.exec(source.read(dataOffset, size).toString("utf8"));
      if (path?.[1] !== undefined) longName = path[1];
    } else if (type !== "g") {
      const prefix = isUstar(header) ? field(header, 345, 155) : "";
      const name = field(header, 0, 100);
      yield {
        name: longName ?? (prefix === "" ? name : `${prefix}/${name}`),
        type,
        dataOffset,
        size,
      };
      longName = undefined;
    }
    offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
  }
}

function memorySource(buffer: Buffer): TarSource {
  return {
    size: buffer.length,
    read: (offset, length) => buffer.subarray(offset, offset + length),
  };
}

/** A layer or a blob, decompressed when it is gzip or zstd. */
function inflate(data: Buffer): Buffer {
  if (data[0] === 0x1f && data[1] === 0x8b) return gunzipSync(data);
  if (data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
    return zstdDecompressSync(data);
  }
  return data;
}

/** What {@link scanImage} found. */
export interface ImageScan {
  /** Entries of the saved archive that were read. */
  readonly entries: number;
  /** Layers walked as file systems. */
  readonly layers: number;
  /** Files in any layer whose name starts with `.env`. */
  readonly envFiles: readonly string[];
  /** Archive entries (layers, configs, manifests) whose bytes contain the needle. */
  readonly hits: readonly string[];
}

/**
 * `docker save` the image and search it: every file name of every layer for
 * an `.env` file, and every byte of every layer and of the image
 * configuration for `needle`.
 */
export function scanImage(tag: string, needle: string, workDir: string): ImageScan {
  const archive = join(workDir, `${basename(tag).replace(/[^a-z0-9.-]/gi, "_")}.tar`);
  execFileSync("docker", ["save", "-o", archive, tag], { stdio: "ignore" });
  const descriptor = openSync(archive, "r");
  try {
    const outer: TarSource = {
      size: statSync(archive).size,
      read(offset, length) {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const read = readSync(descriptor, buffer, filled, length - filled, offset + filled);
          if (read === 0) break;
          filled += read;
        }
        return buffer.subarray(0, filled);
      },
    };
    const envFiles: string[] = [];
    const hits: string[] = [];
    const bytes = Buffer.from(needle, "utf8");
    let entries = 0;
    let layers = 0;
    for (const entry of tarEntries(outer)) {
      if (entry.type !== "0" || entry.size === 0) continue;
      entries += 1;
      const content = inflate(outer.read(entry.dataOffset, entry.size));
      if (content.includes(bytes)) hits.push(entry.name);
      if (content.length < BLOCK || !isUstar(content.subarray(0, BLOCK))) continue;
      layers += 1;
      for (const file of tarEntries(memorySource(content))) {
        if (basename(file.name).startsWith(".env")) envFiles.push(`${entry.name}: ${file.name}`);
      }
    }
    return { entries, layers, envFiles, hits };
  } finally {
    closeSync(descriptor);
    rmSync(archive, { force: true });
  }
}
