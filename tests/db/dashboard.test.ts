import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { asMember, linkParent, makePool } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1544 — the dashboard payload.
 *
 * The thing worth guarding here is that this function stays a BATCH. It is
 * allowed to assemble, and not allowed to decide: every status in the payload
 * has to be the same answer the evaluators give for the same moment, or there
 * are two implementations of readiness and they will drift.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };
let children: { id: string; name: string }[];

const SCHOOL_DAY = "2026-11-13"; // a Friday
type Payload = Record<string, never>;

async function dashboard(at: string) {
  return asMember(pool, parent.authId, async (c) => {
    const { rows } = await c.query<{ d: unknown }>(
      `select evaluate_household_dashboard($1, $2) as d`,
      [parent.householdId, at],
    );
    return rows[0].d as {
      members: { id: string; display_name: string; own_outstanding: number; own_total: number }[];
      floors: { name: string; rooms: { space_id: string; name: string; status: string }[] }[];
      activities: { id: string; name: string; per_member: { member_id: string; status: string; blocking: unknown[] }[] }[];
      pets: { name: string; care: { title: string; by: string | null; at_local: string | null; satisfaction: string }[] }[];
      shopping: { name: string }[];
      progress: { done: number; total: number };
      in_morning_window: boolean;
      local_date: string;
    };
  });
}

async function moment(date: string, time: string): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    `select ((($1::text || ' ' || $2::text)::timestamp) at time zone h.timezone) as t
       from households h where h.id = $3`,
    [date, time, parent.householdId],
  );
  return rows[0].t;
}

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "slice6@example.test");
  const c = await pool.query<{ id: string; name: string }>(
    `select id, display_name as name from family_members where role = 'child' order by display_name`,
  );
  children = c.rows;
  await asMember(pool, parent.authId, (cl) =>
    cl.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, SCHOOL_DAY]),
  );
  await pool.query(
    `update task_instances set state = 'pending', completed_by = null, completed_at = null,
        submitted_by = null, submitted_at = null, not_applicable_reason = null,
        not_applicable_by = null, not_applicable_at = null
      where occurrence_date = $1`,
    [SCHOOL_DAY],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("one call returns the whole screen (AC10)", () => {
  it("includes members, floors, activities, the pet, shopping and progress", async () => {
    const d = await dashboard(await moment(SCHOOL_DAY, "14:00"));
    expect(d.members.length).toBe(5);
    expect(d.floors.map((f) => f.name).sort()).toEqual(["Downstairs", "Upstairs"]);
    expect(d.floors.flatMap((f) => f.rooms)).toHaveLength(11);
    expect(d.activities.map((a) => a.name).sort()).toEqual(["Play Video Games", "Watch TV"]);
    expect(d.pets).toHaveLength(1);
    expect(d.progress.total).toBeGreaterThan(0);
  });
});

describe("the payload agrees with the evaluators (AC7)", () => {
  it("every room status matches evaluate_space_status for the same moment", async () => {
    const at = await moment(SCHOOL_DAY, "14:00");
    const d = await dashboard(at);

    for (const room of d.floors.flatMap((f) => f.rooms)) {
      const direct = await asMember(pool, parent.authId, async (c) => {
        const { rows } = await c.query<{ r: { status: string } }>(
          `select evaluate_space_status($1, $2) as r`,
          [room.space_id, at],
        );
        return rows[0].r;
      });
      expect(room.status).toBe(direct.status);
    }
  });

  it("every activity status matches evaluate_activity_readiness for the same moment", async () => {
    const at = await moment(SCHOOL_DAY, "14:00");
    const d = await dashboard(at);

    for (const activity of d.activities) {
      for (const perMember of activity.per_member) {
        const direct = await asMember(pool, parent.authId, async (c) => {
          const { rows } = await c.query<{ r: { status: string } }>(
            `select evaluate_activity_readiness($1, $2, $3, $4) as r`,
            [parent.householdId, perMember.member_id, activity.id, at],
          );
          return rows[0].r;
        });
        expect(perMember.status).toBe(direct.status);
      }
    }
  });
});

describe("readiness is per member, not per household (AC5)", () => {
  it("one child's unpacked lunch leaves the siblings ready", async () => {
    const at = await moment(SCHOOL_DAY, "07:00");
    const [first] = children;

    const { rows: lunch } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
        where ti.occurrence_date = $1 and ti.subject_member_id = $2 and r.title ilike '%lunch%'`,
      [SCHOOL_DAY, first.id],
    );
    await pool.query(
      `update task_instances set state = 'completed', completed_by = $2, completed_at = now()
        where occurrence_date = $1 and not (id = any($3::uuid[]))`,
      [SCHOOL_DAY, parent.memberId, [lunch[0].id]],
    );

    const d = await dashboard(at);
    const games = d.activities.find((a) => /video/i.test(a.name))!;
    const blocked = games.per_member.find((p) => p.member_id === first.id)!;
    const others = games.per_member.filter((p) => p.member_id !== first.id);

    expect(blocked.status).toBe("not_ready");
    for (const o of others) expect(o.status).toBe("ready_to_ask");

    // And the member tile distinguishes "nothing of their own" from "done".
    const tile = d.members.find((m) => m.id === first.id)!;
    expect(tile.own_total).toBeGreaterThan(0);
    expect(tile.own_outstanding).toBe(1);
  });
});

describe("the pet shows who and when (AC6)", () => {
  it("names the member and the local time", async () => {
    const at = await moment(SCHOOL_DAY, "07:00");
    const { rows: feed } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
         join task_definitions td on td.id = ti.definition_id
        where ti.occurrence_date = $1 and td.pet_id is not null and r.title ilike '%feed%'`,
      [SCHOOL_DAY],
    );
    await pool.query(
      `update task_instances set state = 'completed', completed_by = $2,
          completed_at = (($1::text || ' 07:12')::timestamp at time zone 'America/Vancouver')
        where id = $3`,
      [SCHOOL_DAY, children[1].id, feed[0].id],
    );

    const d = await dashboard(at);
    const fed = d.pets[0].care.find((c) => /feed/i.test(c.title))!;
    expect(fed.satisfaction).toBe("satisfied");
    expect(fed.by).toBe(children[1].name);
    // Local time, so nobody feeds the dog twice at breakfast.
    expect(fed.at_local).toBe("07:12");
  });
});

