import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { makePool } from "./helpers";

/**
 * HAL-1541 — does this task count right now?
 *
 * Every moment below is built by Postgres from a local date and time in the
 * household's own timezone, never by hand-computing a UTC offset. Vancouver
 * changes offset twice a year and a hard-coded "15:00Z is 07:00 local" would
 * quietly start testing the wrong hour in March.
 */

let pool: pg.Pool;
let householdId: string;
let children: { id: string; name: string }[];

/** A timestamptz for a local wall-clock time in the household's zone. */
async function moment(date: string, time: string): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    `select ((($1::text || ' ' || $2::text)::timestamp) at time zone h.timezone) as t
       from households h where h.id = $3`,
    [date, time, householdId],
  );
  return rows[0].t;
}

async function schoolDayDefinition(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select td.id from task_definitions td
       join task_definition_revisions r on r.id = td.current_revision_id
      where r.recurrence = 'school_day' limit 1`,
  );
  return rows[0].id;
}

async function dailyDefinition(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select td.id from task_definitions td
       join task_definition_revisions r on r.id = td.current_revision_id
      where r.recurrence = 'daily' limit 1`,
  );
  return rows[0].id;
}

async function applies(definitionId: string, memberId: string, at: string) {
  const { rows } = await pool.query<{ a: boolean }>(
    `select applicable_at($1, $2, $3) as a`,
    [definitionId, memberId, at],
  );
  return rows[0].a;
}

// Chosen for their weekdays; asserted below so a wrong guess fails loudly
// rather than silently testing the wrong thing.
const TUESDAY = "2026-11-17";
const SATURDAY = "2026-11-14";

beforeAll(async () => {
  pool = makePool();
  const h = await pool.query<{ id: string }>(`select id from households limit 1`);
  householdId = h.rows[0].id;
  const c = await pool.query<{ id: string; name: string }>(
    `select id, display_name as name from family_members where role = 'child' order by display_name`,
  );
  children = c.rows;
});

afterAll(async () => {
  await pool.end();
});

describe("the fixture dates are the weekdays this suite assumes", () => {
  it("uses a real Tuesday and a real Saturday", async () => {
    const { rows } = await pool.query<{ tue: string; sat: string }>(
      `select extract(isodow from $1::date)::text as tue,
              extract(isodow from $2::date)::text as sat`,
      [TUESDAY, SATURDAY],
    );
    expect(rows[0].tue).toBe("2"); // Tuesday
    expect(rows[0].sat).toBe("6"); // Saturday
  });
});

describe("daily tasks always count (AC1)", () => {
  it("applies on a weekday morning, a Saturday afternoon and the middle of the night", async () => {
    const def = await dailyDefinition();
    for (const at of [
      await moment(TUESDAY, "07:00"),
      await moment(SATURDAY, "14:00"),
      await moment(SATURDAY, "03:00"),
    ]) {
      expect(await applies(def, children[0].id, at)).toBe(true);
    }
  });
});

describe("school-morning tasks (AC2-AC4)", () => {
  it("does not apply on Saturday afternoon — parent spec test 5", async () => {
    const def = await schoolDayDefinition();
    const at = await moment(SATURDAY, "14:00");
    for (const child of children) {
      expect(await applies(def, child.id, at)).toBe(false);
    }
  });

  it("applies on a Tuesday at 07:00 and not at 09:00", async () => {
    const def = await schoolDayDefinition();
    expect(await applies(def, children[0].id, await moment(TUESDAY, "07:00"))).toBe(true);
    expect(await applies(def, children[0].id, await moment(TUESDAY, "09:00"))).toBe(false);
  });

  it("is start-inclusive and end-exclusive at the window boundaries", async () => {
    const def = await schoolDayDefinition();
    // The seeded window is 06:30 to 08:30.
    expect(await applies(def, children[0].id, await moment(TUESDAY, "06:30"))).toBe(true);
    expect(await applies(def, children[0].id, await moment(TUESDAY, "08:29:59"))).toBe(true);
    expect(await applies(def, children[0].id, await moment(TUESDAY, "08:30"))).toBe(false);
    expect(await applies(def, children[0].id, await moment(TUESDAY, "06:29:59"))).toBe(false);
  });
});

