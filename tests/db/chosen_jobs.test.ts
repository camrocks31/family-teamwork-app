import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import dotenv from "dotenv";
import { asMember, expectClientRejected, linkParent, makePool } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1549 — a job can say why, and some jobs are chosen rather than given.
 *
 * Most of these are written from the attacker's side, because the dangerous
 * surface here is not "can a child take a job" but "what else can a child
 * reach while holding the family iPad". The arrangement that matters is the
 * real one: a CHILD's actor token on top of a PARENT's authenticated browser
 * session, where app_is_parent() is true and a naive authority check would
 * hand a seven-year-old the run of the household.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };
let child: { id: string; name: string };
let sibling: { id: string; name: string };
let deviceId: string;
let today: string;
let tomorrow: string;
const PIN = "7314";

async function asDevice<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("set role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({
        sub: "22222222-2222-2222-2222-222222222222",
        role: "authenticated",
        app_metadata: { household_id: parent.householdId, role: "device" },
      }),
    ]);
    return await fn(client);
  } finally {
    await client.query("reset role").catch(() => {});
    await client.query("select set_config('request.jwt.claims', null, false)").catch(() => {});
    client.release();
  }
}

async function createDeviceUser(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await admin.auth.admin.createUser({
    email: `device-${crypto.randomUUID()}@devices.invalid`,
    password: crypto.randomUUID(),
    email_confirm: true,
    app_metadata: { household_id: parent.householdId, role: "device" },
  });
  if (error) throw error;
  return data.user.id;
}

async function enrollDevice(label: string): Promise<string> {
  const code = await asMember(pool, parent.authId, async (c) => {
    const { rows } = await c.query<{ c: string }>(
      `select create_device_enrollment_code(30) as c`,
    );
    return rows[0].c;
  });
  const authUserId = await createDeviceUser();
  // Consumption is the Edge Function's job and is granted to no client role,
  // so the test calls it with the superuser connection, as the function would.
  const { rows } = await pool.query<{ d: string }>(
    `select app_consume_enrollment_code($1, $2, $3) as d`,
    [code, label, authUserId],
  );
  return rows[0].d;
}

/** A child's actor token, the thing that must never carry parent authority. */
async function tokenFor(memberId: string): Promise<string> {
  const { rows } = await asDevice((c) =>
    c.query<{ t: { ok: boolean; token?: string } }>(
      `select verify_member_pin($1, $2, $3) as t`,
      [memberId, PIN, deviceId],
    ),
  );
  if (!rows[0].t.ok) throw new Error("PIN refused in fixture");
  return rows[0].t.token!;
}

let made = 0;
/** An open, per-member job nobody holds yet. */
async function anOpenJob(
  client: pg.PoolClient,
  opts: { reason?: string; countsTowardRewards?: boolean } = {},
): Promise<string> {
  made += 1;
  const { rows } = await client.query<{ id: string }>(
    `select save_task(
       null, $1, array['Only thing to check'], null, null,
       'per_member', 'daily', null, null, false, false, false,
       null, $2, 'open', $3
     ) as id`,
    [`Chosen fixture ${made}`, opts.reason ?? null, opts.countsTowardRewards ?? true],
  );
  return rows[0].id;
}

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "hal1549@example.test");
  const kids = await pool.query<{ id: string; name: string }>(
    `select id, display_name as name from family_members
      where role = 'child' and household_id = $1 order by display_name`,
    [parent.householdId],
  );
  child = kids.rows[0];
  sibling = kids.rows[1];

  // app_household_today is granted to no client role, so the dates are
  // resolved once here with the superuser connection rather than called from
  // inside a member session.
  const { rows: dates } = await pool.query<{ today: string; tomorrow: string }>(
    `select app_household_today($1)::text as today,
            (app_household_today($1) + 1)::text as tomorrow`,
    [parent.householdId],
  );
  today = dates[0].today;
  tomorrow = dates[0].tomorrow;

  // A previous run that failed halfway may have left fixtures behind.
  await cleanupFixtures(pool);

  deviceId = await enrollDevice("Test iPad 1549");
  for (const m of [child.id, sibling.id]) {
    await asMember(pool, parent.authId, (c) =>
      c.query(`select set_member_pin($1, $2)`, [m, PIN]),
    );
  }
});

