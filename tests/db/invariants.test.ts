import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  aChildId,
  expectClientRejected,
  makePool,
  sampleDefinitions,
  seedIds,
  withRollback,
} from "./helpers";

/**
 * HAL-1539 acceptance criteria 4-8.
 *
 * Each test here takes a rule the spec says the database enforces and tries to
 * break it. A passing test means Postgres refused — not that application code
 * remembered to check. These are the invariants two independent reviews spent
 * three rounds on, so they get tested against the real engine.
 */

let pool: pg.Pool;
let defs: Awaited<ReturnType<typeof sampleDefinitions>>;
let ids: Awaited<ReturnType<typeof seedIds>>;
let childId: string;

beforeAll(async () => {
  pool = makePool();
  defs = await sampleDefinitions(pool);
  ids = await seedIds(pool);
  childId = await aChildId(pool);
});

afterAll(async () => {
  await pool.end();
});

const TODAY = "2026-11-13";

describe("occurrence mode cannot disagree with its definition (AC4)", () => {
  it("refuses an instance whose occurrence_mode differs from the definition's", async () => {
    await withRollback(pool, async (client) => {
      // defs.shared is a 'shared' definition. Claim it is per_member.
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'per_member', $4, $5)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY, childId],
      );
      // A composite foreign key, not a CHECK: a CHECK cannot reference another
      // table, which is the defect both reviewers caught in round 2.
      expect(error.code).toBe("23503");
    });
  });

  it("refuses a per-member instance with no subject", async () => {
    await withRollback(pool, async (client) => {
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'per_member', $4, null)`,
        [defs.perMember.household_id, defs.perMember.id, defs.perMember.revision_id, TODAY],
      );
      expect(error.code).toBe("23514"); // check_violation
    });
  });

  it("refuses a shared instance that names a subject", async () => {
    await withRollback(pool, async (client) => {
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'shared', $4, $5)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY, childId],
      );
      expect(error.code).toBe("23514");
    });
  });
});

describe("one definition, one date, one instance per grain (AC5)", () => {
  it("refuses a duplicate shared instance for the same definition and date", async () => {
    await withRollback(pool, async (client) => {
      await client.query(
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode, occurrence_date)
         values ($1, $2, $3, 'shared', $4)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY],
      );
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode, occurrence_date)
         values ($1, $2, $3, 'shared', $4)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY],
      );
      expect(error.code).toBe("23505"); // unique_violation
    });
  });

  it("refuses a duplicate per-member instance for the same member and date", async () => {
    await withRollback(pool, async (client) => {
      await client.query(
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'per_member', $4, $5)`,
        [defs.perMember.household_id, defs.perMember.id, defs.perMember.revision_id, TODAY, childId],
      );
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'per_member', $4, $5)`,
        [defs.perMember.household_id, defs.perMember.id, defs.perMember.revision_id, TODAY, childId],
      );
      expect(error.code).toBe("23505");
    });
  });

  it("allows two different members to have their own instance of one definition", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from family_members where role = 'child' order by display_name limit 2`,
      );
      expect(rows).toHaveLength(2);
      for (const member of rows) {
        await client.query(
          `insert into task_instances
             (household_id, definition_id, definition_revision_id, occurrence_mode,
              occurrence_date, subject_member_id)
           values ($1, $2, $3, 'per_member', $4, $5)`,
          [
            defs.perMember.household_id,
            defs.perMember.id,
            defs.perMember.revision_id,
            TODAY,
            member.id,
          ],
        );
      }
      const count = await client.query<{ n: string }>(
        `select count(*) as n from task_instances
          where definition_id = $1 and occurrence_date = $2`,
        [defs.perMember.id, TODAY],
      );
      expect(Number(count.rows[0].n)).toBe(2);
    });
  });

  it("cannot produce a mixed shared and per-member pair for one definition and date", async () => {
    await withRollback(pool, async (client) => {
      await client.query(
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode, occurrence_date)
         values ($1, $2, $3, 'shared', $4)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY],
      );
      // The coalesced single-index design would have allowed this row through,
      // because (def, date, NULL) and (def, date, member) are different keys.
      const error = await expectClientRejected(
        client,
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode,
            occurrence_date, subject_member_id)
         values ($1, $2, $3, 'per_member', $4, $5)`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY, childId],
      );
      expect(error.code).toBe("23503");
    });
  });
});

describe("requirement item scope must match its target (AC6)", () => {
  it("refuses a space item at requester scope", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from requirement_groups limit 1`,
      );
      const error = await expectClientRejected(
        client,
        `insert into requirement_group_items
           (group_id, household_id, target_kind, target_space_id, scope)
         values ($1, $2, 'space', $3, 'requester')`,
        [rows[0].id, ids.household_id, ids.children_bedroom],
      );
      expect(error.code).toBe("23514");
    });
  });

  it("refuses a household item pointed at a per-member definition", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from requirement_groups limit 1`,
      );
      const error = await expectClientRejected(
        client,
        `insert into requirement_group_items
           (group_id, household_id, target_kind, target_definition_id, occurrence_mode, scope)
         values ($1, $2, 'task_definition', $3, 'per_member', 'household')`,
        [rows[0].id, ids.household_id, defs.perMember.id],
      );
      expect(error.code).toBe("23514");
    });
  });

  it("refuses a requester item pointed at a shared definition", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select id from requirement_groups limit 1`,
      );
      const error = await expectClientRejected(
        client,
        `insert into requirement_group_items
           (group_id, household_id, target_kind, target_definition_id, occurrence_mode, scope)
         values ($1, $2, 'task_definition', $3, 'shared', 'requester')`,
        [rows[0].id, ids.household_id, defs.shared.id],
      );
      expect(error.code).toBe("23514");
    });
  });
});

