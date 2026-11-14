import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { makePool } from "./helpers";

/**
 * HAL-1545 acceptance criterion 7 — the grant layer, not just row level
 * security.
 *
 * Supabase's default privileges grant EXECUTE on every new function in
 * `public` to `anon` and `authenticated`. `revoke ... from public` does not
 * remove them, so for most of this schema's life the browser-reachable roles
 * could call 28 of 32 functions. Nothing was actually exploitable — each
 * function re-checks its caller, and an anonymous call was refused with 42501
 * — but the API surface was four times what was designed, with only the
 * innermost check behind it.
 *
 * So this file pins the surface. It is deliberately an exhaustive, named list:
 * adding a function and not deciding whether a browser may call it fails here,
 * which is the only way a rule like this stays true a year later.
 */

let pool: pg.Pool;

/** Exactly what a signed-in browser client may call. */
const AUTHENTICATED_MAY_EXECUTE = [
  "add_shopping_item",
  // Row level security itself calls these two. A policy expression runs with
  // the querying role's privileges, so revoking them does not harden anything
  // — it breaks every signed-in read. Both take no arguments and describe only
  // the caller's own session, so there is nothing to leak.
  "app_current_household_id",
  "app_is_parent",
  "app_today_is_school_day",
  "approve_task_instance",
  "complete_task_instance",
  "create_device_enrollment_code",
  "enroll_this_device",
  "ensure_day_materialized",
  "evaluate_activity_readiness",
  "evaluate_household_dashboard",
  "evaluate_rewards",
  "evaluate_space_status",
  "exempt_task_instance",
  "list_devices",
  "list_my_jobs",
  "mark_task_not_needed",
  "return_task_instance",
  "revoke_device",
  "revoke_member_session",
  "save_task",
  "set_task_active",
  "set_member_pin",
  "start_task_instance",
  "submit_task_instance",
  "verify_member_pin",
].sort();

beforeAll(() => {
  pool = makePool();
});
afterAll(async () => {
  await pool.end();
});

async function executableBy(role: string): Promise<string[]> {
  const { rows } = await pool.query<{ proname: string }>(
    `select distinct p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        -- Procedures and aggregates too. Filtering to 'f' alone left a hole
        -- in the guard: a procedure created later would be executable by
        -- PUBLIC and this test would not have noticed.
        and p.prokind in ('f', 'p', 'a')
        and has_function_privilege($1, p.oid, 'EXECUTE')
      order by 1`,
    [role],
  );
  return rows.map((r) => r.proname);
}

describe("function grants", () => {
  it("lets an anonymous caller execute nothing at all", async () => {
    // Every client of this app signs in first. The kiosk iPad is an enrolled,
    // signed-in device that mints a short-lived actor token for a child; it is
    // never anonymous. So there is no function `anon` has cause to call, and
    // the honest expression of that is an empty list.
    expect(await executableBy("anon")).toEqual([]);
  });

  it("exposes exactly the intended API to a signed-in client", async () => {
    expect(await executableBy("authenticated")).toEqual(AUTHENTICATED_MAY_EXECUTE);
  });

  it("keeps the internal helpers unreachable from a browser", async () => {
    // Named separately from the list above, because these are the ones whose
    // exposure actually mattered: they are SECURITY DEFINER and bypass row
    // level security, so reaching them from another household's session would
    // have read across the tenant boundary the schema is built on.
    const internal = [
      "app_apply_transition",
      "app_consume_enrollment_code",
      "app_current_member_id",
      "app_household_today",
      "app_in_morning_window",
      "app_instance_applies_at",
      "app_instance_satisfaction",
      "app_is_school_day",
      "app_recurrence_applies_at",
      "app_requirement_rows",
      "app_resolve_actor",
      "app_transition_target",
      "applicable_at",
    ];
    const reachable = await executableBy("authenticated");
    const anonReachable = await executableBy("anon");
    for (const name of internal) {
      expect(reachable, `${name} must not be callable by authenticated`).not.toContain(name);
      expect(anonReachable, `${name} must not be callable by anon`).not.toContain(name);
    }
  });

  it("keeps the service role working: it is the backend key, not a browser key", async () => {
    // The bootstrap script and Edge Functions use it, and it never ships to a
    // client. Locking it down here would break account creation and prove
    // nothing.
    const reachable = await executableBy("service_role");
    expect(reachable).toContain("evaluate_household_dashboard");
    expect(reachable).toContain("app_resolve_actor");
  });

  it("leaves no function in public executable by PUBLIC", async () => {
    // The invariant that actually holds, and the one that catches a function
    // added without a decision about it.
    //
    // Two things enforce it, and it is worth knowing which does what.
    //
    // 20261114030100_private_by_default.sql revokes EXECUTE from PUBLIC in the
    // role's GLOBAL default privileges, so a newly created function is private
    // from the moment it exists. An earlier migration tried to do this scoped
    // with `IN SCHEMA` and it silently did nothing — the measured difference
    // between the two is written up in that migration.
    //
    // This test stays regardless, because a default is a safety net and the
    // named list above is a decision. A function added later still has to be
    // argued for here.
    const { rows } = await pool.query<{ proname: string; proacl: string | null }>(
      `select p.proname, p.proacl::text
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind in ('f', 'p', 'a')
          -- A null ACL means "built-in default", which for a function grants
          -- EXECUTE to PUBLIC. An explicit '=X/' entry says the same thing.
          and (p.proacl is null or array_to_string(p.proacl, ',') like '=X/%'
               or array_to_string(p.proacl, ',') like '%,=X/%')
        order by 1`,
    );
    expect(
      rows.map((r) => r.proname),
      "these functions are executable by PUBLIC, so by anyone with the anon key",
    ).toEqual([]);
  });
});