/**
 * Remove everything this file creates.
 *
 * Run at BOTH ends, and that is the point. These fixtures go through
 * save_task, which commits, so a run that fails halfway leaves definitions
 * behind — and transitions.test.ts asserts GLOBALLY that no instance is
 * pinned to a revision other than its definition's current one, which stray
 * fixtures make false. A teardown that only runs on success turns one failing
 * run into a poisoned database for every run after it, which is exactly what
 * happened while this file was being written.
 *
 * Order matters: task_events, task_operations and task_photos all reference an
 * instance, and task_instances references a revision, with ON DELETE RESTRICT
 * most of the way down.
 */
async function cleanupFixtures(p: pg.Pool) {
  const mine = `select definition_id from task_definition_revisions where title like 'Chosen fixture %'`;
  const myInstances = `select id from task_instances where definition_id in (${mine})`;
  await p.query(`delete from task_events where task_instance_id in (${myInstances})`);
  await p.query(`delete from task_operations where task_instance_id in (${myInstances})`);
  await p.query(`delete from task_photos where task_instance_id in (${myInstances})`);
  await p.query(`delete from task_instances where definition_id in (${mine})`);
  await p.query(`delete from task_assignments where definition_id in (${mine})`);
  await p.query(`delete from rewards where name like 'Chosen reward %'`);
  await p.query(
    `delete from task_definition_criteria where revision_id in (
       select id from task_definition_revisions where title like 'Chosen fixture %')`,
  );
  await p.query(
    `update task_definitions set current_revision_id = null where id in (${mine})`,
  );
  await p.query(`delete from task_definition_revisions where title like 'Chosen fixture %'`);
  // Only the ones left with no revision at all, which after the line above is
  // exactly this file's definitions.
  await p.query(
    `delete from task_definitions td
      where td.current_revision_id is null
        and not exists (select 1 from task_definition_revisions r where r.definition_id = td.id)`,
  );
}

afterAll(async () => {
  await cleanupFixtures(pool);
  await pool.end();
});

// ---------------------------------------------------------------------------
// R1 — a job can say why it matters
// ---------------------------------------------------------------------------

describe("a job can say why it matters (AC1–AC4)", () => {
  it("writes the reason onto the new revision and leaves the old one alone", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows: made } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture reason', array['x'], null, null,
            'shared', 'daily', null, null, false, false, false, null,
            'because the porch goes bad fast') as id`,
      );
      const def = made[0].id;
      await c.query(
        `select save_task($1, 'Chosen fixture reason', array['x'], null, null,
            'shared', 'daily', null, null, false, false, false, null,
            'a completely different reason') as id`,
        [def],
      );
      const { rows } = await c.query<{ revision_number: number; reason: string }>(
        `select revision_number, reason from task_definition_revisions
          where definition_id = $1 order by revision_number`,
        [def],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0].reason).toBe("because the porch goes bad fast");
      expect(rows[1].reason).toBe("a completely different reason");
    });
  });

  it("stores null when no reason is given", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows: made } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture no reason', array['x']) as id`,
      );
      const { rows } = await c.query<{ reason: string | null }>(
        `select r.reason from task_definition_revisions r
          where r.definition_id = $1`,
        [made[0].id],
      );
      expect(rows[0].reason).toBeNull();
    });
  });

  it("btrims a blank or whitespace reason to null, so no empty line renders", async () => {
    await asMember(pool, parent.authId, async (c) => {
      for (const blank of ["", "   ", "\t \n"]) {
        const { rows: made } = await c.query<{ id: string }>(
          `select save_task(null, 'Chosen fixture blank reason', array['x'], null, null,
              'shared', 'daily', null, null, false, false, false, null, $1) as id`,
          [blank],
        );
        const { rows } = await c.query<{ reason: string | null }>(
          `select reason from task_definition_revisions where definition_id = $1`,
          [made[0].id],
        );
        expect(rows[0].reason, `for ${JSON.stringify(blank)}`).toBeNull();
      }
    });
  });

  it("gives a child the reason from the PINNED revision, not the current one", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows: made } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture pinned reason', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $1,
            'the reason this morning') as id`,
        [[child.id]],
      );
      const def = made[0].id;
      await c.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, today]);
      // The edit happens AFTER today's instance exists.
      await c.query(
        `select save_task($1, 'Chosen fixture pinned reason', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $2,
            'rewritten this afternoon') as id`,
        [def, [child.id]],
      );
      const { rows } = await c.query<{ j: { jobs: { title: string; reason: string }[] } }>(
        `select list_my_jobs($1) as j`,
        [child.id],
      );
      const job = rows[0].j.jobs.find((x) => x.title === "Chosen fixture pinned reason");
      expect(job, "the fixture job should be on today's list").toBeTruthy();
      expect(job!.reason).toBe("the reason this morning");
    });
  });
});

// ---------------------------------------------------------------------------
// R2 — children choose some of their own jobs
// ---------------------------------------------------------------------------

describe("which jobs can be opened (AC5)", () => {
  it("opens a per-member job, refuses to open a shared one", async () => {
    await asMember(pool, parent.authId, async (c) => {
      await expect(anOpenJob(c)).resolves.toBeTruthy();

      const error = await expectClientRejected(
        c,
        `select save_task(null, 'Chosen fixture shared', array['x'], null, null,
            'shared', 'daily', null, null, false, false, false, null, null, 'open')`,
      );
      expect(error.code).toBe("23514");
      expect(error.message).toMatch(/task_definitions_open_is_per_member/);
    });
  });

  it("refuses to convert an existing shared job to per-member even with no instances", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture convert', array['x']) as id`,
      );
      // No instance has been materialized for it at all. The revision's own
      // composite foreign key still refuses the change, which is why the
      // conversion is unsupported rather than merely awkward.
      const { rows: n } = await c.query<{ n: string }>(
        `select count(*) as n from task_instances where definition_id = $1`,
        [rows[0].id],
      );
      expect(n[0].n).toBe("0");

      const error = await expectClientRejected(
        c,
        `select save_task($1, 'Chosen fixture convert', array['x'], null, null, 'per_member')`,
        [rows[0].id],
      );
      expect(error.code).toBe("23503");
    });
  });
});

