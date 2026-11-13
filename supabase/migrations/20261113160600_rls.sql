-- Our Family Hub — row level security.
--
-- HAL-1538 §2.4 and requirement 17. The app is static code served from a public
-- URL: the client is untrusted and the published bundle carries only the anon
-- key. Everything that must be true is true here, in the database.
--
-- Slice 1 grants the parent principal. The device and member-actor principals
-- arrive in slice 5; the helpers below already read their claims, so slice 5
-- adds policies rather than reworking these.

-- Which household the caller belongs to.
--
-- SECURITY DEFINER because it reads family_members, which is itself protected
-- by the policies this function is used to define — a non-definer function
-- would recurse. search_path is pinned so a caller cannot shadow the tables it
-- reads.
create or replace function app_current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- A parent (or any member with a login): household comes from their row,
    -- never from a claim they could influence.
    (select fm.household_id
       from family_members fm
      where fm.auth_user_id = auth.uid()
        and fm.is_active
      limit 1),
    -- An enrolled device: household comes from app_metadata, which is
    -- server-set at enrollment and not user-editable.
    nullif(
      ((auth.jwt() -> 'app_metadata') ->> 'household_id'),
      ''
    )::uuid
  );
$$;

revoke all on function app_current_household_id() from public;
grant execute on function app_current_household_id() to authenticated, anon;

-- True only for an authenticated parent. A device session is never a parent,
-- whatever profile is selected on screen.
create or replace function app_is_parent()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from family_members fm
     where fm.auth_user_id = auth.uid()
       and fm.role = 'parent'
       and fm.is_active
  );
$$;

revoke all on function app_is_parent() from public;
grant execute on function app_is_parent() to authenticated, anon;

-- Enable RLS everywhere. A table without RLS is readable by anyone holding the
-- anon key, which on a public static site is everyone.
alter table households                   enable row level security;
alter table family_members               enable row level security;
alter table member_credentials           enable row level security;
alter table household_spaces             enable row level security;
alter table pets                         enable row level security;
alter table task_definitions             enable row level security;
alter table task_definition_revisions    enable row level security;
alter table task_definition_criteria     enable row level security;
alter table task_assignments             enable row level security;
alter table task_instances               enable row level security;
alter table task_events                  enable row level security;
alter table task_photos                  enable row level security;
alter table activities                   enable row level security;
alter table activity_availability_windows enable row level security;
alter table activity_grants              enable row level security;
alter table requirement_groups           enable row level security;
alter table requirement_group_items      enable row level security;
alter table activity_requirements        enable row level security;
alter table schedule_rules               enable row level security;
alter table shopping_items               enable row level security;
alter table calendar_events              enable row level security;
alter table calendar_event_attendees     enable row level security;
alter table devices                      enable row level security;
alter table device_enrollment_codes      enable row level security;
alter table member_sessions              enable row level security;

-- Also force it for the table owner, so a definer function cannot accidentally
-- read credentials through ownership.
alter table member_credentials force row level security;

-- The household row itself.
create policy households_parent_select on households
  for select to authenticated
  using (id = app_current_household_id());

create policy households_parent_update on households
  for update to authenticated
  using (id = app_current_household_id() and app_is_parent())
  with check (id = app_current_household_id() and app_is_parent());

-- Every other table follows one of three shapes. They are written out rather
-- than generated so each is greppable and reviewable on its own.

-- Shape A — parent reads and writes freely within the household.
-- Configuration and household data a parent administers directly (HAL-1538
-- §2.4: with no application server, a parent session writes these tables under
-- RLS; device and actor sessions never do).
do $$
declare
  t text;
begin
  foreach t in array array[
    'family_members',
    'household_spaces',
    'pets',
    'task_definitions',
    'task_definition_criteria',
    'task_assignments',
    'activities',
    'activity_availability_windows',
    'activity_grants',
    'requirement_groups',
    'requirement_group_items',
    'activity_requirements',
    'schedule_rules',
    'shopping_items',
    'calendar_events',
    'calendar_event_attendees',
    'devices',
    'device_enrollment_codes',
    'task_photos',
    'task_instances'
  ]
  loop
    execute format(
      'create policy %I on %I for select to authenticated using (household_id = app_current_household_id())',
      t || '_parent_select', t
    );
    execute format(
      'create policy %I on %I for insert to authenticated with check (household_id = app_current_household_id() and app_is_parent())',
      t || '_parent_insert', t
    );
    execute format(
      'create policy %I on %I for update to authenticated using (household_id = app_current_household_id() and app_is_parent()) with check (household_id = app_current_household_id() and app_is_parent())',
      t || '_parent_update', t
    );
    execute format(
      'create policy %I on %I for delete to authenticated using (household_id = app_current_household_id() and app_is_parent())',
      t || '_parent_delete', t
    );
  end loop;
end
$$;

-- Shape B — append-only. Readable within the household, insertable, never
-- changed or removed by any client.
--
-- task_definition_revisions carries the guarantee that a dated instance's
-- pinned revision cannot be altered after the fact (HAL-1538 requirement 1).
-- task_events is the immutable audit of who changed what.
create policy task_definition_revisions_select on task_definition_revisions
  for select to authenticated
  using (household_id = app_current_household_id());

create policy task_definition_revisions_insert on task_definition_revisions
  for insert to authenticated
  with check (household_id = app_current_household_id() and app_is_parent());

create policy task_events_select on task_events
  for select to authenticated
  using (household_id = app_current_household_id());

create policy task_events_insert on task_events
  for insert to authenticated
  with check (household_id = app_current_household_id());

-- No update or delete policy exists for either table. Belt and braces: revoke
-- the privilege as well, so the absence of a policy is not the only thing
-- standing between a parent session and rewritten history.
revoke update, delete on task_definition_revisions from authenticated, anon;
revoke update, delete on task_events from authenticated, anon;

-- Shape C — member_credentials. No policy, and no grant.
--
-- This is the table that cannot be protected by RLS alone: RLS filters rows,
-- not columns, and a device session must read family_members to draw the
-- profile tiles. Keeping the PIN hash in its own table with no client grant is
-- what makes "a device can never read a PIN hash" true rather than aspirational.
revoke all on member_credentials from authenticated, anon;

-- member_sessions is reached only by the SECURITY DEFINER functions that mint
-- and check actor tokens (slice 5). No client role touches it directly.
revoke all on member_sessions from authenticated, anon;