describe("adult-shared bedrooms are present but do not gate (AC3)", () => {
  it("appear as rooms with their own status", async () => {
    const d = await dashboard(await moment(SCHOOL_DAY, "14:00"));
    const names = d.floors.flatMap((f) => f.rooms).map((r) => r.name);
    expect(names).toContain("Adult Bedroom");
    expect(names).toContain("Shared Bedroom");
  });

  it("but are absent from every activity's blockers", async () => {
    const at = await moment(SCHOOL_DAY, "14:00");
    await pool.query(
      `update task_instances set state = 'pending', completed_by = null, completed_at = null
        where occurrence_date = $1`,
      [SCHOOL_DAY],
    );
    // With the whole house undone, the adult rooms still must not appear as
    // reasons a child cannot watch television.
    const d = await dashboard(at);
    const everything = JSON.stringify(d.activities);
    expect(everything).not.toMatch(/Adult Bedroom|Shared Bedroom/);
  });
});

describe("the clock alone changes the answer (AC8)", () => {
  it("differs across the end of the morning window with no row touched", async () => {
    const before = await dashboard(await moment(SCHOOL_DAY, "07:00"));
    const after = await dashboard(await moment(SCHOOL_DAY, "09:00"));

    expect(before.in_morning_window).toBe(true);
    expect(after.in_morning_window).toBe(false);
    // Fewer things apply once the morning is over, and nothing was written.
    expect(after.progress.total).toBeLessThan(before.progress.total);
  });
});

describe("another household is refused", () => {
  it("will not assemble a dashboard for someone else", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into households (name, timezone) values ('Not Yours', 'UTC') returning id`,
    );
    try {
      await expect(
        asMember(pool, parent.authId, (c) =>
          c.query(`select evaluate_household_dashboard($1, now())`, [rows[0].id]),
        ),
      ).rejects.toThrow(/not your household/i);
    } finally {
      await pool.query(`delete from households where id = $1`, [rows[0].id]);
    }
  });
});

export type { Payload };
