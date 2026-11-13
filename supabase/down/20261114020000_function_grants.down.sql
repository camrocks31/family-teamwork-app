-- Reverse 20261114020000_function_grants.sql.
--
-- This restores Supabase's defaults: EXECUTE on every function in `public` for
-- PUBLIC, anon and authenticated, and default privileges that keep granting to
-- the two named roles. That is a WIDENING, which is unusual for a down
-- migration — but a reverse migration has to actually reverse, and the round
-- trip is checked in CI.
--
-- PUBLIC is restored per function rather than through default privileges,
-- because revoking or granting EXECUTE to PUBLIC in default privileges has no
-- effect on PostgreSQL 17.11.
do $$
begin
  execute format(
    'alter default privileges for role %I in schema public ' ||
    'grant execute on functions to anon, authenticated',
    current_user);
end
$$;

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
      'grant execute on function %s to public, anon, authenticated', f.sig);
  end loop;
end
$$;

-- Restore the four denials that EXISTED BEFORE this migration. The loop above
-- grants every function to everyone, which is broader than the state it is
-- meant to return to: earlier migrations had already revoked these by name,
-- and handing `app_consume_enrollment_code` or `app_apply_transition` to
-- anonymous callers would be a hole this migration never opened. Found by
-- independent review, which applied this file on its own and compared.
revoke all on function
  app_apply_transition(uuid, text, uuid, integer, text, text),
  app_consume_enrollment_code(text, text, uuid)
  from public, anon, authenticated;

revoke all on function
  verify_member_pin(uuid, text, uuid),
  evaluate_household_dashboard(uuid, timestamp with time zone)
  from public, anon;