describe("overrides (AC5-AC7)", () => {
  it("a household holiday suppresses the morning for every child — parent spec test 14", async () => {
    const def = await schoolDayDefinition();
    const at = await moment(TUESDAY, "07:00");

    for (const child of children) {
      expect(await applies(def, child.id, at)).toBe(true);
    }

    await pool.query(
      `insert into schedule_rules (household_id, rule_kind, override_date, is_school_day, note)
       values ($1, 'date_override', $2, false, 'Pro-D day')`,
      [householdId, TUESDAY],
    );
    try {
      for (const child of children) {
        expect(await applies(def, child.id, at)).toBe(false);
      }
    } finally {
      await pool.query(
        `delete from schedule_rules where household_id = $1 and override_date = $2`,
        [householdId, TUESDAY],
      );
    }
  });

  it("one child's override does not move their siblings", async () => {
    const def = await schoolDayDefinition();
    const at = await moment(TUESDAY, "07:00");
    const [first, ...others] = children;

    await pool.query(
      `insert into schedule_rules (household_id, member_id, rule_kind, override_date, is_school_day)
       values ($1, $2, 'date_override', $3, false)`,
      [householdId, first.id, TUESDAY],
    );
    try {
      expect(await applies(def, first.id, at)).toBe(false);
      for (const sibling of others) {
        expect(await applies(def, sibling.id, at)).toBe(true);
      }
    } finally {
      await pool.query(`delete from schedule_rules where member_id = $1`, [first.id]);
    }
  });

  it("a household holiday outranks a child's own weekly school day", async () => {
    const def = await schoolDayDefinition();
    const at = await moment(TUESDAY, "07:00");
    const child = children[0];

    // This child goes to school on Tuesdays, explicitly.
    await pool.query(
      `insert into schedule_rules (household_id, member_id, rule_kind, day_of_week, is_school_day)
       values ($1, $2, 'weekly', 2, true)`,
      [householdId, child.id],
    );
    // But the school is shut.
    await pool.query(
      `insert into schedule_rules (household_id, rule_kind, override_date, is_school_day, note)
       values ($1, 'date_override', $2, false, 'Closure')`,
      [householdId, TUESDAY],
    );
    try {
      expect(await applies(def, child.id, at)).toBe(false);
    } finally {
      await pool.query(`delete from schedule_rules where member_id = $1`, [child.id]);
      await pool.query(
        `delete from schedule_rules where household_id = $1 and override_date = $2`,
        [householdId, TUESDAY],
      );
    }
  });
});

describe("a household with no morning window (AC8)", () => {
  it("has no school-morning task apply, which is not the same as being outside the window", async () => {
    const def = await schoolDayDefinition();
    const at = await moment(TUESDAY, "07:00");

    const before = await pool.query<{ a: boolean }>(
      `select app_in_morning_window($1, $2) as a`,
      [householdId, at],
    );
    expect(before.rows[0].a).toBe(true);

    await pool.query(
      `update households set morning_window_start = null, morning_window_end = null where id = $1`,
      [householdId],
    );
    try {
      expect(await applies(def, children[0].id, at)).toBe(false);
      // It is still a school day — the window is what is missing, and the two
      // conditions stay distinguishable for settings to flag.
      const isSchool = await pool.query<{ a: boolean }>(
        `select app_is_school_day($1, $2, $3) as a`,
        [householdId, children[0].id, TUESDAY],
      );
      expect(isSchool.rows[0].a).toBe(true);
    } finally {
      await pool.query(
        `update households set morning_window_start = '06:30', morning_window_end = '08:30' where id = $1`,
        [householdId],
      );
    }
  });
});

