// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Ground-truth isolation, enforced by the database rather than by discipline
// (docs/architecture.md#ground-truth-isolation, db/README.md#2-roles).
//
// Every isolation assertion lives here. The point is not that the grants were
// written: it is that a diagnosis connection which names a `gt` relation is
// refused by PostgreSQL, whatever the code around it intended.
// `app-schema.test.ts` covers the `app` tables themselves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listMigrations } from "../../src/index.ts";
import { type PgTestStack, startPostgres } from "../../src/testing.ts";
import { MIGRATIONS_DIR, sqlstateOf, withClient } from "./helpers.ts";

/** PostgreSQL's SQLSTATE for insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = "42501";

let stack: PgTestStack;

beforeAll(async () => {
  stack = await startPostgres();
  // A table in `app` that the DML checks can aim at, created by the migrating
  // role so that 0001's default privileges apply to it exactly as they apply to
  // the diagnosis tables.
  await withClient(stack.adminUrl, async (client) => {
    await client.query(
      "CREATE TABLE app._probe (id integer GENERATED ALWAYS AS IDENTITY, note text)",
    );
  });
});

afterAll(async () => {
  await stack.stop();
});

describe("schema privileges", () => {
  it("keeps app_rw out of gt, gt_rw out of app, and lets eval into both", async () => {
    const privileges = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{
        app_rw_on_gt: boolean;
        gt_rw_on_app: boolean;
        eval_on_gt: boolean;
        eval_on_app: boolean;
      }>(
        `SELECT has_schema_privilege('app_rw','gt','USAGE')  AS app_rw_on_gt,
                has_schema_privilege('gt_rw','app','USAGE')  AS gt_rw_on_app,
                has_schema_privilege('eval','gt','USAGE')    AS eval_on_gt,
                has_schema_privilege('eval','app','USAGE')   AS eval_on_app`,
      );
      return result.rows[0];
    });
    expect(privileges).toEqual({
      app_rw_on_gt: false,
      gt_rw_on_app: false,
      eval_on_gt: true,
      eval_on_app: true,
    });
  });
});

describe("connected as app_rw", () => {
  it("is refused every ground-truth table", async () => {
    const state = await withClient(stack.urlFor("app_rw"), (client) =>
      sqlstateOf(() => client.query("SELECT count(*) FROM gt.injections")),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("writes and reads its own schema", async () => {
    const rows = await withClient(stack.urlFor("app_rw"), async (client) => {
      await client.query("INSERT INTO app._probe (note) VALUES ('from app_rw')");
      const result = await client.query<{ note: string }>("SELECT note FROM app._probe");
      return result.rows.map((row) => row.note);
    });
    expect(rows).toContain("from app_rw");
  });

  it("cannot become gt_rw", async () => {
    const state = await withClient(stack.urlFor("app_rw"), (client) =>
      sqlstateOf(() => client.query("SET ROLE gt_rw")),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("connected as gt_rw", () => {
  it("writes markers and is refused the diagnosis schema", async () => {
    await withClient(stack.urlFor("gt_rw"), async (client) => {
      await client.query(
        `INSERT INTO gt.markers (unit_id, kind, preset_id, sim_ts_from, sim_ts_to, wall_ts)
         VALUES ('cau-7-01', 'jump', 'preset-a', '2020-02-01T00:00:00Z', '2020-02-01T01:00:00Z', now())`,
      );
      const count = await client.query<{ count: string }>("SELECT count(*) FROM gt.markers");
      expect(count.rows[0]?.count).toBe("1");
      expect(await sqlstateOf(() => client.query("SELECT * FROM app._probe"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });
});

describe("connected as eval", () => {
  it("reads ground truth, never writes it, and writes the diagnosis schema", async () => {
    await withClient(stack.urlFor("eval"), async (client) => {
      await client.query("SELECT * FROM gt.injections");
      await client.query("SELECT * FROM gt.v_injection_windows");
      const refused = await sqlstateOf(() =>
        client.query(
          `INSERT INTO gt.injections
             (unit_id, instance_id, injection_id, fault_id, event, sim_ts, wall_ts)
           VALUES ('cau-7-01', 'inj-1-1', 'oil-leak', 'f-001', 'start', now(), now())`,
        ),
      );
      expect(refused).toBe(INSUFFICIENT_PRIVILEGE);
      await client.query("INSERT INTO app._probe (note) VALUES ('from eval')");
    });
  });
});

describe("the catalog itself", () => {
  it("records no grant of any gt relation to app_rw", async () => {
    const grants = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'app_rw' AND table_schema = 'gt'`,
      );
      return result.rows;
    });
    expect(grants).toEqual([]);
  });
});

describe("what the migrations left behind", () => {
  it("installed vector and pg_trgm", async () => {
    const names = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension ORDER BY extname",
      );
      return result.rows.map((row) => row.extname);
    });
    expect(names).toContain("vector");
    expect(names).toContain("pg_trgm");
  });

  // Every migration on disk, not a fixed list: a new migration changes nothing
  // this asserts.
  // `app-schema.test.ts` is where the numbering itself is pinned.
  it("recorded every migration with the hash of the file on disk", async () => {
    const rows = await withClient(stack.adminUrl, async (client) => {
      const result = await client.query<{ version: number; name: string; sha256: string }>(
        "SELECT version, name, sha256 FROM public.schema_migrations ORDER BY version",
      );
      return result.rows;
    });
    const files = listMigrations(MIGRATIONS_DIR);
    expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows.map((row) => row.name)).toEqual(files.map((file) => file.name));
    for (const row of rows) expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.map((row) => row.sha256)).toEqual(files.map((file) => file.sha256));
    expect(rows.slice(0, 2).map((row) => row.name)).toEqual(["extensions_schemas", "ground_truth"]);
  });
});
