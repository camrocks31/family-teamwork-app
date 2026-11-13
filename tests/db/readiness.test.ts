import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import dotenv from "dotenv";
import { asMember, linkParent, makePool } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1542 — the readiness engine.
 *
 * These are the parent spec's own acceptance scenarios, run against the real
 * database as a real signed-in member. The question the product exists to
 * answer is "can I play yet, and if not, what is left?", so most of these
 * assert the *explanation* as well as the status: a bare "no" is the failure
 * mode the brief is written against.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };
let children: { id: string; name: string }[];
let games: string;
let tv: string;

// 2026-11-13 is a Friday (a school day); 2026-11-14 is the Saturday. Both are
// within the one-day-ahead guard on materialization.
const SCHOOL_DAY = "2026-11-13";
const WEEKEND = "2026-11-14";

async function moment(date: string, time: string): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    `select ((($1::text || ' ' || $2::text)::timestamp) at time zone h.timezone) as t
       from households h where h.id = $3`,
    [date, time, parent.householdId],
  );
  return rows[0].t;
}

async function readiness(memberId: string, activityId: string, at: string) {
  return asMember(pool, parent.authId, async (c) => {
    const { rows } = await c.query<{ r: unknown }>(
      `select evaluate_activity_readiness($1, $2, $3, $4) as r`,
      [parent.householdId, memberId, activityId, at],
    );
    return rows[0].r as {
      status: string;
      blocking: { reason_code: string; reason: string; link_kind: string; link_id: string; link_name: string; title: string }[];
      satisfied: { title: string }[];
      pending_reviews: { title: string }[];
      exemptions: { title: string }[];
      applicable_count: number;
      reasons: string[];
    };
  });
}

/**
 * An instance that really is one of this activity's requirements.
 *
 * Picking any old shared instance is not good enough: the adult-shared
 * bedrooms are deliberately NOT in the cleaning group (D1), so an arbitrary
 * task may have no bearing on readiness at all — which is exactly how two of
 * these tests first failed.
 */
async function requirementInstance(activityId: string, memberId: string, date: string) {
  const { rows } = await pool.query<{ instance_id: string; revision_id: string }>(
    `select rr.instance_id, ti.definition_revision_id as revision_id
       from app_requirement_rows($1, $2, $3) rr
       join task_instances ti on ti.id = rr.instance_id
      where rr.link_kind = 'space'
      limit 1`,
    [activityId, memberId, date],
  );
  if (rows.length === 0) throw new Error("no requirement instance found");
  return rows[0];
}

/** Mark an instance done, filling the columns the check constraints demand. */
async function satisfy(instanceId: string) {
  await pool.query(
    `update task_instances
        set state = 'completed', completed_by = $2, completed_at = now(), version = version + 1
      where id = $1`,
    [instanceId, parent.memberId],
  );
}

async function setState(instanceId: string, state: string, extra: Record<string, unknown> = {}) {
  if (state === "submitted") {
    await pool.query(
      `update task_instances set state = 'submitted', submitted_by = $2, submitted_at = now()
        where id = $1`,
      [instanceId, extra.by ?? parent.memberId],
    );
  } else if (state === "needs_attention") {
    await pool.query(
      `update task_instances set state = 'needs_attention', correction_note = $2 where id = $1`,
      [instanceId, extra.note ?? "Have another look"],
    );
  } else if (state === "exempt") {
    await pool.query(
      `update task_instances
          set state = 'not_applicable', not_applicable_reason = 'parent_exemption',
              not_applicable_by = $2, not_applicable_at = now(), exemption_note = 'Excused'
        where id = $1`,
      [instanceId, parent.memberId],
    );
  } else {
    await pool.query(`update task_instances set state = $2 where id = $1`, [instanceId, state]);
  }
}

/** Satisfy every instance for a date except the ones named. */
async function satisfyAllExcept(date: string, exceptIds: string[] = []) {
  await pool.query(
    `update task_instances
        set state = 'completed', completed_by = $2, completed_at = now()
      where occurrence_date = $1 and not (id = any($3::uuid[]))`,
    [date, parent.memberId, exceptIds],
  );
}

