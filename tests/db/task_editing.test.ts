import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { expectClientRejected, linkParent, makePool, withRollback } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1545 — creating and editing tasks from the app.
 *
 * The contract being defended here is that editing a task never rewrites
 * history. An edit writes a new immutable revision and repoints the
 * definition; every dated instance keeps the revision it was created under,
 * so yesterday's "tidy the bedroom" still lists yesterday's criteria after
 * someone changes the wording today.
 *
 * That is three writes in three tables. Row level security would let a
 * browser do them one at a time, which is why save_task exists — and why
 * these tests care as much about what survives a failure as about the happy
 * path.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "task-editing@example.test");
});
afterAll(async () => {
  await pool.end();
});

/** Run as the signed-in parent, the way the browser does. */
async function asParent<T>(
  client: pg.PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
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

async function aSpace(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "select id from household_spaces where household_id = $1 limit 1",
    [parent.householdId],
  );
  return rows[0].id;
}

describe("creating a task", () => {
  it("writes a first revision with its criteria, and points the task at it", async () => {
    await withRollback(pool, async (client) => {
      const spaceId = await aSpace(client);
      const { rows } = await asParent(client, () =>
        client.query<{ id: string }>(
          `select save_task(null, 'Water the plants',
             array['Front windowsill', 'Kitchen herbs'], $1) as id`,
          [spaceId],
        ),
      );
      const definitionId = rows[0].id;

      const { rows: def } = await client.query(
        `select d.is_active, d.location_space_id, r.revision_number, r.title
           from task_definitions d
           join task_definition_revisions r on r.id = d.current_revision_id
          where d.id = $1`,
        [definitionId],
      );
      expect(def[0]).toMatchObject({
        is_active: true,
        location_space_id: spaceId,
        revision_number: 1,
        title: "Water the plants",
      });

      const { rows: criteria } = await client.query<{ text: string }>(
        `select c.text from task_definition_criteria c
           join task_definition_revisions r on r.id = c.revision_id
          where r.definition_id = $1 order by c.display_order`,
        [definitionId],
      );
      expect(criteria.map((c) => c.text)).toEqual([
        "Front windowsill",
        "Kitchen herbs",
      ]);
    });
  });

  it("refuses a task with nothing to check off", async () => {
    // The brief's words: an opaque single "clean house" checkbox is the thing
    // this app must never be.
    await withRollback(pool, async (client) => {
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          "select save_task(null, 'Tidy up', array[]::text[])",
        );
        expect(error.message).toMatch(/at least one thing to check off/i);
      });
    });
  });

  it("refuses criteria that are only whitespace", async () => {
    await withRollback(pool, async (client) => {
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          "select save_task(null, 'Tidy up', array['   ', ''])",
        );
        expect(error.message).toMatch(/at least one thing to check off/i);
      });
    });
  });

  it("refuses a room belonging to another household", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `with h as (
           insert into households (name, timezone)
           values ('Elsewhere', 'America/Vancouver') returning id
         )
         insert into household_spaces (household_id, name)
         select id, 'Their Kitchen' from h returning id`,
      );
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          "select save_task(null, 'Reach in', array['nope'], $1)",
          [rows[0].id],
        );
        expect(error.message).toMatch(/no such room in your household/i);
      });
    });
  });
});

