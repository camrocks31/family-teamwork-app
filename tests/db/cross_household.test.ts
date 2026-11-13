import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { expectClientRejected, linkParent, makePool, withRollback } from "./helpers";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1545 — authority defects found by independent review of the function
 * grant lockdown, each reproduced before being accepted and each pinned here.
 *
 * The lockdown decided WHO MAY CALL each function. These tests are about what
 * happens once they are inside it: whether the function checks that the ids it
 * was handed belong to the caller, and whether a PIN is actually verified.
 *
 * The app has one household, so none of this was exploitable in practice. That
 * is a fact about today's data rather than about the code, and it stops being
 * true the first time a second household exists — which is exactly the kind of
 * thing that gets forgotten. Hence a second household, built here.
 */

let pool: pg.Pool;
let parentA: { memberId: string; authId: string; householdId: string };

beforeAll(async () => {
  pool = makePool();
  parentA = await linkParent(pool, "Parent One", "cross-household@example.test");
});
afterAll(async () => {
  await pool.end();
});

/** A whole second household: parent, child, enrolled device, PIN, live session. */
async function withHouseholdB<T>(
  client: pg.PoolClient,
  fn: (b: { householdId: string; childId: string; deviceId: string }) => Promise<T>,
): Promise<T> {
  const { rows } = await client.query<{
    household_id: string;
    child_id: string;
    device_id: string;
  }>(`
    with h as (
      insert into households (name, timezone)
      values ('Household B', 'America/Vancouver') returning id
    ), p as (
      insert into family_members (household_id, display_name, role, is_active)
      select id, 'B Parent', 'parent', true from h returning id, household_id
    ), c as (
      insert into family_members (household_id, display_name, role, is_active)
      select id, 'B Child', 'child', true from h returning id, household_id
    ), d as (
      insert into devices (household_id, label, status, enrolled_by)
      select p.household_id, 'B iPad', 'active', p.id from p returning id, household_id
    ), cred as (
      insert into member_credentials (member_id, household_id, pin_hash)
      select c.id, c.household_id, extensions.crypt('4321', extensions.gen_salt('bf')) from c
    ), sess as (
      insert into member_sessions (household_id, member_id, device_id, token_digest, expires_at)
      select d.household_id, c.id, d.id, 'deadbeef', now() + interval '8 hours'
        from d, c
    )
    select h.id as household_id, c.id as child_id, d.id as device_id from h, c, d
  `);
  const b = rows[0];
  return fn({ householdId: b.household_id, childId: b.child_id, deviceId: b.device_id });
}

/** An enrolled device and a known PIN inside the caller's OWN household. */
async function ownDeviceAndPin(client: pg.PoolClient, householdId: string) {
  const { rows } = await client.query<{ child_id: string; device_id: string }>(
    `
    with p as (
      select id from family_members where household_id = $1 and role = 'parent' limit 1
    ), c as (
      select id from family_members where household_id = $1 and role = 'child' limit 1
    ), d as (
      insert into devices (household_id, label, status, enrolled_by)
      select $1, 'A iPad', 'active', p.id from p returning id
    ), cred as (
      insert into member_credentials (member_id, household_id, pin_hash)
      select c.id, $1, extensions.crypt('1234', extensions.gen_salt('bf')) from c
      on conflict (member_id) do update
        set pin_hash = extensions.crypt('1234', extensions.gen_salt('bf'))
    )
    select c.id as child_id, d.id as device_id from c, d
  `,
    [householdId],
  );
  return rows[0];
}

async function asParentA(client: pg.PoolClient) {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: parentA.authId, role: "authenticated" }),
  ]);
}

describe("a PIN is actually verified", () => {
  it("refuses a NULL PIN instead of treating it as correct", async () => {
    // The defect: crypt(NULL, hash) is NULL, so `hash <> crypt(NULL, hash)` is
    // NULL rather than true, the rejection branch never ran, and the function
    // fell through to success. verify_member_pin(child, NULL, device) returned
    // {"ok": true, "token": "..."} — a live actor token for a child with no
    // PIN at all. It was reachable by any signed-in client.
    await withRollback(pool, async (client) => {
      const own = await ownDeviceAndPin(client, parentA.householdId);
      await asParentA(client);
      const error = await expectClientRejected(
        client,
        "select verify_member_pin($1, NULL, $2)",
        [own.child_id, own.device_id],
      );
      expect(error.message).toMatch(/PIN is required/i);
    });
  });

  it("refuses a blank PIN", async () => {
    await withRollback(pool, async (client) => {
      const own = await ownDeviceAndPin(client, parentA.householdId);
      await asParentA(client);
      const error = await expectClientRejected(
        client,
        "select verify_member_pin($1, '   ', $2)",
        [own.child_id, own.device_id],
      );
      expect(error.message).toMatch(/PIN is required/i);
    });
  });

  it("still accepts the right PIN and still rejects a wrong one", async () => {
    // The fix must not have turned the lock into a wall.
    await withRollback(pool, async (client) => {
      const own = await ownDeviceAndPin(client, parentA.householdId);
      await asParentA(client);

      const wrong = await client.query("select verify_member_pin($1, '9999', $2) as r", [
        own.child_id,
        own.device_id,
      ]);
      expect(wrong.rows[0].r.ok).toBe(false);
      expect(wrong.rows[0].r.reason).toBe("wrong_pin");

      const right = await client.query("select verify_member_pin($1, '1234', $2) as r", [
        own.child_id,
        own.device_id,
      ]);
      expect(right.rows[0].r.ok).toBe(true);
      expect(typeof right.rows[0].r.token).toBe("string");
    });
  });
});

