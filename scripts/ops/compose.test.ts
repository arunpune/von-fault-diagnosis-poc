// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The Compose topology and its invariants, from the test runner.
//
// Three things are checked here. First, `scripts/ops/compose-check.sh` passes:
// the three file combinations render and every invariant holds. That needs
// Docker, so a machine without it gets a warning and the rest of the file still
// runs; FDP_REQUIRE_DOCKER turns the absence into a failure, which is what CI
// sets. Second, the checker itself has teeth: each of nine mutations of a
// rendered configuration — a stray service, a dropped `depends_on` condition, a
// missing healthcheck, a restarting one-shot, the pre-PG18 volume path, a
// writable model cache, an API key on the simulator, an extra published port, a
// bumped image tag — must be rejected, so a green run means something. Third,
// every `${VAR}` the compose files interpolate is listed in `.env.example` and,
// unless it is one of the two secrets, supplies its default; that is the same
// rule `fdp-checks env --compose` applies, asserted here through the YAML parser
// so it also holds for a variable hidden inside a nested value.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts/ops/compose-check.sh");
const INVARIANTS = join(REPO_ROOT, "scripts/ops/compose-invariants.py");
const ENV_EXAMPLE = join(REPO_ROOT, ".env.example");

/** The files the checker knows about, with the variant label each renders as. */
const VARIANTS = [
  { variant: "base", files: ["compose.yaml"] },
  { variant: "dev", files: ["compose.yaml", "compose.dev.yaml"] },
  { variant: "ci", files: ["compose.yaml", "compose.ci.yaml"] },
] as const;

/** The two variables that hold a credential: no default (ground rule 7, CONTRIBUTING.md). */
const SECRETS = new Set(["TYPESAFE_API_KEY", "LLM_API_KEY"]);

/** `${NAME}`, `${NAME:-default}`; `$$` is Compose's escape for a literal `$`. */
const INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g;

const requireDocker = Boolean(process.env["FDP_REQUIRE_DOCKER"]);

function hasDocker(): boolean {
  return spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
}

