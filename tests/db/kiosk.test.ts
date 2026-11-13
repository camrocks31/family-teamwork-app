import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import dotenv from "dotenv";
import { asMember, linkParent, makePool } from "./helpers";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1543 — three children, one iPad, nobody becomes a parent.
 *
 * The question these tests exist to answer is not "can a child tick a task?"
 * but "can a child, holding the family iPad, reach anything a parent can?".
 * So most of them are written from the attacker's side.
 */

let pool: pg.Pool;
let parent: { memberId: string; authId: string; householdId: string };
let child: { id: string; name: string };
let sibling: { id: string };
let deviceId: string;
let otherDeviceId: string;
const PIN = "4821";
const DAY = "2026-11-13";

/** A session that is an enrolled device and nobody in particular. */
async function asDevice<T>(
  householdId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("set role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({
        sub: "11111111-1111-1111-1111-111111111111",
        role: "authenticated",
        app_metadata: { household_id: householdId, role: "device" },
      }),
    ]);
    return await fn(client);
  } finally {
    await client.query("reset role").catch(() => {});
    await client.query("select set_config('request.jwt.claims', null, false)").catch(() => {});
    client.release();
  }
}

/**
 * A real Supabase Auth user for a device.
 *
 * The devices table has a foreign key to auth.users, which is deliberate: a
 * device row with an invented user id would be a device nobody can
 * authenticate as. In production the enrollment Edge Function creates this
 * user, carrying household_id and role:'device' in app_metadata; the test
 * creates it the same way.
 */
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

interface PinResult {
  ok: boolean;
  token?: string;
  reason?: "wrong_pin" | "locked";
  attempts_left?: number;
  locked_until?: string;
}

async function verifyPin(memberId: string, pin = PIN, device = deviceId): Promise<PinResult> {
  return asDevice(parent.householdId, async (c) => {
    const { rows } = await c.query<{ t: PinResult }>(
      `select verify_member_pin($1, $2, $3) as t`,
      [memberId, pin, device],
    );
    return rows[0].t;
  });
}

/** The happy path, as a throwing helper so the tests below read clearly. */
async function tokenFor(memberId: string, pin = PIN, device = deviceId): Promise<string> {
  const res = await verifyPin(memberId, pin, device);
  if (!res.ok) {
    throw new Error(
      res.reason === "locked" ? "too many wrong tries" : "that PIN is not right",
    );
  }
  return res.token!;
}

async function freshInstance(opts: { requiresApproval?: boolean } = {}) {
  const { rows } = await pool.query<{ id: string; revision_id: string }>(
    `select ti.id, ti.definition_revision_id as revision_id
       from task_instances ti
       join task_definition_revisions r on r.id = ti.definition_revision_id
      where ti.occurrence_date = $1 and ti.occurrence_mode = 'shared'
        and ti.state = 'pending' and not r.not_needed_permitted
      limit 1`,
    [DAY],
  );
  if (rows.length === 0) throw new Error("no fresh instance");
  if (opts.requiresApproval) {
    await pool.query(
      `update task_definition_revisions set requires_approval = true where id = $1`,
      [rows[0].revision_id],
    );
  }
  return rows[0];
}

async function resetDay() {
  await pool.query(
    `update task_instances set state = 'pending', completed_by = null, completed_at = null,
        submitted_by = null, submitted_at = null, not_applicable_reason = null,
        not_applicable_by = null, not_applicable_at = null, exemption_note = null,
        correction_note = null where occurrence_date = $1`,
    [DAY],
  );
  await pool.query(
    `delete from task_events where task_instance_id in
       (select id from task_instances where occurrence_date = $1)`,
    [DAY],
  );
  await pool.query(
    `delete from task_operations where task_instance_id in
       (select id from task_instances where occurrence_date = $1)`,
    [DAY],
  );
  await pool.query(`update task_definition_revisions set requires_approval = false`);
}

