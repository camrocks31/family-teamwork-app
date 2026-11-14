-- Our Family Hub — create and edit a task from the app, in one transaction.
--
-- Editing a task is not a row update. The brief requires that changing a task
-- never rewrites history, so an edit writes a NEW immutable revision and
-- points the definition at it; every dated instance keeps the revision it was
-- created under, and yesterday's "tidy the bedroom" still means what it meant
-- yesterday.
--
-- That is three writes across three tables — a revision, its criteria, and
-- the definition's pointer — and row level security would happily let a
-- browser do them one at a time. Then a dropped connection between the second
-- and the third leaves a definition pointing at the old revision with a new
-- one orphaned beside it, or criteria belonging to a revision nothing uses.
-- So it is one SECURITY DEFINER function instead: all of it, or none of it.
--
-- Parent-only, enforced here rather than in the interface, and scoped to the
-- caller's household at every step — the ids a caller hands in are checked,
-- never trusted.

create or replace function save_task(
  p_definition_id uuid,
  p_title text,
  p_criteria text[],
  p_space_id uuid default null,
  p_pet_id uuid default null,
  p_occurrence_mode occurrence_mode default 'shared',
  p_recurrence recurrence_kind default 'daily',
  p_one_off_date date default null,
  p_details text default null,
  p_requires_approval boolean default false,
  p_photo_required boolean default false,
  p_not_needed_permitted boolean default false,
  p_subject_member_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_definition uuid;
  v_revision uuid;
  v_next_number integer;
  v_member uuid;
  v_text text;
  v_order integer := 0;
begin
  if not app_is_parent() then
    raise exception 'only a parent can change tasks'
      using errcode = 'insufficient_privilege';
  end if;
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'a task needs a name' using errcode = 'invalid_parameter_value';
  end if;
  -- The brief is explicit that an opaque "clean the house" checkbox is the
  -- thing this app must not be, so a task without criteria is refused here
  -- rather than quietly allowed and discovered on a wall-mounted iPad.
  if p_criteria is null or array_length(p_criteria, 1) is null then
    raise exception 'a task needs at least one thing to check off'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_space_id is not null and p_pet_id is not null then
    raise exception 'a task belongs to a room or to a pet, not both'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_recurrence = 'one_off' and p_one_off_date is null then
    raise exception 'a one-off task needs a date' using errcode = 'invalid_parameter_value';
  end if;

  -- Every id handed in must belong to this household.
  if p_space_id is not null and not exists (
    select 1 from household_spaces where id = p_space_id and household_id = v_household
  ) then
    raise exception 'no such room in your household' using errcode = 'no_data_found';
  end if;
  if p_pet_id is not null and not exists (
    select 1 from pets where id = p_pet_id and household_id = v_household
  ) then
    raise exception 'no such pet in your household' using errcode = 'no_data_found';
  end if;

  if p_definition_id is null then
    insert into task_definitions (
      household_id, location_space_id, pet_id, occurrence_mode
    )
    values (v_household, p_space_id, p_pet_id, p_occurrence_mode)
    returning id into v_definition;
  else
    update task_definitions
       set location_space_id = p_space_id,
           pet_id = p_pet_id,
           occurrence_mode = p_occurrence_mode
     where id = p_definition_id and household_id = v_household
    returning id into v_definition;
    if v_definition is null then
      raise exception 'no such task in your household' using errcode = 'no_data_found';
    end if;
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next_number
    from task_definition_revisions where definition_id = v_definition;

  insert into task_definition_revisions (
    definition_id, household_id, revision_number, title, details,
    recurrence, one_off_date, requires_approval, photo_required,
    not_needed_permitted, occurrence_mode
  )
  values (
    v_definition, v_household, v_next_number, btrim(p_title), p_details,
    p_recurrence, p_one_off_date, p_requires_approval, p_photo_required,
    p_not_needed_permitted, p_occurrence_mode
  )
  returning id into v_revision;

  foreach v_text in array p_criteria loop
    if btrim(v_text) <> '' then
      v_order := v_order + 1;
      insert into task_definition_criteria (revision_id, household_id, display_order, text)
      values (v_revision, v_household, v_order, btrim(v_text));
    end if;
  end loop;
  if v_order = 0 then
    raise exception 'a task needs at least one thing to check off'
      using errcode = 'invalid_parameter_value';
  end if;

  update task_definitions
     set current_revision_id = v_revision
   where id = v_definition;

  -- Who it is for. Replaced wholesale rather than merged: the caller sends
  -- the list it wants, and a half-applied assignment change is the kind of
  -- thing nobody notices until a child's task stops appearing.
  if p_subject_member_ids is not null then
    delete from task_assignments where definition_id = v_definition;
    foreach v_member in array p_subject_member_ids loop
      if not exists (
        select 1 from family_members
         where id = v_member and household_id = v_household and is_active
      ) then
        raise exception 'no such family member in your household'
          using errcode = 'no_data_found';
      end if;
      insert into task_assignments (definition_id, member_id, household_id)
      values (v_definition, v_member, v_household);
    end loop;
  end if;

  return v_definition;
end;
$$;

revoke all on function save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[]) from public, anon, authenticated;
grant execute on function save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[]) to authenticated;


-- Retire a task without destroying what it has already recorded.
--
-- Deleting the definition would cascade to its instances and take the
-- household's history with it, so a task that is no longer wanted is simply
-- stopped. Tomorrow it is not created; yesterday still happened.
create or replace function set_task_active(p_definition_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not app_is_parent() then
    raise exception 'only a parent can change tasks'
      using errcode = 'insufficient_privilege';
  end if;
  update task_definitions
     set is_active = p_active
   where id = p_definition_id and household_id = app_current_household_id();
  if not found then
    raise exception 'no such task in your household' using errcode = 'no_data_found';
  end if;
end;
$$;

revoke all on function set_task_active(uuid, boolean) from public, anon, authenticated;
grant execute on function set_task_active(uuid, boolean) to authenticated;
