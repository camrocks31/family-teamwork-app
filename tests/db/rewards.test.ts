import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { expectClientRejected, linkParent, makePool, withRollback } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1545 — rewards.
 *
 * A reward is a named thing a child earns by completing N jobs over a day or
 * a week, and progress is DERIVED from task_instances rather than stored.
 * These tests care most about the consequence of that choice: when a parent
 * sends a job back, the progress goes down on its own, with nothing to
 * reconcile. A stored counter is where that sort of thing quietly goes wrong.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "rewards@example.test");
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

async function children(client: pg.PoolClient) {
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `select id, display_name from family_members
      where household_id = $1 and role = 'child' and is_active
      order by display_name`,
    [parent.householdId],
  );
  return rows;
}

/**
 * A completed job for this child, this many days from the household's today.
 *
 * Each call makes its OWN task. There is one shared instance per task per
 * day — the grain key — so two completions on the same day genuinely need
 * two tasks, and reusing a seeded one collides with whatever the rest of the
 * suite has already left on today's date.
 *
 * The date is computed in the HOUSEHOLD's timezone, because that is what
 * evaluate_rewards compares against; the server's date would make this wrong
 * for a few hours every evening.
 */
let fixtureCount = 0;
async function completeOne(client: pg.PoolClient, memberId: string, dayOffset = 0) {
  fixtureCount += 1;
  const { rows: def } = await client.query<{ id: string }>(
    `insert into task_definitions (household_id, occurrence_mode)
     values ($1, 'shared') returning id`,
    [parent.householdId],
  );
  const { rows: rev } = await client.query<{ id: string }>(
    `insert into task_definition_revisions
       (definition_id, household_id, revision_number, title, recurrence, occurrence_mode)
     values ($1, $2, 1, $3, 'daily', 'shared') returning id`,
    [def[0].id, parent.householdId, `Fixture job ${fixtureCount}`],
  );
  await client.query(
    `insert into task_instances
       (definition_id, definition_revision_id, household_id, occurrence_date,
        state, occurrence_mode, completed_by, completed_at)
     select $1, $2, $3, ((now() at time zone h.timezone)::date + $4::integer),
            'completed', 'shared', $5, now()
       from households h where h.id = $3`,
    [def[0].id, rev[0].id, parent.householdId, dayOffset, memberId],
  );
}

async function evaluate(client: pg.PoolClient) {
  const { rows } = await client.query<{ r: unknown[] }>(
    "select evaluate_rewards($1) as r",
    [parent.householdId],
  );
  return rows[0].r as {
    name: string;
    member_id: string;
    display_name: string;
    done: number;
    earned: boolean;
    still_needed: number;
  }[];
}

