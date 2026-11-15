-- Our Family Hub — each child's own list, and the things you can only do together.
--
-- THE DEFECT THIS FIXES is visible on a screenshot of the dashboard: "Play
-- Video Games" and "Watch TV" rendered as two cards with byte-for-byte
-- identical contents — the same four house jobs, the same three children, the
-- same verdict three times each. Twelve tiles carrying two facts. On a phone
-- that is a full screen of pure repetition before anything useful.
--
-- It was not a layout bug. An activity had no audience: every activity was
-- offered to every child, so every activity asked the same question of the
-- same people and necessarily got the same answer. Fixing it in the renderer
-- would have been a band-aid over a modelling hole.
--
-- Two rows close it.
--
--   AUDIENCE. Which children an activity is even offered to. The eldest wants
--   the tablet and the television; the boys want the console. Once the lists
--   differ, the cards differ, and the duplication cannot come back.
--
--   PARTICIPATION. 'solo' means your own work unlocks it. 'team' means
--   EVERY child in the audience must be ready, not just the one asking.
--
-- The second is the one that matters most, and it is not a feature — it is
-- the answer to a design problem. A reward that counts work makes siblings
-- rivals: the fastest to the dishwasher wins, and helping your brother is a
-- losing move. We already removed the scoring (see rewards_own_jobs). A team
-- activity goes further and inverts it: "Console — together" unlocks only
-- when both brothers are done, so the quickest route to your own evening runs
-- through helping the other one finish. Nobody has to be told to co-operate;
-- it is simply the shortest path.
--
-- Audience is a TABLE, not a column on activities. It is multi-valued, and an
-- array or a comma-separated list would be the 1NF defect this schema has
-- avoided everywhere else. No rows at all means "every child", so existing
-- activities keep working untouched and a household that never opens this
-- setting never meets it.

-- ---------------------------------------------------------------------------
-- Who an activity is for, and how many of them must be ready
-- ---------------------------------------------------------------------------

create type activity_participation as enum ('solo', 'team');

alter table activities
  add column participation activity_participation not null default 'solo';

comment on column activities.participation is
  'solo: the asking child''s own work unlocks it. team: every child in the '
  'audience must be ready, so helping a sibling finish is the fastest route '
  'to your own evening.';

