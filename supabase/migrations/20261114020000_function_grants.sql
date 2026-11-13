-- Our Family Hub — make function execution default-deny, and grant the client
-- API back by name.
--
-- WHY THIS EXISTS
--
-- Supabase sets default privileges that grant EXECUTE on every new function in
-- `public` to `anon`, `authenticated` and `service_role`:
--
--   select defaclacl from pg_default_acl where defaclobjtype = 'f';
--   -> {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
--       service_role=X/postgres}
--
-- So `revoke all on function f() from public` — which earlier migrations use
-- throughout — removes the PUBLIC pseudo-role's grant and leaves the explicit
-- ones untouched. Slice 5 found this and fixed it for four functions by naming
-- the roles. The other twenty-eight kept the pattern that does not work, and a
-- catalogue check before the first deployment found them:
--
--   28 of 32 functions in `public` were EXECUTE-able by `anon`.
--
-- WHAT WAS AND WAS NOT EXPOSED
--
-- Measured at runtime, as the `anon` role with no JWT, on 2026-11-13:
--
--   complete_task_instance(...)   -> refused, 42501
--                                    "no acting family member for this session"
--   select from households        -> 0 rows (row level security)
--
-- So no anonymous caller could change or read household state: every function
-- re-checks its caller, and that defence held. Three things were still wrong:
--
--   1. app_resolve_actor(token) was callable by anyone on the internet and
--      distinguishes "no such token" from "revoked" from "idle too long" — a
--      token-validity oracle needing no credential at all.
--   2. The SECURITY DEFINER helpers bypass row level security by design, and
--      exposing them to `authenticated` is a cross-household read path. One
--      household makes that academic today; the schema treats households as a
--      tenant boundary, and this punched through it.
--   3. The real surface was 28 functions where the design intended 17, with
--      nothing but each function's own guard behind it. Defence in depth means
--      the grant layer should also be right.
--
-- THE APPROACH
--
-- Default-deny, then allow by name. The default privileges are changed first,
-- so a function added by a later migration is private until someone grants it
-- deliberately — a forgotten grant then shows up as a 404 from PostgREST,
-- which is a loud and safe way to fail. tests/db/grants.test.ts asserts the
-- whole matrix, so adding a function without deciding its visibility fails the
-- suite rather than quietly widening the API.
--
-- `service_role` keeps its access: it is the backend key used by the bootstrap
-- script and Edge Functions, and it never reaches a browser.

-- 1. Stop Supabase's default privileges from granting the browser roles
--    EXECUTE on every function added from here on.
--
--    This removes `anon` and `authenticated`. It does NOT remove PUBLIC, and
--    it cannot: measured on PostgreSQL 17.11, `alter default privileges ...
--    revoke execute on functions from public` is silently discarded — the
--    revocation is not even recorded in pg_default_acl, and a function created
--    afterwards still carries `=X/owner`. An explicit `revoke ... from public`
--    after creation does work, which is what step 2 does.
--
--    An event trigger would close the gap, but creating one needs superuser
--    and the migration role on a hosted project is not one. So a function
--    added by a later migration WILL be executable by PUBLIC — and therefore
--    by anon — until it is revoked. The guard against that is
--    tests/db/grants.test.ts, which asserts the whole matrix by name and fails
--    the suite rather than letting the API widen unnoticed. That test is doing
--    real work; it is not decoration.
do $$
begin
  -- Bound to whichever role runs the migrations (postgres, locally and on a
  -- hosted project) rather than hard-coded, because default privileges only
  -- apply to objects created by the role they name.
  execute format(
    'alter default privileges for role %I in schema public ' ||
    'revoke execute on functions from anon, authenticated',
    current_user);
end
$$;

-- 2. Take EXECUTE away from PUBLIC and from the browser-reachable roles on
--    everything that exists today. A loop, because the point is that nothing
--    is missed: app_transition_target had never been revoked from anything at
--    all, and a hand-written list is how that happens.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end
$$;

