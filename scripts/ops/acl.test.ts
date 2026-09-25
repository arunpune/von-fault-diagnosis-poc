// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The offline half of the broker's tests: the committed `infra/mosquitto/acl` is
// still what `packages/contracts/topics.json` renders to, and the four places that
// list credentials still agree.
//
// `scripts/ops/mosquitto.integration.test.ts` proves what the broker then does
// with those files; this file needs neither Docker nor a network.
//
// A checkout without the contracts' `topics.json` skips the rendering tests with a
// warning, so the broker files can be worked on without the contracts; CI sets
// FDP_REQUIRE_CONTRACTS=1, which turns the skip into a failure.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANONYMOUS,
  aclUsers,
  parseTopics,
  renderAcl,
  type TopicsWithAcl,
} from "./render-mosquitto-acl.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const TOPICS_FILE = join(REPO_ROOT, "packages", "contracts", "topics.json");
const ACL_FILE = join(REPO_ROOT, "infra", "mosquitto", "acl");
const PASSWD_TXT_FILE = join(REPO_ROOT, "infra", "mosquitto", "passwd.txt");
const PASSWD_FILE = join(REPO_ROOT, "infra", "mosquitto", "passwd");

/** The unit id every committed filter is rendered for. */
const UNIT_ID = "cau-7";

/** What an unauthenticated client may read, and nothing else. */
const ANONYMOUS_READ = [
  `plant/${UNIT_ID}/telemetry/#`,
  `plant/${UNIT_ID}/status/#`,
  `plant/${UNIT_ID}/events/#`,
  `plant/${UNIT_ID}/decisions`,
  `plant/${UNIT_ID}/alerts/#`,
  "$SYS/#",
];

/** The five broker credentials, one per client role. */
const EXPECTED_USERS = ["gateway", "sim", "backend-diag", "backend-ops", "eval"];

const contractsRequired = process.env.FDP_REQUIRE_CONTRACTS === "1";
const contractsPresent = existsSync(TOPICS_FILE);

if (!contractsPresent && !contractsRequired) {
  console.warn(
    `acl.test.ts: ${TOPICS_FILE} is absent from this checkout, so the` +
      " rendering tests are skipped. Set FDP_REQUIRE_CONTRACTS=1 to make this a failure.",
  );
}

const acl = readFileSync(ACL_FILE, "utf8");

/** Every credential the committed ACL opens a `user` block for, in file order. */
function usersInAcl(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("user "))
    .map((line) => line.slice("user ".length).trim());
}

/** Every credential a Mosquitto password file lists, plaintext or hashed. */
function usersInPasswordFile(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(0, line.indexOf(":")));
}

/** True when an MQTT topic filter matches a concrete topic name (MQTT 5 §4.7). */
function filterMatches(filter: string, topic: string): boolean {
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");
  for (let index = 0; index < filterLevels.length; index += 1) {
    const level = filterLevels[index];
    if (level === "#") return index <= topicLevels.length;
    if (index >= topicLevels.length) return false;
    if (level !== "+" && level !== topicLevels[index]) return false;
  }
  return filterLevels.length === topicLevels.length;
}

function readTopics(): TopicsWithAcl {
  return parseTopics(readFileSync(TOPICS_FILE, "utf8"), TOPICS_FILE);
}

describe("infra/mosquitto/acl", () => {
  it("opens a user block for exactly the five broker credentials", () => {
    expect(usersInAcl(acl).toSorted()).toEqual([...EXPECTED_USERS].toSorted());
  });

  it("grants anonymous clients exactly the anonymous read filters and nothing else", () => {
    const general = acl.slice(0, acl.indexOf("\nuser "));
    const rules = general
      .split("\n")
      .filter((line) => line.startsWith("topic "))
      .map((line) => line.slice("topic ".length));
    expect(rules).toEqual(ANONYMOUS_READ.map((filter) => `read ${filter}`));
  });

  it("makes eval a read-only credential over plant, gt and $SYS", () => {
    expect(blockOf("eval")).toEqual(["read plant/#", "read gt/#", "read $SYS/#"]);
  });

  it("keeps ground truth and the control topics out of backend-diag's reads", () => {
    const reads = blockOf("backend-diag")
      .filter((rule) => rule.startsWith("read "))
      .map((rule) => rule.slice("read ".length));
    expect(reads.length).toBeGreaterThan(0);
    for (const topic of [
      `gt/${UNIT_ID}/catalog`,
      `gt/${UNIT_ID}/injection/active`,
      `plant/${UNIT_ID}/control/cmd`,
      `plant/${UNIT_ID}/control/ack`,
    ]) {
      const matching = reads.filter((filter) => filterMatches(filter, topic));
      expect(matching, `backend-diag must not be able to read ${topic}`).toEqual([]);
    }
  });

  /** The `topic …` rules of one `user` block, without the `topic ` prefix. */
  function blockOf(user: string): string[] {
    const blocks = acl.split("\n\n");
    const block = blocks.find((candidate) => candidate.startsWith(`user ${user}\n`));
    expect(block, `the ACL has no block for ${user}`).toBeDefined();
    return (block as string)
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("topic "))
      .map((line) => line.slice("topic ".length));
  }
});

describe("credential files", () => {
  it("lists the same users in passwd.txt and the hashed passwd", () => {
    const plaintext = usersInPasswordFile(readFileSync(PASSWD_TXT_FILE, "utf8"));
    const hashed = usersInPasswordFile(readFileSync(PASSWD_FILE, "utf8"));
    expect(plaintext.toSorted()).toEqual([...EXPECTED_USERS].toSorted());
    expect(hashed.toSorted()).toEqual(plaintext.toSorted());
  });

  it("carries no comment line, which mosquitto_passwd would hash as a credential", () => {
    for (const file of [PASSWD_TXT_FILE, PASSWD_FILE]) {
      const offenders = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("#"));
      expect(offenders, `${file} must stay a pure user:password file`).toEqual([]);
    }
  });

  it("hashes every default with the PBKDF2-SHA512 scheme of Mosquitto 2.0.22", () => {
    const lines = readFileSync(PASSWD_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    for (const line of lines) {
      expect(line.slice(line.indexOf(":") + 1)).toMatch(/^\$7\$\d+\$[^$]+\$[^$]+$/);
    }
  });
});

describe.skipIf(!contractsPresent)("rendered from packages/contracts/topics.json", () => {
  it("reproduces the committed ACL byte for byte", () => {
    expect(renderAcl(readTopics())).toBe(acl);
  });

  it("agrees with passwd.txt on the credential set", () => {
    const fromContracts = aclUsers(readTopics());
    const fromPasswords = usersInPasswordFile(readFileSync(PASSWD_TXT_FILE, "utf8"));
    expect(fromContracts.toSorted()).toEqual(fromPasswords.toSorted());
  });

  it("substitutes {unit_id} everywhere, leaving no template left in the file", () => {
    expect(readTopics().default_unit_id).toBe(UNIT_ID);
    expect(acl).not.toContain("{unit_id}");
  });

  it("gives anonymous no write filter at all", () => {
    expect(readTopics().acl[ANONYMOUS].write ?? []).toEqual([]);
  });
});

describe.skipIf(contractsPresent)("packages/contracts/topics.json", () => {
  it("is present when FDP_REQUIRE_CONTRACTS=1 asks for it", () => {
    expect(contractsRequired, `${TOPICS_FILE} is absent`).toBe(false);
  });
});