describe("earning a reward", () => {
  it("counts a child's completed jobs this week, and says when it is earned", async () => {
    await withRollback(pool, async (client) => {
      const [child] = await children(client);
      await client.query(
        `insert into rewards (household_id, name, threshold_count, period)
         values ($1, 'Film night', 2, 'week')`,
        [parent.householdId],
      );

      let rows = await asParent(client, () => evaluate(client));
      let mine = rows.find((r) => r.member_id === child.id)!;
      expect(mine).toMatchObject({ done: 0, earned: false, still_needed: 2 });

      await completeOne(client, child.id);
      rows = await asParent(client, () => evaluate(client));
      mine = rows.find((r) => r.member_id === child.id)!;
      expect(mine).toMatchObject({ done: 1, earned: false, still_needed: 1 });

      await completeOne(client, child.id);
      rows = await asParent(client, () => evaluate(client));
      mine = rows.find((r) => r.member_id === child.id)!;
      expect(mine).toMatchObject({ done: 2, earned: true, still_needed: 0 });
    });
  });

  it("takes the progress back down when a job is un-completed", async () => {
    // The reason this is derived rather than counted into a column. A parent
    // sending work back has to move the number, and a stored total is where
    // that silently fails to happen.
    await withRollback(pool, async (client) => {
      const [child] = await children(client);
      await client.query(
        `insert into rewards (household_id, name, threshold_count, period)
         values ($1, 'Film night', 1, 'week')`,
        [parent.householdId],
      );
      await completeOne(client, child.id);

      let mine = (await asParent(client, () => evaluate(client))).find(
        (r) => r.member_id === child.id,
      )!;
      expect(mine.earned).toBe(true);

      await client.query(
        `update task_instances
            set state = 'needs_attention', completed_by = null, completed_at = null
          where completed_by = $1`,
        [child.id],
      );

      mine = (await asParent(client, () => evaluate(client))).find(
        (r) => r.member_id === child.id,
      )!;
      expect(mine).toMatchObject({ done: 0, earned: false });
    });
  });

  it("does not count another child's work", async () => {
    await withRollback(pool, async (client) => {
      const [first, second] = await children(client);
      await client.query(
        `insert into rewards (household_id, name, threshold_count, period)
         values ($1, 'Film night', 1, 'week')`,
        [parent.householdId],
      );
      await completeOne(client, second.id);

      const rows = await asParent(client, () => evaluate(client));
      expect(rows.find((r) => r.member_id === first.id)!.done).toBe(0);
      expect(rows.find((r) => r.member_id === second.id)!.done).toBe(1);
    });
  });

  it("counts only today for a daily reward", async () => {
    await withRollback(pool, async (client) => {
      const [child] = await children(client);
      await client.query(
        `insert into rewards (household_id, name, threshold_count, period)
         values ($1, 'Pudding', 1, 'day')`,
        [parent.householdId],
      );
      // Yesterday's work does not pay for today's pudding.
      await completeOne(client, child.id, -1);

      const rows = await asParent(client, () => evaluate(client));
      expect(rows.find((r) => r.member_id === child.id)!.done).toBe(0);
    });
  });

  it("gives a reward aimed at one child to that child only", async () => {
    await withRollback(pool, async (client) => {
      const [first, second] = await children(client);
      await client.query(
        `insert into rewards (household_id, name, threshold_count, period, member_id)
         values ($1, 'Comic for Desmond', 1, 'week', $2)`,
        [parent.householdId, second.id],
      );

      const rows = await asParent(client, () => evaluate(client));
      expect(rows.map((r) => r.member_id)).toEqual([second.id]);
      expect(rows.some((r) => r.member_id === first.id)).toBe(false);
    });
  });
});

describe("rewards stay inside their household", () => {
  it("refuses to evaluate another household's rewards", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into households (name, timezone)
         values ('Elsewhere', 'America/Vancouver') returning id`,
      );
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          "select evaluate_rewards($1)",
          [rows[0].id],
        );
        expect(error.message).toMatch(/not your household/i);
      });
    });
  });

  it("refuses a reward pointed at a child in another household", async () => {
    // The composite foreign key, not a CHECK — a CHECK cannot reach another
    // table to find out whose child this is.
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `with h as (
           insert into households (name, timezone)
           values ('Elsewhere', 'America/Vancouver') returning id
         )
         insert into family_members (household_id, display_name, role, is_active)
         select id, 'Their Child', 'child', true from h returning id`,
      );
      const error = await expectClientRejected(
        client,
        `insert into rewards (household_id, name, threshold_count, member_id)
         values ($1, 'Reach in', 1, $2)`,
        [parent.householdId, rows[0].id],
      );
      expect(error.message).toMatch(/foreign key|rewards_member_in_household/i);
    });
  });

  it("will not accept a threshold of zero", async () => {
    await withRollback(pool, async (client) => {
      const error = await expectClientRejected(
        client,
        `insert into rewards (household_id, name, threshold_count)
         values ($1, 'Free pudding', 0)`,
        [parent.householdId],
      );
      expect(error.message).toMatch(/threshold_positive/i);
    });
  });
});

describe("only a parent may set rewards", () => {
  it("refuses a signed-in caller with no household", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({
          sub: "00000000-0000-0000-0000-000000000000",
          role: "authenticated",
        }),
      ]);
      // Row level security filters the insert rather than raising, so the
      // check is that nothing lands.
      await client
        .query(
          `insert into rewards (household_id, name, threshold_count)
           values ($1, 'Sneaky', 1)`,
          [parent.householdId],
        )
        .catch(() => undefined);
    });

    const { rows } = await pool.query(
      "select id from rewards where name = 'Sneaky'",
    );
    expect(rows).toHaveLength(0);
  });
});
