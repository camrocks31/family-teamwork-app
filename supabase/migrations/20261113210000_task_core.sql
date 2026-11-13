-- Our Family Hub — slice 2: making tasks move.
--
-- Everything that changes a task's state lives here, as SECURITY DEFINER
-- functions. The client never writes task_instances directly: with no
-- application server (HAL-1538 §2.4) these functions ARE the server, so each
-- one re-derives the acting member from the session rather than trusting a
-- caller-supplied id, checks authority itself, and writes its audit row inside
-- the same transaction as the state change.

-- ---------------------------------------------------------------------------
-- Who is acting
-- ---------------------------------------------------------------------------

-- The family member behind the current session. Attribution is derived here,
-- never passed in: a caller that could name its own actor could credit work to
-- a sibling, which is exactly what requirement 6 exists to prevent.
create or replace function app_current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select fm.id
    from family_members fm
   where fm.auth_user_id = auth.uid()
     and fm.is_active
   limit 1;
$$;

revoke all on function app_current_member_id() from public;
grant execute on function app_current_member_id() to authenticated;

-- Today, in the household's own timezone. Day boundaries are a household fact,
-- not a server fact: a task completed at 11pm in Vancouver belongs to that day
-- wherever the database happens to run.
create or replace function app_household_today(p_household_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
begin
  select timezone into v_timezone from households where id = p_household_id;
  if v_timezone is null then
    -- HAL-1538 §3.1 Absent: refuse rather than fall back to UTC. A silent
    -- wrong day would move work between dates without anyone noticing.
    raise exception 'household % has no timezone configured', p_household_id
      using errcode = 'invalid_parameter_value';
  end if;
  return (now() at time zone v_timezone)::date;
end;
$$;

revoke all on function app_household_today(uuid) from public;
grant execute on function app_household_today(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The replay ledger
-- ---------------------------------------------------------------------------

-- HAL-1538 requirement 10, case 1: "a request repeating an operation id already
-- recorded returns that operation's stored result and touches nothing."
-- Storing the result, not just the id, is what lets a retry answer identically
-- instead of guessing.
create table task_operations (
  operation_id uuid primary key,
  household_id uuid not null references households (id) on delete restrict,
  task_instance_id uuid not null references task_instances (id) on delete cascade,
  actor_member_id uuid references family_members (id) on delete set null,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),

  foreign key (task_instance_id, household_id) references task_instances (id, household_id)
);

create index task_operations_instance_idx on task_operations (task_instance_id);

alter table task_operations enable row level security;

create policy task_operations_select on task_operations
  for select to authenticated
  using (household_id = app_current_household_id());

-- Only the transition functions write here. A client that could forge a ledger
-- row could make a later real operation look like a replay and be ignored.
revoke insert, update, delete on task_operations from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Materializing a day
-- ---------------------------------------------------------------------------

-- HAL-1538 requirement 9. Idempotent, safe under concurrent callers, and
-- careful about which day it is.
create or replace function ensure_day_materialized(
  p_household_id uuid,
  p_local_date date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date;
  v_created integer := 0;
  v_rows integer;
begin
  if app_current_household_id() is distinct from p_household_id then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  v_today := app_household_today(p_household_id);

  -- HAL-1538 §3.1 Out of range. Tomorrow is allowed so a device crossing
  -- midnight can prepare the next day; anything further is a caller bug or a
  -- wrong clock, and silently creating it would scatter instances into the
  -- future where nobody looks.
  if p_local_date > v_today + 1 then
    raise exception 'cannot materialize % — more than one day ahead of % in this household',
      p_local_date, v_today
      using errcode = 'invalid_parameter_value';
  end if;

  -- One statement per grain, so every row in a grain sees the same
  -- configuration: a settings change cannot take effect halfway through.
  -- current_revision_id is read here and pinned onto the instance, which is
  -- what stops a later policy edit re-judging this day's work.
  insert into task_instances (
    household_id, definition_id, definition_revision_id,
    occurrence_mode, occurrence_date, subject_member_id, state
  )
  select td.household_id, td.id, td.current_revision_id,
         'shared', p_local_date, null, 'pending'
    from task_definitions td
   where td.household_id = p_household_id
     and td.is_active
     and td.occurrence_mode = 'shared'
     and td.current_revision_id is not null
  on conflict do nothing;

  get diagnostics v_rows = row_count;
  v_created := v_created + v_rows;

  insert into task_instances (
    household_id, definition_id, definition_revision_id,
    occurrence_mode, occurrence_date, subject_member_id, state
  )
  select td.household_id, td.id, td.current_revision_id,
         'per_member', p_local_date, ta.member_id, 'pending'
    from task_definitions td
    join task_assignments ta on ta.definition_id = td.id
    join family_members fm on fm.id = ta.member_id and fm.is_active
   where td.household_id = p_household_id
     and td.is_active
     and td.occurrence_mode = 'per_member'
     and td.current_revision_id is not null
  on conflict do nothing;

  get diagnostics v_rows = row_count;
  v_created := v_created + v_rows;

  return v_created;
end;
$$;

revoke all on function ensure_day_materialized(uuid, date) from public;
grant execute on function ensure_day_materialized(uuid, date) to authenticated;