describe("a child takes a job (AC6, AC7, AC24)", () => {
  it("records the assignment and creates today's instance", async () => {
    const token = await tokenFor(child.id);
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);

      const { rows: a } = await c.query<{ member_id: string }>(
        `select member_id from task_assignments where definition_id = $1`,
        [def],
      );
      expect(a).toHaveLength(1);
      expect(a[0].member_id).toBe(child.id);

      const { rows: i } = await c.query<{ subject_member_id: string }>(
        `select subject_member_id from task_instances
          where definition_id = $1 and occurrence_date = $2`,
        [def, today],
      );
      expect(i).toHaveLength(1);
      expect(i[0].subject_member_id).toBe(child.id);
    });
  });

  it("is idempotent — a double tap is not an error", async () => {
    const token = await tokenFor(child.id);
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from task_assignments where definition_id = $1`,
        [def],
      );
      expect(rows[0].n).toBe("1");
    });
  });

  it("refuses a job whose definition has no revision yet", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      // A definition can exist with no current revision; the materializer
      // skips those, so an assignment would be a job taken that never appears.
      await c.query(`update task_definitions set current_revision_id = null where id = $1`, [def]);
      const token = await tokenFor(child.id);
      const error = await expectClientRejected(c, `select choose_job($1, null, $2)`, [def, token]);
      expect(error.message).toMatch(/nothing set up yet/i);
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from task_assignments where definition_id = $1`,
        [def],
      );
      expect(rows[0].n).toBe("0");
    });
  });
});

describe("an actor token never carries parent authority (AC8)", () => {
  it("refuses a sibling, and accepts the actor's own id in the SAME session", async () => {
    const token = await tokenFor(child.id);
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);

      // The dangerous arrangement: a child's token on a PARENT's session, so
      // app_is_parent() is true. The authority that counts is the one
      // established when the token resolved, and that is not a parent.
      const { rows: p } = await c.query<{ p: boolean }>(`select app_is_parent() as p`);
      expect(p[0].p, "the fixture must be a parent session for this to prove anything").toBe(true);

      const error = await expectClientRejected(c, `select choose_job($1, $2, $3)`, [
        def,
        sibling.id,
        token,
      ]);
      expect(error.code).toBe("42501");

      // The positive control. Without it this test would also pass on a
      // session where no actor resolved at all, proving nothing about the
      // sibling comparison.
      await expect(
        c.query(`select choose_job($1, $2, $3)`, [def, child.id, token]),
      ).resolves.toBeTruthy();

      const { rows } = await c.query<{ member_id: string }>(
        `select member_id from task_assignments where definition_id = $1`,
        [def],
      );
      expect(rows.map((r) => r.member_id)).toEqual([child.id]);
    });
  });

  it("lets a parent with no token choose for a child", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      await c.query(`select choose_job($1, $2, null)`, [def, sibling.id]);
      const { rows } = await c.query<{ member_id: string }>(
        `select member_id from task_assignments where definition_id = $1`,
        [def],
      );
      expect(rows.map((r) => r.member_id)).toEqual([sibling.id]);
    });
  });
});

