// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// `fdp-eval validate`: the scenarios and the reference catalog, checked without
// replaying a single row.
//
// It answers two questions, and E1 (docs/evaluation.md) asks both of them.
// Does every scenario file still mean something — does its slice exist and
// cover its range, does its injection id resolve, does its failure id land on
// a window that overlaps what it replays? And does the reference catalog still
// name every cause ground truth refers to, in a vocabulary the pipeline
// understands?
//
// Neither question needs the dataset, a key or Docker, which is the point: a
// renamed slice or a dropped cause is caught in any checkout, in a second, and
// named — rather than surfacing as a strange number in a run an hour later.
//
// Exit codes, narrower than `fdp-eval run`'s because everything this command
// can fail on is configuration: 0 all green, 1 a usage error or bad data (a
// scenario that does not load or bind, a fault id the catalog does not have), 3
// the command could not run at all — a missing scenarios directory, an
// unreadable report path.

import { loadFailureTable, loadInjections } from "@fdp/ground-truth";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";

import {
  MINI_CATALOG_PATH,
  REFERENCE_CATALOG_PATH,
  byFaultId,
  loadReferenceCatalog,
  referenceCatalogExists,
} from "../catalog/reference.ts";
import { CatalogError } from "../catalog/types.ts";
import type { ReferenceCatalog, UnmappedDirection } from "../catalog/types.ts";
import { createLogger } from "../log.ts";
import { REPO_ROOT } from "../slices.ts";
import {
  PROFILES,
  ScenarioError,
  bindScenario,
  loadScenario,
  scenarioFiles,
} from "../scenario/index.ts";
import type { BoundScenario, Profile } from "../scenario/index.ts";
import { SCENARIOS_DIR } from "../scenario/load.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_ABORTED = 3;

/** Where the report is written when `--out` names nothing else. */
export const DEFAULT_OUT_DIR = "reports/eval";

/** The file E1 reads. */
export const REPORT_NAME = "catalog-validation.md";

/**
 * The licence header the report carries: it is manual-derived content, not code.
 *
 * The two lines are fenced off from `reuse lint`, which would otherwise read the literals as
 * this file's own declaration and fail on a Markdown comment inside a TypeScript string.
 */
/* REUSE-IgnoreStart */
export const REPORT_LICENCE_HEADER: readonly string[] = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
/* REUSE-IgnoreEnd */

/**
 * The cause ids ground truth is pinned to, written out here rather than derived.
 *
 * Ten of them are referenced by the committed data and would be found anyway; the eleventh,
 * `supply_voltage_low_or_unbalanced`, is the documented alternative reading of `motor_overload`
 * and is referenced by nothing, which is exactly why E1 names the list rather than deriving it.
 */
export const PINNED_FAULT_IDS: readonly string[] = [
  "airend_bearing_wear",
  "condensate_drain_blocked",
  "downstream_air_leak",
  "dryer_purge_leak",
  "high_air_demand",
  "high_ambient_temperature",
  "intake_valve_not_opening",
  "oil_cooler_fouled",
  "oil_temperature_sensor_fault",
  "supply_voltage_low_or_unbalanced",
  "tower_changeover_valve_fault",
];

function usage(): string {
  return [
    "usage: fdp-eval validate [options]",
    "",
    "options:",
    "  --catalog-only      skip the scenarios and check only the reference catalog",
    "  --dir <path>        the scenarios directory (default tools/eval/scenarios)",
    "  --catalog <path>    the catalog document (default tools/eval/fixtures/catalog.json)",
    "  --profile <name>    the profile whose replay ranges are bound (default core)",
    "  --out <dir>         where the report is written (default reports/eval)",
    "  --help              print this text",
    "",
    "scenario format and catalog sources: docs/evaluation.md",
    "",
  ].join("\n");
}

/** One reference ground truth makes to a cause, and where it makes it. */
interface FaultReference {
  readonly fault_id: string;
  readonly where: string;
}

/** Every cause id the ground-truth data names, with the record that names it. */
export function groundTruthFaultIds(): FaultReference[] {
  const found: FaultReference[] = [];
  const table = loadFailureTable();
  for (const failure of table.failures) {
    found.push({ fault_id: failure.fault_id, where: `failure ${failure.id}` });
    for (const accepted of failure.accepted_fault_ids) {
      found.push({ fault_id: accepted, where: `failure ${failure.id} (accepted)` });
    }
  }
  for (const episode of table.unlabelled_episodes) {
    found.push({ fault_id: episode.fault_id_hint, where: `unlabelled episode ${episode.start}` });
  }
  for (const injection of loadInjections()?.injections ?? []) {
    found.push({ fault_id: injection.fault_id, where: `injection ${injection.injection_id}` });
  }
  for (const faultId of PINNED_FAULT_IDS) {
    found.push({ fault_id: faultId, where: "the pinned cause registry" });
  }
  return found;
}