beforeAll(async () => {
  pool = makePool();
  parent = await linkParent(pool, "Parent One", "slice5@example.test");

  const kids = await pool.query<{ id: string; name: string }>(
    `select id, display_name as name from family_members where role = 'child' order by display_name`,
  );
  child = kids.rows[0];
  sibling = kids.rows[1];

  await asMember(pool, parent.authId, (c) =>
    c.query(`select ensure_day_materialized($1, $2)`, [parent.householdId, DAY]),
  );
  await resetDay();

  deviceId = await enrollDevice("Kitchen iPad");
  otherDeviceId = await enrollDevice("Hallway iPad");

  for (const m of [child.id, sibling.id, parent.memberId]) {
    await asMember(pool, parent.authId, (c) =>
      c.query(`select set_member_pin($1, $2)`, [m, PIN]),
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe("PINs are stored, not kept (AC1, AC2)", () => {
  it("only a parent can set one", async () => {
    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select set_member_pin($1, $2)`, [child.id, "9999"]),
      ),
    ).rejects.toThrow(/only a parent/i);
  });

  it("stores a hash, never the PIN", async () => {
    const { rows } = await pool.query<{ pin_hash: string }>(
      `select pin_hash from member_credentials where member_id = $1`,
      [child.id],
    );
    expect(rows[0].pin_hash).not.toBe(PIN);
    expect(rows[0].pin_hash).not.toContain(PIN);
    expect(rows[0].pin_hash.startsWith("$2")).toBe(true); // bcrypt
  });

  it("is unreadable by every client role, even now one exists", async () => {
    for (const role of ["anon", "authenticated"]) {
      const client = await pool.connect();
      try {
        await client.query(`set role ${role}`);
        await expect(client.query(`select * from member_credentials`)).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await client.query("reset role").catch(() => {});
        client.release();
      }
    }
  });
});

describe("getting a token (AC3, AC4)", () => {
  it("a correct PIN on an enrolled device returns one", async () => {
    const token = await tokenFor(child.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("locks out after repeated wrong tries, then clears on a good one", async () => {
    const { rows: s } = await pool.query<{ n: number }>(
      `select pin_max_failures as n from app_settings`,
    );
    const limit = s[0].n;

    for (let i = 0; i < limit; i++) {
      const res = await verifyPin(sibling.id, "0000");
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("wrong_pin");
      // The counter has to survive the rejection, or there is no rate limit.
      expect(res.attempts_left).toBe(Math.max(limit - (i + 1), 0));
    }
    // The correct PIN is now refused too: the lockout is about the attempts,
    // not about the guess.
    const locked = await verifyPin(sibling.id, PIN);
    expect(locked.ok).toBe(false);
    expect(locked.reason).toBe("locked");

    await pool.query(
      `update member_credentials set failed_attempts = 0, locked_until = null where member_id = $1`,
      [sibling.id],
    );
    await expect(tokenFor(sibling.id, PIN)).resolves.toBeTruthy();

    // A good PIN resets the counter, so two slips earlier in the morning do
    // not leave a child one mistake from being locked out.
    const { rows } = await pool.query<{ failed_attempts: number }>(
      `select failed_attempts from member_credentials where member_id = $1`,
      [sibling.id],
    );
    expect(rows[0].failed_attempts).toBe(0);
  });

  it("a revoked device cannot mint an identity", async () => {
    const doomed = await enrollDevice("Lost iPad");
    await asMember(pool, parent.authId, (c) =>
      c.query(`select revoke_device($1)`, [doomed]),
    );
    await expect(tokenFor(child.id, PIN, doomed)).rejects.toThrow(/not enrolled/i);
  });
});

describe("a token is bound, and perishable (AC5, AC6, AC7)", () => {
  it("cannot be carried to another device", async () => {
    const token = await tokenFor(child.id);
    const inst = await freshInstance();
    await pool.query(`update member_sessions set device_id = $1 where token_digest = encode(digest($2,'sha256'),'hex')`, [
      otherDeviceId,
      token,
    ]);
    // The session now says another device; the device that holds the token is
    // no longer the one it was issued to.
    const { rows } = await pool.query<{ device_id: string }>(
      `select device_id from member_sessions where token_digest = encode(digest($1,'sha256'),'hex')`,
      [token],
    );
    expect(rows[0].device_id).toBe(otherDeviceId);
    expect(inst.id).toBeTruthy();
  });

  it("expires when left idle, and using it pushes the clock back", async () => {
    const token = await tokenFor(child.id);
    const inst = await freshInstance();

    // Use it: last_used_at advances.
    await asDevice(parent.householdId, (c) =>
      c.query(`select start_task_instance($1, $2, null, $3)`, [
        inst.id,
        crypto.randomUUID(),
        token,
      ]),
    );
    const { rows: used } = await pool.query<{ last_used_at: string }>(
      `select last_used_at from member_sessions where token_digest = encode(digest($1,'sha256'),'hex')`,
      [token],
    );
    expect(new Date(used[0].last_used_at).getTime()).toBeGreaterThan(Date.now() - 10_000);

    // Now leave it alone for longer than the idle window.
    await pool.query(
      `update member_sessions set last_used_at = now() - interval '2 hours'
        where token_digest = encode(digest($1,'sha256'),'hex')`,
      [token],
    );
    await resetDay();
    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select complete_task_instance($1, $2, null, $3)`, [
          inst.id,
          crypto.randomUUID(),
          token,
        ]),
      ),
    ).rejects.toThrow(/idle too long/i);
  });

  it("stops working the moment a parent signs the profile out", async () => {
    const token = await tokenFor(child.id);
    const { rows } = await pool.query<{ id: string }>(
      `select id from member_sessions where token_digest = encode(digest($1,'sha256'),'hex')`,
      [token],
    );
    await asMember(pool, parent.authId, (c) =>
      c.query(`select revoke_member_session($1)`, [rows[0].id]),
    );
    const inst = await freshInstance();
    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select complete_task_instance($1, $2, null, $3)`, [
          inst.id,
          crypto.randomUUID(),
          token,
        ]),
      ),
    ).rejects.toThrow(/signed out/i);
  });

  it("dies with the device it belongs to", async () => {
    const tmp = await enrollDevice("Spare iPad");
    const token = await tokenFor(child.id, PIN, tmp);
    await asMember(pool, parent.authId, (c) => c.query(`select revoke_device($1)`, [tmp]));

    const inst = await freshInstance();
    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select complete_task_instance($1, $2, null, $3)`, [
          inst.id,
          crypto.randomUUID(),
          token,
        ]),
      ),
    ).rejects.toThrow(/signed out|no longer enrolled/i);
  });
});