describe("one household cannot reach into another", () => {
  it("will not verify a PIN on another household's device", async () => {
    // The device used to supply its own household, so a real parent of one
    // house could probe another child's PIN, read the attempts-left counter,
    // lock them out, and on a correct guess mint a working actor token there.
    await withRollback(pool, async (client) => {
      await withHouseholdB(client, async (b) => {
        await asParentA(client);
        const error = await expectClientRejected(
          client,
          "select verify_member_pin($1, '4321', $2)",
          [b.childId, b.deviceId],
        );
        // Another household's device is indistinguishable from an unenrolled
        // one: the error must not confirm that the device exists.
        expect(error.message).toMatch(/not enrolled/i);
      });
    });
  });

  it("will not revoke another household's device or sign out its sessions", async () => {
    // revoke_device scoped its `devices` update by household but not its
    // `member_sessions` update, so the target's device stayed active while
    // every profile on it was signed out.
    await withRollback(pool, async (client) => {
      await withHouseholdB(client, async (b) => {
        await asParentA(client);
        // A raised exception aborts the transaction, and the point of this
        // test is what survives it, so the rejected call gets its own
        // savepoint to roll back to.
        await client.query("savepoint probe");
        await expectClientRejected(client, "select revoke_device($1)", [b.deviceId]);
        await client.query("rollback to savepoint probe");
        await client.query("reset role");

        const { rows } = await client.query(
          `select (select status from devices where id = $1) as status,
                  (select count(*)::int from member_sessions
                    where device_id = $1 and revoked_at is not null) as revoked`,
          [b.deviceId],
        );
        expect(rows[0].status).toBe("active");
        expect(rows[0].revoked).toBe(0);
      });
    });
  });

  it("still lets a parent revoke their own household's device", async () => {
    await withRollback(pool, async (client) => {
      const own = await ownDeviceAndPin(client, parentA.householdId);
      await asParentA(client);
      await client.query("select revoke_device($1)", [own.device_id]);
      await client.query("reset role");
      const { rows } = await client.query("select status from devices where id = $1", [
        own.device_id,
      ]);
      expect(rows[0].status).toBe("revoked");
    });
  });

  it("will not answer a replay with an operation recorded against a different task", async () => {
    // The task_operations lookup was the FIRST statement in
    // app_apply_transition, keyed on the operation id alone, and it returned
    // the stored result before the caller or the task had been established —
    // so an operation id answered for whatever row it had been recorded
    // against, in any household. Authorisation now runs first and the lookup
    // is scoped to this household AND this task.
    //
    // Scoping to the task is what this asserts: hand the function an
    // operation id belonging to a different instance and it must not hand
    // back that instance's result.
    await withRollback(pool, async (client) => {
      const { rows: tz } = await client.query<{ d: string }>(
        `select to_char((now() at time zone h.timezone)::date, 'YYYY-MM-DD') as d
           from households h where h.id = $1`,
        [parentA.householdId],
      );
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: parentA.authId, role: "authenticated" }),
      ]);
      // app_household_today is internal and not granted to a client, so the
      // local date was computed above from the household's own timezone.
      await client.query("select ensure_day_materialized($1, $2)", [
        parentA.householdId,
        tz[0].d,
      ]);
      await client.query("reset role");

      const { rows: insts } = await client.query<{ id: string; version: number }>(
        `select id, version from task_instances
          where household_id = $1 and state = 'pending' limit 2`,
        [parentA.householdId],
      );
      if (insts.length < 2) throw new Error("need two pending tasks for this test");
      const [target, other] = insts;

      // An operation already recorded against `other`, carrying a result that
      // would be unmistakable if it leaked.
      const { rows: op } = await client.query<{ operation_id: string }>(
        `insert into task_operations (operation_id, household_id, task_instance_id, operation, result)
         values (gen_random_uuid(), $1, $2, 'complete',
                 '{"instance_id":"THE-OTHER-TASK","state":"completed"}'::jsonb)
         returning operation_id`,
        [parentA.householdId, other.id],
      );

      await asParentA(client);
      const error = await expectClientRejected(
        client,
        "select complete_task_instance($1, $2, $3, null)",
        [target.id, op[0].operation_id, target.version],
      );
      // Refused, and — the thing that matters — the other task's stored
      // result is nowhere in the answer.
      expect(error.message).toMatch(/already used for a different task/i);
      expect(error.message).not.toContain("THE-OTHER-TASK");
    });
  });
});
