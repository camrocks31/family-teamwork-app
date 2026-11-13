-- Reverse of 20261113160600_rls.sql.
--
-- Order matters here, and getting it wrong is how this file failed the first
-- time it was run: every policy created by the forward migration references
-- app_current_household_id() or app_is_parent(), so Postgres refuses to drop
-- the functions while the policies exist. Policies first, then the functions.
--
-- The policies are enumerated from pg_policies rather than listed by name, so
-- this stays correct if a later slice adds the device and actor policies the
-- forward migration was written to accommodate.
do $$
declare
  p record;
begin
  for p in
    select policyname, tablename from pg_policies where schemaname = 'public'
  loop
    execute format('drop policy if exists %I on %I', p.policyname, p.tablename);
  end loop;
end
$$;

drop function if exists app_is_parent();
drop function if exists app_current_household_id();

-- Restore the privileges the forward migration revoked, so the schema is back
-- to the state the previous migration left it in rather than a quieter one.
grant update, delete on task_definition_revisions to authenticated;
grant update, delete on task_events to authenticated;
grant select, insert, update, delete on member_credentials to authenticated;
grant select, insert, update, delete on member_sessions to authenticated;

alter table households                    disable row level security;
alter table family_members                disable row level security;
alter table member_credentials            disable row level security;
alter table household_spaces              disable row level security;
alter table pets                          disable row level security;
alter table task_definitions              disable row level security;
alter table task_definition_revisions     disable row level security;
alter table task_definition_criteria      disable row level security;
alter table task_assignments              disable row level security;
alter table task_instances                disable row level security;
alter table task_events                   disable row level security;
alter table task_photos                   disable row level security;
alter table activities                    disable row level security;
alter table activity_availability_windows disable row level security;
alter table activity_grants               disable row level security;
alter table requirement_groups            disable row level security;
alter table requirement_group_items       disable row level security;
alter table activity_requirements         disable row level security;
alter table schedule_rules                disable row level security;
alter table shopping_items                disable row level security;
alter table calendar_events               disable row level security;
alter table calendar_event_attendees      disable row level security;
alter table devices                       disable row level security;
alter table device_enrollment_codes       disable row level security;
alter table member_sessions               disable row level security;