/** The names `.env.example` declares, whether commented out or assigned. */
function declaredVariables(): Set<string> {
  const names = new Set<string>();
  for (const raw of readFileSync(ENV_EXAMPLE, "utf8").split("\n")) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(raw.trim());
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/** Every `${VAR…}` reference in a compose file, with the text after the name. */
function interpolations(text: string): { name: string; suffix: string }[] {
  const found: { name: string; suffix: string }[] = [];
  for (const line of text.split("\n")) {
    for (const match of line.replaceAll("$$", "").matchAll(INTERPOLATION)) {
      found.push({ name: match[1] as string, suffix: match[2] as string });
    }
  }
  return found;
}

/** The configuration Docker would act on, never reading the developer's .env. */
function render(files: readonly string[]): Record<string, unknown> {
  const args = ["compose", "--env-file", "/dev/null"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  const json = execFileSync("docker", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return JSON.parse(json) as Record<string, unknown>;
}

/** Feed a rendered configuration to the checker and report how it judged it. */
function judge(
  variant: string,
  config: unknown,
  root: string = REPO_ROOT,
): { status: number; stderr: string } {
  const result = spawnSync("python3", [INVARIANTS, variant, "--root", root], {
    input: JSON.stringify(config),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

/** The file-backed inputs the checker reads from the repository root. */
const ROOT_FILES = [".dockerignore", "compose.yaml", "compose.dev.yaml", "compose.ci.yaml"];
const BROKER_DOCKERFILE = join(REPO_ROOT, "infra/mosquitto/Dockerfile");
const scratchRoots: string[] = [];

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A root that differs from the repository only in the broker Dockerfile.
 *
 * The other file-backed inputs are symlinked, so every invariant but the base-image pin
 * judges exactly what the committed tree holds.
 */
function rootWithBrokerDockerfile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fdp-compose-"));
  scratchRoots.push(dir);
  for (const file of ROOT_FILES) symlinkSync(join(REPO_ROOT, file), join(dir, file));
  mkdirSync(join(dir, "infra", "mosquitto"), { recursive: true });
  writeFileSync(join(dir, "infra", "mosquitto", "Dockerfile"), text);
  return dir;
}

type Services = Record<string, Record<string, unknown>>;

/** A deep copy of the base rendering, so each mutation starts from a clean one. */
function mutable(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  services: Services;
} {
  const copy = structuredClone(config);
  return { config: copy, services: copy["services"] as Services };
}

describe("compose-check", () => {
  const docker = hasDocker();

  it.runIf(docker || requireDocker)("passes on every file combination", () => {
    expect(docker, "Docker is required when FDP_REQUIRE_DOCKER is set").toBe(true);
    const result = spawnSync("bash", [CHECK_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(result.stderr + result.stdout).not.toMatch(/FAIL/);
    expect(result.status).toBe(0);
  });

  it.skipIf(docker || requireDocker)("is skipped without Docker", () => {
    console.warn("compose.test.ts: docker is not on PATH; the rendered checks are skipped");
    expect(existsSync(CHECK_SCRIPT)).toBe(true);
  });

  it("is executable and syntactically valid", () => {
    expect(spawnSync("bash", ["-n", CHECK_SCRIPT]).status).toBe(0);
    expect(spawnSync("bash", [CHECK_SCRIPT, "--help"], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", [CHECK_SCRIPT, "--bogus"], { encoding: "utf8" }).status).toBe(2);
  });
});

describe.runIf(hasDocker())("compose-invariants", () => {
  it.each(VARIANTS)("accepts the $variant variant", ({ variant, files }) => {
    expect(judge(variant, render(files)).status).toBe(0);
  });

  it("rejects a service that does not belong to the stack", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    services["typesafe-mock"] = { restart: "unless-stopped" };
    expect(judge("base", config).stderr).toMatch(/not part of the base stack/);
  });

  it("rejects a dropped depends_on condition", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    delete (services["backend"]!["depends_on"] as Record<string, unknown>)["init"];
    expect(judge("base", config).stderr).toMatch(/backend: depends_on is/);
  });

  it("rejects a service without a healthcheck", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    delete services["gateway"]!["healthcheck"];
    expect(judge("base", config).stderr).toMatch(/gateway: no healthcheck/);
  });

  it("rejects a one-shot that restarts", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    services["init"]!["restart"] = "unless-stopped";
    expect(judge("base", config).stderr).toMatch(/init: restart is 'unless-stopped'/);
  });

  it("rejects the pre-PostgreSQL-18 volume path", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    const volumes = services["postgres"]!["volumes"] as Record<string, unknown>[];
    volumes[0]!["target"] = "/var/lib/postgresql/data";
    expect(judge("base", config).stderr).toMatch(/nothing is mounted at \/var\/lib\/postgresql/);
  });

  it("rejects a writable model cache on the backend", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    const volumes = services["backend"]!["volumes"] as Record<string, unknown>[];
    delete volumes[0]!["read_only"];
    expect(judge("base", config).stderr).toMatch(
      /backend: the model cache must be mounted read-only/,
    );
  });

  it("rejects an API key on a service that must not see one", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    (services["modbus-sim"]!["environment"] as Record<string, string>)["TYPESAFE_API_KEY"] = "";
    expect(judge("base", config).stderr).toMatch(/modbus-sim: sees \['TYPESAFE_API_KEY'\]/);
  });

  it("rejects an undeclared published port", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    services["postgres"]!["ports"] = [{ mode: "ingress", target: 5432, published: "5432" }];
    expect(judge("base", config).stderr).toMatch(/published port \('postgres'/);
  });

  it("rejects a database image that is not the pinned one", () => {
    const { config, services } = mutable(render(["compose.yaml"]));
    services["postgres"]!["image"] = "pgvector/pgvector:0.8.6-pg17-trixie";
    expect(judge("base", config).stderr).toMatch(/postgres: image is/);
  });

  // The broker Dockerfile writes its pin as the default of `ARG MQTT_IMAGE`, so that
  // the 2.1 upgrade is a build argument rather than an edit. The pin still has to be
  // the pinned tag.
  it("accepts the pinned broker image written as an ARG default", () => {
    const root = rootWithBrokerDockerfile(readFileSync(BROKER_DOCKERFILE, "utf8"));
    expect(judge("base", render(["compose.yaml"]), root).status).toBe(0);
  });

  it("rejects a broker base image that is not the pinned one", () => {
    const bumped = readFileSync(BROKER_DOCKERFILE, "utf8").replace(
      "ARG MQTT_IMAGE=eclipse-mosquitto:2.0.22",
      "ARG MQTT_IMAGE=eclipse-mosquitto:2.1.2-alpine",
    );
    const root = rootWithBrokerDockerfile(bumped);
    expect(judge("base", render(["compose.yaml"]), root).stderr).toMatch(/does not build FROM/);
  });
});

describe("compose variables", () => {
  const declared = declaredVariables();

  it.each(["compose.yaml", "compose.dev.yaml", "compose.ci.yaml"])(
    "%s references only variables listed in .env.example",
    (file) => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const { name } of interpolations(text)) {
        expect(declared, `${file} interpolates ${name}`).toContain(name);
      }
    },
  );

  it("gives every non-secret reference a default", () => {
    const text = readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8");
    for (const { name, suffix } of interpolations(text)) {
      if (SECRETS.has(name)) continue;
      expect(suffix.startsWith(":-"), `${name} must be written \${${name}:-default}`).toBe(true);
    }
  });

  it("parses as YAML and declares both named volumes", () => {
    const document = parse(readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8")) as {
      name: string;
      volumes: Record<string, unknown>;
      services: Record<string, unknown>;
    };
    expect(document.name).toBe("fault-diagnosis-poc");
    expect(Object.keys(document.volumes).sort()).toEqual(["model-cache", "pgdata"]);
    expect(Object.keys(document.services)).toHaveLength(7);
  });
});
