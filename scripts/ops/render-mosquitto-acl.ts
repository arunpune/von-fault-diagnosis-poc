// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Renders `infra/mosquitto/acl` from the `acl` block of
// `packages/contracts/topics.json`.
//
//   pnpm exec tsx scripts/ops/render-mosquitto-acl.ts           # write the file
//   pnpm exec tsx scripts/ops/render-mosquitto-acl.ts --check    # exit 1 on drift
//
// `make mosquitto-acl` runs the first form, `scripts/ops/acl.test.ts` the second
// through `renderAcl`, so one edit in `topics.json` changes the broker's topic
// rights and the drift check proves the committed file followed.
//
// Layout (fixed, because the file is committed and compared byte for byte):
// the SPDX header, the "rendered from" line, the general block — Mosquitto
// applies those lines to anonymous clients only — then one blank line
// and one `user` block per credential, `read` lines before `write` lines, both
// in the order `topics.json` lists them. `{unit_id}` becomes `default_unit_id`.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The credential Mosquitto addresses through the general block, not a `user` block. */
export const ANONYMOUS = "anonymous";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const TOPICS_FILE = join(REPO_ROOT, "packages", "contracts", "topics.json");
const ACL_FILE = join(REPO_ROOT, "infra", "mosquitto", "acl");

// The rendered file's own SPDX tags. They belong to the ACL, not to this
// script, so they are fenced off: `reuse lint` would otherwise read the closing
// quote as part of the declaration and report this file as non-compliant.
// REUSE-IgnoreStart
const HEADER = [
  "# SPDX-FileCopyrightText: 2026 Meddle S.r.l.",
  "# SPDX-License-Identifier: Apache-2.0",
  "# Rendered from packages/contracts/topics.json by scripts/ops/render-mosquitto-acl.ts." +
    " Do not edit; run `make mosquitto-acl`.",
];
// REUSE-IgnoreEnd

/** One credential's topic filters, as `topics.json` states them. */
export interface AclEntry {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}

/** The part of `topics.json` this renderer reads. */
export interface TopicsWithAcl {
  readonly default_unit_id: string;
  readonly acl: Readonly<Record<string, AclEntry>>;
}

class RenderError extends Error {}

function assertShape(value: unknown, source: string): asserts value is TopicsWithAcl {
  if (typeof value !== "object" || value === null) {
    throw new RenderError(`${source}: not a JSON object`);
  }
  const candidate = value as Partial<TopicsWithAcl>;
  if (typeof candidate.default_unit_id !== "string" || candidate.default_unit_id === "") {
    throw new RenderError(`${source}: default_unit_id must be a non-empty string`);
  }
  if (typeof candidate.acl !== "object" || candidate.acl === null) {
    throw new RenderError(`${source}: the acl block is missing`);
  }
  if (!(ANONYMOUS in candidate.acl)) {
    throw new RenderError(`${source}: the acl block has no "${ANONYMOUS}" entry`);
  }
}

/** Parse `topics.json`, failing loudly on anything this renderer cannot use. */
export function parseTopics(json: string, source = TOPICS_FILE): TopicsWithAcl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new RenderError(`${source}: ${(cause as Error).message}`);
  }
  assertShape(parsed, source);
  return parsed;
}

function filterLines(
  access: "read" | "write",
  filters: readonly string[],
  unitId: string,
): string[] {
  return filters.map((filter) => `topic ${access} ${filter.replaceAll("{unit_id}", unitId)}`);
}

function entryLines(entry: AclEntry, unitId: string): string[] {
  return [
    ...filterLines("read", entry.read ?? [], unitId),
    ...filterLines("write", entry.write ?? [], unitId),
  ];
}

/** The exact bytes `infra/mosquitto/acl` must hold for these contracts. */
export function renderAcl(topics: TopicsWithAcl): string {
  const unitId = topics.default_unit_id;
  const blocks: string[][] = [[...HEADER, ...entryLines(topics.acl[ANONYMOUS], unitId)]];

  for (const [user, entry] of Object.entries(topics.acl)) {
    if (user === ANONYMOUS) continue;
    blocks.push([`user ${user}`, ...entryLines(entry, unitId)]);
  }

  return `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

/** The credentials the rendered file gives a `user` block, in `topics.json` order. */
export function aclUsers(topics: TopicsWithAcl): string[] {
  return Object.keys(topics.acl).filter((user) => user !== ANONYMOUS);
}

/** Render from the committed `topics.json`. */
export function renderFromContracts(topicsFile = TOPICS_FILE): string {
  return renderAcl(parseTopics(readFileSync(topicsFile, "utf8"), topicsFile));
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`render-mosquitto-acl: unknown argument ${unknown[0]}\n`);
    return 2;
  }

  const rendered = renderFromContracts();
  if (!check) {
    writeFileSync(ACL_FILE, rendered, "utf8");
    process.stdout.write(`render-mosquitto-acl: wrote ${ACL_FILE}\n`);
    return 0;
  }

  const committed = readFileSync(ACL_FILE, "utf8");
  if (committed === rendered) {
    process.stdout.write("render-mosquitto-acl: infra/mosquitto/acl is up to date\n");
    return 0;
  }
  process.stderr.write(
    "render-mosquitto-acl: infra/mosquitto/acl no longer matches packages/contracts/topics.json." +
      " Run `make mosquitto-acl`.\n",
  );
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`render-mosquitto-acl: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