create table activity_audience (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  activity_id uuid not null references activities (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete restrict,
  created_at timestamptz not null default now(),

  -- One child cannot be in an activity's audience twice: a duplicate would
  -- evaluate their requirements twice for a team activity and double-count
  -- every blocker they have.
  unique (activity_id, member_id),
  foreign key (activity_id, household_id) references activities (id, household_id),
  foreign key (member_id, household_id) references family_members (id, household_id)
);

create index activity_audience_member_idx on activity_audience (member_id);

comment on table activity_audience is
  'Which children an activity is offered to. NO ROWS means every child — so '
  'an activity created before this table existed keeps its old meaning.';

-- ---------------------------------------------------------------------------
-- A stable order for people
-- ---------------------------------------------------------------------------
--
-- The dashboard ordered members by display_name, which put the family in
-- alphabetical order — "Child One, Child Three, Child Two" — and looked
-- random to anyone reading it. A household has an order its members would
-- recognise (usually age) and no column held it.
--
-- Deliberately NOT a birth date. The schema stores no ages and no dates of
-- birth (HAL-1538 I4), and an ordering integer is all the dashboard needs.
-- The default is 1000, not 0, because the backfill below starts at 10: a
-- member added after this migration would otherwise take 0 and sort above
-- everybody. Measured — a new child landed above both parents.
alter table family_members
  add column display_order integer not null default 1000;

-- Backfill: parents first, then children, each block alphabetical so the
-- result is deterministic rather than whatever order the rows happen to sit
-- in. A parent can reorder afterwards.
with ordered as (
  select id,
         row_number() over (
           partition by household_id
           order by case role when 'parent' then 0 else 1 end, display_name
         ) * 10 as n
    from family_members
)
update family_members fm
   set display_order = ordered.n
  from ordered
 where ordered.id = fm.id;

alter table activity_audience enable row level security;

-- READ within the household; WRITE only through save_activity.
--
-- This is deliberately NOT the Shape A policy set the other configuration
-- tables use, and the reason is a rule that no CHECK can express: a team
-- activity needs at least two people. save_activity enforces it, but under
-- Shape A a parent session could simply delete a row from this table and
-- leave participation = 'team' with one member — measured, and the dashboard
-- then renders "waiting for everyone" above a single name, which the editor
-- refuses to create in the first place. A multi-row invariant cannot live in
-- a constraint, so it lives in the only writer.
create policy activity_audience_parent_select on activity_audience
  for select to authenticated
  using (household_id = app_current_household_id());

revoke insert, update, delete on activity_audience from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Who must be ready
-- ---------------------------------------------------------------------------
--
-- One definition of "the audience", used by the readiness engine and the
-- dashboard alike, so a child can never be offered an activity the engine
-- would not evaluate for them, or vice versa.
--
-- INTERNAL. It is SECURITY DEFINER, it bypasses RLS, and it takes an id from
-- its caller without checking whose household that id belongs to — so granting
-- it to `authenticated` handed any signed-in session the names and ids of
-- another household's children for the price of one guessed uuid. Measured:
-- from this household's parent session, app_activity_audience(<their activity>)
-- returned "Their Child" while the same id read through RLS returned nothing.
--
-- It is therefore granted to nobody, exactly like app_requirement_rows, and
-- both of its callers below check the household BEFORE reaching it. A definer
-- function that owns no authorization decision must not be reachable from a
-- browser; that is the rule the grants test pins.
create or replace function app_activity_audience(p_activity_id uuid)
returns table (member_id uuid, display_name text, display_order integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select fm.id, fm.display_name, fm.display_order
    from activities act
    join family_members fm
      on fm.household_id = act.household_id
     and fm.is_active
     and fm.role = 'child'
   where act.id = p_activity_id
     -- An explicit audience wins. With no rows the activity is for every
     -- child, which is what every activity meant before this table existed.
     and (
       not exists (select 1 from activity_audience aa where aa.activity_id = act.id)
       or exists (
         select 1 from activity_audience aa
          where aa.activity_id = act.id and aa.member_id = fm.id
       )
     )
   order by fm.display_order, fm.display_name;
$$;

-- ---------------------------------------------------------------------------
-- Readiness, now that an activity can belong to more than one person
-- ---------------------------------------------------------------------------
--
-- The body below is the existing engine with one structural change: it
-- evaluates a LIST of members rather than one.
--
--   solo  — the list is just the asking child, exactly as before.
--   team  — the list is everyone in the audience.
--
-- Household-scope requirements (the kitchen, the dog's water) are evaluated
-- ONCE, against the asking child's pass. Without that, a shared blocker would
-- appear once per team member and the duplication this migration exists to
-- remove would come straight back in a new disguise.
--
-- Every blocking row now carries WHOSE work it is, so the interface can say
-- "waiting on one thing of Desmond's" instead of a bare count. That is the
-- sentence that turns a team activity from a punishment into a prompt.
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
  v_audience jsonb := '[]'::jsonb;
  v_applicable integer := 0;
  v_status text;
  v_reason text;
  v_eval_members uuid[];
  v_eval_member uuid;
  v_eval_name text;
  v_is_self boolean;
begin
  if app_current_household_id() is distinct from p_household_id then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  select * into a from activities where id = p_activity_id and household_id = p_household_id;
  if not found then
    raise exception 'no such activity' using errcode = 'no_data_found';
  end if;

  -- The requester has to be a real, active member of this household.
  --
  -- A null requester used to be merely useless. The team loop made it
  -- dangerous: v_is_self is `v_eval_member = p_member_id`, which is NULL when
  -- the requester is NULL, and `where v_is_self or scope = 'requester'` then
  -- evaluates to NULL for every household row and drops them all. The engine
  -- answered 'ready_to_ask', applicable_count 0, while the same activity for a
  -- real child reported seventeen outstanding blockers. Measured against the
  -- local database, not reasoned about: the gate said yes to a null.
  --
  -- Checked here rather than relied upon from the caller, because this
  -- function is granted to the browser and its argument comes from one.
  if not exists (
    select 1 from family_members
     where id = p_member_id and household_id = p_household_id and is_active
  ) then
    raise exception 'no such family member in your household'
      using errcode = 'no_data_found';
  end if;

  select timezone into v_timezone from households where id = p_household_id;
  v_local_date := (p_evaluated_at at time zone v_timezone)::date;
  v_local_time := (p_evaluated_at at time zone v_timezone)::time;
  v_dow := extract(isodow from v_local_date);

  select coalesce(
           jsonb_agg(jsonb_build_object('member_id', member_id, 'display_name', display_name)
                     order by display_order, display_name),
           '[]'::jsonb)
    into v_audience
    from app_activity_audience(a.id);

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
        'participation', a.participation,
        'audience', v_audience,
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

  -- Whose work counts.
  if a.participation = 'team' then
    select array_agg(member_id order by display_order, display_name)
      into v_eval_members
      from app_activity_audience(a.id);
    v_eval_members := coalesce(v_eval_members, array[]::uuid[]);
    -- A parent inspecting a team activity, or a child who has been taken out
    -- of its audience, is still answered honestly about their own position.
    if not (p_member_id = any (v_eval_members)) then
      v_eval_members := array[p_member_id] || v_eval_members;
    end if;
  else
    v_eval_members := array[p_member_id];
  end if;

  foreach v_eval_member in array v_eval_members loop
    -- `is not distinct from` rather than `=`, so this is a boolean and never
    -- NULL. The guard above already rejects a null requester; this makes the
    -- WHERE clause below incapable of silently dropping household rows even
    -- if some future caller reaches it another way.
    v_is_self := v_eval_member is not distinct from p_member_id;
    select display_name into v_eval_name from family_members where id = v_eval_member;

    for v_row in
      select * from app_requirement_rows(p_activity_id, v_eval_member, v_local_date)
      -- The house is everybody's, so it is counted once — on the asking
      -- child's pass. Teammates contribute only their OWN work.
       where v_is_self or scope = 'requester'
    loop
      if v_row.instance_id is not null
         and not app_instance_applies_at(v_row.instance_id, p_evaluated_at) then
        continue;
      end if;

      v_applicable := v_applicable + 1;

      if v_row.instance_id is null then
        v_blocking := v_blocking || jsonb_build_object(
          'reason_code', 'missing_instance',
          'reason', v_row.title || ' has no task for today yet.',
          'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
          'link_name', v_row.link_name, 'title', v_row.title,
          'group_id', v_row.group_id, 'group_name', v_row.group_name,
          'scope', v_row.scope,
          'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
          'for_member_name', case when v_row.scope = 'requester' then v_eval_name end,
          'is_self', v_is_self
        );
        continue;
      end if;

      v_sat := app_instance_satisfaction(v_row.instance_id);

      if v_sat = 'satisfied' then
        v_satisfied := v_satisfied || jsonb_build_object(
          'title', v_row.title, 'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
          'link_name', v_row.link_name, 'instance_id', v_row.instance_id,
          'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
          'for_member_name', case when v_row.scope = 'requester' then v_eval_name end
        );
        if exists (
          select 1 from task_instances ti
           where ti.id = v_row.instance_id
             and ti.state = 'not_applicable'
             and ti.not_applicable_reason = 'parent_exemption'
        ) then
          v_exemptions := v_exemptions || jsonb_build_object(
            'title', v_row.title, 'instance_id', v_row.instance_id,
            'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
            'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
            'for_member_name', case when v_row.scope = 'requester' then v_eval_name end
          );
        end if;

      elsif v_sat = 'pending_review' then
        -- Attributed, like the blocking rows below it. Without the owner, a
        -- team with both children awaiting approval produced two entries
        -- identical apart from their ids — a duplicate with nobody's name on
        -- it, which is the symptom this whole migration exists to remove.
        v_pending := v_pending || jsonb_build_object(
          'title', v_row.title, 'instance_id', v_row.instance_id,
          'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
          'link_name', v_row.link_name,
          'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
          'for_member_name', case when v_row.scope = 'requester' then v_eval_name end
        );
        v_blocking := v_blocking || jsonb_build_object(
          'reason_code', 'pending_review',
          'reason', v_row.title || ' is waiting for a parent to check it.',
          'link_kind', v_row.link_kind, 'link_id', v_row.link_id,
          'link_name', v_row.link_name, 'title', v_row.title,
          'group_id', v_row.group_id, 'group_name', v_row.group_name,
          'scope', v_row.scope,
          'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
          'for_member_name', case when v_row.scope = 'requester' then v_eval_name end,
          'is_self', v_is_self
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
          'group_id', v_row.group_id, 'group_name', v_row.group_name,
          'scope', v_row.scope,
          'for_member_id', case when v_row.scope = 'requester' then v_eval_member end,
          'for_member_name', case when v_row.scope = 'requester' then v_eval_name end,
          'is_self', v_is_self
        );
      end if;
    end loop;
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
    'participation', a.participation,
    'audience', v_audience,
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
-- The dashboard: only ask the question of the people it is asked about
-- ---------------------------------------------------------------------------
--
-- Two changes, both subtractions.
--
--   Members come back in display_order, so the family reads in the order the
--   family would say it, not alphabetically.
--
--   An activity is evaluated only for the children in its audience. That is
--   what stops the payload carrying the eldest's verdict on a console she
--   does not play, which is what the interface was rendering as a tile.
create or replace function evaluate_household_dashboard(
  p_household_id uuid,
  p_evaluated_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h households%rowtype;
  v_local_date date;
  v_members jsonb;
  v_spaces jsonb;
  v_activities jsonb;
  v_pets jsonb;
  v_shopping jsonb;
  v_progress jsonb;
  v_in_morning boolean;
begin
  if app_current_household_id() is distinct from p_household_id then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  select * into h from households where id = p_household_id;
  if not found then
    raise exception 'no such household' using errcode = 'no_data_found';
  end if;
  v_local_date := (p_evaluated_at at time zone h.timezone)::date;
  v_in_morning := app_in_morning_window(p_household_id, p_evaluated_at);

  -- Counts only, and no ranking anywhere: HAL-1538 I5 forbids measuring
  -- participation, and a leaderboard is the shape that rule exists to
  -- prevent. Sorting by display_order is a reading order, not a score.
  select coalesce(jsonb_agg(m order by (m->>'display_order')::integer, m->>'display_name'), '[]'::jsonb)
    into v_members
    from (
      select jsonb_build_object(
        'id', fm.id,
        'display_name', fm.display_name,
        'role', fm.role,
        'avatar_emoji', fm.avatar_emoji,
        'accent_color', fm.accent_color,
        'display_order', fm.display_order,
        'simple_view', fm.simple_view,
        'own_outstanding', (
          select count(*) from task_instances ti
           where ti.subject_member_id = fm.id
             and ti.occurrence_date = v_local_date
             and app_instance_applies_at(ti.id, p_evaluated_at)
             and app_instance_satisfaction(ti.id) <> 'satisfied'
        ),
        'own_total', (
          select count(*) from task_instances ti
           where ti.subject_member_id = fm.id
             and ti.occurrence_date = v_local_date
             and app_instance_applies_at(ti.id, p_evaluated_at)
        )
      ) as m
      from family_members fm
      where fm.household_id = p_household_id and fm.is_active
    ) t;

  select coalesce(jsonb_agg(f order by f->>'display_order'), '[]'::jsonb) into v_spaces
    from (
      select jsonb_build_object(
        'id', floor.id,
        'name', floor.name,
        'icon', floor.icon,
        'display_order', lpad(floor.display_order::text, 4, '0'),
        'rooms', (
          select coalesce(jsonb_agg(
            evaluate_space_status(room.id, p_evaluated_at) || jsonb_build_object(
              'icon', room.icon, 'display_order', room.display_order
            ) order by room.display_order
          ), '[]'::jsonb)
          from household_spaces room
          where room.parent_space_id = floor.id and room.is_active
        )
      ) as f
      from household_spaces floor
      where floor.household_id = p_household_id
        and floor.parent_space_id is null
        and floor.is_active
    ) t;

  -- Evaluated per member of the AUDIENCE, not per child in the house.
  select coalesce(jsonb_agg(a order by a->>'display_order'), '[]'::jsonb) into v_activities
    from (
      select jsonb_build_object(
        'id', act.id,
        'name', act.name,
        'icon', act.icon,
        'participation', act.participation,
        'display_order', lpad(act.display_order::text, 4, '0'),
        'per_member', (
          select coalesce(jsonb_agg(
            evaluate_activity_readiness(p_household_id, aud.member_id, act.id, p_evaluated_at)
            order by aud.display_order, aud.display_name
          ), '[]'::jsonb)
          from app_activity_audience(act.id) aud
        )
      ) as a
      from activities act
      where act.household_id = p_household_id and act.is_active
        -- An activity nobody can be evaluated for is left out entirely.
        -- Its audience can name only children who have since been
        -- deactivated, and the "no rows means everyone" fallback keys on
        -- whether rows EXIST rather than on who they resolve to — so the
        -- payload carried an active activity with an empty per_member list.
        -- A card with nothing in it, in the migration whose whole purpose is
        -- removing empty and duplicated cards.
        and exists (select 1 from app_activity_audience(act.id))
    ) t;

  select coalesce(jsonb_agg(p order by p->>'name'), '[]'::jsonb) into v_pets
    from (
      select jsonb_build_object(
        'id', pet.id,
        'name', pet.name,
        'avatar_emoji', pet.avatar_emoji,
        'care', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'instance_id', ti.id,
              'title', r.title,
              'state', ti.state,
              'satisfaction', app_instance_satisfaction(ti.id),
              'not_applicable_reason', ti.not_applicable_reason,
              'by', fm.display_name,
              'at_local', case
                when ti.completed_at is not null
                  then to_char(ti.completed_at at time zone h.timezone, 'HH24:MI')
                when ti.not_applicable_at is not null
                  then to_char(ti.not_applicable_at at time zone h.timezone, 'HH24:MI')
                else null end
            ) order by r.title
          ), '[]'::jsonb)
          from task_instances ti
          join task_definitions td on td.id = ti.definition_id
          join task_definition_revisions r on r.id = ti.definition_revision_id
          left join family_members fm
                 on fm.id = coalesce(ti.completed_by, ti.not_applicable_by)
          where td.pet_id = pet.id
            and ti.occurrence_date = v_local_date
            and app_instance_applies_at(ti.id, p_evaluated_at)
        )
      ) as p
      from pets pet
      where pet.household_id = p_household_id and pet.is_active
    ) t;

  select coalesce(jsonb_agg(s order by s->>'created_at' desc), '[]'::jsonb) into v_shopping
    from (
      select jsonb_build_object(
        'id', si.id, 'name', si.name, 'list_kind', si.list_kind,
        'created_at', si.created_at, 'by', fm.display_name
      ) as s
      from shopping_items si
      join family_members fm on fm.id = si.created_by
      where si.household_id = p_household_id and not si.purchased
      order by si.created_at desc
      limit 5
    ) t;

  select jsonb_build_object('done', count(*) filter (where sat = 'satisfied'), 'total', count(*))
    into v_progress
    from (
      select app_instance_satisfaction(ti.id) as sat
        from task_instances ti
       where ti.household_id = p_household_id
         and ti.occurrence_date = v_local_date
         and app_instance_applies_at(ti.id, p_evaluated_at)
    ) t;

  return jsonb_build_object(
    'household', jsonb_build_object('id', h.id, 'name', h.name, 'timezone', h.timezone),
    'evaluated_at', p_evaluated_at,
    'local_date', v_local_date,
    'in_morning_window', v_in_morning,
    'morning_window_end', h.morning_window_end,
    'members', v_members,
    'floors', v_spaces,
    'activities', v_activities,
    'pets', v_pets,
    'shopping', v_shopping,
    'progress', v_progress
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Editing an activity from Settings
-- ---------------------------------------------------------------------------
--
-- One transaction, like save_task and for the same reason: an activity, its
-- audience and its requirement groups are three tables, and a dropped
-- connection between them leaves a console nobody can play or a team of one.
create or replace function save_activity(
  p_activity_id uuid default null,
  p_name text default null,
  p_icon text default null,
  p_participation activity_participation default 'solo',
  p_requires_parent_approval boolean default false,
  p_member_ids uuid[] default null,
  p_group_ids uuid[] default null,
  p_display_order integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_activity uuid;
  v_member uuid;
  v_group uuid;
  v_order integer;
begin
  if not app_is_parent() then
    raise exception 'only a parent can change activities'
      using errcode = 'insufficient_privilege';
  end if;
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'an activity needs a name' using errcode = 'invalid_parameter_value';
  end if;

  -- A team of one is a solo activity wearing a hat, and it reads as a bug on
  -- the dashboard ("waiting for everyone" above a single name). Refused here
  -- rather than rendered.
  -- DISTINCT members, not array length: array[c1, c1] has length two and is
  -- one person, and it used to pass this check and then fail further down on
  -- the unique index with a raw 23505 instead of the sentence below.
  if p_participation = 'team'
     and (select count(distinct m)
            from unnest(coalesce(p_member_ids, array[]::uuid[])) m) < 2 then
    raise exception 'a team activity needs at least two people'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_activity_id is null then
    select coalesce(max(display_order), 0) + 1 into v_order
      from activities where household_id = v_household;
    insert into activities (
      household_id, name, icon, participation, requires_parent_approval, display_order
    )
    values (
      v_household, btrim(p_name), p_icon, p_participation,
      coalesce(p_requires_parent_approval, false), coalesce(p_display_order, v_order)
    )
    returning id into v_activity;
  else
    update activities
       set name = btrim(p_name),
           icon = p_icon,
           participation = p_participation,
           requires_parent_approval = coalesce(p_requires_parent_approval, false),
           display_order = coalesce(p_display_order, display_order)
     where id = p_activity_id and household_id = v_household
    returning id into v_activity;
    if v_activity is null then
      raise exception 'no such activity in your household' using errcode = 'no_data_found';
    end if;
  end if;

  -- Audience. NULL leaves it alone; an array replaces it wholesale, and an
  -- empty array means "every child", which is the same thing as having no
  -- rows.
  --
  -- The delete used to sit OUTSIDE this guard, so the smallest legal edit —
  -- save_activity(id, 'new name') — silently wiped the audience and returned
  -- a targeted activity to every child. Measured: a team of two, renamed,
  -- came back with participation 'team' and zero audience rows, which is the
  -- exact state this migration exists to remove. It also disagreed with
  -- p_group_ids sixteen lines below, and with save_task's own
  -- p_subject_member_ids, which this function says it follows.
  if p_member_ids is not null then
    delete from activity_audience where activity_id = v_activity;
    foreach v_member in array p_member_ids loop
      -- Every id is checked against the caller's household. Ids arrive from a
      -- browser and are never trusted.
      if not exists (
        select 1 from family_members
         where id = v_member and household_id = v_household and is_active and role = 'child'
      ) then
        raise exception 'no such child in your household' using errcode = 'no_data_found';
      end if;
      insert into activity_audience (household_id, activity_id, member_id)
      values (v_household, v_activity, v_member);
    end loop;
  end if;

  if p_group_ids is not null then
    delete from activity_requirements where activity_id = v_activity;
    foreach v_group in array p_group_ids loop
      if not exists (
        select 1 from requirement_groups
         where id = v_group and household_id = v_household
      ) then
        raise exception 'no such requirement group in your household'
          using errcode = 'no_data_found';
      end if;
      insert into activity_requirements (activity_id, group_id, household_id)
      values (v_activity, v_group, v_household);
    end loop;
  end if;

  return v_activity;
end;
$$;

create or replace function set_activity_active(p_activity_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not app_is_parent() then
    raise exception 'only a parent can change activities'
      using errcode = 'insufficient_privilege';
  end if;
  update activities
     set is_active = coalesce(p_active, true)
   where id = p_activity_id and household_id = app_current_household_id();
  if not found then
    raise exception 'no such activity in your household' using errcode = 'no_data_found';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Default-deny stays default-deny: every new function is named.
-- ---------------------------------------------------------------------------

-- Internal: revoked from everyone and granted back to nobody. The definer
-- functions that call it run as the owner, so they still can.
revoke all on function app_activity_audience(uuid) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'evaluate_activity_readiness(uuid, uuid, uuid, timestamptz)',
    'evaluate_household_dashboard(uuid, timestamptz)',
    'save_activity(uuid, text, text, activity_participation, boolean, uuid[], uuid[], integer)',
    'set_activity_active(uuid, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;
