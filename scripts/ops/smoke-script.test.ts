// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The static side of the Compose smoke test: what can be proven about scripts/smoke.sh and
// scripts/ops/wait-for-stack.sh without starting a stack.
//
// Four groups. The scripts parse, pass shellcheck when it is installed, and answer --help
// and bad arguments with the documented exit codes. Live mode's key handling: a
// missing .env or a missing key is exit 5 naming the key, never its value, and --dry-run
// contacts nothing — proven by a `docker` stub on PATH that records every call. The source
// never traces commands, never renders the Compose configuration and never expands a key
// variable. Last, the embedded Python checker is run on synthetic inputs, so each assertion
// the stack run relies on is shown to fail when it should: ground-truth literals on the
// wire, a missing signature-A symptom, an incomplete init report, and an image that carries
// an environment file or the CI mock's token.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SMOKE = join(REPO_ROOT, "scripts/smoke.sh");
const WAIT = join(REPO_ROOT, "scripts/ops/wait-for-stack.sh");
const FAULTS_YAML = join(REPO_ROOT, "manual/spec/faults.yaml");
const FIXTURE = join(REPO_ROOT, "data/fixtures/metropt3/ci-slice.csv");

const EXIT_ASSERTION = 1;
const EXIT_STACK = 2;
const EXIT_NO_TICKET = 3;
const EXIT_USAGE = 4;
const EXIT_KEYS = 5;

/** Values that look like keys; the tests assert they never reach the output. */
const FAKE_TYPESAFE_KEY = "fdp-test-typesafe-value-4711";
const FAKE_LLM_KEY = "fdp-test-llm-value-0815";
/** The bearer token compose.ci.yaml hands the mock; spelled in two parts so no log greps it. */
const MOCK_TOKEN = ["fdp-ci-mock", "key"].join("-");

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fdp-smoke-test-"));
  scratch.push(dir);
  return dir;
}

function hasTool(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

/** Run a script with bash and a controlled environment. */
function run(
  script: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  return spawnSync("bash", [script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "", FDP_TIMING_SLACK: "", ...env },
  });
}

function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`;
}

/** An env file with the given lines. */
function envFile(lines: readonly string[]): string {
  const path = join(tempDir(), ".env");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** A PATH whose `docker` records its arguments instead of running. */
function stubbedDockerPath(): { path: string; calls: string } {
  const dir = tempDir();
  const calls = join(dir, "docker-calls.log");
  const stub = join(dir, "docker");
  writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`);
  chmodSync(stub, 0o755);
  return { path: `${dir}:${process.env["PATH"] ?? ""}`, calls };
}

const SOURCE = readFileSync(SMOKE, "utf8");

/** The Python program smoke.sh embeds between `<<'PY'` and `PY`. */
function embeddedPython(): string {
  const match = /<<'PY' \|\| true\n([\s\S]*?)\nPY\n/.exec(SOURCE);
  if (match?.[1] === undefined) throw new Error("smoke.sh embeds no Python program");
  return match[1];
}

