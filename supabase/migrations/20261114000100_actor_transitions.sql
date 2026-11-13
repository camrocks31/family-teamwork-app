-- Our Family Hub — slice 5: letting a child act, without the iPad becoming an
-- authority.
--
-- The transition functions gain one optional argument. Slice 2's callers keep
-- working unchanged; a device passes its actor token and the acting member is
-- resolved from that instead of from the session.
--
-- The rule that matters is four lines down in app_apply_transition: when an
-- actor token is used, is_parent is FALSE, unconditionally. A parent's own PIN
-- on the family iPad does not make that iPad a parent. Without this, "selecting
-- Dad's avatar grants nothing" would be a sentence in a document rather than a
-- property of the system.

-- The old signatures go first, so no overload can be resolved by accident.
drop function if exists start_task_instance(uuid, uuid, integer);
drop function if exists submit_task_instance(uuid, uuid, integer);
drop function if exists complete_task_instance(uuid, uuid, integer);
drop function if exists approve_task_instance(uuid, uuid, integer);
drop function if exists return_task_instance(uuid, text, uuid, integer);
drop function if exists exempt_task_instance(uuid, text, uuid, integer);
drop function if exists mark_task_not_needed(uuid, uuid, integer);
drop function if exists app_apply_transition(uuid, text, uuid, integer, text);

