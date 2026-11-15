import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { expectClientRejected, linkParent, makePool, withRollback } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * Per-child activity catalogues, and the things you can only do together.
 *
 * Two behaviours matter here and both are easy to get subtly wrong.
 *
 *   THE HOUSE IS COUNTED ONCE. A team activity evaluates several people, and
 *   the naive loop re-evaluates the shared requirements for each of them. The
 *   dashboard would then print "the kitchen" twice for a team of two — which
 *   is the exact duplication this whole slice exists to remove, returned in a
 *   new disguise. Several tests below assert the count, not just the verdict.
 *
 *   A TEAM WAITS FOR EVERYONE. Not for the person asking. That is the point:
 *   it makes helping your brother the fastest route to your own evening,
 *   rather than a way to lose a race. If a team activity ever unlocks for the
 *   first child to finish, the mechanic has inverted into the thing it was
 *   built to replace.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "catalogues@example.test");
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
      order by display_order, display_name`,
    [parent.householdId],
  );
  return rows;
}

/** Today, in the household's own timezone — the only date the engine uses. */
async function localToday(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ d: string }>(
    `select to_char((now() at time zone h.timezone)::date, 'YYYY-MM-DD') as d
       from households h where h.id = $1`,
    [parent.householdId],
  );
  return rows[0].d;
}

let fixtureSeq = 0;

/**
 * A task definition plus today's instance(s), wired into a requirement group.
 *
 * `shared` definitions get one instance belonging to the house; `per_member`
 * ones get an assignment and an instance for each named child, which is what
 * `app_requirement_rows` needs before a requester-scope item resolves to
 * anything at all.
 */
async function addRequirement(
  client: pg.PoolClient,
  groupId: string,
  mode: "shared" | "per_member",
  subjects: string[],
  state: "pending" | "completed" = "pending",
) {
  fixtureSeq += 1;
  const title = `Catalogue fixture ${fixtureSeq}`;
  const { rows: def } = await client.query<{ id: string }>(
    `insert into task_definitions (household_id, occurrence_mode)
     values ($1, $2) returning id`,
    [parent.householdId, mode],
  );
  const { rows: rev } = await client.query<{ id: string }>(
    `insert into task_definition_revisions
       (definition_id, household_id, revision_number, title, recurrence, occurrence_mode)
     values ($1, $2, 1, $3, 'daily', $4) returning id`,
    [def[0].id, parent.householdId, title, mode],
  );
  await client.query(`update task_definitions set current_revision_id = $1 where id = $2`, [
    rev[0].id,
    def[0].id,
  ]);

  const today = await localToday(client);
  if (mode === "shared") {
    await client.query(
      // Every use of $5 is cast: without it Postgres sees the parameter once
      // as a task_state and once as text and refuses with "inconsistent types
      // deduced for parameter $5".
      `insert into task_instances
         (definition_id, definition_revision_id, household_id, occurrence_date,
          state, occurrence_mode, subject_member_id, completed_by, completed_at)
       values ($1, $2, $3, $4::date, $5::task_state, 'shared', null,
               case when $5::text = 'completed' then $6::uuid end,
               case when $5::text = 'completed' then now() end)`,
      [def[0].id, rev[0].id, parent.householdId, today, state, subjects[0] ?? parent.memberId],
    );
  } else {
    for (const memberId of subjects) {
      await client.query(
        `insert into task_assignments (definition_id, household_id, member_id)
         values ($1, $2, $3)`,
        [def[0].id, parent.householdId, memberId],
      );
      await client.query(
        `insert into task_instances
           (definition_id, definition_revision_id, household_id, occurrence_date,
            state, occurrence_mode, subject_member_id, completed_by, completed_at)
         values ($1, $2, $3, $4::date, $5::task_state, 'per_member', $6::uuid,
                 case when $5::text = 'completed' then $6::uuid end,
                 case when $5::text = 'completed' then now() end)`,
        [def[0].id, rev[0].id, parent.householdId, today, state, memberId],
      );
    }
  }

  await client.query(
    `insert into requirement_group_items
       (group_id, household_id, target_kind, target_definition_id, occurrence_mode, scope)
     values ($1, $2, 'task_definition', $3, $4, $5)`,
    [groupId, parent.householdId, def[0].id, mode, mode === "shared" ? "household" : "requester"],
  );
  return def[0].id;
}

/** An activity with its own empty requirement group, ready to be filled. */
async function makeActivity(
  client: pg.PoolClient,
  participation: "solo" | "team",
  audience: string[] | null,
) {
  fixtureSeq += 1;
  const { rows: act } = await client.query<{ id: string }>(
    `insert into activities (household_id, name, participation)
     values ($1, $2, $3) returning id`,
    [parent.householdId, `Catalogue activity ${fixtureSeq}`, participation],
  );
  const { rows: grp } = await client.query<{ id: string }>(
    `insert into requirement_groups (household_id, name)
     values ($1, $2) returning id`,
    [parent.householdId, `Catalogue group ${fixtureSeq}`],
  );
  await client.query(
    `insert into activity_requirements (activity_id, group_id, household_id)
     values ($1, $2, $3)`,
    [act.at(0)!.id, grp[0].id, parent.householdId],
  );
  if (audience) {
    for (const memberId of audience) {
      await client.query(
        `insert into activity_audience (household_id, activity_id, member_id)
         values ($1, $2, $3)`,
        [parent.householdId, act[0].id, memberId],
      );
    }
  }
  return { activityId: act[0].id, groupId: grp[0].id };
}

interface Readiness {
  status: string;
  participation: string;
  applicable_count: number;
  audience: { member_id: string; display_name: string }[];
  blocking: {
    title: string;
    scope: string;
    for_member_id: string | null;
    for_member_name: string | null;
    is_self: boolean;
  }[];
}

async function readiness(
  client: pg.PoolClient,
  memberId: string,
  activityId: string,
): Promise<Readiness> {
  const { rows } = await client.query<{ r: Readiness }>(
    `select evaluate_activity_readiness($1, $2, $3) as r`,
    [parent.householdId, memberId, activityId],
  );
  return rows[0].r;
}

describe("who an activity is for", () => {
  it("offers it to every child when nobody is named", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const { activityId } = await makeActivity(client, "solo", null);
      const { rows } = await client.query<{ member_id: string }>(
        `select member_id from app_activity_audience($1)`,
        [activityId],
      );
      expect(rows.map((r) => r.member_id).sort()).toEqual(kids.map((k) => k.id).sort());
    });
  });

  it("offers it only to the children named", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const { activityId } = await makeActivity(client, "solo", [kids[0].id]);
      const { rows } = await client.query<{ member_id: string }>(
        `select member_id from app_activity_audience($1)`,
        [activityId],
      );
      expect(rows.map((r) => r.member_id)).toEqual([kids[0].id]);
    });
  });

  it("never offers an activity to a parent", async () => {
    await withRollback(pool, async (client) => {
      const { activityId } = await makeActivity(client, "solo", null);
      const { rows } = await client.query<{ member_id: string }>(
        `select member_id from app_activity_audience($1)`,
        [activityId],
      );
      expect(rows.map((r) => r.member_id)).not.toContain(parent.memberId);
    });
  });

  /**
   * The defect that started this slice: the dashboard asked every activity
   * about every child, so two activities produced identical cards. It must
   * now ask only about the audience.
   */
  it("evaluates an activity on the dashboard only for its audience", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const { activityId } = await makeActivity(client, "solo", [kids[1].id]);
      const dash = await asParent(client, async () => {
        const { rows } = await client.query<{ d: { activities: { id: string; per_member: { member_id: string }[] }[] } }>(
          `select evaluate_household_dashboard($1) as d`,
          [parent.householdId],
        );
        return rows[0].d;
      });
      const mine = dash.activities.find((a) => a.id === activityId);
      expect(mine!.per_member.map((p) => p.member_id)).toEqual([kids[1].id]);
    });
  });
});

describe("a team waits for everyone", () => {
  it("stays shut while a teammate still has work, even though you are done", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "team", [a.id, b.id]);
      // A's job is done; B's is not.
      await addRequirement(client, groupId, "per_member", [a.id], "completed");
      await addRequirement(client, groupId, "per_member", [b.id], "pending");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      expect(forA.participation).toBe("team");
      expect(forA.status).toBe("not_ready");
      // And it says WHOSE work it is waiting on, which is the sentence that
      // turns this from a punishment into a prompt.
      expect(forA.blocking).toHaveLength(1);
      expect(forA.blocking[0].for_member_id).toBe(b.id);
      expect(forA.blocking[0].for_member_name).toBe(b.display_name);
      expect(forA.blocking[0].is_self).toBe(false);
    });
  });

  it("opens once every teammate is done", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "team", [a.id, b.id]);
      await addRequirement(client, groupId, "per_member", [a.id, b.id], "completed");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      expect(forA.status).toBe("ready_to_ask");
      expect(forA.blocking).toHaveLength(0);
    });
  });

  /**
   * The counting test. A household requirement belongs to the house, not to a
   * person, so a team of two must report it ONCE. Reported twice it would
   * print "the kitchen" twice on one card.
   */
  it("counts the house once, however many people are on the team", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "team", [a.id, b.id]);
      await addRequirement(client, groupId, "shared", [], "pending");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      expect(forA.applicable_count).toBe(1);
      expect(forA.blocking).toHaveLength(1);
      expect(forA.blocking[0].scope).toBe("household");
      expect(forA.blocking[0].for_member_id).toBeNull();
    });
  });

  it("counts each teammate's own work once, and the house once, together", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "team", [a.id, b.id]);
      await addRequirement(client, groupId, "shared", [], "pending");
      await addRequirement(client, groupId, "per_member", [a.id, b.id], "pending");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      // One house job + one job each for two people.
      expect(forA.applicable_count).toBe(3);
      const household = forA.blocking.filter((x) => x.scope === "household");
      const personal = forA.blocking.filter((x) => x.scope === "requester");
      expect(household).toHaveLength(1);
      expect(personal).toHaveLength(2);
      expect(personal.map((p) => p.for_member_id).sort()).toEqual([a.id, b.id].sort());
    });
  });

  it("gives both teammates the same answer", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "team", [a.id, b.id]);
      await addRequirement(client, groupId, "per_member", [a.id], "completed");
      await addRequirement(client, groupId, "per_member", [b.id], "pending");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      const forB = await asParent(client, () => readiness(client, b.id, activityId));
      expect(forA.status).toBe(forB.status);
      expect(forA.applicable_count).toBe(forB.applicable_count);
    });
  });
});

describe("solo is unaffected by anyone else", () => {
  it("opens on your own work alone, while a sibling is still busy", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const [a, b] = kids;
      const { activityId, groupId } = await makeActivity(client, "solo", [a.id, b.id]);
      await addRequirement(client, groupId, "per_member", [a.id], "completed");
      await addRequirement(client, groupId, "per_member", [b.id], "pending");

      const forA = await asParent(client, () => readiness(client, a.id, activityId));
      expect(forA.status).toBe("ready_to_ask");
      const forB = await asParent(client, () => readiness(client, b.id, activityId));
      expect(forB.status).toBe("not_ready");
    });
  });
});

describe("editing an activity", () => {
  it("refuses a team of one", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          `select save_activity(null, 'Solo team', null, 'team', false, $1::uuid[], null, null)`,
          [[kids[0].id]],
        );
        expect(error.message).toMatch(/at least two people/i);
      });
    });
  });

  it("refuses a child who is not in your household", async () => {
    await withRollback(pool, async (client) => {
      const { rows: other } = await client.query<{ id: string }>(
        `insert into households (name, timezone) values ('Other', 'America/Vancouver')
         returning id`,
      );
      const { rows: stranger } = await client.query<{ id: string }>(
        `insert into family_members (household_id, display_name, role)
         values ($1, 'Someone Else', 'child') returning id`,
        [other[0].id],
      );
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          `select save_activity(null, 'Trespass', null, 'solo', false, $1::uuid[], null, null)`,
          [[stranger[0].id]],
        );
        expect(error.message).toMatch(/no such child/i);
      });
    });
  });

  it("refuses a caller who is not a parent", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role authenticated");
      try {
        const error = await expectClientRejected(
          client,
          `select save_activity(null, 'Not allowed', null, 'solo', false, null, null, null)`,
        );
        expect(error.message).toMatch(/only a parent/i);
      } finally {
        await client.query("reset role").catch(() => {});
      }
    });
  });

  it("replaces the audience wholesale", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const id = await asParent(client, async () => {
        const { rows } = await client.query<{ save_activity: string }>(
          `select save_activity(null, 'Console', '🎮', 'team', false, $1::uuid[], null, null)`,
          [[kids[0].id, kids[1].id]],
        );
        return rows[0].save_activity;
      });
      await asParent(client, async () => {
        await client.query(
          `select save_activity($1, 'Console', '🎮', 'solo', false, $2::uuid[], null, null)`,
          [id, [kids[2].id]],
        );
      });
      const { rows } = await client.query<{ member_id: string }>(
        `select member_id from activity_audience where activity_id = $1`,
        [id],
      );
      expect(rows.map((r) => r.member_id)).toEqual([kids[2].id]);
    });
  });
});

describe("the new surface is not open to the public", () => {
  it("refuses anon on every new function", async () => {
    await withRollback(pool, async (client) => {
      await client.query("set local role anon");
      for (const call of [
        `select app_activity_audience('00000000-0000-0000-0000-000000000000')`,
        `select save_activity(null, 'x', null, 'solo', false, null, null, null)`,
        `select set_activity_active('00000000-0000-0000-0000-000000000000', false)`,
      ]) {
        // Each refusal aborts the transaction, so every call gets its own
        // savepoint to roll back to — otherwise only the first is tested and
        // the rest fail with "current transaction is aborted".
        await client.query("savepoint probe");
        const error = await expectClientRejected(client, call);
        expect(error.code).toBe("42501");
        await client.query("rollback to savepoint probe");
      }
      await client.query("reset role").catch(() => {});
    });
  });
});

describe("people read in the family's own order", () => {
  it("puts parents before children and is deterministic", async () => {
    const { rows } = await pool.query<{ display_name: string; role: string; display_order: number }>(
      `select display_name, role, display_order from family_members
        where household_id = $1 order by display_order`,
      [parent.householdId],
    );
    const roles = rows.map((r) => r.role);
    expect(roles.indexOf("child")).toBeGreaterThan(roles.lastIndexOf("parent"));
    expect(new Set(rows.map((r) => r.display_order)).size).toBe(rows.length);
  });
});

/**
 * The second reviewer's findings, pinned.
 *
 * Every one of these was reproduced against the live database before the fix
 * and is asserted here so it cannot come back quietly.
 */
describe("editing an activity does not undo it", () => {
  it("leaves the audience alone when the caller does not mention it", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const id = await asParent(client, async () => {
        const { rows } = await client.query<{ save_activity: string }>(
          `select save_activity(null, 'Console', '🎮', 'team', false, $1::uuid[], null, null)`,
          [[kids[0].id, kids[1].id]],
        );
        return rows[0].save_activity;
      });
      // The smallest legal edit. This used to wipe the audience, which means
      // "every child" — silently un-targeting the activity.
      await asParent(client, async () => {
        await client.query(`select save_activity($1, 'Console renamed')`, [id]);
      });
      const { rows } = await client.query<{ member_id: string }>(
        `select member_id from activity_audience where activity_id = $1`,
        [id],
      );
      expect(rows.map((r) => r.member_id).sort()).toEqual([kids[0].id, kids[1].id].sort());
    });
  });

  it("refuses one person listed twice as a team, in words", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          `select save_activity(null, 'Dupe', null, 'team', false, $1::uuid[], null, null)`,
          [[kids[0].id, kids[0].id]],
        );
        // Not a raw unique-violation from further down the function.
        expect(error.message).toMatch(/at least two people/i);
      });
    });
  });

  it("does not let a parent edit the audience around the editor", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const id = await asParent(client, async () => {
        const { rows } = await client.query<{ save_activity: string }>(
          `select save_activity(null, 'Console', '🎮', 'team', false, $1::uuid[], null, null)`,
          [[kids[0].id, kids[1].id]],
        );
        return rows[0].save_activity;
      });
      // A team needs two people, and no CHECK can say so across rows — so the
      // table is read-only to clients and save_activity is the only writer.
      await asParent(client, async () => {
        const error = await expectClientRejected(
          client,
          `delete from activity_audience where activity_id = $1 and member_id = $2`,
          [id, kids[1].id],
        );
        expect(error.code).toBe("42501");
      });
    });
  });
});

describe("an activity nobody can do", () => {
  it("is left out of the dashboard rather than shown empty", async () => {
    await withRollback(pool, async (client) => {
      const kids = await children(client);
      const id = await asParent(client, async () => {
        const { rows } = await client.query<{ save_activity: string }>(
          `select save_activity(null, 'Only theirs', '🎮', 'solo', false, $1::uuid[], null, null)`,
          [[kids[0].id]],
        );
        return rows[0].save_activity;
      });
      // The only child it was for leaves the household.
      await client.query(`update family_members set is_active = false where id = $1`, [
        kids[0].id,
      ]);
      const dash = await asParent(client, async () => {
        const { rows } = await client.query<{ d: { activities: { id: string }[] } }>(
          `select evaluate_household_dashboard($1) as d`,
          [parent.householdId],
        );
        return rows[0].d;
      });
      expect(dash.activities.map((a) => a.id)).not.toContain(id);
    });
  });
});

describe("somebody who joins later", () => {
  it("sorts after the people already here, not above them", async () => {
    await withRollback(pool, async (client) => {
      await client.query(
        `insert into family_members (household_id, display_name, role)
         values ($1, 'Someone New', 'child')`,
        [parent.householdId],
      );
      const { rows } = await client.query<{ display_name: string }>(
        `select display_name from family_members
          where household_id = $1 order by display_order, display_name`,
        [parent.householdId],
      );
      expect(rows[rows.length - 1].display_name).toBe("Someone New");
    });
  });
});