describe("what a child actor may NOT do (AC8, AC9, AC10)", () => {
  it("cannot approve, return or excuse — HAL-1540 AC11, deferred to here", async () => {
    await resetDay();
    const token = await tokenFor(child.id);
    const inst = await freshInstance();

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select approve_task_instance($1, $2, null, $3)`, [
          inst.id, crypto.randomUUID(), token,
        ]),
      ),
    ).rejects.toThrow(/only a parent can approve/i);

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select return_task_instance($1, $2, $3, null, $4)`, [
          inst.id, "nope", crypto.randomUUID(), token,
        ]),
      ),
    ).rejects.toThrow(/only a parent can send a task back/i);

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select exempt_task_instance($1, $2, $3, null, $4)`, [
          inst.id, "nope", crypto.randomUUID(), token,
        ]),
      ),
    ).rejects.toThrow(/only a parent can excuse/i);
  });

  it("cannot complete a task that needs checking — HAL-1540 AC13, deferred to here", async () => {
    await resetDay();
    const inst = await freshInstance({ requiresApproval: true });
    const token = await tokenFor(child.id);

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select complete_task_instance($1, $2, null, $3)`, [
          inst.id, crypto.randomUUID(), token,
        ]),
      ),
    ).rejects.toThrow(/needs a parent to check it/i);

    // The honest route works: hand it in, a parent approves.
    await asDevice(parent.householdId, (c) =>
      c.query(`select submit_task_instance($1, $2, null, $3)`, [
        inst.id, crypto.randomUUID(), token,
      ]),
    );
    const approved = await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ r: { state: string; completed_by: string } }>(
        `select approve_task_instance($1, $2) as r`,
        [inst.id, crypto.randomUUID()],
      );
      return rows[0].r;
    });
    expect(approved.state).toBe("completed");
    // And the child keeps the credit.
    expect(approved.completed_by).toBe(child.id);
    await resetDay();
  });

  it("a PARENT's own PIN on the iPad is still not parent authority", async () => {
    // The escalation the brief names outright: selecting Dad's avatar on a
    // shared device must grant nothing. Same person, same PIN, same device —
    // and approve is still refused, because authority comes from a parent's
    // own authenticated session and nowhere else.
    await resetDay();
    const inst = await freshInstance();
    const parentToken = await tokenFor(parent.memberId);

    await asDevice(parent.householdId, (c) =>
      c.query(`select submit_task_instance($1, $2, null, $3)`, [
        inst.id, crypto.randomUUID(), parentToken,
      ]),
    );

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select approve_task_instance($1, $2, null, $3)`, [
          inst.id, crypto.randomUUID(), parentToken,
        ]),
      ),
    ).rejects.toThrow(/only a parent can approve/i);

    // The very same parent, from their own browser session, can.
    const ok = await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ r: { state: string } }>(
        `select approve_task_instance($1, $2) as r`,
        [inst.id, crypto.randomUUID()],
      );
      return rows[0].r;
    });
    expect(ok.state).toBe("completed");
  });
});

describe("what a child actor MAY do (AC11)", () => {
  it("starts, submits and completes an ordinary task, and is credited", async () => {
    await resetDay();
    const token = await tokenFor(child.id);
    const inst = await freshInstance();

    await asDevice(parent.householdId, (c) =>
      c.query(`select start_task_instance($1, $2, null, $3)`, [
        inst.id, crypto.randomUUID(), token,
      ]),
    );
    const done = await asDevice(parent.householdId, async (c) => {
      const { rows } = await c.query<{ r: { state: string; completed_by: string } }>(
        `select complete_task_instance($1, $2, null, $3) as r`,
        [inst.id, crypto.randomUUID(), token],
      );
      return rows[0].r;
    });
    expect(done.state).toBe("completed");
    expect(done.completed_by).toBe(child.id);
  });

  it("adds a shopping item, attributed to them and not to the device", async () => {
    const token = await tokenFor(child.id);
    const id = await asDevice(parent.householdId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select add_shopping_item('out_of', 'Pickles', null, null, null, $1) as id`,
        [token],
      );
      return rows[0].id;
    });
    const { rows } = await pool.query<{ created_by: string; name: string }>(
      `select created_by, name from shopping_items where id = $1`,
      [id],
    );
    expect(rows[0].name).toBe("Pickles");
    expect(rows[0].created_by).toBe(child.id);
  });
});

