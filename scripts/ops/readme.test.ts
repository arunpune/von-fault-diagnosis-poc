// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The README is the user-facing contract for commands, ports and variables, so these
// eight checks hold it to the files it describes:
//
//   1. no placeholder is left, and the clone command names the published repository;
//   2. every `make <target>` it mentions is a target of the root Makefile (`make -pn`), and every
//      target of the Commands table has help text;
//   3. the Configuration table lists the variables of `.env.example` with the same defaults, in
//      the same groups and order (the set rule duplicates `fdp-checks env` on purpose, so this
//      check needs no Python toolchain);
//   4. every relative link and in-page anchor resolves;
//   5. the MetroPT-3 credit carries the DOI and the licence, and the licence section names both
//      project licences;
//   6. the ports it names are the `.env.example` defaults and the development ports of
//      compose.dev.yaml;
//   7. the five-minute tour keeps the preset and injection labels the stack E2E drives, and step 2
//      describes signature A;
//   8. the README is a tracked file with its SPDX header that no blocklist exclusion or exemption
//      covers, so `make blocklist` and `fdp-checks spdx` scan it like any other file.
//
// `make` and `git` run with a minimal environment: the make database lists every environment
// variable, and nothing here needs a key in it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const README_FILE = "README.md";
const README = readFileSync(join(REPO_ROOT, README_FILE), "utf8");
const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");

/** Inline HTML the README may use; anything else in angle brackets is a placeholder. */
const HTML_ELEMENTS = new Set([
  "a",
  "br",
  "details",
  "img",
  "kbd",
  "p",
  "picture",
  "source",
  "sub",
  "summary",
  "sup",
]);
/** The variables whose defaults are the ports the README names. */
const PUBLISHED_PORTS = ["UI_PORT", "MQTT_PORT", "MODBUS_PORT"] as const;
/** The labels the stack E2E drives and step 2's signature A. */
const TOUR_PRESET = "Air leak – 5 Jun 2020";
const TOUR_INJECTION = "Oil cooler fouling";
const SIGNATURE_A = "stays loaded";
const SUPERSEDED_SIGNATURE = /more frequent load cycles/i;
// The README's own SPDX tags, not this file's: fenced off so that `reuse lint` does not read the
// closing `-->",` as part of a declaration of this file's licence.
// REUSE-IgnoreStart
const SPDX_HEADER = [
  "<!-- SPDX-FileCopyrightText: 2026 Meddle S.r.l. -->",
  "<!-- SPDX-License-Identifier: CC-BY-4.0 -->",
];
// REUSE-IgnoreEnd

interface EnvVariable {
  group: string;
  name: string;
  /** The default after `=`, without a trailing comment; empty for the secrets and unset values. */
  value: string;
}

interface ConfigRow {
  group: string;
  names: string[];
  defaultCell: string;
}

/**
 * Run a command in the repository with nothing but PATH and HOME from the environment (git reads
 * its `safe.directory` exceptions from the global configuration under HOME).
 */
function run(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout };
}

/** The Markdown with every fenced code block removed. */
function withoutFences(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .filter((line) => {
      if (line.startsWith("```")) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n");
}

/** The contents of every fenced code block, one entry per line. */
function fencedLines(markdown: string): string[] {
  let fenced = false;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (fenced) lines.push(line);
  }
  return lines;
}

/** The body of a `## title` section, up to the next `## ` heading outside a code block. */
function section(title: string): string {
  const body: string[] = [];
  let inside = false;
  let fenced = false;
  for (const line of README.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      inside = line === `## ${title}`;
      continue;
    }
    if (inside) body.push(line);
  }
  expect(body, `README section "## ${title}"`).not.toHaveLength(0);
  return body.join("\n");
}

/** Prose with line breaks and runs of spaces collapsed, so a wrapped sentence reads as one. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** A list item that starts with `marker` in `body`, with its indented continuation lines. */
function listItem(body: string, marker: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith(marker));
  expect(start, `list item "${marker}…"`).toBeGreaterThanOrEqual(0);
  const item = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    item.push(line);
  }
  return flatten(item.join("\n"));
}

/** The cells of a Markdown table row. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** The body rows of every table in `body`, header and separator rows excluded. */
function tableRows(body: string): string[][] {
  const rows: string[][] = [];
  let header = true;
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) {
      header = true;
      continue;
    }
    if (header || /^\|[\s|:-]+\|$/.test(line)) {
      header = false;
      continue;
    }
    rows.push(cells(line));
  }
  return rows;
}

/** Every variable of `.env.example` in file order, with its `## ` group and default. */
function envVariables(): EnvVariable[] {
  const variables: EnvVariable[] = [];
  let group = "";
  for (const raw of ENV_EXAMPLE.split("\n")) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      group = heading[1];
      continue;
    }
    const assignment = /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (assignment?.[1] === undefined || assignment[2] === undefined) continue;
    const value = assignment[2].replace(/\s+#.*$/, "").trim();
    variables.push({ group, name: assignment[1], value });
  }
  return variables;
}