/** Run one subcommand of the embedded checker. */
function checker(args: readonly string[], input?: string | Buffer): SpawnSyncReturns<string> {
  return spawnSync("python3", ["-c", embeddedPython(), ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
}

describe("the scripts", () => {
  it.each([SMOKE, WAIT])("%s parses", (script) => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it.runIf(hasTool("shellcheck"))("passes shellcheck", () => {
    const result = spawnSync("shellcheck", ["-s", "bash", SMOKE, WAIT], { encoding: "utf8" });
    expect(output(result)).toBe("");
    expect(result.status).toBe(0);
  });

  it("embeds a Python checker that compiles", () => {
    const result = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), 'smoke', 'exec')"],
      {
        input: embeddedPython(),
        encoding: "utf8",
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("smoke.sh arguments", () => {
  it("prints its usage for --help and exits 0", () => {
    const result = run(SMOKE, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: scripts\/smoke\.sh/);
    expect(result.stdout).toMatch(/--mode MODE/);
  });

  it.each([
    [["--mode", "bogus"]],
    [["--bogus"]],
    [["--speed", "0"]],
    [["--speed", "3601"]],
    [["--decision-timeout", "soon"]],
    [["--project", "Not Valid"]],
    [["--mode"]],
  ])("rejects %j with exit 4", (args) => {
    expect(run(SMOKE, args).status).toBe(EXIT_USAGE);
  });

  it("rejects a malformed FDP_TIMING_SLACK with exit 4", () => {
    expect(run(SMOKE, ["--dry-run"], { FDP_TIMING_SLACK: "fast" }).status).toBe(EXIT_USAGE);
  });
});

describe("live mode's keys", () => {
  it("exits 5 with 'keys missing' when ENV_FILE does not exist", () => {
    const result = run(SMOKE, ["--mode", "live", "--dry-run"], { ENV_FILE: "/nonexistent/.env" });
    expect(result.status).toBe(EXIT_KEYS);
    expect(output(result)).toMatch(/keys missing in \/nonexistent\/\.env/);
  });

  it("names the missing key and never prints the one that is present", () => {
    const env = envFile([`TYPESAFE_API_KEY=${FAKE_TYPESAFE_KEY}`, "LLM_API_KEY="]);
    const result = run(SMOKE, ["--mode", "live", "--dry-run"], { ENV_FILE: env });
    expect(result.status).toBe(EXIT_KEYS);
    expect(output(result)).toMatch(/keys missing in .*: LLM_API_KEY/);
    expect(output(result)).not.toContain(FAKE_TYPESAFE_KEY);
  });

  it("accepts --env-file in place of ENV_FILE", () => {
    const result = run(SMOKE, ["--mode", "live", "--dry-run", "--env-file", "/nonexistent/.env"], {
      ENV_FILE: envFile([`TYPESAFE_API_KEY=${FAKE_TYPESAFE_KEY}`, `LLM_API_KEY=${FAKE_LLM_KEY}`]),
    });
    expect(result.status).toBe(EXIT_KEYS);
    expect(output(result)).toMatch(/keys missing in \/nonexistent\/\.env/);
  });

  it("passes a dry run with both keys, contacting nothing and printing no value", () => {
    const docker = stubbedDockerPath();
    const env = envFile([
      `TYPESAFE_API_KEY=${FAKE_TYPESAFE_KEY}`,
      `LLM_API_KEY=${FAKE_LLM_KEY}`,
      "LLM_MODEL=model-under-test",
    ]);
    const result = run(SMOKE, ["--mode", "live", "--dry-run"], {
      ENV_FILE: env,
      PATH: docker.path,
    });
    expect(output(result)).toMatch(/dry run/);
    expect(result.status).toBe(0);
    expect(output(result)).not.toContain(FAKE_TYPESAFE_KEY);
    expect(output(result)).not.toContain(FAKE_LLM_KEY);
    expect(existsSync(docker.calls), "docker was called during a dry run").toBe(false);
  });
});

describe("ci mode's dry run", () => {
  it("needs the cut fixture slice and contacts nothing", () => {
    const docker = stubbedDockerPath();
    const result = run(SMOKE, ["--mode", "ci", "--dry-run"], { PATH: docker.path });
    if (existsSync(FIXTURE)) {
      expect(result.status).toBe(0);
    } else {
      expect(result.status).toBe(EXIT_STACK);
      expect(output(result)).toMatch(/make fixtures/);
    }
    expect(existsSync(docker.calls), "docker was called during a dry run").toBe(false);
  });
});

describe("the smoke script's source", () => {
  it("never traces commands", () => {
    expect(SOURCE).not.toMatch(/^\s*set\s+-[a-z]*x/m);
    expect(SOURCE).not.toMatch(/set\s+-o\s+xtrace/);
  });

  it("never renders the Compose configuration", () => {
    expect(SOURCE).not.toMatch(/compose[^\n]*\sconfig\b/);
  });

  it("never expands a key variable, let alone echoes one", () => {
    expect(SOURCE).not.toMatch(/\$\{?(TYPESAFE_API_KEY|LLM_API_KEY)\b/);
    expect(SOURCE).not.toMatch(/(echo|printf)[^\n]*(TYPESAFE_API_KEY|LLM_API_KEY)=/);
  });

  it("checks key presence with grep -q only", () => {
    expect(SOURCE).toMatch(/grep -qE "\^\$\{key\}=\.\+" "\$ENV_FILE"/);
  });
});

describe("wait-for-stack.sh arguments", () => {
  it("prints its usage for --help and exits 0", () => {
    const result = run(WAIT, ["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: scripts\/ops\/wait-for-stack\.sh/);
  });

  it.each([[[]], [["--timeout", "0", "p"]], [["--bogus", "p"]], [["a", "b"]]])(
    "rejects %j with exit 4",
    (args) => {
      expect(run(WAIT, args).status).toBe(EXIT_USAGE);
    },
  );
});

/** One `mosquitto_sub -v` line carrying a telemetry batch. */
function wireLine(samples: readonly Record<string, unknown>[]): string {
  const batch = { schema: "urn:fdp:schema:telemetry-samples:v1", unit_id: "cau-7", samples };
  return `plant/cau-7/telemetry/samples ${JSON.stringify(batch)}`;
}

function sample(
  seq: number,
  simTs: string,
  loaded: boolean,
  purge: number,
): Record<string, unknown> {
  return {
    seq,
    sim_ts: simTs,
    flags: { discontinuity: false, missing: false },
    values: { intake_closed: !loaded, load_valve: loaded, dryer_purge_pressure: purge },
    alarms: [],
  };
}

/** Samples every 10 s from `from` on 5 June 2020, loaded throughout. */
function loadedRun(minutes: number, purge: number): Record<string, unknown>[] {
  const start = Date.parse("2020-06-05T09:48:00.000Z");
  return Array.from({ length: (minutes * 60) / 10 + 1 }, (_, index) =>
    sample(index + 1, new Date(start + index * 10_000).toISOString(), true, purge),
  );
}

function capture(lines: readonly string[]): string {
  const path = join(tempDir(), "capture.txt");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("the embedded checker", () => {
  it("accepts clean telemetry and names a ground-truth literal on the wire", () => {
    const clean = capture(
      [1, 2, 3].map((seq) => wireLine([sample(seq, "2020-02-01T00:00:00.000Z", false, 0)])),
    );
    expect(checker(["telemetry", clean, "3"]).status).toBe(0);

    const leaked = capture([
      wireLine([sample(1, "2020-02-01T00:00:00.000Z", false, 0)]),
      wireLine([{ ...sample(2, "2020-02-01T00:00:10.000Z", false, 0), fault_id: "x" }]),
      wireLine([sample(3, "2020-02-01T00:00:20.000Z", false, 0)]),
    ]);
    const result = checker(["telemetry", leaked, "3"]);
    expect(result.status).toBe(EXIT_ASSERTION);
    expect(result.stdout).toMatch(/fault_id/);

    expect(checker(["telemetry", capture([wireLine([])]), "3"]).status).toBe(EXIT_ASSERTION);
  });

  it("sees signature A only when the unit stays loaded for half an hour with high purge pressure", () => {
    const run40 = loadedRun(40, 1.6);
    const ok = checker([
      "symptom",
      capture([wireLine(run40.slice(0, 120)), wireLine(run40.slice(120))]),
      "2020-06-05",
    ]);
    expect(ok.stdout).toMatch(/loaded for 40 sim min/);
    expect(ok.status).toBe(0);

    expect(checker(["symptom", capture([wireLine(loadedRun(20, 1.6))]), "2020-06-05"]).status).toBe(
      EXIT_ASSERTION,
    );
    expect(checker(["symptom", capture([wireLine(loadedRun(40, 0.4))]), "2020-06-05"]).status).toBe(
      EXIT_ASSERTION,
    );
    const broken = loadedRun(40, 1.6).map((s, index) =>
      index === 100 ? sample(101, s["sim_ts"] as string, false, 0) : s,
    );
    expect(checker(["symptom", capture([wireLine(broken)]), "2020-06-05"]).status).toBe(
      EXIT_ASSERTION,
    );
  });

  it("asserts the init report against every cause of faults.yaml", () => {
    const ids = [
      ...readFileSync(FAULTS_YAML, "utf8").matchAll(/^ {2}- fault_id:\s*([a-z0-9_]+)\s*$/gm),
    ].map((match) => match[1] as string);
    expect(ids.length).toBeGreaterThanOrEqual(38);
    const logLine = (faultIds: readonly string[], skipped = false): string => {
      const report = {
        skipped,
        manual: { path: "/data/manual/cau-7-realistic.pdf" },
        catalog: skipped
          ? null
          : { causes: faultIds.length, fault_ids: faultIds, source: "tables" },
      };
      return JSON.stringify({ event: "ingest.report", report: JSON.stringify(report) });
    };

    const complete = checker(
      ["init-report", FAULTS_YAML],
      `${logLine(ids)}\n${logLine([], true)}\n`,
    );
    expect(complete.stdout).toMatch(new RegExp(`${ids.length} causes`));
    expect(complete.status).toBe(0);

    const partial = checker(["init-report", FAULTS_YAML], `${logLine(ids.slice(1))}\n`);
    expect(partial.status).toBe(EXIT_ASSERTION);
    expect(partial.stdout).toContain(ids[0]);

    expect(checker(["init-report", FAULTS_YAML], `${logLine([], true)}\n`).status).toBe(
      EXIT_ASSERTION,
    );
  });

  describe("the ticket MUST", () => {
    /** Nothing listens on port 1, so every ticket read fails and the poll gives up at once. */
    const NO_BACKEND = "http://127.0.0.1:1";

    function decisionFile(backend: "von" | "rules"): string {
      const path = join(tempDir(), "decision.json");
      const decision = {
        decision_id: "d-1",
        episode_id: "e-1",
        backend,
        confidence: 0.208,
        gate: { outcome: "log" },
        probabilities: { dryer_purge_leak: 0.667, purge_silencer_damaged: 0.75 },
      };
      writeFileSync(path, JSON.stringify(decision));
      return path;
    }

    it("fails with exit 3 and names the known cause when the rules backend opens no ticket", () => {
      const result = checker(["wait-ticket", NO_BACKEND, decisionFile("rules"), "0"]);
      expect(result.status).toBe(EXIT_NO_TICKET);
      expect(result.stdout).toMatch(/gate log, confidence 0\.208/);
      expect(result.stdout).toMatch(
        /known failure: .*rules backend cannot reach review on signature A/,
      );
    });

    it("fails with exit 3 and no known cause for any other backend", () => {
      const result = checker(["wait-ticket", NO_BACKEND, decisionFile("von"), "0"]);
      expect(result.status).toBe(EXIT_NO_TICKET);
      expect(result.stdout).not.toMatch(/known failure/);
    });
  });

  describe("the waits for a new event or decision", () => {
    /** Nothing listens on port 1, so every read fails and the poll gives up at once. */
    const NO_BACKEND = "http://127.0.0.1:1";

    /** The ids a wait ignores, as `ids` writes them before the step. */
    function baselineFile(): string {
      const path = join(tempDir(), "baseline.json");
      writeFileSync(path, JSON.stringify(["already-seen"]));
      return path;
    }

    it("reads the event baseline and times out on the stack, not on its input", () => {
      const result = checker([
        "wait-event",
        NO_BACKEND,
        baselineFile(),
        "2020-06-05T06:00:00Z",
        "0",
      ]);
      expect(result.status).toBe(EXIT_ASSERTION);
      expect(result.stdout).toMatch(/no suspect event within 0s/);
      expect(result.stdout).not.toMatch(/unexpected input/);
    });

    it("reads the decision baseline and times out on the stack, not on its input", () => {
      const out = join(tempDir(), "decision.json");
      const result = checker([
        "wait-decision",
        NO_BACKEND,
        baselineFile(),
        "2020-06-05T06:00:00Z",
        "",
        "rules",
        "rules-v1",
        "0",
        out,
        "0",
      ]);
      expect(result.status).toBe(EXIT_ASSERTION);
      expect(result.stdout).toMatch(/no rules decision within 0s/);
      expect(result.stdout).not.toMatch(/unexpected input/);
    });
  });

  describe("image scan", () => {
    /** A `docker save`-shaped archive: one layer tar holding `files`, as an OCI blob. */
    function savedImage(files: Record<string, string>): Buffer {
      const dir = tempDir();
      const layer = join(dir, "layer");
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(layer, name, ".."), { recursive: true });
        writeFileSync(join(layer, name), content);
      }
      const blobs = join(dir, "image", "blobs", "sha256");
      mkdirSync(blobs, { recursive: true });
      expect(spawnSync("tar", ["-cf", join(blobs, "layer0"), "-C", layer, "."]).status).toBe(0);
      writeFileSync(join(dir, "image", "index.json"), '{"schemaVersion":2}');
      const archive = join(dir, "image.tar");
      expect(spawnSync("tar", ["-cf", archive, "-C", join(dir, "image"), "."]).status).toBe(0);
      return readFileSync(archive);
    }

    it("passes a clean image", () => {
      const result = checker(
        ["scan-image", "clean:test"],
        savedImage({ "app/server.js": "listen(3000)\n" }),
      );
      expect(result.stdout).toMatch(/1 layers, no environment file/);
      expect(result.status).toBe(0);
    });

    it.each([
      ["an environment file", { "app/.env": "LOG_LEVEL=info\n" }, /\.env/],
      ["the CI mock's token", { "app/config.yaml": `token: ${MOCK_TOKEN}\n` }, /the CI mock token/],
      [
        "a key-shaped value",
        { "app/notes.txt": `sk-ant-${"a".repeat(32)}\n` },
        /a key-shaped value/,
      ],
    ])("fails an image that carries %s", (_label, files, pattern) => {
      const result = checker(["scan-image", "leaky:test"], savedImage(files));
      expect(result.status).toBe(EXIT_ASSERTION);
      expect(result.stdout).toMatch(pattern);
      // A finding names what was found, never the token itself.
      expect(result.stdout).not.toContain(MOCK_TOKEN);
    });
  });
});
