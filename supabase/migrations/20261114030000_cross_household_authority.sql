-- Our Family Hub — close three authority defects found by independent review
-- of 20261114020000_function_grants.sql, before any of this reached a hosted
-- database.
--
-- All three were reproduced here before being accepted, and all three are
-- reachable by an ordinary signed-in parent, which is the only kind of client
-- this app has. The grant lockdown in the previous migration was necessary and
-- is unchanged; these are the checks that should have been behind it.
--
--   1. A NULL PIN AUTHENTICATED. `crypt(NULL, hash)` is NULL, so
--      `hash <> crypt(NULL, hash)` is NULL, not true, and the rejection branch
--      never ran. verify_member_pin(child, NULL, device) returned
--      {"ok": true, "token": "..."} — a live actor token for a child, with no
--      PIN at all. Measured on the seeded household.
--
--   2. verify_member_pin TOOK THE HOUSEHOLD FROM THE DEVICE ROW, not from the
--      caller. A real parent of household A, acting as themselves, probed
--      household B's child PIN (getting the attempts-left count back), and on
--      the correct PIN minted a working token in B. Measured across two
--      households.
--
--   3. revoke_device SCOPED ONE UPDATE OF TWO. The same parent of A called it
--      on B's device: B's device correctly stayed `active`, and two of B's
--      member_sessions were revoked anyway. A cross-household write.
--
--   4. app_apply_transition ANSWERED REPLAYS BEFORE AUTHORISING. The
--      task_operations lookup was the first statement in the function and was
--      keyed on the operation id alone, so any signed-in caller holding an
--      operation id from another household received its stored result.
--
-- One household exists today, so none of this was exploitable in practice.
-- That is a fact about the data, not about the code, and it stops being true
-- the first time a second household exists.

create or replace function verify_member_pin(
  p_member_id uuid,
  p_pin text,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  s app_settings%rowtype;
  cred member_credentials%rowtype;
  fm family_members%rowtype;
  dev devices%rowtype;
  v_token text;
begin
  select * into s from app_settings limit 1;

  -- A PIN must actually be supplied. NULL is not a wrong PIN, it is no PIN:
  -- crypt(NULL, hash) is NULL, so `hash <> NULL` is NULL rather than true and
  -- the rejection below was SKIPPED ENTIRELY — verify_member_pin(child, NULL,
  -- device) returned {"ok": true} with a live actor token. Measured, not
  -- theorised. Checked here as well as in the comparison, so the failure mode
  -- cannot come back by a different route.
  if p_pin is null or btrim(p_pin) = '' then
    raise exception 'a PIN is required' using errcode = 'invalid_parameter_value';
  end if;

  -- The device must belong to the CALLER's household, not merely exist.
  -- Without this clause the household came from the device row itself, so any
  -- signed-in person who knew a device id and a member id from another
  -- household could probe that child's PIN, lock them out, and on a correct
  -- guess mint an actor token in a house they have nothing to do with.
  select * into dev from devices
   where id = p_device_id and household_id = app_current_household_id();
  if not found or dev.status <> 'active' then
    -- A revoked device, an unknown device and another household's device are
    -- deliberately indistinguishable: the error says nothing a prober can use.
    raise exception 'this device is not enrolled' using errcode = 'insufficient_privilege';
  end if;

  select * into fm from family_members
   where id = p_member_id and household_id = dev.household_id and is_active;
  if not found then
    raise exception 'no such family member on this device'
      using errcode = 'no_data_found';
  end if;

  select * into cred from member_credentials where member_id = p_member_id for update;
  if not found then
    raise exception 'no PIN has been set for this profile yet'
      using errcode = 'no_data_found';
  end if;

  if cred.locked_until is not null and cred.locked_until > now() then
    return jsonb_build_object(
      'ok', false, 'reason', 'locked', 'locked_until', cred.locked_until
    );
  end if;

  if cred.pin_hash is distinct from crypt(p_pin, cred.pin_hash) then
    update member_credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = case
             when failed_attempts + 1 >= s.pin_max_failures
               then now() + make_interval(mins => s.pin_lockout_minutes)
             else null end,
           updated_at = now()
     where member_id = p_member_id;
    -- Committed, not rolled back: this is the counter the lockout depends on.
    select * into cred from member_credentials where member_id = p_member_id;
    return jsonb_build_object(
      'ok', false,
      'reason', 'wrong_pin',
      'attempts_left', greatest(s.pin_max_failures - cred.failed_attempts, 0),
      'locked_until', cred.locked_until
    );
  end if;

  -- A good PIN clears the counter, so a child who mistypes twice and then
  -- gets it right is not one slip away from a lockout all morning.
  update member_credentials
     set failed_attempts = 0, locked_until = null, updated_at = now()
   where member_id = p_member_id;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into member_sessions (
    household_id, member_id, device_id, token_digest, expires_at
  )
  values (
    dev.household_id, p_member_id, p_device_id,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + make_interval(hours => s.actor_max_lifetime_hours)
  );

  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

create or replace function revoke_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not app_is_parent() then
    raise exception 'only a parent can remove a device'
      using errcode = 'insufficient_privilege';
  end if;
  -- Establish ownership FIRST and refuse outright, rather than running two
  -- updates and hoping each filters correctly. The previous version scoped the
  -- device update by household but not the session update, so a parent of one
  -- household could sign every profile out of another household's iPad —
  -- their device stayed active while their children were all logged out.
  if not exists (
    select 1 from devices
     where id = p_device_id and household_id = app_current_household_id()
  ) then
    raise exception 'this device is not enrolled' using errcode = 'insufficient_privilege';
  end if;

  update devices
     set status = 'revoked', revoked_at = now()
   where id = p_device_id and household_id = app_current_household_id();

  -- Sign out everyone who was using it. Leaving their tokens alive would mean
  -- a removed iPad still had working identities on it until they timed out.
  update member_sessions set revoked_at = now()
   where device_id = p_device_id and revoked_at is null
     and household_id = app_current_household_id();
end;
$$;

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

  -- Replay is answered only AFTER the caller has been established and the
  -- task confirmed to be theirs. It used to be the very first thing the
  -- function did, which meant anyone signed in who knew an operation id —
  -- from any household — got back that operation's stored result: the task,
  -- its state, who completed it and when. Authorisation has to come first,
  -- and the lookup is scoped to this household and this task as well, so a
  -- recycled id cannot answer for a different row.
  if p_operation_id is not null then
    select result into v_prior from task_operations
     where operation_id = p_operation_id
       and household_id = v_inst.household_id
       and task_instance_id = v_inst.id;
    if found then
      return v_prior || jsonb_build_object('outcome', 'replayed');
    end if;
    -- The id exists, but against a different task or household. Say so,
    -- rather than falling through to an insert that trips the primary key and
    -- reports `23505` with no explanation. This is a client bug — operation
    -- ids are per operation — and it should read like one.
    if exists (select 1 from task_operations where operation_id = p_operation_id) then
      raise exception 'that operation id was already used for a different task'
        using errcode = 'unique_violation';
    end if;
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