/** The Configuration table: a bold first cell opens a group, every other row lists variables. */
function configRows(): ConfigRow[] {
  const rows: ConfigRow[] = [];
  let group = "";
  for (const [first = "", second = ""] of tableRows(section("Configuration"))) {
    const heading = /^\*\*(.+)\*\*$/.exec(first);
    if (heading?.[1] !== undefined) {
      group = heading[1];
      continue;
    }
    const names = [...first.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1] as string);
    rows.push({ group, names, defaultCell: second });
  }
  return rows;
}

/** The ordered groups of a variable list, each with the names it holds. */
function grouped(entries: { group: string; name: string }[]): [string, string[]][] {
  const groups: [string, string[]][] = [];
  for (const { group, name } of entries) {
    const last = groups.at(-1);
    if (last?.[0] === group) last[1].push(name);
    else groups.push([group, [name]]);
  }
  return groups;
}

function envDefault(name: string): string {
  const variable = envVariables().find((entry) => entry.name === name);
  expect(variable, `${name} in .env.example`).toBeDefined();
  return variable?.value ?? "";
}

/** Every target of the root Makefile, read from make's own database. */
function makeTargets(): Set<string> {
  const { status, stdout } = run("make", ["-pn", "help"]);
  expect(status, "make -pn help").toBe(0);
  const targets = new Set<string>();
  const lines = stdout.split("\n");
  lines.forEach((line, index) => {
    const target = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?:\s|$)/.exec(line)?.[1];
    if (target !== undefined && lines[index - 1] !== "# Not a target:") targets.add(target);
  });
  return targets;
}

/** Target → description, as `make help` prints them. */
function helpTexts(): Map<string, string> {
  const { status, stdout } = run("make", ["-s", "help"]);
  expect(status, "make help").toBe(0);
  const texts = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const entry = /^\s+(\S+)\s+(.*)$/.exec(line);
    if (entry?.[1] !== undefined) texts.set(entry[1], (entry[2] ?? "").trim());
  }
  return texts;
}

