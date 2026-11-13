-- Our Family Hub — slice 2: state transitions.
--
-- One internal function does the work; the public functions are thin wrappers
-- over it. That is deliberate: HAL-1538 I3 requires a single validation owner,
-- and six near-identical copies of "lock the row, check authority, check the
-- version, write the event" is exactly how those six drift apart.

-- ---------------------------------------------------------------------------
-- Where each operation is trying to get to
-- ---------------------------------------------------------------------------
--
-- Split out from the authority checks on purpose. The order matters: the loser
-- of a completion race must be told "already done" rather than "you cannot
-- complete a completed task", and that can only be decided once we know the
-- target state but BEFORE we judge whether the transition is legal from here.
create or replace function app_transition_target(p_operation text)
returns table (target task_state, reason not_applicable_reason)
language sql
immutable
as $$
  select t.target, t.reason from (values
    ('start',      'in_progress'::task_state,    null::not_applicable_reason),
    ('submit',     'submitted',                  null),
    ('complete',   'completed',                  null),
    ('approve',    'completed',                  null),
    ('return',     'needs_attention',            null),
    ('exempt',     'not_applicable',             'parent_exemption'),
    ('not_needed', 'not_applicable',             'not_needed')
  ) as t(op, target, reason)
  where t.op = p_operation;
$$;