describe("editing a task", () => {
  it("adds a revision instead of rewriting the old one", async () => {
    await withRollback(pool, async (client) => {
      const spaceId = await aSpace(client);
      const definitionId = (
        await asParent(client, () =>
          client.query<{ id: string }>(
            "select save_task(null, 'Old name', array['Old criterion'], $1) as id",
            [spaceId],
          ),
        )
      ).rows[0].id;

      await asParent(client, () =>
        client.query("select save_task($1, 'New name', array['New criterion'], $2)", [
          definitionId,
          spaceId,
        ]),
      );

      const { rows: revisions } = await client.query<{
        revision_number: number;
        title: string;
      }>(
        `select revision_number, title from task_definition_revisions
          where definition_id = $1 order by revision_number`,
        [definitionId],
      );
      expect(revisions).toEqual([
        { revision_number: 1, title: "Old name" },
        { revision_number: 2, title: "New name" },
      ]);

      // The old revision keeps its own criteria, untouched.
      const { rows: old } = await client.query<{ text: string }>(
        `select c.text from task_definition_criteria c
           join task_definition_revisions r on r.id = c.revision_id
          where r.definition_id = $1 and r.revision_number = 1`,
        [definitionId],
      );
      expect(old.map((c) => c.text)).toEqual(["Old criterion"]);
    });
  });

  it("leaves yesterday's instance pointing at the wording it was made under", async () => {
    // The whole reason revisions exist. A task renamed this afternoon must
    // not change what this morning's instance says it required.
    await withRollback(pool, async (client) => {
      const spaceId = await aSpace(client);
      const definitionId = (
        await asParent(client, () =>
          client.query<{ id: string }>(
            "select save_task(null, 'As it was', array['As it was'], $1) as id",
            [spaceId],
          ),
        )
      ).rows[0].id;

      const { rows: first } = await client.query<{ id: string }>(
        "select current_revision_id as id from task_definitions where id = $1",
        [definitionId],
      );
      const originalRevision = first[0].id;

      const { rows: inst } = await client.query<{ id: string }>(
        `insert into task_instances
           (definition_id, definition_revision_id, household_id, occurrence_date,
          state, occurrence_mode, completed_by, completed_at)
         values ($1, $2, $3, current_date - 1, 'completed', 'shared', $4, now())
         returning id`,
        [definitionId, originalRevision, parent.householdId, parent.memberId],
      );

      await asParent(client, () =>
        client.query("select save_task($1, 'Renamed today', array['Different now'], $2)", [
          definitionId,
          spaceId,
        ]),
      );

      const { rows: after } = await client.query<{
        pinned: string;
        title: string;
      }>(
        `select i.definition_revision_id as pinned, r.title
           from task_instances i
           join task_definition_revisions r on r.id = i.definition_revision_id
          where i.id = $1`,
        [inst[0].id],
      );
      expect(after[0].pinned).toBe(originalRevision);
      expect(after[0].title).toBe("As it was");
    });
  });

  it("refuses a task belonging to another household", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `with h as (
           insert into households (name, timezone)
           values ('Elsewhere', 'America/Vancouver') returning id
         ), d as (
           insert into task_definitions (household_id, occurrence_mode)
           select id, 'shared' from h returning id
         )
         select id from d`,
      );
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          "select save_task($1, 'Reach in', array['nope'])",
          [rows[0].id],
        );
        expect(error.message).toMatch(/no such task in your household/i);
      });
    });
  });
});

describe("retiring a task", () => {
  it("stops it without destroying what it recorded", async () => {
    await withRollback(pool, async (client) => {
      const spaceId = await aSpace(client);
      const definitionId = (
        await asParent(client, () =>
          client.query<{ id: string }>(
            "select save_task(null, 'Seasonal job', array['Only in summer'], $1) as id",
            [spaceId],
          ),
        )
      ).rows[0].id;

      const { rows: inst } = await client.query<{ id: string }>(
        `insert into task_instances
           (definition_id, definition_revision_id, household_id, occurrence_date,
            state, occurrence_mode, completed_by, completed_at)
         select $1, current_revision_id, $2, current_date - 2, 'completed', 'shared', $3, now()
           from task_definitions where id = $1
         returning id`,
        [definitionId, parent.householdId, parent.memberId],
      );

      await asParent(client, () =>
        client.query("select set_task_active($1, false)", [definitionId]),
      );

      const { rows } = await client.query<{ is_active: boolean }>(
        "select is_active from task_definitions where id = $1",
        [definitionId],
      );
      expect(rows[0].is_active).toBe(false);

      // The history is still there.
      const { rows: still } = await client.query(
        "select id from task_instances where id = $1",
        [inst[0].id],
      );
      expect(still).toHaveLength(1);
    });
  });
});

describe("only a parent may do any of it", () => {
  it("refuses a signed-in caller with no household", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role authenticated");
      await client.query(
        "select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" })],
      );
      const error = await expectClientRejected(
        client,
        "select save_task(null, 'Sneak one in', array['nope'])",
      );
      expect(error.message).toMatch(/only a parent can change tasks/i);
    });
  });

  it("is unreachable by an anonymous caller", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role anon");
      const error = await expectClientRejected(
        client,
        "select save_task(null, 'Sneak one in', array['nope'])",
      );
      expect(error.message).toMatch(/permission denied/i);
    });
  });
});