/** The targets of every `make <target>` in the README's code blocks and code spans. */
function mentionedTargets(): Set<string> {
  const inline = [...withoutFences(README).matchAll(/`([^`\n]+)`/g)].map(
    (match) => match[1] as string,
  );
  const targets = new Set<string>();
  for (const snippet of [...fencedLines(README), ...inline]) {
    for (const match of snippet.matchAll(/(?:^|[\s;&|(])make\s+([a-z][a-z0-9_-]*)/g)) {
      targets.add(match[1] as string);
    }
  }
  return targets;
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Angle-bracket tokens that are neither markup, autolinks nor arrows, e.g. `<repo>`. */
function placeholders(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/<([^<>\n]+)>/g)) {
    const inner = match[1] as string;
    const element = inner.split(/\s/)[0]?.toLowerCase() ?? "";
    const markup = inner.startsWith("!--") || inner.startsWith("/") || inner.endsWith("/");
    const autolink = inner.includes("://");
    const hasWord = /[\p{L}…]/u.test(inner);
    if (!markup && !autolink && hasWord && !HTML_ELEMENTS.has(element)) found.push(inner);
  }
  return found;
}

/** A path glob of the blocklist configuration as a regular expression. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/** The globs of `exclude = [...]` in tools/blocklist/blocklist.toml. */
function blocklistExcludes(): string[] {
  const toml = readFileSync(join(REPO_ROOT, "tools/blocklist/blocklist.toml"), "utf8");
  const block = /^exclude\s*=\s*\[([\s\S]*?)\]/m.exec(toml)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

/** The path globs of tools/blocklist/data/allow.txt (`<glob> :: <term>  # reason`). */
function blocklistExemptions(): string[] {
  return readFileSync(join(REPO_ROOT, "tools/blocklist/data/allow.txt"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("::")[0]?.trim() ?? "");
}

describe("README consistency", () => {
  it("1. keeps no placeholder and clones the published repository", () => {
    expect(placeholders(README), "placeholders left in the README").toEqual([]);
    for (const retired of ["<repo>", "<public-share-url>"]) expect(README).not.toContain(retired);
    expect(README).toContain(
      "git clone https://github.com/meddleconnect/jev-fault-diagnosis-poc.git",
    );
  });

  it("2. mentions only Makefile targets, and every target of the Commands table has help text", () => {
    const targets = makeTargets();
    const mentioned = [...mentionedTargets()].sort();
    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((target) => !targets.has(target))).toEqual([]);

    const help = helpTexts();
    const rows = tableRows(section("Commands"));
    expect(rows.length).toBeGreaterThan(0);
    for (const [command = "", description = ""] of rows) {
      const target = /^`make ([a-z][a-z0-9_-]*)`$/.exec(command)?.[1];
      expect(target, `Commands row "${command}"`).toBeDefined();
      expect(description, `README description of ${command}`).not.toBe("");
      expect(help.get(target ?? "") ?? "", `make help text of ${command}`).not.toBe("");
    }
  });

  it("3. lists the variables of .env.example with the same defaults, groups and order", () => {
    const variables = envVariables();
    const rows = configRows();
    const documented = rows.flatMap((row) => row.names);
    expect([...documented].sort()).toEqual(variables.map((variable) => variable.name).sort());

    for (const row of rows) {
      expect(
        row.names.length,
        `a Configuration row without a variable: ${row.defaultCell}`,
      ).toBeGreaterThan(0);
      for (const name of row.names) {
        const value = envDefault(name);
        if (value === "") {
          // No value in .env.example: the cell explains the fallback in words and claims no literal.
          expect(row.defaultCell, `${name} default`).not.toBe("");
          expect(row.defaultCell, `${name} has no default in .env.example`).not.toMatch(
            /^`[^`]*`$/,
          );
        } else {
          expect(row.defaultCell, `${name} default`).toBe(`\`${value}\``);
        }
      }
    }

    const tableOrder = rows.flatMap((row) => row.names.map((name) => ({ group: row.group, name })));
    expect(grouped(tableOrder)).toEqual(grouped(variables));
  });

  it("4. resolves every relative link and in-page anchor", () => {
    const prose = withoutFences(README).replace(/`[^`\n]*`/g, "");
    const anchors = new Set(
      [...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
        slug((match[1] as string).replace(/`/g, "")),
      ),
    );
    const targets = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);
    const relative = targets.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
    expect(relative.length).toBeGreaterThan(0);
    for (const target of relative) {
      const [path = "", fragment] = target.split("#");
      if (path === "") expect(anchors, `anchor ${target}`).toContain(fragment);
      else expect(existsSync(join(REPO_ROOT, path)), `link ${target}`).toBe(true);
    }
  });

  it("5. credits MetroPT-3 with its DOI and licence and names both project licences", () => {
    const credits = section("License and credits");
    const metropt = listItem(credits, "- MetroPT-3:");
    expect(metropt).toContain("10.24432/C5VW3R");
    expect(metropt).toContain("CC BY 4.0");
    expect(credits).toContain("Apache-2.0");
    expect(credits).toContain("CC BY 4.0");
  });

  it("6. names the .env.example ports and the development ports of compose.dev.yaml", () => {
    const text = flatten(README);
    const published = PUBLISHED_PORTS.map((name) => {
      const port = envDefault(name);
      expect(port, name).toMatch(/^\d+$/);
      expect(text, `the ports sentence names ${name}`).toContain(`\`${name}\` (${port})`);
      return port;
    });
    const [uiPort, mqttPort] = published;
    expect(README).toContain(`http://localhost:${uiPort}`);
    expect(README).toMatch(new RegExp(`mosquitto_sub -h localhost -p ${mqttPort} `));

    const dev = parse(readFileSync(join(REPO_ROOT, "compose.dev.yaml"), "utf8")) as {
      services: Record<string, { ports?: string[] }>;
    };
    const devPorts = Object.values(dev.services).flatMap((service) =>
      (service.ports ?? []).map((mapping) => mapping.split(":").at(-2) ?? ""),
    );
    expect(devPorts.length).toBeGreaterThan(0);
    for (const port of devPorts)
      expect(text, `development port ${port}`).toMatch(new RegExp(`\\b${port}\\b`));

    const known = new Set([...published, ...devPorts]);
    const named = [...README.matchAll(/localhost:(\d+)/g)].map((match) => match[1] as string);
    expect(named.filter((port) => !known.has(port))).toEqual([]);
  });

  it("7. keeps the tour's preset and injection labels and describes signature A in step 2", () => {
    const tour = section("Try it in five minutes");
    expect(tour).toContain(TOUR_PRESET);
    expect(tour).toContain(TOUR_INJECTION);
    const step2 = listItem(tour, "2. ");
    expect(step2).toContain(TOUR_PRESET);
    expect(step2).toContain(SIGNATURE_A);
    expect(step2).not.toMatch(SUPERSEDED_SIGNATURE);
  });

  it("8. is a tracked file with its SPDX header that the blocklist scan does not skip", () => {
    expect(
      run("git", ["ls-files", "--error-unmatch", README_FILE]).status,
      "git tracks README.md",
    ).toBe(0);
    expect(README.split("\n").slice(0, SPDX_HEADER.length)).toEqual(SPDX_HEADER);
    for (const glob of [...blocklistExcludes(), ...blocklistExemptions()]) {
      expect(globToRegExp(glob).test(README_FILE), `blocklist glob ${glob}`).toBe(false);
    }
    expect(blocklistExcludes().length, "blocklist.toml exclude list parsed").toBeGreaterThan(0);
  });
});
