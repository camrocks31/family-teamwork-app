import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { makePool } from "./helpers";

/**
 * HAL-1539 acceptance criteria 11 and 12.
 *
 * AC11 is a privacy check. The repository is public because free GitHub Pages
 * requires it, so the committed seed must carry structure and nothing about the
 * household. The test is written as an ALLOWLIST — these are the only names the
 * seed may contain — rather than a denylist of the family's real names, because
 * a denylist would have to name them, which is the very thing being prevented.
 */

let pool: pg.Pool;

beforeAll(async () => {
  pool = makePool();
});

afterAll(async () => {
  await pool.end();
});

const ALLOWED_MEMBER_NAMES = [
  "Parent One",
  "Parent Two",
  "Child One",
  "Child Two",
  "Child Three",
];

const ALLOWED_SPACE_NAMES = [
  "Upstairs",
  "Downstairs",
  "Shared Bedroom",
  "Children's Bedroom",
  "Adult Bedroom",
  "Upstairs Bathroom",
  "Upstairs Landing",
  "Living Room",
  "Dining Room",
  "Kitchen",
  "Downstairs Bathroom",
  "Entry Area",
  "Stairs",
];

describe("the committed seed publishes nothing about the household (AC11)", () => {
  it("uses only placeholder member names", async () => {
    const { rows } = await pool.query<{ display_name: string }>(
      `select display_name from family_members order by display_name`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(ALLOWED_MEMBER_NAMES).toContain(row.display_name);
    }
  });

  it("uses only generic space names", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `select name from household_spaces order by name`,
    );
    for (const row of rows) {
      expect(ALLOWED_SPACE_NAMES).toContain(row.name);
    }
  });

  it("names the pet generically", async () => {
    const { rows } = await pool.query<{ name: string }>(`select name from pets`);
    for (const row of rows) {
      expect(row.name).toBe("Dog");
    }
  });
});

describe("the household structure is the real one", () => {
  it("seeds two floors and eleven spaces", async () => {
    const floors = await pool.query<{ n: string }>(
      `select count(*) as n from household_spaces where parent_space_id is null`,
    );
    const rooms = await pool.query<{ n: string }>(
      `select count(*) as n from household_spaces where parent_space_id is not null`,
    );
    expect(Number(floors.rows[0].n)).toBe(2);
    expect(Number(rooms.rows[0].n)).toBe(11);
  });

  it("gives every cleaning definition its specific criteria, never one opaque checkbox", async () => {
    const { rows } = await pool.query<{ title: string; criteria: string }>(
      `select r.title, count(c.id) as criteria
         from task_definition_revisions r
         left join task_definition_criteria c on c.revision_id = r.id
        group by r.id, r.title
        having count(c.id) = 0`,
    );
    expect(rows).toEqual([]);
  });

  it("permits 'Not Needed' on exactly one seeded definition", async () => {
    const { rows } = await pool.query<{ title: string }>(
      `select title from task_definition_revisions where not_needed_permitted`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Pick up after the dog");
  });
});

describe("D1: adult-shared bedrooms do not gate the children's activities (AC12)", () => {
  it("includes every shared space and the children's bedroom", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `select s.name
         from requirement_group_items i
         join requirement_groups g on g.id = i.group_id
         join household_spaces s on s.id = i.target_space_id
        where g.name = 'Daily Household Cleaning'
        order by s.name`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      [
        "Children's Bedroom",
        "Dining Room",
        "Downstairs Bathroom",
        "Entry Area",
        "Kitchen",
        "Living Room",
        "Stairs",
        "Upstairs Bathroom",
        "Upstairs Landing",
      ].sort(),
    );
  });

  it("excludes both adult-shared bedrooms", async () => {
    const { rows } = await pool.query<{ name: string }>(
      `select s.name
         from requirement_group_items i
         join requirement_groups g on g.id = i.group_id
         join household_spaces s on s.id = i.target_space_id
        where g.name = 'Daily Household Cleaning'
          and s.name in ('Adult Bedroom', 'Shared Bedroom')`,
    );
    // Cameron's decision, 2026-11-13: an adult's tidying must never be the
    // reason a child cannot watch TV.
    expect(rows).toEqual([]);
  });

  it("still gives both adult bedrooms their own daily tasks", async () => {
    const { rows } = await pool.query<{ name: string; tasks: string }>(
      `select s.name, count(td.id) as tasks
         from household_spaces s
         join task_definitions td on td.location_space_id = s.id
        where s.name in ('Adult Bedroom', 'Shared Bedroom')
        group by s.name`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Number(row.tasks)).toBeGreaterThan(0);
    }
  });

  it("scopes every school-morning requirement to the requesting child", async () => {
    const { rows } = await pool.query<{ scope: string; n: string }>(
      `select i.scope, count(*) as n
         from requirement_group_items i
         join requirement_groups g on g.id = i.group_id
         join task_definitions td on td.id = i.target_definition_id
        where g.name = 'School Morning Readiness'
          and td.occurrence_mode = 'per_member'
        group by i.scope`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("requester");
  });

  it("keeps the pet's morning care shared, so one child doing it counts for all", async () => {
    const { rows } = await pool.query<{ scope: string; n: string }>(
      `select i.scope, count(*) as n
         from requirement_group_items i
         join requirement_groups g on g.id = i.group_id
         join task_definitions td on td.id = i.target_definition_id
        where g.name = 'School Morning Readiness'
          and td.pet_id is not null
        group by i.scope`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("household");
    expect(Number(rows[0].n)).toBe(4);
  });
});
