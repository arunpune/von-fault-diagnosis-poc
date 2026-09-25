// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Checks on the production build in dist/:
//
//   * the JavaScript the first paint needs — the entry chunk and every chunk it imports
//     statically — stays within 250 kB gzip, and the sheets, the Review, Events and Cost tabs and
//     the recorder's Recharts-drawn charts stay out of it; every chunk's size is printed for the
//     record;
//   * the page makes no request outside its own origin: no external URL in index.html or in the
//     CSS, and the Plex faces the CSS names exist in the build;
//   * `vite preview` serves the page and the fonts.
//
// It reads the output of `pnpm --filter @fdp/frontend build` and is skipped until one exists,
// so `pnpm test` stays usable before the first build; CI builds first.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");
const MANIFEST_PATH = path.join(DIST_DIR, ".vite", "manifest.json");

/** Initial JavaScript budget, in kB of gzip as Vite reports them (1 kB = 1000 bytes). */
const INITIAL_JS_BUDGET_KB = 250;

/** Chunks kept out of the first paint, by the source file of their entry module. */
const LAZY_SOURCES = [
  "src/features/recorder/RecorderCharts.tsx",
  "src/features/decisions/DecisionSheet.tsx",
  "src/features/tickets/TicketSheet.tsx",
  "src/features/review/ReviewTab.tsx",
  "src/features/events/EventsTab.tsx",
  "src/features/cost/CostTab.tsx",
];

/** An absolute or protocol-relative URL: anything that would leave the page's origin. */
const EXTERNAL_URL = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

type Manifest = Record<string, ManifestChunk>;

interface ChunkSize {
  file: string;
  bytes: number;
  gzipBytes: number;
  initial: boolean;
}

const built = existsSync(MANIFEST_PATH);

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** The entry chunks and everything they import statically, as manifest keys. */
function initialChunkKeys(manifest: Manifest): Set<string> {
  const pending = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
  const seen = new Set<string>();
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (!seen.has(key)) {
      seen.add(key);
      pending.push(...(manifest[key]?.imports ?? []));
    }
  }
  return seen;
}

function measureChunks(manifest: Manifest): ChunkSize[] {
  const initialFiles = new Set([...initialChunkKeys(manifest)].map((key) => manifest[key]?.file));
  const files = new Set(
    Object.values(manifest)
      .map((chunk) => chunk.file)
      .filter((file) => file.endsWith(".js")),
  );
  return [...files].sort().map((file) => {
    const content = readFileSync(path.join(DIST_DIR, file));
    return {
      file,
      bytes: content.byteLength,
      gzipBytes: gzipSync(content, { level: 9 }).byteLength,
      initial: initialFiles.has(file),
    };
  });
}

function kB(bytes: number): string {
  return (bytes / 1000).toFixed(2).padStart(9);
}

function report(chunks: ChunkSize[], initialGzipBytes: number): string {
  const rows = chunks.map(
    (chunk) =>
      `${chunk.initial ? "initial" : "lazy   "}  ${kB(chunk.bytes)} kB  ${kB(chunk.gzipBytes)} kB gzip  ${chunk.file}`,
  );
  return [
    "JavaScript chunks of dist/ (sizes in kB of 1000 bytes):",
    ...rows,
    `initial JavaScript: ${kB(initialGzipBytes)} kB gzip of a ${INITIAL_JS_BUDGET_KB} kB budget`,
  ].join("\n");
}

function cssFiles(): string[] {
  return readdirSync(path.join(DIST_DIR, "assets"))
    .filter((file) => file.endsWith(".css"))
    .map((file) => path.join(DIST_DIR, "assets", file));
}

describe.runIf(built)("production bundle", () => {
  it(`keeps the initial JavaScript within ${INITIAL_JS_BUDGET_KB} kB gzip`, () => {
    const chunks = measureChunks(readManifest());
    const initialGzipBytes = chunks
      .filter((chunk) => chunk.initial)
      .reduce((sum, chunk) => sum + chunk.gzipBytes, 0);

    console.info(report(chunks, initialGzipBytes));

    expect(initialGzipBytes).toBeGreaterThan(0);
    expect(initialGzipBytes).toBeLessThanOrEqual(INITIAL_JS_BUDGET_KB * 1000);
  });

  it("keeps the sheets, the three lazy tabs and the recorder charts out of the first paint", () => {
    const manifest = readManifest();
    const initial = initialChunkKeys(manifest);

    for (const source of LAZY_SOURCES) {
      expect(manifest[source], `${source} has a chunk of its own`).toBeDefined();
      expect(initial.has(source), `${source} is loaded on demand`).toBe(false);
    }
  });

  it("links nothing outside the page's origin from index.html", () => {
    const html = readFileSync(path.join(DIST_DIR, "index.html"), "utf8");

    expect(html).not.toMatch(EXTERNAL_URL);
    expect(html).toContain('href="/fonts/IBMPlexSans-Regular.woff2"');
  });

  it("loads every font from the build itself", () => {
    const css = cssFiles()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    const external = urls.filter((url) => !url.startsWith("data:") && EXTERNAL_URL.test(url));
    const fonts = urls.filter((url) => url.endsWith(".woff2")).sort();

    expect(external).toEqual([]);
    expect(fonts).toEqual([
      "/fonts/IBMPlexMono-Regular.woff2",
      "/fonts/IBMPlexSans-Medium.woff2",
      "/fonts/IBMPlexSans-Regular.woff2",
      "/fonts/IBMPlexSans-SemiBold.woff2",
    ]);
    for (const font of fonts) {
      expect(existsSync(path.join(DIST_DIR, font)), `${font} is in dist/`).toBe(true);
    }
  });
});

describe.runIf(built)("vite preview", () => {
  let server: PreviewServer;
  let origin: string;

  beforeAll(async () => {
    server = await preview({
      root: PACKAGE_DIR,
      logLevel: "silent",
      preview: { port: 0, host: "127.0.0.1", open: false },
    });
    const address = server.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("vite preview is not listening on a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves the page", async () => {
    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>CAU-7 fault diagnosis</title>");
  });

  it("serves the self-hosted fonts", async () => {
    const response = await fetch(`${origin}/fonts/IBMPlexSans-Regular.woff2`);

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });
});