async function resetDay(date: string) {
  await pool.query(
    `update task_instances
        set state = 'pending', completed_by = null, completed_at = null,
            submitted_by = null, submitted_at = null,
            not_applicable_reason = null, not_applicable_by = null,
            not_applicable_at = null, exemption_note = null, correction_note = null
      where occurrence_date = $1`,
    [date],
  );
}

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "slice4@example.test");

  const c = await pool.query<{ id: string; name: string }>(
    `select id, display_name as name from family_members where role = 'child' order by display_name`,
  );
  children = c.rows;

  const a = await pool.query<{ id: string; name: string }>(
    `select id, name from activities order by display_order`,
  );
  games = a.rows.find((x) => /video/i.test(x.name))!.id;
  tv = a.rows.find((x) => /tv/i.test(x.name))!.id;

  for (const day of [SCHOOL_DAY, WEEKEND]) {
    await asMember(pool, parent.authId, (cl) =>
      cl.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, day]),
    );
    // Start from a clean day so the suite is repeatable without a database
    // reset in between. One of these tests deletes an instance on purpose, so
    // materializing again above is part of the cleanup too.
    await resetDay(day);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("the blocker says what is left and where (AC1 — parent spec test 2)", () => {
  it("names the children's bedroom and links to it", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");

    const { rows: bedroom } = await pool.query<{ id: string; instance_id: string }>(
      `select sp.id, ti.id as instance_id
         from household_spaces sp
         join task_definitions td on td.location_space_id = sp.id
         join task_instances ti on ti.definition_id = td.id and ti.occurrence_date = $1
        where sp.name = 'Children''s Bedroom' limit 1`,
      [WEEKEND],
    );
    await satisfyAllExcept(WEEKEND, [bedroom[0].instance_id]);

    const result = await readiness(children[0].id, games, at);

    expect(result.status).toBe("not_ready");
    const blocker = result.blocking.find((b) => b.link_kind === "space");
    expect(blocker).toBeDefined();
    expect(blocker!.link_name).toBe("Children's Bedroom");
    expect(blocker!.link_id).toBe(bedroom[0].id);
    expect(blocker!.reason).toMatch(/Children's Bedroom needs attention/);
  });
});

describe("the last task finishes the house (AC2 — parent spec test 3)", () => {
  it("turns both activities ready at the same moment", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");

    const req = await requirementInstance(games, children[0].id, WEEKEND);
    const last = [{ id: req.instance_id }];
    await satisfyAllExcept(WEEKEND, [last[0].id]);

    expect((await readiness(children[0].id, games, at)).status).toBe("not_ready");
    expect((await readiness(children[0].id, tv, at)).status).toBe("not_ready");

    await satisfy(last[0].id);

    expect((await readiness(children[0].id, games, at)).status).toBe("ready_to_ask");
    expect((await readiness(children[0].id, tv, at)).status).toBe("ready_to_ask");
  });
});