create or replace function app_apply_transition(
  p_instance_id uuid,
  p_operation text,
  p_operation_id uuid,
  p_expected_version integer,
  p_note text default null,
  p_actor_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_actor_is_parent boolean;
  v_inst task_instances%rowtype;
  v_rev task_definition_revisions%rowtype;
  v_prior jsonb;
  v_target task_state;
  v_from_state task_state;
  v_reason not_applicable_reason;
  v_completed_by uuid;
  v_may_work boolean;
  v_has_photo boolean;
  v_result jsonb;
begin
  if p_operation_id is not null then
    select result into v_prior from task_operations where operation_id = p_operation_id;
    if found then
      return v_prior || jsonb_build_object('outcome', 'replayed');
    end if;
  end if;

  select target, reason into v_target, v_reason from app_transition_target(p_operation);
  if v_target is null then
    raise exception 'unknown operation %', p_operation
      using errcode = 'invalid_parameter_value';
  end if;

  -- Who is acting, and with what authority.
  v_actor := app_resolve_actor(p_actor_token);
  if v_actor is not null then
    -- An actor token NEVER confers parent authority — not even one minted
    -- from a parent's own PIN. Parent authority comes from a parent's own
    -- authenticated session and nowhere else.
    v_actor_is_parent := false;
  else
    v_actor := app_current_member_id();
    v_actor_is_parent := app_is_parent();
  end if;

  if v_actor is null then
    raise exception 'no acting family member for this session'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_inst from task_instances where id = p_instance_id for update;
  if not found then
    raise exception 'no such task' using errcode = 'no_data_found';
  end if;
  if v_inst.household_id is distinct from app_current_household_id() then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;
  -- The acting member must belong to the same household as the task. A token
  -- from elsewhere cannot reach in, even on an enrolled device.
  if not exists (
    select 1 from family_members
     where id = v_actor and household_id = v_inst.household_id and is_active
  ) then
    raise exception 'that profile is not part of this household'
      using errcode = 'insufficient_privilege';
  end if;

  if p_expected_version is not null and p_expected_version <> v_inst.version then
    if v_inst.state = v_target
       and v_inst.not_applicable_reason is not distinct from v_reason then
      return jsonb_build_object(
        'instance_id', v_inst.id, 'state', v_inst.state,
        'completed_by', v_inst.completed_by, 'completed_at', v_inst.completed_at,
        'version', v_inst.version, 'outcome', 'already_satisfied'
      );
    end if;
    raise exception 'this task changed while you were working on it (expected version %, now %)',
      p_expected_version, v_inst.version
      using errcode = 'serialization_failure';
  end if;

  select * into v_rev from task_definition_revisions where id = v_inst.definition_revision_id;

  v_may_work := v_actor_is_parent
    or (v_inst.occurrence_mode = 'shared')
    or (v_inst.subject_member_id = v_actor);

  case p_operation
    when 'start' then
      if not v_may_work then
        raise exception 'this is not your task' using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state not in ('pending', 'needs_attention') then
        raise exception 'cannot start a task that is %', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;

    when 'submit' then
      if not v_may_work then
        raise exception 'this is not your task' using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state not in ('pending', 'in_progress', 'needs_attention') then
        raise exception 'cannot submit a task that is %', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;

    when 'complete' then
      if not v_may_work then
        raise exception 'this is not your task' using errcode = 'insufficient_privilege';
      end if;
      if v_rev.requires_approval and not v_actor_is_parent then
        raise exception 'this task needs a parent to check it: submit it instead'
          using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state not in ('pending', 'in_progress', 'needs_attention') then
        raise exception 'cannot complete a task that is %', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;
      v_completed_by := v_actor;

    when 'approve' then
      if not v_actor_is_parent then
        raise exception 'only a parent can approve a task'
          using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state <> 'submitted' then
        raise exception 'cannot approve a task that is %', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;
      v_completed_by := coalesce(v_inst.submitted_by, v_inst.subject_member_id);

    when 'return' then
      if not v_actor_is_parent then
        raise exception 'only a parent can send a task back'
          using errcode = 'insufficient_privilege';
      end if;

    when 'exempt' then
      if not v_actor_is_parent then
        raise exception 'only a parent can excuse a task'
          using errcode = 'insufficient_privilege';
      end if;

    when 'not_needed' then
      if not v_may_work then
        raise exception 'this is not your task' using errcode = 'insufficient_privilege';
      end if;
      if not v_rev.not_needed_permitted then
        raise exception 'this task cannot be marked as not needed'
          using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state not in ('pending', 'in_progress') then
        raise exception 'cannot mark a task that is % as not needed', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;
  end case;

  if v_rev.photo_required and v_target in ('submitted', 'completed') then
    select exists (select 1 from task_photos where task_instance_id = v_inst.id)
      into v_has_photo;
    if not v_has_photo then
      raise exception 'this task needs a photo before it can be handed in'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_from_state := v_inst.state;

  update task_instances
     set state = v_target,
         version = version + 1,
         updated_at = now(),
         submitted_by = case when v_target = 'submitted' then v_actor else submitted_by end,
         submitted_at = case when v_target = 'submitted' then now() else submitted_at end,
         completed_by = case when v_target = 'completed' then v_completed_by else null end,
         completed_at = case when v_target = 'completed' then now() else null end,
         not_applicable_reason = case when v_target = 'not_applicable' then v_reason else null end,
         not_applicable_by     = case when v_target = 'not_applicable' then v_actor else null end,
         not_applicable_at     = case when v_target = 'not_applicable' then now() else null end,
         exemption_note = case when v_reason = 'parent_exemption' then p_note else null end,
         correction_note = case
                             when v_target = 'needs_attention' then p_note
                             when v_target in ('completed', 'not_applicable') then null
                             else correction_note
                           end
   where id = v_inst.id
   returning * into v_inst;

  insert into task_events (
    household_id, task_instance_id, actor_member_id, from_state, to_state, note
  )
  values (v_inst.household_id, v_inst.id, v_actor, v_from_state, v_target, p_note);

  v_result := jsonb_build_object(
    'instance_id', v_inst.id, 'state', v_inst.state,
    'completed_by', v_inst.completed_by, 'completed_at', v_inst.completed_at,
    'version', v_inst.version, 'outcome', 'applied'
  );

  if p_operation_id is not null then
    insert into task_operations (
      operation_id, household_id, task_instance_id, actor_member_id, operation, result
    )
    values (p_operation_id, v_inst.household_id, v_inst.id, v_actor, p_operation, v_result);
  end if;

  return v_result;
end;
$$;

-- From the client roles by name: `revoke ... from public` alone does not
-- remove Supabase's default grants to anon and authenticated, which would
-- leave this internal entry point callable with an arbitrary operation name.
revoke all on function app_apply_transition(uuid, text, uuid, integer, text, text)
  from public, anon, authenticated;

-- Public entry points, each with the optional actor token last so slice 2's
-- callers are unaffected.
create or replace function start_task_instance(
  p_instance_id uuid, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'start', p_operation_id, p_expected_version, null, p_actor_token);
$$;

create or replace function submit_task_instance(
  p_instance_id uuid, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'submit', p_operation_id, p_expected_version, null, p_actor_token);
$$;

create or replace function complete_task_instance(
  p_instance_id uuid, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'complete', p_operation_id, p_expected_version, null, p_actor_token);
$$;

create or replace function approve_task_instance(
  p_instance_id uuid, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'approve', p_operation_id, p_expected_version, null, p_actor_token);
$$;

create or replace function return_task_instance(
  p_instance_id uuid, p_note text, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'return', p_operation_id, p_expected_version, p_note, p_actor_token);
$$;

create or replace function exempt_task_instance(
  p_instance_id uuid, p_note text, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'exempt', p_operation_id, p_expected_version, p_note, p_actor_token);
$$;

create or replace function mark_task_not_needed(
  p_instance_id uuid, p_operation_id uuid default null,
  p_expected_version integer default null, p_actor_token text default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'not_needed', p_operation_id, p_expected_version, null, p_actor_token);
$$;

-- Shopping, which a child on a device may also do (parent requirement 15).
-- Attribution is server-derived here for the same reason it is for tasks.
create or replace function add_shopping_item(
  p_list_kind shopping_list_kind,
  p_name text,
  p_category text default null,
  p_quantity integer default null,
  p_notes text default null,
  p_actor_token text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_household uuid;
  v_id uuid;
begin
  v_actor := app_resolve_actor(p_actor_token);
  if v_actor is null then
    v_actor := app_current_member_id();
  end if;
  if v_actor is null then
    raise exception 'no acting family member for this session'
      using errcode = 'insufficient_privilege';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'an item needs a name' using errcode = 'invalid_parameter_value';
  end if;

  select household_id into v_household from family_members where id = v_actor;
  if v_household is distinct from app_current_household_id() then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  insert into shopping_items (household_id, list_kind, name, category, quantity, notes, created_by)
  values (v_household, p_list_kind, trim(p_name), p_category, p_quantity, p_notes, v_actor)
  returning id into v_id;

  return v_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'start_task_instance(uuid, uuid, integer, text)',
    'submit_task_instance(uuid, uuid, integer, text)',
    'complete_task_instance(uuid, uuid, integer, text)',
    'approve_task_instance(uuid, uuid, integer, text)',
    'return_task_instance(uuid, text, uuid, integer, text)',
    'exempt_task_instance(uuid, text, uuid, integer, text)',
    'mark_task_not_needed(uuid, uuid, integer, text)',
    'add_shopping_item(shopping_list_kind, text, text, integer, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
