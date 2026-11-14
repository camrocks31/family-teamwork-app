import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { expectClientRejected, makePool, withRollback } from "./helpers";

/**
 * HAL-1539 acceptance criterion 9.
 *
 * The bundle served from GitHub Pages carries the anon key, and anyone can read
 * it. So "anonymous reads nothing" is not a nicety — it is the whole perimeter.
 * These tests act as the real `anon` and `authenticated` Postgres roles rather
 * than going through the client library, because that is the level an attacker
 * would use.
 */

let pool: pg.Pool;

const EVERY_TABLE = [
  "households",
  "family_members",
  "household_spaces",
  "pets",
  "task_definitions",
  "task_definition_revisions",
  "task_definition_criteria",
  "task_assignments",
  "task_instances",
  "task_events",
  "task_photos",
  "activities",
  "activity_availability_windows",
  "activity_grants",
  "requirement_groups",
  "requirement_group_items",
  "activity_requirements",
  "schedule_rules",
  "rewards",
  "shopping_items",
  "calendar_events",
  "calendar_event_attendees",
  "devices",
  "device_enrollment_codes",
];

beforeAll(async () => {
  pool = makePool();
});

afterAll(async () => {
  await pool.end();
});

describe("row level security is on everywhere", () => {
  it("has RLS enabled on every application table", async () => {
    const { rows } = await pool.query<{ tablename: string }>(
      `select c.relname as tablename
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not c.relrowsecurity`,
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
});

describe("an anonymous visitor reads nothing (AC9)", () => {
  for (const table of EVERY_TABLE) {
    it(`returns zero rows from ${table}`, async () => {
      await withRollback(pool, async (client) => {
        await client.query("set local role anon");
        const { rows } = await client.query(`select * from ${table}`);
        expect(rows).toEqual([]);
      });
    });
  }
});

describe("an authenticated session with no household reads nothing", () => {
  it("returns zero rows even as the authenticated role", async () => {
    await withRollback(pool, async (client) => {
      // A signed-in user who is not linked to any family_members row — for
      // example someone who obtained an account some other way — resolves to a
      // null household and therefore matches no row.
      await client.query("set local role authenticated");
      const { rows } = await client.query(`select * from family_members`);
      expect(rows).toEqual([]);
    });
  });
});

describe("the PIN hash is unreachable by any client role (AC9)", () => {
  // This is the defect that made the original design's acceptance criterion
  // impossible: RLS filters rows, not columns, and a device must read
  // family_members to draw the profile tiles. Credentials therefore live in
  // their own table with no grant at all.
  for (const role of ["anon", "authenticated"]) {
    it(`refuses a credentials read for ${role}`, async () => {
      await withRollback(pool, async (client) => {
        await client.query(`set local role ${role}`);
        const error = await expectClientRejected(
          client,
          `select * from member_credentials`,
        );
        expect(error.code).toBe("42501"); // insufficient_privilege
      });
    });

    it(`refuses a member_sessions read for ${role}`, async () => {
      await withRollback(pool, async (client) => {
        await client.query(`set local role ${role}`);
        const error = await expectClientRejected(
          client,
          `select * from member_sessions`,
        );
        expect(error.code).toBe("42501");
      });
    });
  }

  it("keeps the pin_hash column off family_members entirely", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_name = 'family_members'
          and column_name ilike '%pin%'`,
    );
    expect(rows).toEqual([]);
  });
});
