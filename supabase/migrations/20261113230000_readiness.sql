-- Our Family Hub — slice 4: can I play yet, and if not, what is left?
--
-- HAL-1538 I1: readiness is derived at call time from authoritative rows.
-- There is no isReady column, no cache, no trigger-maintained copy, and only
-- one implementation of these rules — this one. The client asks; it never
-- works the answer out for itself.

-- ---------------------------------------------------------------------------
-- Does one instance satisfy its requirement?
-- ---------------------------------------------------------------------------
--
-- The satisfaction rule from parent requirement 8, in exactly one place.
-- Judged against the revision the instance PINNED, so turning on "needs a
-- parent to check it" today cannot retroactively unsatisfy yesterday.
create or replace function app_instance_satisfaction(p_instance_id uuid)
returns text
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
    return 'missing';
  end if;
  select * into r from task_definition_revisions where id = ti.definition_revision_id;

  case ti.state
    when 'completed' then return 'satisfied';
    -- Both reasons satisfy: a parent's exemption and an honest "there was
    -- nothing to pick up" are equally not-outstanding work.
    when 'not_applicable' then return 'satisfied';
    when 'submitted' then
      if r.requires_approval then return 'pending_review'; else return 'satisfied'; end if;
    when 'needs_attention' then return 'returned_for_correction';
    else return 'incomplete';
  end case;
end;
$$;