-- ---------------------------------------------------------------------------
-- The core transition
-- ---------------------------------------------------------------------------
create or replace function app_apply_transition(
  p_instance_id uuid,
  p_operation text,
  p_operation_id uuid,
  p_expected_version integer,
  p_note text default null
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
  -- Case 1 of HAL-1538 requirement 10: a replayed operation id returns its
  -- recorded result and touches nothing. Checked before the row is even
  -- locked, so a retry storm cannot serialise behind work it will not do.
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

  v_actor := app_current_member_id();
  if v_actor is null then
    raise exception 'no acting family member for this session'
      using errcode = 'insufficient_privilege';
  end if;
  v_actor_is_parent := app_is_parent();

  -- Lock the instance. Two callers racing the same task meet here, and the
  -- loser reads the winner's committed row rather than the stale one.
  select * into v_inst from task_instances where id = p_instance_id for update;
  if not found then
    raise exception 'no such task' using errcode = 'no_data_found';
  end if;
  if v_inst.household_id is distinct from app_current_household_id() then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  -- Cases 2 and 3 of requirement 10, decided before any legality check.
  -- A stale version is only a conflict when applying would move the task
  -- somewhere other than where it already is. The loser of a completion race
  -- wants exactly the state the winner produced, so it succeeds and receives
  -- the winner's result — neither child sees an error for tapping at the same
  -- moment as a sibling. A retry arriving after a parent has sent the task
  -- back wants a different state, so it is refused.
  if p_expected_version is not null and p_expected_version <> v_inst.version then
    if v_inst.state = v_target
       and v_inst.not_applicable_reason is not distinct from v_reason then
      return jsonb_build_object(
        'instance_id', v_inst.id,
        'state', v_inst.state,
        'completed_by', v_inst.completed_by,
        'completed_at', v_inst.completed_at,
        'version', v_inst.version,
        'outcome', 'already_satisfied'
      );
    end if;
    raise exception 'this task changed while you were working on it (expected version %, now %)',
      p_expected_version, v_inst.version
      using errcode = 'serialization_failure';
  end if;

  select * into v_rev from task_definition_revisions where id = v_inst.definition_revision_id;

  -- Who may work on this at all. A parent's own session is sufficient
  -- authority for any task (HAL-1538 requirement 17); otherwise a shared task
  -- is open to any active member and a per-member task only to its subject.
  v_may_work := v_actor_is_parent
    or (v_inst.occurrence_mode = 'shared')
    or (v_inst.subject_member_id = v_actor);

  -- Authority, then legality, per operation.
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
      -- A child cannot shortcut review. Where the pinned revision requires
      -- approval, the only route to completed is submit then a parent's
      -- approve (HAL-1538 requirement 7).
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
      -- The child who did the work keeps the credit. The approving parent is
      -- recorded on the event only — otherwise reviewing a task would quietly
      -- transfer it to the reviewer.
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
      -- "Not Needed" is not a universal escape hatch: without this check a
      -- child could clear every blocker and walk straight to Ready.
      if not v_rev.not_needed_permitted then
        raise exception 'this task cannot be marked as not needed'
          using errcode = 'insufficient_privilege';
      end if;
      if v_inst.state not in ('pending', 'in_progress') then
        raise exception 'cannot mark a task that is % as not needed', v_inst.state
          using errcode = 'invalid_parameter_value';
      end if;
  end case;

  -- A required photo must actually exist. Enforced on both submit and
  -- complete: those are the two ways a child says "this is done", and a policy
  -- that only bit on one of them would be half a policy.
  if v_rev.photo_required and v_target in ('submitted', 'completed') then
    select exists (select 1 from task_photos where task_instance_id = v_inst.id)
      into v_has_photo;
    if not v_has_photo then
      raise exception 'this task needs a photo before it can be handed in'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Captured before the UPDATE overwrites v_inst: the audit row records where
  -- the task came from, and reading it afterwards would record where it went.
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

  -- Exactly one audit row per state change, in the same transaction, so the
  -- history can never disagree with the state.
  insert into task_events (
    household_id, task_instance_id, actor_member_id, from_state, to_state, note
  )
  values (
    v_inst.household_id, v_inst.id, v_actor, v_from_state, v_target, p_note
  );

  v_result := jsonb_build_object(
    'instance_id', v_inst.id,
    'state', v_inst.state,
    'completed_by', v_inst.completed_by,
    'completed_at', v_inst.completed_at,
    'version', v_inst.version,
    'outcome', 'applied'
  );

  if p_operation_id is not null then
    insert into task_operations (
      operation_id, household_id, task_instance_id, actor_member_id, operation, result
    )
    values (
      p_operation_id, v_inst.household_id, v_inst.id, v_actor, p_operation, v_result
    );
  end if;

  return v_result;
end;
$$;

revoke all on function app_apply_transition(uuid, text, uuid, integer, text) from public;
-- Not granted to any client role: the public wrappers below are the entry
-- points, so a caller cannot invent an operation name.

-- ---------------------------------------------------------------------------
-- Public entry points
-- ---------------------------------------------------------------------------
--
-- One per operation, so the operation name is chosen by the schema rather than
-- by the caller, and so each can be granted (or later withheld) on its own.
-- Every one takes the operation id and expected version that make retries safe.

create or replace function start_task_instance(
  p_instance_id uuid, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'start', p_operation_id, p_expected_version, null);
$$;

create or replace function submit_task_instance(
  p_instance_id uuid, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'submit', p_operation_id, p_expected_version, null);
$$;

create or replace function complete_task_instance(
  p_instance_id uuid, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'complete', p_operation_id, p_expected_version, null);
$$;

create or replace function approve_task_instance(
  p_instance_id uuid, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'approve', p_operation_id, p_expected_version, null);
$$;

create or replace function return_task_instance(
  p_instance_id uuid, p_note text, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'return', p_operation_id, p_expected_version, p_note);
$$;

create or replace function exempt_task_instance(
  p_instance_id uuid, p_note text, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'exempt', p_operation_id, p_expected_version, p_note);
$$;

create or replace function mark_task_not_needed(
  p_instance_id uuid, p_operation_id uuid default null, p_expected_version integer default null
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app_apply_transition(p_instance_id, 'not_needed', p_operation_id, p_expected_version, null);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'start_task_instance(uuid, uuid, integer)',
    'submit_task_instance(uuid, uuid, integer)',
    'complete_task_instance(uuid, uuid, integer)',
    'approve_task_instance(uuid, uuid, integer)',
    'return_task_instance(uuid, text, uuid, integer)',
    'exempt_task_instance(uuid, text, uuid, integer)',
    'mark_task_not_needed(uuid, uuid, integer)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