describe("task definition revisions are append-only (AC7)", () => {
  it("refuses UPDATE for the authenticated role", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role authenticated");
      const error = await expectClientRejected(
        client,
        `update task_definition_revisions set title = 'rewritten'`,
      );
      expect(error.code).toBe("42501"); // insufficient_privilege
    });
  });

  it("refuses DELETE for the authenticated role", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role authenticated");
      const error = await expectClientRejected(
        client,
        `delete from task_definition_revisions`,
      );
      expect(error.code).toBe("42501");
    });
  });

  it("refuses UPDATE for the anon role", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role anon");
      const error = await expectClientRejected(
        client,
        `update task_definition_revisions set title = 'rewritten'`,
      );
      expect(error.code).toBe("42501");
    });
  });
});

describe("a photo has exactly one subject (AC8)", () => {
  it("refuses a photo with both a task instance and a space", async () => {
    await withRollback(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into task_instances
           (household_id, definition_id, definition_revision_id, occurrence_mode, occurrence_date)
         values ($1, $2, $3, 'shared', $4) returning id`,
        [defs.shared.household_id, defs.shared.id, defs.shared.revision_id, TODAY],
      );
      const error = await expectClientRejected(
        client,
        `insert into task_photos
           (household_id, task_instance_id, space_id, storage_path, uploaded_by, byte_size, content_type)
         values ($1, $2, $3, 'p.jpg', $4, 100, 'image/jpeg')`,
        [ids.household_id, rows[0].id, ids.kitchen, childId],
      );
      expect(error.code).toBe("23514");
    });
  });

  it("refuses a photo with neither", async () => {
    await withRollback(pool, async (client) => {
      const error = await expectClientRejected(
        client,
        `insert into task_photos
           (household_id, storage_path, uploaded_by, byte_size, content_type)
         values ($1, 'p.jpg', $2, 100, 'image/jpeg')`,
        [ids.household_id, childId],
      );
      expect(error.code).toBe("23514");
    });
  });

  it("accepts a space photo with no task instance", async () => {
    await withRollback(pool, async (client) => {
      const { rowCount } = await client.query(
        `insert into task_photos
           (household_id, space_id, storage_path, uploaded_by, byte_size, content_type)
         values ($1, $2, 'room.jpg', $3, 100, 'image/jpeg')`,
        [ids.household_id, ids.kitchen, childId],
      );
      expect(rowCount).toBe(1);
    });
  });
});
