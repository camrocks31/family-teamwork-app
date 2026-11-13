-- Our Family Hub — slice 6: everything the mounted iPad shows, in one call.
--
-- This is a BATCH, not a second implementation. Every status in the payload
-- comes from evaluate_activity_readiness or evaluate_space_status, called
-- here. HAL-1538 §2.4 allows exactly one implementation of the rules, and a
-- dashboard that worked them out again would be the thing that invariant
-- exists to forbid.
--
-- The reason it exists at all is traffic: rendering the dashboard from the
-- client would be two activities times five members, plus eleven rooms, on
-- every realtime change, on a tablet on a kitchen wall. Twenty-one round
-- trips per tick is not a design, it is a habit.

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

  -- Members, each with what they personally still owe. Counts only, and no
  -- ranking anywhere: HAL-1538 I5 forbids measuring participation, and a
  -- leaderboard is the shape that rule exists to prevent.
  select coalesce(jsonb_agg(m order by m->>'display_name'), '[]'::jsonb) into v_members
    from (
      select jsonb_build_object(
        'id', fm.id,
        'display_name', fm.display_name,
        'role', fm.role,
        'avatar_emoji', fm.avatar_emoji,
        'accent_color', fm.accent_color,
        -- Their OWN tasks: both the count outstanding and how many they have
        -- at all. Without the total, a member with no personal tasks right
        -- now reads as "all done" while the house is untouched — which is
        -- true of their own list and a lie about the morning.
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

  -- Rooms, grouped by the floor they hang from. Floors are spaces with no
  -- parent, so this needs no special case for them.
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

  -- Activities, evaluated PER MEMBER. The same activity can legitimately be
  -- ready for one child and not another — one unpacked lunch does not stop
  -- the siblings — so a single household-wide card would be a lie.
  select coalesce(jsonb_agg(a order by a->>'display_order'), '[]'::jsonb) into v_activities
    from (
      select jsonb_build_object(
        'id', act.id,
        'name', act.name,
        'icon', act.icon,
        'display_order', lpad(act.display_order::text, 4, '0'),
        'per_member', (
          select coalesce(jsonb_agg(
            evaluate_activity_readiness(p_household_id, fm.id, act.id, p_evaluated_at)
            order by fm.display_name
          ), '[]'::jsonb)
          from family_members fm
          where fm.household_id = p_household_id and fm.is_active and fm.role = 'child'
        )
      ) as a
      from activities act
      where act.household_id = p_household_id and act.is_active
    ) t;

  -- The pet's care, with who did it and when. The whole point of showing the
  -- actor is that nobody feeds the dog twice.
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

  -- Household progress across everything that applies right now.
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

revoke all on function evaluate_household_dashboard(uuid, timestamptz) from public, anon;
grant execute on function evaluate_household_dashboard(uuid, timestamptz) to authenticated;