describe("one household cannot reach another's jobs (AC9, AC10)", () => {
  it("answers identically for a foreign job and a job that does not exist", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows: b } = await client.query<{ def: string }>(`
        with h as (
          insert into households (name, timezone)
          values ('Household B 1549', 'America/Vancouver') returning id
        ), d as (
          insert into task_definitions (household_id, occurrence_mode, assignment_mode)
          select id, 'per_member', 'open' from h returning id, household_id
        ), r as (
          insert into task_definition_revisions
            (definition_id, household_id, revision_number, title, recurrence, occurrence_mode)
          select d.id, d.household_id, 1, 'B job', 'daily', 'per_member' from d returning id, definition_id
        )
        select d.id as def from d, r
      `);
      const foreignDef = b[0].def;
      const nowhere = crypto.randomUUID();

      await client.query("set role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, false)", [
        JSON.stringify({ sub: parent.authId, role: "authenticated" }),
      ]);

      // Each refusal gets its own savepoint: without one the first error
      // aborts the transaction and the second reports 25P02 rather than its
      // own code, which would make the comparison meaningless.
      await client.query("savepoint a");
      const a = await expectClientRejected(client, `select choose_job($1)`, [foreignDef]);
      await client.query("rollback to savepoint a");
      const z = await expectClientRejected(client, `select choose_job($1)`, [nowhere]);

      expect(a.code).toBe(z.code);
      // Neither answer may tell a caller whether somebody else's job exists.
      expect(a.message).toBe(z.message);
      expect(a.message).toMatch(/no such job in your household/i);
    } finally {
      await client.query("rollback").catch(() => {});
      await client.query("reset role").catch(() => {});
      await client.query("select set_config('request.jwt.claims', null, false)").catch(() => {});
      client.release();
    }
  });

  it("refuses a job that is not open, and says so", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture assigned', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $1) as id`,
        [[child.id]],
      );
      const token = await tokenFor(child.id);
      const error = await expectClientRejected(c, `select choose_job($1, null, $2)`, [
        rows[0].id,
        token,
      ]);
      expect(error.code).toBe("42501");
      expect(error.message).toMatch(/not one anyone can take/i);
    });
  });
});