-- ---------------------------------------------------------------------------
-- What does this activity require of this member, right now?
-- ---------------------------------------------------------------------------
--
-- Expansion carries HAL-1538 I2. The three cases are deliberately separate
-- UNION branches rather than one clever join: each encodes a different rule
-- about whose instance counts, and collapsing them is how one child's task
-- ends up in another child's evaluation.
create or replace function app_requirement_rows(
  p_activity_id uuid,
  p_member_id uuid,
  p_local_date date
)
returns table (
  group_id uuid,
  group_name text,
  item_id uuid,
  scope evaluation_scope,
  link_kind text,
  link_id uuid,
  link_name text,
  title text,
  instance_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A household item: the target's single shared instance. One satisfaction
  -- counts for everyone.
  select g.id, g.name, i.id, i.scope,
         'task'::text, td.id, coalesce(sp.name, r.title), r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join task_definitions td on td.id = i.target_definition_id and td.is_active
    join task_definition_revisions r on r.id = td.current_revision_id
    left join household_spaces sp on sp.id = td.location_space_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id is null
   where ar.activity_id = p_activity_id
     and i.target_kind = 'task_definition'
     and i.scope = 'household'

  union all

  -- A requester item: the evaluating member's OWN instance. Joining through
  -- task_assignments is what makes "not assigned to you" mean "does not apply
  -- to you" rather than "blocked forever on someone else's lunch".
  select g.id, g.name, i.id, i.scope,
         'task'::text, td.id, r.title, r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join task_definitions td on td.id = i.target_definition_id and td.is_active
    join task_definition_revisions r on r.id = td.current_revision_id
    join task_assignments ta on ta.definition_id = td.id and ta.member_id = p_member_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id = p_member_id
   where ar.activity_id = p_activity_id
     and i.target_kind = 'task_definition'
     and i.scope = 'requester'

  union all

  -- A space item: every SHARED definition in that room. Per-member
  -- definitions in the same room are deliberately not reached this way —
  -- they need their own requester item — so a space can never pull one
  -- child's personal task into another child's evaluation.
  select g.id, g.name, i.id, i.scope,
         'space'::text, sp.id, sp.name, r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join household_spaces sp on sp.id = i.target_space_id and sp.is_active
    join task_definitions td on td.location_space_id = sp.id
                            and td.is_active
                            and td.occurrence_mode = 'shared'
    join task_definition_revisions r on r.id = td.current_revision_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id is null
   where ar.activity_id = p_activity_id
     and i.target_kind = 'space';
$$;

-- ---------------------------------------------------------------------------
-- The answer
-- ---------------------------------------------------------------------------
create or replace function evaluate_activity_readiness(
  p_household_id uuid,
  p_member_id uuid,
  p_activity_id uuid,
  p_evaluated_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a activities%rowtype;
  v_timezone text;
  v_local_date date;
  v_local_time time;
  v_dow smallint;
  v_has_windows boolean;
  v_in_window boolean;
  v_granted boolean;
  v_row record;
  v_sat text;
  v_blocking jsonb := '[]'::jsonb;
  v_satisfied jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_exemptions jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_applicable integer := 0;
  v_status text;
  v_reason text;
begin
  -- SECURITY DEFINER bypasses RLS, so the household check cannot be left to
  -- a policy: without this, any signed-in session could read another
  -- household's readiness by guessing ids.
  if app_current_household_id() is distinct from p_household_id then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  select * into a from activities where id = p_activity_id and household_id = p_household_id;
  if not found then
    raise exception 'no such activity' using errcode = 'no_data_found';
  end if;

  select timezone into v_timezone from households where id = p_household_id;
  v_local_date := (p_evaluated_at at time zone v_timezone)::date;
  v_local_time := (p_evaluated_at at time zone v_timezone)::time;
  v_dow := extract(isodow from v_local_date);

  -- Temporarily unavailable is reported BEFORE prerequisites (parent
  -- requirement 11): "not until four o'clock" is a different answer from
  -- "tidy your room", and listing chores for a time that is not available
  -- would be misleading.
  select exists (select 1 from activity_availability_windows where activity_id = a.id)
    into v_has_windows;
  if v_has_windows then
    select exists (
      select 1 from activity_availability_windows w
       where w.activity_id = a.id
         and (w.day_of_week is null or w.day_of_week = v_dow)
         and v_local_time >= w.start_time
         and v_local_time < w.end_time
    ) into v_in_window;

    if not v_in_window then
      return jsonb_build_object(
        'status', 'temporarily_unavailable',
        'activity', jsonb_build_object('id', a.id, 'name', a.name, 'icon', a.icon),
        'member_id', p_member_id,
        'evaluated_at', p_evaluated_at,
        'local_date', v_local_date,
        'reasons', jsonb_build_array(a.name || ' is not available at this time of day.'),
        'blocking', '[]'::jsonb,
        'satisfied', '[]'::jsonb,
        'pending_reviews', '[]'::jsonb,
        'exemptions', '[]'::jsonb,
        'groups', '[]'::jsonb
      );
    end if;
  end if;

  for v_row in
    select * from app_requirement_rows(p_activity_id, p_member_id, v_local_date)
  loop
    -- A requirement that does not apply at this moment is omitted entirely,
    -- rather than reported as satisfied. On a Saturday the lunch simply is
    -- not part of the question.
    if v_row.instance_id is not null
       and not app_instance_applies_at(v_row.instance_id, p_evaluated_at) then
      continue;
    end if;

    v_applicable := v_applicable + 1;

    if v_row.instance_id is null then
      -- An instance that should exist but does not. This blocks: treating it
      -- as nothing to do would quietly grant readiness for work never created.
      v_blocking := v_blocking || jsonb_build_object(
        'reason_code', 'missing_instance',
        'reason', v_row.title || ' has no task for today yet.',
        'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
        'link_name', v_row.link_name, 'title', v_row.title,
        'group_id', v_row.group_id, 'group_name', v_row.group_name
      );
      continue;
    end if;

    v_sat := app_instance_satisfaction(v_row.instance_id);

    if v_sat = 'satisfied' then
      v_satisfied := v_satisfied || jsonb_build_object(
        'title', v_row.title, 'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
        'link_name', v_row.link_name, 'instance_id', v_row.instance_id
      );
      -- An exemption still satisfies, but the result says so out loud so the
      -- dashboard can show it was excused rather than done.
      if exists (
        select 1 from task_instances ti
         where ti.id = v_row.instance_id
           and ti.state = 'not_applicable'
           and ti.not_applicable_reason = 'parent_exemption'
      ) then
        v_exemptions := v_exemptions || jsonb_build_object(
          'title', v_row.title, 'instance_id', v_row.instance_id,
          'link_kind', v_row.link_kind, 'link_id', v_row.link_id
        );
      end if;

    elsif v_sat = 'pending_review' then
      v_pending := v_pending || jsonb_build_object(
        'title', v_row.title, 'instance_id', v_row.instance_id,
        'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
        'link_name', v_row.link_name
      );
      v_blocking := v_blocking || jsonb_build_object(
        'reason_code', 'pending_review',
        'reason', v_row.title || ' is waiting for a parent to check it.',
        'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
        'link_name', v_row.link_name, 'title', v_row.title,
        'group_id', v_row.group_id, 'group_name', v_row.group_name
      );

    else
      v_blocking := v_blocking || jsonb_build_object(
        'reason_code', v_sat,
        'reason', case
                    when v_sat = 'returned_for_correction'
                      then v_row.link_name || ' was sent back for another look.'
                    when v_row.link_kind = 'space'
                      then v_row.link_name || ' needs attention.'
                    else v_row.title || ' is not done yet.'
                  end,
        'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
        'link_name', v_row.link_name, 'title', v_row.title,
        'group_id', v_row.group_id, 'group_name', v_row.group_name
      );
    end if;
  end loop;

  select coalesce(jsonb_agg(distinct jsonb_build_object('id', g.id, 'name', g.name)), '[]'::jsonb)
    into v_groups
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
   where ar.activity_id = p_activity_id;

  if jsonb_array_length(v_blocking) > 0 then
    v_status := 'not_ready';
    v_reason := null;
  else
    -- Readiness and permission stay distinct (parent requirement 11).
    -- Satisfying prerequisites never by itself yields approved.
    v_status := 'ready_to_ask';
    if a.requires_parent_approval then
      select exists (
        select 1 from activity_grants ag
         where ag.activity_id = a.id
           and ag.member_id = p_member_id
           and ag.valid_from <= p_evaluated_at
           and (ag.valid_until is null or ag.valid_until > p_evaluated_at)
      ) into v_granted;
      if v_granted then v_status := 'approved'; end if;
    end if;
    if v_applicable = 0 then
      v_reason := 'Nothing is required right now.';
    end if;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'activity', jsonb_build_object('id', a.id, 'name', a.name, 'icon', a.icon),
    'member_id', p_member_id,
    'evaluated_at', p_evaluated_at,
    'local_date', v_local_date,
    'applicable_count', v_applicable,
    'groups', v_groups,
    'blocking', v_blocking,
    'satisfied', v_satisfied,
    'pending_reviews', v_pending,
    'exemptions', v_exemptions,
    'reasons', case when v_reason is null then '[]'::jsonb else jsonb_build_array(v_reason) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Room status
-- ---------------------------------------------------------------------------
--
-- Parent requirement 21. Uses app_instance_applies_at at the same moment the
-- readiness engine does, so a room and an activity can never disagree about
-- the same instance.
create or replace function evaluate_space_status(
  p_space_id uuid,
  p_evaluated_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sp household_spaces%rowtype;
  v_timezone text;
  v_local_date date;
  v_total integer := 0;
  v_satisfied integer := 0;
  v_started integer := 0;   -- in_progress or submitted
  v_awaiting integer := 0;  -- submitted and still needing approval
  v_returned integer := 0;
  v_row record;
  v_sat text;
  v_status text;
begin
  select * into sp from household_spaces where id = p_space_id;
  if not found then
    raise exception 'no such space' using errcode = 'no_data_found';
  end if;
  -- Same reasoning as evaluate_activity_readiness: definer rights mean this
  -- check belongs here, not in a policy.
  if sp.household_id is distinct from app_current_household_id() then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;
  select timezone into v_timezone from households where id = sp.household_id;
  v_local_date := (p_evaluated_at at time zone v_timezone)::date;

  for v_row in
    select ti.id, ti.state
      from task_instances ti
      join task_definitions td on td.id = ti.definition_id
     where td.location_space_id = p_space_id
       and ti.occurrence_date = v_local_date
  loop
    if not app_instance_applies_at(v_row.id, p_evaluated_at) then
      continue;
    end if;
    v_total := v_total + 1;
    v_sat := app_instance_satisfaction(v_row.id);

    if v_sat = 'satisfied' then v_satisfied := v_satisfied + 1; end if;
    if v_sat = 'pending_review' then v_awaiting := v_awaiting + 1; end if;
    if v_sat = 'returned_for_correction' then v_returned := v_returned + 1; end if;
    if v_row.state in ('in_progress', 'submitted') then v_started := v_started + 1; end if;
  end loop;

  -- The precedence from requirement 21, with In Progress as a catch-all so
  -- every combination resolves. An earlier draft left two submitted-and-
  -- awaiting tasks matching no rule at all.
  if v_total = 0 then
    v_status := 'ready';
  elsif v_returned > 0 or (v_started = 0 and v_satisfied = 0) then
    v_status := 'needs_attention';
  elsif v_awaiting > 0 and (v_satisfied + v_awaiting) = v_total then
    v_status := 'awaiting_review';
  elsif v_satisfied = v_total then
    v_status := 'ready';
  else
    v_status := 'in_progress';
  end if;

  return jsonb_build_object(
    'space_id', sp.id,
    'name', sp.name,
    'status', v_status,
    'applicable', v_total,
    'satisfied', v_satisfied,
    'awaiting_review', v_awaiting,
    'returned', v_returned,
    'note', case when v_total = 0 then 'Nothing needed here today.' else null end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'app_instance_satisfaction(uuid)',
    'app_requirement_rows(uuid, uuid, date)',
    'evaluate_activity_readiness(uuid, uuid, uuid, timestamptz)',
    'evaluate_space_status(uuid, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
