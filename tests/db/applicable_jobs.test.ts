import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { expectClientRejected, linkParent, makePool, withRollback } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1545 — a child is never shown a job that does not apply today.
 *
 * Found by opening the app on a Saturday morning: My jobs told Hazel to pack
 * a school lunch. The engine was right all along — app_instance_applies_at
 * returned false for every school task — but the page read task_instances
 * directly and nothing asked.
 *
 * Instances exist for every active job every day on purpose, because
 * applicability is decided at call time and never written down; that is what
 * lets a snow day declared at 07:30 take effect at 07:30. The cost is that
 * any screen listing instances has to ask, and list_my_jobs is the one place
 * that asks.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "applicable-jobs@example.test");
});
afterAll(async () => {
  await pool.end();
});

async function asParent<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: parent.authId, role: "authenticated" }),
  ]);
  try {
    return await fn();
  } finally {
    await client.query("reset role").catch(() => {});
  }
}

/** Today's jobs, created the way the app creates them. */
async function materializeToday(client: pg.PoolClient) {
  const { rows } = await client.query<{ d: string }>(
    `select to_char(app_household_today($1), 'YYYY-MM-DD') as d`,
    [parent.householdId],
  );
  await asParent(client, () =>
    client.query("select ensure_day_materialized($1, $2::date)", [
      parent.householdId,
      rows[0].d,
    ]),
  );
}

async function aChild(client: pg.PoolClient) {
  const { rows } = await client.query<{ id: string }>(
    `select id from family_members
      where household_id = $1 and role = 'child' and is_active limit 1`,
    [parent.householdId],
  );
  return rows[0].id;
}

/**
 * Say, for today only, whether it is a school day.
 *
 * A dated override outranks the weekly pattern, which is how a snow day or
 * an inset day is meant to be expressed.
 */
async function setSchoolDay(client: pg.PoolClient, isSchoolDay: boolean) {
  await client.query(
    `insert into schedule_rules (household_id, rule_kind, override_date, is_school_day)
     select $1, 'date_override', app_household_today($1), $2
     on conflict (household_id, override_date)
       where rule_kind = 'date_override' and member_id is null
       do update set is_school_day = excluded.is_school_day`,
    [parent.householdId, isSchoolDay],
  );
}

describe("My jobs only lists what applies", () => {
  it("leaves out school-morning jobs when today is not a school day", async () => {
    await withRollback(pool, async (client) => {
      const child = await aChild(client);
      // Materialisation derives the household from the session, so it runs
      // as the parent. app_household_today is internal and not granted to a
      // client, so the date is worked out first.
      await materializeToday(client);
      await setSchoolDay(client, false);

      const { rows } = await asParent(client, () =>
        client.query<{ j: { title: string }[] }>("select list_my_jobs($1) as j", [child]),
      );
      const titles = rows[0].j.map((t) => t.title);

      // The instances exist; they simply do not apply.
      const { rows: present } = await client.query<{ n: number }>(
        `select count(*)::int as n
           from task_instances ti
           join task_definition_revisions r on r.id = ti.definition_revision_id
          where ti.occurrence_date = app_household_today($1)
            and r.recurrence = 'school_day'`,
        [parent.householdId],
      );
      expect(present[0].n, "school instances should exist").toBeGreaterThan(0);
      expect(titles, "but none of them should be offered").not.toContain("Pack a proper lunch");
      expect(titles).not.toContain("Eat breakfast");
    });
  });

  it("includes them when today IS a school day", async () => {
    await withRollback(pool, async (client) => {
      const child = await aChild(client);
      // Materialisation derives the household from the session, so it runs
      // as the parent. app_household_today is internal and not granted to a
      // client, so the date is worked out first.
      await materializeToday(client);
      await setSchoolDay(client, true);

      const { rows } = await asParent(client, () =>
        client.query<{ j: { title: string }[] }>("select list_my_jobs($1) as j", [child]),
      );
      const titles = rows[0].j.map((t) => t.title);
      expect(titles).toContain("Pack a proper lunch");
    });
  });

  it("says whether a job is theirs or the whole house's", async () => {
    await withRollback(pool, async (client) => {
      const child = await aChild(client);
      // Materialisation derives the household from the session, so it runs
      // as the parent. app_household_today is internal and not granted to a
      // client, so the date is worked out first.
      await materializeToday(client);

      const { rows } = await asParent(client, () =>
        client.query<{ j: { title: string; mine: boolean }[] }>(
          "select list_my_jobs($1) as j",
          [child],
        ),
      );
      expect(rows[0].j.length).toBeGreaterThan(0);
      expect(rows[0].j.some((t) => t.mine === false), "shared jobs appear").toBe(true);
    });
  });

  it("refuses a child in another household", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `with h as (
           insert into households (name, timezone)
           values ('Elsewhere', 'America/Vancouver') returning id
         )
         insert into family_members (household_id, display_name, role, is_active)
         select id, 'Their Child', 'child', true from h returning id`,
      );
      await asParent(client, async () => {
        const error = await expectClientRejected(client, "select list_my_jobs($1)", [
          rows[0].id,
        ]);
        expect(error.message).toMatch(/no such family member in your household/i);
      });
    });
  });
});

describe("the school-morning banner tells the truth", () => {
  it("is false when today is not a school day", async () => {
    await withRollback(pool, async (client) => {
      await setSchoolDay(client, false);
      const { rows } = await asParent(client, () =>
        client.query<{ v: boolean }>("select app_today_is_school_day() as v"),
      );
      expect(rows[0].v).toBe(false);
    });
  });

  it("is true when it is", async () => {
    await withRollback(pool, async (client) => {
      await setSchoolDay(client, true);
      const { rows } = await asParent(client, () =>
        client.query<{ v: boolean }>("select app_today_is_school_day() as v"),
      );
      expect(rows[0].v).toBe(true);
    });
  });
});