describe("one child's lunch is their own (AC3 — parent spec test 4)", () => {
  it("blocks only the child who has not packed it", async () => {
    await resetDay(SCHOOL_DAY);
    const at = await moment(SCHOOL_DAY, "07:00");

    const [first, ...others] = children;
    const { rows: lunch } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
        where ti.occurrence_date = $1 and ti.subject_member_id = $2
          and r.title ilike '%lunch%'`,
      [SCHOOL_DAY, first.id],
    );
    await satisfyAllExcept(SCHOOL_DAY, [lunch[0].id]);

    const blocked = await readiness(first.id, games, at);
    expect(blocked.status).toBe("not_ready");
    expect(blocked.blocking.map((b) => b.title).join(" ")).toMatch(/lunch/i);

    // The siblings are not held up by it. "Do not pressure siblings to do one
    // another's work" is the rule this protects.
    for (const sibling of others) {
      const r = await readiness(sibling.id, games, at);
      expect(r.status).toBe("ready_to_ask");
    }
  });
});

describe("weekends are not school mornings (AC4 — parent spec test 5)", () => {
  it("mentions no breakfast, lunch, water bottle or getting dressed", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");

    for (const child of children) {
      const r = await readiness(child.id, games, at);
      const everything = JSON.stringify([...r.blocking, ...r.satisfied]);
      expect(everything).not.toMatch(/breakfast|lunch|water bottle|ready to go/i);
    }
  });
});

describe("scope rules (AC5, AC6)", () => {
  it("a per-member task never blocks a member it is not assigned to", async () => {
    await resetDay(SCHOOL_DAY);
    const at = await moment(SCHOOL_DAY, "07:00");
    await satisfyAllExcept(SCHOOL_DAY, []);

    // A parent is not assigned any school-morning task, so none applies.
    const r = await readiness(parent.memberId, games, at);
    expect(r.blocking).toEqual([]);
    expect(JSON.stringify(r.satisfied)).not.toMatch(/lunch/i);
  });

  it("a space item pulls in only shared tasks, never a child's own", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n
         from app_requirement_rows($1, $2, $3) rr
         join task_instances ti on ti.id = rr.instance_id
        where rr.link_kind = 'space' and ti.occurrence_mode = 'per_member'`,
      [games, children[0].id, SCHOOL_DAY],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("edge cases the spec calls out (AC7, AC8)", () => {
  it("an activity with nothing required is ready, and says so", async () => {
    const { rows: act } = await pool.query<{ id: string }>(
      `insert into activities (household_id, name, icon) values ($1, 'Read a book', '📚')
       returning id`,
      [parent.householdId],
    );
    try {
      const at = await moment(WEEKEND, "14:00");
      const r = await readiness(children[0].id, act[0].id, at);
      expect(r.status).toBe("ready_to_ask");
      expect(r.applicable_count).toBe(0);
      expect(r.reasons.join(" ")).toMatch(/nothing is required/i);
    } finally {
      await pool.query(`delete from activities where id = $1`, [act[0].id]);
    }
  });

  it("a task that should exist but does not blocks, rather than counting as done", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");
    await satisfyAllExcept(WEEKEND, []);
    expect((await readiness(children[0].id, games, at)).status).toBe("ready_to_ask");

    const { rows: victim } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definitions td on td.id = ti.definition_id
         join household_spaces sp on sp.id = td.location_space_id
        where ti.occurrence_date = $1 and sp.name = 'Kitchen' limit 1`,
      [WEEKEND],
    );
    await pool.query(`delete from task_events where task_instance_id = $1`, [victim[0].id]);
    await pool.query(`delete from task_instances where id = $1`, [victim[0].id]);

    const r = await readiness(children[0].id, games, at);
    expect(r.status).toBe("not_ready");
    expect(r.blocking.some((b) => b.reason_code === "missing_instance")).toBe(true);

    await asMember(pool, parent.authId, (c) =>
      c.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, WEEKEND]),
    );
  });
});

describe("review, exemption and permission (AC9, AC10, AC11)", () => {
  it("submitted counts only where the task does not need checking", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");
    const req = await requirementInstance(games, children[0].id, WEEKEND);
    const inst = [{ id: req.instance_id, revision_id: req.revision_id }];
    await satisfyAllExcept(WEEKEND, [inst[0].id]);
    await setState(inst[0].id, "submitted");

    // No approval required: handing it in is enough.
    expect((await readiness(children[0].id, games, at)).status).toBe("ready_to_ask");

    // Now the same task, under a revision that requires a parent's check.
    await pool.query(
      `update task_definition_revisions set requires_approval = true where id = $1`,
      [inst[0].revision_id],
    );
    try {
      const r = await readiness(children[0].id, games, at);
      expect(r.status).toBe("not_ready");
      expect(r.pending_reviews.length).toBe(1);
      expect(r.blocking.some((b) => b.reason_code === "pending_review")).toBe(true);
    } finally {
      await pool.query(
        `update task_definition_revisions set requires_approval = false where id = $1`,
        [inst[0].revision_id],
      );
    }
  });

  it("an exemption satisfies, and is reported as an exemption", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");
    const req = await requirementInstance(games, children[0].id, WEEKEND);
    const inst = [{ id: req.instance_id }];
    await satisfyAllExcept(WEEKEND, [inst[0].id]);
    await setState(inst[0].id, "exempt");

    const r = await readiness(children[0].id, games, at);
    expect(r.status).toBe("ready_to_ask");
    expect(r.exemptions.length).toBe(1);
  });

  it("ready to ask is not the same as approved", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");
    await satisfyAllExcept(WEEKEND, []);

    await pool.query(`update activities set requires_parent_approval = true where id = $1`, [games]);
    try {
      // Everything is done, and the answer is still "you may ask".
      expect((await readiness(children[0].id, games, at)).status).toBe("ready_to_ask");

      const { rows: grant } = await pool.query<{ id: string }>(
        `insert into activity_grants
           (household_id, activity_id, member_id, granted_by, valid_from, valid_until)
         values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 day')
         returning id`,
        [parent.householdId, games, children[0].id, parent.memberId],
      );
      expect((await readiness(children[0].id, games, at)).status).toBe("approved");

      // And a grant that has run out stops counting.
      await pool.query(
        `update activity_grants set valid_until = now() - interval '1 minute' where id = $1`,
        [grant[0].id],
      );
      expect((await readiness(children[0].id, games, at)).status).toBe("ready_to_ask");
      await pool.query(`delete from activity_grants where id = $1`, [grant[0].id]);
    } finally {
      await pool.query(
        `update activities set requires_parent_approval = false where id = $1`,
        [games],
      );
    }
  });

  it("an activity outside its hours says so before listing chores (AC12)", async () => {
    await resetDay(WEEKEND);
    const at = await moment(WEEKEND, "14:00");
    await pool.query(
      `insert into activity_availability_windows (activity_id, household_id, start_time, end_time)
       values ($1, $2, '16:00', '19:00')`,
      [games, parent.householdId],
    );
    try {
      const r = await readiness(children[0].id, games, at);
      expect(r.status).toBe("temporarily_unavailable");
      // No chore list: the honest answer is about the clock, not the house.
      expect(r.blocking).toEqual([]);
      expect(r.reasons.join(" ")).toMatch(/not available at this time/i);
    } finally {
      await pool.query(`delete from activity_availability_windows where activity_id = $1`, [games]);
    }
  });
});

describe("room status is total (AC13, AC14)", () => {
  async function spaceStatus(spaceId: string, at: string) {
    return asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ r: { status: string; note: string | null } }>(
        `select evaluate_space_status($1, $2) as r`,
        [spaceId, at],
      );
      return rows[0].r;
    });
  }

  let kitchen: string;
  let kitchenInstances: string[];

  beforeAll(async () => {
    const { rows } = await pool.query<{ id: string }>(
      `select id from household_spaces where name = 'Kitchen'`,
    );
    kitchen = rows[0].id;
    const inst = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definitions td on td.id = ti.definition_id
        where td.location_space_id = $1 and ti.occurrence_date = $2`,
      [kitchen, WEEKEND],
    );
    kitchenInstances = inst.rows.map((r) => r.id);
  });

  it("every combination resolves to a status", async () => {
    const at = await moment(WEEKEND, "14:00");
    const [first] = kitchenInstances;

    await resetDay(WEEKEND);
    expect((await spaceStatus(kitchen, at)).status).toBe("needs_attention"); // all pending

    await setState(first, "needs_attention");
    expect((await spaceStatus(kitchen, at)).status).toBe("needs_attention"); // returned

    await resetDay(WEEKEND);
    await pool.query(
      `update task_definition_revisions set requires_approval = true
        where id in (select definition_revision_id from task_instances where id = any($1::uuid[]))`,
      [kitchenInstances],
    );
    try {
      for (const id of kitchenInstances) await setState(id, "submitted");
      // Two submitted-and-awaiting. The first draft of the precedence rules
      // left exactly this case matching nothing at all.
      expect((await spaceStatus(kitchen, at)).status).toBe("awaiting_review");

      if (kitchenInstances.length > 1) {
        await setState(kitchenInstances[1], "pending");
        expect((await spaceStatus(kitchen, at)).status).toBe("in_progress");
      }
    } finally {
      await pool.query(
        `update task_definition_revisions set requires_approval = false
          where id in (select definition_revision_id from task_instances where id = any($1::uuid[]))`,
        [kitchenInstances],
      );
    }

    await resetDay(WEEKEND);
    for (const id of kitchenInstances) await satisfy(id);
    expect((await spaceStatus(kitchen, at)).status).toBe("ready");
  });

  it("a room with nothing to do today is ready, and says why", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into household_spaces (household_id, name) values ($1, 'Spare Room')
       returning id`,
      [parent.householdId],
    );
    try {
      const at = await moment(WEEKEND, "14:00");
      const status = await spaceStatus(rows[0].id, at);
      expect(status.status).toBe("ready");
      expect(status.note).toMatch(/nothing needed/i);
    } finally {
      await pool.query(`delete from household_spaces where id = $1`, [rows[0].id]);
    }
  });

  it("a room and an activity never disagree about the same instance", async () => {
    // Outside the morning window, a school-morning task is invisible to both.
    const at = await moment(SCHOOL_DAY, "14:00");
    const { rows } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
        where ti.occurrence_date = $1 and r.recurrence = 'school_day' limit 1`,
      [SCHOOL_DAY],
    );
    const appliesNow = await pool.query<{ a: boolean }>(
      `select app_instance_applies_at($1, $2) as a`,
      [rows[0].id, at],
    );
    expect(appliesNow.rows[0].a).toBe(false);

    await resetDay(SCHOOL_DAY);
    const r = await readiness(children[0].id, games, at);
    expect(JSON.stringify(r.blocking)).not.toMatch(/lunch|breakfast|water bottle/i);
  });
});

describe("readiness is never stored (AC15)", () => {
  it("no table has a column holding it", async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and (column_name ilike '%is_ready%'
            or column_name ilike '%readiness%'
            or column_name = 'ready')`,
    );
    expect(rows).toEqual([]);
  });

  it("is refused for another household", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into households (name, timezone) values ('Someone Else', 'UTC') returning id`,
    );
    try {
      const at = await moment(WEEKEND, "14:00");
      await expect(
        asMember(pool, parent.authId, (c) =>
          c.query(`select evaluate_activity_readiness($1, $2, $3, $4)`, [
            rows[0].id,
            children[0].id,
            games,
            at,
          ]),
        ),
      ).rejects.toThrow(/not your household/i);
    } finally {
      await pool.query(`delete from households where id = $1`, [rows[0].id]);
    }
  });
});