describe("the household's clock, not the server's (AC9)", () => {
  it("gives two households in different zones different answers for one instant", async () => {
    // 07:00 in Vancouver is 15:00 UTC, which is well past a London morning.
    const at = await moment(TUESDAY, "07:00");

    const { rows: other } = await pool.query<{ id: string }>(
      `insert into households (name, timezone, morning_window_start, morning_window_end)
       values ('Other Household', 'Europe/London', '06:30', '08:30')
       returning id`,
    );
    const otherId = other[0].id;
    try {
      await pool.query(
        `insert into schedule_rules (household_id, rule_kind, day_of_week, is_school_day)
         select $1, 'weekly', d, d <= 5 from generate_series(1,7) d`,
        [otherId],
      );
      const vancouver = await pool.query<{ a: boolean }>(
        `select app_in_morning_window($1, $2) as a`,
        [householdId, at],
      );
      const london = await pool.query<{ a: boolean }>(
        `select app_in_morning_window($1, $2) as a`,
        [otherId, at],
      );
      expect(vancouver.rows[0].a).toBe(true);
      expect(london.rows[0].a).toBe(false); // already mid-afternoon there
    } finally {
      await pool.query(`delete from schedule_rules where household_id = $1`, [otherId]);
      await pool.query(`delete from households where id = $1`, [otherId]);
    }
  });
});

describe("an instance answers from the revision it pinned (AC10-AC11)", () => {
  it("is unaffected by a later change to the definition's recurrence", async () => {
    // A daily instance, created under a daily revision.
    const { rows: inst } = await pool.query<{ id: string; definition_id: string }>(
      `select ti.id, ti.definition_id
         from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
        where r.recurrence = 'daily' and ti.occurrence_mode = 'shared'
        limit 1`,
    );
    const at = await moment(SATURDAY, "14:00");

    const before = await pool.query<{ a: boolean }>(
      `select app_instance_applies_at($1, $2) as a`,
      [inst[0].id, at],
    );
    expect(before.rows[0].a).toBe(true);

    // The parent changes the task to school-mornings only, from now on.
    const { rows: rev } = await pool.query<{ id: string }>(
      `insert into task_definition_revisions
         (definition_id, household_id, revision_number, title, recurrence, occurrence_mode)
       select td.id, td.household_id,
              (select max(revision_number) + 1 from task_definition_revisions
                where definition_id = td.id),
              'Changed', 'school_day', td.occurrence_mode
         from task_definitions td where td.id = $1
       returning id`,
      [inst[0].definition_id],
    );
    await pool.query(`update task_definitions set current_revision_id = $1 where id = $2`, [
      rev[0].id,
      inst[0].definition_id,
    ]);

    try {
      // The existing instance still answers from its pinned revision.
      const after = await pool.query<{ a: boolean }>(
        `select app_instance_applies_at($1, $2) as a`,
        [inst[0].id, at],
      );
      expect(after.rows[0].a).toBe(true);

      // While the definition itself now follows the new rule.
      const def = await pool.query<{ a: boolean }>(
        `select applicable_at($1, $2, $3) as a`,
        [inst[0].definition_id, null, at],
      );
      expect(def.rows[0].a).toBe(false);
    } finally {
      await pool.query(
        `update task_definitions set current_revision_id = (
           select id from task_definition_revisions
            where definition_id = $1 and revision_number = 1)
          where id = $1`,
        [inst[0].definition_id],
      );
      await pool.query(`delete from task_definition_revisions where id = $1`, [rev[0].id]);
    }
  });

  it("a holiday added mid-morning takes effect at once, with no re-materialization", async () => {
    const { rows: inst } = await pool.query<{ id: string }>(
      `select ti.id from task_instances ti
         join task_definition_revisions r on r.id = ti.definition_revision_id
        where r.recurrence = 'school_day' limit 1`,
    );
    const at = await moment(TUESDAY, "07:30");

    const before = await pool.query<{ a: boolean }>(
      `select app_instance_applies_at($1, $2) as a`,
      [inst[0].id, at],
    );
    expect(before.rows[0].a).toBe(true);

    await pool.query(
      `insert into schedule_rules (household_id, rule_kind, override_date, is_school_day, note)
       values ($1, 'date_override', $2, false, 'Snow day')`,
      [householdId, TUESDAY],
    );
    try {
      const after = await pool.query<{ a: boolean }>(
        `select app_instance_applies_at($1, $2) as a`,
        [inst[0].id, at],
      );
      // The instance row was never touched: applicability has one owner, and
      // it is this function rather than anything written down.
      expect(after.rows[0].a).toBe(false);
    } finally {
      await pool.query(
        `delete from schedule_rules where household_id = $1 and override_date = $2`,
        [householdId, TUESDAY],
      );
    }
  });
});