describe("giving a job back (AC11, AC12, AC21)", () => {
  it("keeps the work already recorded, and stops tomorrow's", async () => {
    const token = await tokenFor(child.id);
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);

      const { rows: inst } = await c.query<{ id: string }>(
        `select id from task_instances
          where definition_id = $1 and occurrence_date = $2`,
        [def, today],
      );
      await c.query(`select complete_task_instance($1, gen_random_uuid(), null, $2)`, [
        inst[0].id,
        token,
      ]);

      await c.query(`select release_job($1, null, $2)`, [def, token]);

      const { rows: kept } = await c.query<{
        state: string;
        completed_by: string | null;
        completed_at: string | null;
      }>(`select state, completed_by, completed_at from task_instances where id = $1`, [
        inst[0].id,
      ]);
      expect(kept).toHaveLength(1);
      expect(kept[0].state).toBe("completed");
      expect(kept[0].completed_by).toBe(child.id);
      expect(kept[0].completed_at).not.toBeNull();

      const { rows: gone } = await c.query<{ n: string }>(
        `select count(*) as n from task_assignments where definition_id = $1`,
        [def],
      );
      expect(gone[0].n).toBe("0");

      // Absence tomorrow proves nothing unless tomorrow is actually built.
      await c.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, tomorrow]);
      const { rows: nextDay } = await c.query<{ n: string }>(
        `select count(*) as n from task_instances
          where definition_id = $1 and occurrence_date = $2`,
        [def, tomorrow],
      );
      expect(nextDay[0].n).toBe("0");
    });
  });

  it("removes a pristine instance, keeps a started one, and survives a photo", async () => {
    await asMember(pool, parent.authId, async (c) => {
      // (a) never started — the instance goes
      const a = await anOpenJob(c);
      const tokenA = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [a, tokenA]);
      await c.query(`select release_job($1, null, $2)`, [a, tokenA]);
      const { rows: ra } = await c.query<{ n: string }>(
        `select count(*) as n from task_instances where definition_id = $1`,
        [a],
      );
      expect(ra[0].n, "an untouched pending instance leaves nothing behind").toBe("0");

      // (b) started — the instance stays
      const b = await anOpenJob(c);
      const tokenB = await tokenFor(sibling.id);
      await c.query(`select choose_job($1, null, $2)`, [b, tokenB]);
      const { rows: ib } = await c.query<{ id: string }>(
        `select id from task_instances where definition_id = $1`,
        [b],
      );
      await c.query(`select start_task_instance($1, gen_random_uuid(), null, $2)`, [
        ib[0].id,
        tokenB,
      ]);
      await c.query(`select release_job($1, null, $2)`, [b, tokenB]);
      const { rows: rb } = await c.query<{ state: string }>(
        `select state from task_instances where id = $1`,
        [ib[0].id],
      );
      expect(rb).toHaveLength(1);
      expect(rb[0].state).toBe("in_progress");

      // (c) a photo on a STILL-PENDING instance. photo_required is only
      // enforced at submit, so this is reachable, and task_photos is
      // ON DELETE RESTRICT — the naive delete would raise 23503 and roll the
      // whole release back, leaving the assignment in place.
      const d = await anOpenJob(c);
      const tokenD = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [d, tokenD]);
      const { rows: idd } = await c.query<{ id: string }>(
        `select id from task_instances where definition_id = $1`,
        [d],
      );
      await c.query(
        `insert into task_photos
           (household_id, task_instance_id, storage_path, uploaded_by, byte_size, content_type)
         values ($1, $2, 'test/pending.jpg', $3, 1234, 'image/jpeg')`,
        [parent.householdId, idd[0].id, child.id],
      );

      await expect(
        c.query(`select release_job($1, null, $2)`, [d, tokenD]),
        "the release must succeed, not fail on the photo's foreign key",
      ).resolves.toBeTruthy();

      const { rows: rd } = await c.query<{ n: string }>(
        `select count(*) as n from task_instances where id = $1`,
        [idd[0].id],
      );
      expect(rd[0].n, "the instance and its photo survive").toBe("1");
      const { rows: assign } = await c.query<{ n: string }>(
        `select count(*) as n from task_assignments where definition_id = $1`,
        [d],
      );
      expect(assign[0].n, "but the assignment still goes").toBe("0");
    });
  });

  it("refuses to give back a job a parent assigned", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select save_task(null, 'Chosen fixture parent assigned', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $1) as id`,
        [[child.id]],
      );
      const def = rows[0].id;
      await c.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, today]);
      const token = await tokenFor(child.id);

      const error = await expectClientRejected(c, `select release_job($1, null, $2)`, [
        def,
        token,
      ]);
      expect(error.code).toBe("42501");

      const { rows: still } = await c.query<{ n: string }>(
        `select count(*) as n from task_assignments where definition_id = $1`,
        [def],
      );
      expect(still[0].n, "the parent's assignment survives").toBe("1");
      const { rows: inst } = await c.query<{ n: string }>(
        `select count(*) as n from task_instances where definition_id = $1`,
        [def],
      );
      expect(Number(inst[0].n), "and so does its instance").toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// R2.8 and R2.11 — how many are asked for, and what the page is given
// ---------------------------------------------------------------------------

describe("how many open jobs a person is asked to hold (AC13)", () => {
  it("refuses a negative minimum and accepts zero", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const error = await expectClientRejected(
        c,
        `update family_members set min_chosen_jobs = -1 where id = $1`,
        [child.id],
      );
      expect(error.code).toBe("23514");
      expect(error.message).toMatch(/min_chosen_jobs_non_negative/);

      await expect(
        c.query(`update family_members set min_chosen_jobs = 0 where id = $1`, [child.id]),
      ).resolves.toBeTruthy();
    });
  });

  it("tells the page the minimum, the count, and both lists", async () => {
    await asMember(pool, parent.authId, async (c) => {
      await c.query(`update family_members set min_chosen_jobs = 2 where id = $1`, [child.id]);
      const def = await anOpenJob(c, { reason: "because somebody has to" });

      const before = await c.query<{
        j: {
          min_chosen_jobs: number;
          chosen_count: number;
          available: { definition_id: string; reason: string }[];
          held: { definition_id: string }[];
        };
      }>(`select list_my_jobs($1) as j`, [child.id]);
      expect(before.rows[0].j.min_chosen_jobs).toBe(2);
      const offered = before.rows[0].j.available.find((x) => x.definition_id === def);
      expect(offered, "a job going spare should be offered").toBeTruthy();
      expect(offered!.reason).toBe("because somebody has to");
      expect(before.rows[0].j.held.some((x) => x.definition_id === def)).toBe(false);

      const token = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);

      const after = await c.query<{
        j: {
          chosen_count: number;
          available: { definition_id: string }[];
          held: { definition_id: string }[];
        };
      }>(`select list_my_jobs($1) as j`, [child.id]);
      expect(after.rows[0].j.chosen_count).toBeGreaterThanOrEqual(1);
      expect(after.rows[0].j.held.some((x) => x.definition_id === def)).toBe(true);
      expect(after.rows[0].j.available.some((x) => x.definition_id === def)).toBe(false);

      await c.query(`update family_members set min_chosen_jobs = 0 where id = $1`, [child.id]);
    });
  });

  it("still offers a release for a job already finished today", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      const token = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);
      const { rows: inst } = await c.query<{ id: string }>(
        `select id from task_instances where definition_id = $1`,
        [def],
      );
      await c.query(`select complete_task_instance($1, gen_random_uuid(), null, $2)`, [
        inst[0].id,
        token,
      ]);

      // The job rows hide completed work, so without `held` the child would
      // have no way to give this back.
      const { rows } = await c.query<{ j: { held: { definition_id: string }[] } }>(
        `select list_my_jobs($1) as j`,
        [child.id],
      );
      expect(rows[0].j.held.some((x) => x.definition_id === def)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// R5 — points are confined to the dull maintenance
// ---------------------------------------------------------------------------

describe("points count only the jobs they are meant for (AC14, AC23)", () => {
  async function aWeeklyReward(c: pg.PoolClient, threshold: number): Promise<string> {
    const { rows } = await c.query<{ id: string }>(
      `insert into rewards (household_id, name, threshold_count, period, member_id)
       values ($1, $2, $3, 'week', $4) returning id`,
      [parent.householdId, `Chosen reward ${Date.now()}${Math.random()}`, threshold, child.id],
    );
    return rows[0].id;
  }

  async function doneCount(c: pg.PoolClient, rewardId: string): Promise<number> {
    const { rows } = await c.query<{ j: { id: string; done: number }[] }>(
      `select evaluate_rewards($1, $2) as j`,
      [parent.householdId, child.id],
    );
    return rows[0].j.find((r) => r.id === rewardId)!.done;
  }

  it("counts a job whose revision says it counts, and not one whose revision says not", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const reward = await aWeeklyReward(c, 5);
      const before = await doneCount(c, reward);

      for (const counts of [true, false]) {
        const def = await anOpenJob(c, { countsTowardRewards: counts });
        const token = await tokenFor(child.id);
        await c.query(`select choose_job($1, null, $2)`, [def, token]);
        const { rows: inst } = await c.query<{ id: string }>(
          `select id from task_instances where definition_id = $1`,
          [def],
        );
        await c.query(`select complete_task_instance($1, gen_random_uuid(), null, $2)`, [
          inst[0].id,
          token,
        ]);
      }

      // Two jobs completed, one of them fenced off from points.
      expect(await doneCount(c, reward)).toBe(before + 1);
    });
  });

  it("does not let a later edit un-earn work already done", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const reward = await aWeeklyReward(c, 1);
      const def = await anOpenJob(c, { countsTowardRewards: true });
      const token = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);
      const { rows: inst } = await c.query<{ id: string }>(
        `select id from task_instances where definition_id = $1`,
        [def],
      );
      await c.query(`select complete_task_instance($1, gen_random_uuid(), null, $2)`, [
        inst[0].id,
        token,
      ]);

      const earned = await doneCount(c, reward);
      expect(earned).toBeGreaterThanOrEqual(1);

      // Later in the same week, the flag comes off. A NEW revision is written;
      // the completed instance stays pinned to the old one. Had the flag lived
      // on the definition, this edit would have reached back and taken the
      // reward away after the child had been told they had it.
      await c.query(
        `select save_task($1, 'Chosen fixture unearn', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, null, null, 'open', false)`,
        [def],
      );
      const { rows: revs } = await c.query<{ n: string }>(
        `select count(*) as n from task_definition_revisions where definition_id = $1`,
        [def],
      );
      expect(revs[0].n, "the edit wrote a second revision").toBe("2");

      expect(await doneCount(c, reward), "the week's credit survives the edit").toBe(earned);
    });
  });
});

// ---------------------------------------------------------------------------
// R2.14 — a parent's edit does not delete the children's choices
// ---------------------------------------------------------------------------

describe("a parent's edit keeps the choices (AC20, AC22)", () => {
  it("leaves a child's chosen job alone when the parent saves an unrelated change", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      const token = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);

      // The editor always sends an array — this is exactly what it sends — and
      // save_task replaces assignments wholesale when it is non-null. For an
      // open job that would delete every choice made since the form opened.
      await c.query(
        `select save_task($1, 'Chosen fixture kept', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $2,
            'a brand new reason', 'open', true)`,
        [def, [sibling.id]],
      );

      const { rows } = await c.query<{ member_id: string }>(
        `select member_id from task_assignments where definition_id = $1`,
        [def],
      );
      expect(rows.map((r) => r.member_id)).toEqual([child.id]);
    });
  });

  it("lets a parent take an open job back, and never silently flips its mode", async () => {
    await asMember(pool, parent.authId, async (c) => {
      const def = await anOpenJob(c);
      const token = await tokenFor(child.id);
      await c.query(`select choose_job($1, null, $2)`, [def, token]);

      // Back to assigned: the parent's list is reasserted, which is the only
      // route out of an open job.
      await c.query(
        `select save_task($1, 'Chosen fixture reclaimed', array['x'], null, null,
            'per_member', 'daily', null, null, false, false, false, $2, null, 'assigned')`,
        [def, [sibling.id]],
      );
      const { rows: mode } = await c.query<{ assignment_mode: string }>(
        `select assignment_mode from task_definitions where id = $1`,
        [def],
      );
      expect(mode[0].assignment_mode).toBe("assigned");
      const { rows: who } = await c.query<{ member_id: string }>(
        `select member_id from task_assignments where definition_id = $1`,
        [def],
      );
      expect(who.map((r) => r.member_id)).toEqual([sibling.id]);

      // And a save that omits the occurrence mode does not quietly turn a
      // per-member job into a shared one: it is refused.
      const open = await anOpenJob(c);
      const error = await expectClientRejected(
        c,
        `select save_task($1, 'Chosen fixture wedge', array['x'])`,
        [open],
      );
      expect(error.code).toBe("23503");
      const { rows: unchanged } = await c.query<{ occurrence_mode: string }>(
        `select occurrence_mode from task_definitions where id = $1`,
        [open],
      );
      expect(unchanged[0].occurrence_mode).toBe("per_member");
    });
  });
});

// ---------------------------------------------------------------------------
// The new surface, as the perimeter sees it
// ---------------------------------------------------------------------------

describe("the new functions are default-deny", () => {
  it("keeps the two internal helpers unreachable by any client role", async () => {
    for (const fn of ["app_choice_principal", "app_lock_open_job"]) {
      for (const role of ["anon", "authenticated"]) {
        const { rows } = await pool.query<{ ok: boolean }>(
          `select has_function_privilege($1, p.oid, 'EXECUTE') as ok
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = $2`,
          [role, fn],
        );
        expect(rows[0]?.ok, `${fn} must be unreachable by ${role}`).toBe(false);
      }
    }
  });

  it("leaves exactly one save_task, so no positional call is ambiguous", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_task'`,
    );
    expect(rows[0].n).toBe("1");
  });

  it("refuses the new functions to an anonymous visitor", async () => {
    for (const fn of ["choose_job", "release_job"]) {
      const { rows } = await pool.query<{ ok: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fn],
      );
      expect(rows[0].ok, `${fn} must not be executable by anon`).toBe(false);
    }
  });
});