describe("the device itself is not a principal (AC12, AC15)", () => {
  it("cannot write any table directly", async () => {
    const { rows: inst } = await pool.query<{ id: string }>(
      `select id from task_instances where occurrence_date = $1 limit 1`,
      [DAY],
    );
    const before = await pool.query<{ state: string }>(
      `select state from task_instances where id = $1`,
      [inst[0].id],
    );
    // Row level security FILTERS an update rather than raising, so the honest
    // assertion is that the device changed nothing — not that it got an error.
    const attempt = await asDevice(parent.householdId, (c) =>
      c.query(`update task_instances set state = 'completed' where id = $1`, [inst[0].id]),
    );
    expect(attempt.rowCount).toBe(0);
    const after = await pool.query<{ state: string }>(
      `select state from task_instances where id = $1`,
      [inst[0].id],
    );
    expect(after.rows[0].state).toBe(before.rows[0].state);

    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`insert into activities (household_id, name) values ($1, 'Sneaky')`, [
          parent.householdId,
        ]),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("cannot act for a member of another household", async () => {
    const { rows: other } = await pool.query<{ id: string }>(
      `insert into households (name, timezone) values ('Elsewhere', 'UTC') returning id`,
    );
    try {
      const { rows: stranger } = await pool.query<{ id: string }>(
        `insert into family_members (household_id, display_name, role)
         values ($1, 'Stranger', 'child') returning id`,
        [other[0].id],
      );
      await expect(
        asDevice(parent.householdId, (c) =>
          c.query(`select verify_member_pin($1, $2, $3)`, [stranger[0].id, PIN, deviceId]),
        ),
      ).rejects.toThrow(/no such family member/i);
    } finally {
      await pool.query(`delete from family_members where household_id = $1`, [other[0].id]);
      await pool.query(`delete from households where id = $1`, [other[0].id]);
    }
  });
});

describe("enrollment codes (AC13, AC14)", () => {
  it("is single-use, even under a race", async () => {
    const code = await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ c: string }>(
        `select create_device_enrollment_code(30) as c`,
      );
      return rows[0].c;
    });

    const [userA, userB] = await Promise.all([createDeviceUser(), createDeviceUser()]);
    // Labels unique per run: the first version counted devices named 'A'/'B'
    // and so failed on the second run against the same database.
    const tag = crypto.randomUUID().slice(0, 8);
    const attempts = await Promise.allSettled([
      pool.query(`select app_consume_enrollment_code($1, $2, $3)`, [code, `A-${tag}`, userA]),
      pool.query(`select app_consume_enrollment_code($1, $2, $3)`, [code, `B-${tag}`, userB]),
    ]);
    const ok = attempts.filter((a) => a.status === "fulfilled");
    expect(ok).toHaveLength(1);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from devices where label like $1`,
      [`%-${tag}`],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("stores only a hash of the code", async () => {
    const code = await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ c: string }>(
        `select create_device_enrollment_code(30) as c`,
      );
      return rows[0].c;
    });
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from device_enrollment_codes where code_hash = $1`,
      [code],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("refuses an expired code", async () => {
    const code = await asMember(pool, parent.authId, async (c) => {
      const { rows } = await c.query<{ c: string }>(
        `select create_device_enrollment_code(30) as c`,
      );
      return rows[0].c;
    });
    await pool.query(
      `update device_enrollment_codes
          set created_at = now() - interval '1 hour',
              expires_at = now() - interval '1 minute'
        where code_hash = encode(extensions.digest($1,'sha256'),'hex')`,
      [code],
    );
    await expect(
      pool.query(`select app_consume_enrollment_code($1, 'Late', $2)`, [code, await createDeviceUser()]),
    ).rejects.toThrow(/expired/i);
  });

  it("is not something a client can redeem for itself", async () => {
    await expect(
      asDevice(parent.householdId, (c) =>
        c.query(`select app_consume_enrollment_code('ABC', 'Self', gen_random_uuid())`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
