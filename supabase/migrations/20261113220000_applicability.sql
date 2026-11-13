-- Our Family Hub — slice 3: does this task count right now?
--
-- HAL-1538 requirement 9 makes applicability a call-time question with exactly
-- one owner. Nothing writes a row to record that a task did not apply today:
-- a holiday added at 07:30 has to take effect at 07:30, and a stored answer
-- would still be saying "school day" until something rewrote it.

-- ---------------------------------------------------------------------------
-- Is it a school day?
-- ---------------------------------------------------------------------------
--
-- Precedence, from parent requirement 5, strongest first:
--
--   1. A HOUSEHOLD holiday or closure override. "A household holiday or
--      closure override outranks any school-day rule", so this wins outright —
--      including over a member's own weekly rule. A Pro-D day is a Pro-D day
--      even for the child whose schedule says Tuesdays are school days.
--   2. A member-specific date override.
--   3. A household date override saying it IS a school day.
--   4. A member-specific weekly rule.
--   5. The household weekly rule.
--   6. No rule at all: not a school day. Silence means no obligation.
create or replace function app_is_school_day(
  p_household_id uuid,
  p_member_id uuid,
  p_local_date date
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_dow smallint := extract(isodow from p_local_date);
  v_answer boolean;
begin
  -- 1. A household closure suppresses everything.
  select is_school_day into v_answer
    from schedule_rules
   where household_id = p_household_id
     and member_id is null
     and rule_kind = 'date_override'
     and override_date = p_local_date;
  if found and v_answer = false then
    return false;
  end if;

  -- 2. This member's own override for the date.
  select is_school_day into v_answer
    from schedule_rules
   where household_id = p_household_id
     and member_id = p_member_id
     and rule_kind = 'date_override'
     and override_date = p_local_date;
  if found then
    return v_answer;
  end if;

  -- 3. A household override for the date (only "yes" can reach here).
  select is_school_day into v_answer
    from schedule_rules
   where household_id = p_household_id
     and member_id is null
     and rule_kind = 'date_override'
     and override_date = p_local_date;
  if found then
    return v_answer;
  end if;

  -- 4. This member's weekly schedule.
  select is_school_day into v_answer
    from schedule_rules
   where household_id = p_household_id
     and member_id = p_member_id
     and rule_kind = 'weekly'
     and day_of_week = v_dow;
  if found then
    return v_answer;
  end if;

  -- 5. The household weekly schedule.
  select is_school_day into v_answer
    from schedule_rules
   where household_id = p_household_id
     and member_id is null
     and rule_kind = 'weekly'
     and day_of_week = v_dow;
  if found then
    return v_answer;
  end if;

  -- 6. Nothing configured.
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Is it still the morning?
-- ---------------------------------------------------------------------------
--
-- Start-inclusive, end-exclusive, in the household's own timezone. 06:30 is
-- inside the window and 08:30 is not, so a task does not briefly count twice
-- at the boundary.
--
-- A household with no window configured is never inside one. Treating "not
-- configured" as "always" would make lunch block television on a Sunday
-- afternoon, which is exactly the pressure the brief forbids.
create or replace function app_in_morning_window(
  p_household_id uuid,
  p_moment timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h households%rowtype;
  v_local time;
begin
  select * into h from households where id = p_household_id;
  if not found then
    raise exception 'no such household %', p_household_id
      using errcode = 'no_data_found';
  end if;
  if h.morning_window_start is null or h.morning_window_end is null then
    return false;
  end if;

  v_local := (p_moment at time zone h.timezone)::time;
  return v_local >= h.morning_window_start and v_local < h.morning_window_end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Applicability
-- ---------------------------------------------------------------------------

-- The shared rule, taking the recurrence facts directly so both entry points
-- below answer identically. Two copies of this would be two answers.
create or replace function app_recurrence_applies_at(
  p_household_id uuid,
  p_member_id uuid,
  p_recurrence recurrence_kind,
  p_one_off_date date,
  p_moment timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_date date;
  v_timezone text;
begin
  select timezone into v_timezone from households where id = p_household_id;
  if v_timezone is null then
    raise exception 'household % has no timezone configured', p_household_id
      using errcode = 'invalid_parameter_value';
  end if;
  v_local_date := (p_moment at time zone v_timezone)::date;

  case p_recurrence
    when 'daily' then
      return true;
    when 'one_off' then
      return p_one_off_date = v_local_date;
    when 'school_day' then
      return app_is_school_day(p_household_id, p_member_id, v_local_date)
         and app_in_morning_window(p_household_id, p_moment);
  end case;
  return false;
end;
$$;

-- For a definition, using its current revision. Used when planning ahead.
create or replace function applicable_at(
  p_definition_id uuid,
  p_member_id uuid,
  p_moment timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  td task_definitions%rowtype;
  r task_definition_revisions%rowtype;
begin
  select * into td from task_definitions where id = p_definition_id;
  if not found then
    raise exception 'no such task definition' using errcode = 'no_data_found';
  end if;
  select * into r from task_definition_revisions where id = td.current_revision_id;
  if not found then
    return false;
  end if;
  return app_recurrence_applies_at(
    td.household_id, p_member_id, r.recurrence, r.one_off_date, p_moment
  );
end;
$$;

-- For a materialized instance, using the revision that instance PINNED.
--
-- This is the one the readiness engine reads. Answering from the definition's
-- current revision instead would let a policy edit today change whether
-- yesterday's instance ever counted — the retroactive-history problem the
-- revision column exists to prevent.
create or replace function app_instance_applies_at(
  p_instance_id uuid,
  p_moment timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ti task_instances%rowtype;
  r task_definition_revisions%rowtype;
begin
  select * into ti from task_instances where id = p_instance_id;
  if not found then
    raise exception 'no such task instance' using errcode = 'no_data_found';
  end if;
  select * into r from task_definition_revisions where id = ti.definition_revision_id;

  return app_recurrence_applies_at(
    ti.household_id,
    -- A shared instance has no subject, so household-level rules decide it.
    ti.subject_member_id,
    r.recurrence,
    r.one_off_date,
    p_moment
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'app_is_school_day(uuid, uuid, date)',
    'app_in_morning_window(uuid, timestamptz)',
    'app_recurrence_applies_at(uuid, uuid, recurrence_kind, date, timestamptz)',
    'applicable_at(uuid, uuid, timestamptz)',
    'app_instance_applies_at(uuid, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