-- 3. Grant back exactly the client API. Signatures are the identity arguments
--    read from pg_proc, not retyped from memory.
--
--    First, the two helpers that ROW LEVEL SECURITY ITSELF needs.
--
--    A policy expression is evaluated with the privileges of the role running
--    the query, not the policy's author. 88 policies are declared `to
--    authenticated` and 87 of them call app_current_household_id(), so taking
--    that grant away does not harden the app — it breaks every signed-in read
--    with "permission denied for function app_current_household_id". The first
--    version of this migration did exactly that, and the existing RLS and
--    kiosk tests caught it.
--
--    Exposing these two costs nothing. Both take NO ARGUMENTS: they report
--    facts about the caller's own session — which household the caller belongs
--    to, and whether the caller is a parent — so there is no identifier for a
--    caller to substitute and nothing to learn about anyone else. That is the
--    dividing line used throughout this file: a zero-argument
--    session-introspection helper may be reachable, while any SECURITY DEFINER
--    function TAKING an id stays private, because it would read across the
--    household boundary that row level security exists to draw.
--
--    `anon` needs neither. No policy applies to it, so an anonymous query
--    matches no rows without ever evaluating these.
grant execute on function app_current_household_id() to authenticated;
grant execute on function app_is_parent() to authenticated;

--    Read paths — the dashboard and the two evaluators behind it.
grant execute on function evaluate_household_dashboard(p_household_id uuid, p_evaluated_at timestamp with time zone) to authenticated;
grant execute on function evaluate_activity_readiness(p_household_id uuid, p_member_id uuid, p_activity_id uuid, p_evaluated_at timestamp with time zone) to authenticated;
grant execute on function evaluate_space_status(p_space_id uuid, p_evaluated_at timestamp with time zone) to authenticated;

--    The day's tasks are created on first sight of a new local date.
grant execute on function ensure_day_materialized(p_household_id uuid, p_local_date date) to authenticated;

--    The seven task transitions. Each one re-checks the caller and, when an
--    actor token is supplied, never treats it as parent authority.
grant execute on function start_task_instance(p_instance_id uuid, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function submit_task_instance(p_instance_id uuid, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function complete_task_instance(p_instance_id uuid, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function approve_task_instance(p_instance_id uuid, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function return_task_instance(p_instance_id uuid, p_note text, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function exempt_task_instance(p_instance_id uuid, p_note text, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;
grant execute on function mark_task_not_needed(p_instance_id uuid, p_operation_id uuid, p_expected_version integer, p_actor_token text) to authenticated;

--    Shopping.
grant execute on function add_shopping_item(p_list_kind shopping_list_kind, p_name text, p_category text, p_quantity integer, p_notes text, p_actor_token text) to authenticated;

--    Kiosk identity. verify_member_pin mints an actor token on an enrolled
--    device; the rest are parent-only and say so internally.
grant execute on function verify_member_pin(p_member_id uuid, p_pin text, p_device_id uuid) to authenticated;
grant execute on function set_member_pin(p_member_id uuid, p_pin text) to authenticated;
grant execute on function create_device_enrollment_code(p_valid_minutes integer) to authenticated;
grant execute on function revoke_device(p_device_id uuid) to authenticated;
grant execute on function revoke_member_session(p_session_id uuid) to authenticated;

-- Deliberately NOT granted, and each for a reason:
--
--   app_* helpers           internal; they bypass row level security. The two
--                           exceptions above are granted because policies call
--                           them, and are safe because they take no arguments.
--   app_apply_transition    the seven wrappers above are its only entry points.
--   app_consume_enrollment_code
--                           device enrollment is a parent action that will go
--                           through an Edge Function (slice 7). Until that
--                           exists there is no client path, and inventing one
--                           here would be a guess.
--   applicable_at           derived detail; the evaluators expose what the UI
--                           needs.
--
-- `anon` is granted nothing at all. Every client of this app signs in first;
-- the kiosk device is an enrolled, signed-in client that then mints an actor
-- token for a child. An anonymous caller has no legitimate request to make.