/** The references whose cause the catalog does not declare, one row per missing id. */
export function unresolvedFaultIds(
  references: readonly FaultReference[],
  catalog: ReferenceCatalog,
): FaultReference[] {
  const known = byFaultId(catalog.entries);
  const seen = new Set<string>();
  const missing: FaultReference[] = [];
  for (const reference of references) {
    if (known.has(reference.fault_id) || seen.has(reference.fault_id)) continue;
    seen.add(reference.fault_id);
    missing.push(reference);
  }
  return missing;
}

function shortPath(path: string): string {
  const inside = relative(REPO_ROOT, path);
  return inside.startsWith("..") ? path : inside;
}

function summaryLine(bound: BoundScenario): string {
  const { scenario, replay, windows, excluded } = bound;
  const range = `${replay.from.toISOString()} → ${replay.to.toISOString()}`;
  const accepted = windows.flatMap((window) => window.accepted);
  return [
    scenario.id.padEnd(36),
    scenario.group.padEnd(18),
    scenario.split.padEnd(5),
    range,
    `windows=${String(windows.length)}`,
    `excluded=${String(excluded.length)}`,
    accepted.length === 0 ? "accepted=—" : `accepted=${[...new Set(accepted)].join("|")}`,
  ].join("  ");
}

interface CatalogOutcome {
  readonly catalog?: ReferenceCatalog;
  readonly path: string;
  readonly authoritative: boolean;
  readonly unmapped: readonly UnmappedDirection[];
  readonly error?: string;
  readonly unresolved: readonly FaultReference[];
}

function checkCatalog(explicit: string | undefined): CatalogOutcome {
  const fallback = !referenceCatalogExists() && explicit === undefined;
  const path = explicit ?? (fallback ? MINI_CATALOG_PATH : REFERENCE_CATALOG_PATH);

  let catalog: ReferenceCatalog;
  try {
    catalog = loadReferenceCatalog(path);
  } catch (error) {
    const unmapped = error instanceof CatalogError ? error.unmapped : [];
    return { path, authoritative: !fallback, unmapped, error: String(error), unresolved: [] };
  }
  return {
    catalog,
    path,
    authoritative: !fallback,
    unmapped: [],
    unresolved: unresolvedFaultIds(groundTruthFaultIds(), catalog),
  };
}

function renderReport(outcome: CatalogOutcome, scenarios: readonly BoundScenario[]): string {
  const { catalog } = outcome;
  const causes = catalog?.entries ?? [];
  const faults = byFaultId(causes);
  const benign = [...faults.values()].filter((entry) => entry.benign);
  const references = groundTruthFaultIds();
  const referenced = [...new Set(references.map((reference) => reference.fault_id))].sort();

  const lines = [
    ...REPORT_LICENCE_HEADER,
    "",
    "# Reference catalog validation (E1)",
    "",
    `Document: \`${shortPath(outcome.path)}\``,
    outcome.authoritative
      ? ""
      : "**The reference catalog is not built on this machine**; the committed mini fixture stands in for it, so the cross-check below is advisory.",
    "",
    "## Catalog size",
    "",
    "| Quantity | Count |",
    "| --- | --- |",
    `| Entries (cause × condition rows) | ${String(causes.length)} |`,
    `| Causes (distinct fault ids) | ${String(faults.size)} |`,
    `| Benign causes | ${String(benign.length)} |`,
    `| Symptom conditions | ${String(catalog?.conditions ?? 0)} |`,
    `| Document shape | ${catalog?.shape ?? "—"} |`,
    `| SHA-256 | \`${catalog?.sha256 ?? "—"}\` |`,
    "",
    "## Fault ids used by ground truth",
    "",
    `${String(referenced.length)} distinct cause ids are referenced by \`packages/ground-truth/data/*.json\` and by the pinned cause registry.`,
    "",
    "| Fault id | In the catalog | First reference |",
    "| --- | --- | --- |",
  ];

  for (const faultId of referenced) {
    const where = references.find((reference) => reference.fault_id === faultId)?.where ?? "—";
    lines.push(`| \`${faultId}\` | ${faults.has(faultId) ? "yes" : "**no**"} | ${where} |`);
  }

  lines.push("", "## Direction words without a mapping", "");
  if (outcome.unmapped.length === 0) {
    lines.push(
      "None: every `signal_moves` direction is in the vocabulary of `common.schema.json`.",
    );
  } else {
    lines.push("| Cause | Word |", "| --- | --- |");
    for (const entry of outcome.unmapped) {
      lines.push(`| \`${entry.fault_id}\` | \`${entry.direction}\` |`);
    }
  }

  lines.push("", "## Scenarios", "");
  if (scenarios.length === 0) {
    lines.push("Not checked in this run (`--catalog-only`).");
  } else {
    lines.push(
      `${String(scenarios.length)} scenario files load and bind against \`@fdp/ground-truth\`.`,
      "",
      "| Scenario | Group | Split | Positive | Windows | Excluded |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const bound of scenarios) {
      lines.push(
        `| \`${bound.scenario.id}\` | ${bound.scenario.group} | ${bound.scenario.split} | ${bound.scenario.positive ? "yes" : "no"} | ${String(bound.windows.length)} | ${String(bound.excluded.length)} |`,
      );
    }
  }

  if (outcome.error !== undefined) {
    lines.push("", "## Error", "", "```text", outcome.error, "```");
  }
  lines.push("");
  return lines.join("\n");
}

function isProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

/**
 * The arguments with the `--` terminator dropped.
 *
 * `pnpm --filter @fdp/eval run validate -- --catalog-only` passes the separator through to the
 * script, and Node's `parseArgs` would read everything behind it as a positional. This command
 * takes no positional at all, so a bare `--` means nothing and is removed rather than refused.
 */
function withoutTerminator(args: readonly string[]): string[] {
  return args.filter((argument) => argument !== "--");
}

/**
 * Runs `fdp-eval validate`.
 *
 * @param args everything after the subcommand name.
 * @returns the process exit code.
 */
export async function run(
  args: readonly string[],
  _env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const log = createLogger();
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: withoutTerminator(args),
      options: {
        "catalog-only": { type: "boolean" },
        dir: { type: "string" },
        catalog: { type: "string" },
        profile: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`fdp-eval validate: ${String(error)}\n\n${usage()}`);
    return EXIT_USAGE;
  }

  if (values["help"] === true) {
    process.stdout.write(usage());
    return EXIT_OK;
  }

  const profileArg = typeof values["profile"] === "string" ? values["profile"] : "core";
  if (!isProfile(profileArg)) {
    process.stderr.write(
      `fdp-eval validate: '${profileArg}' is not a profile (${PROFILES.join(", ")})\n`,
    );
    return EXIT_USAGE;
  }

  const catalogOnly = values["catalog-only"] === true;
  const directory = typeof values["dir"] === "string" ? values["dir"] : SCENARIOS_DIR;
  const outArg = typeof values["out"] === "string" ? values["out"] : DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outArg) ? outArg : join(REPO_ROOT, outArg);
  const catalogArg = typeof values["catalog"] === "string" ? values["catalog"] : undefined;

  const bound: BoundScenario[] = [];
  const failures: string[] = [];

  if (!catalogOnly) {
    let files: string[];
    try {
      files = scenarioFiles(directory);
    } catch (error) {
      process.stderr.write(`fdp-eval validate: cannot read ${directory} (${String(error)})\n`);
      return EXIT_ABORTED;
    }
    if (files.length === 0) {
      process.stderr.write(`fdp-eval validate: no scenario files in ${directory}\n`);
      return EXIT_USAGE;
    }
    for (const file of files) {
      try {
        const scenario = loadScenario(file);
        bound.push(bindScenario(scenario, { profile: profileArg, path: shortPath(file) }));
      } catch (error) {
        const code = error instanceof ScenarioError ? error.code : "schema";
        failures.push(`[${code}] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const line of bound.map(summaryLine)) process.stdout.write(`${line}\n`);
    process.stdout.write(
      `${String(bound.length)} of ${String(files.length)} scenarios bound for profile '${profileArg}'\n`,
    );
  }

  const outcome = checkCatalog(catalogArg);
  if (outcome.catalog === undefined) {
    failures.push(`[catalog] ${outcome.error ?? "the reference catalog could not be read"}`);
  } else {
    process.stdout.write(
      `catalog ${shortPath(outcome.path)}: ${String(outcome.catalog.entries.length)} entries, ` +
        `${String(byFaultId(outcome.catalog.entries).size)} causes, shape ${outcome.catalog.shape}\n`,
    );
  }
  if (!outcome.authoritative) {
    log.warn("the reference catalog is not built; using the committed mini fixture", {
      path: shortPath(outcome.path),
      build: "make manual",
    });
  }
  for (const missing of outcome.unresolved) {
    const message = `[catalog] ${missing.fault_id} (${missing.where}) is not in the catalog`;
    if (outcome.authoritative) failures.push(message);
    else log.warn("advisory: fault id not in the stand-in catalog", { fault_id: missing.fault_id });
  }

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, REPORT_NAME), renderReport(outcome, bound), "utf8");
  } catch (error) {
    process.stderr.write(`fdp-eval validate: cannot write the report (${String(error)})\n`);
    return EXIT_ABORTED;
  }
  process.stdout.write(`report: ${shortPath(join(outDir, REPORT_NAME))}\n`);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.stderr.write(`fdp-eval validate: ${String(failures.length)} problem(s)\n`);
    return EXIT_USAGE;
  }
  return EXIT_OK;
}
