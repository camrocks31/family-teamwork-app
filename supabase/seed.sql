-- Our Family Hub — committed seed.
--
-- HAL-1538 requirement 1: the repository is public, so this file carries
-- STRUCTURE ONLY. Every member and space has a generic placeholder name. The
-- household's real names are applied afterwards by supabase/seed.local.sql,
-- which is untracked. Nothing about the family is published here, and a test
-- asserts it stays that way.
--
-- The structure is still the real structure — two floors, eleven spaces, the
-- cleaning criteria, the school-morning routine, the pet, two activities and
-- two requirement groups — so every acceptance fixture runs against the shape
-- the household actually uses.

-- A seed-time helper: create a definition, its first immutable revision, its
-- ordered criteria, and point the definition at that revision.
create function pg_temp.add_task(
  p_household uuid,
  p_space uuid,
  p_pet uuid,
  p_mode occurrence_mode,
  p_recurrence recurrence_kind,
  p_title text,
  p_criteria text[],
  p_not_needed_permitted boolean default false
) returns uuid
language plpgsql
as $$
declare
  v_definition uuid;
  v_revision uuid;
  v_text text;
  v_order integer := 1;
begin
  insert into task_definitions (household_id, location_space_id, pet_id, occurrence_mode)
  values (p_household, p_space, p_pet, p_mode)
  returning id into v_definition;

  insert into task_definition_revisions (
    definition_id, household_id, revision_number, title,
    recurrence, occurrence_mode, not_needed_permitted
  )
  values (
    v_definition, p_household, 1, p_title,
    p_recurrence, p_mode, p_not_needed_permitted
  )
  returning id into v_revision;

  foreach v_text in array p_criteria loop
    insert into task_definition_criteria (revision_id, household_id, display_order, text)
    values (v_revision, p_household, v_order, v_text);
    v_order := v_order + 1;
  end loop;

  update task_definitions set current_revision_id = v_revision where id = v_definition;
  return v_definition;
end;
$$;

do $$
declare
  v_household uuid;
  v_upstairs uuid;
  v_downstairs uuid;
  v_pet uuid;

  -- Spaces. Named by what they are, never by who sleeps in them.
  v_bed_shared uuid;   -- shared by an adult and a child
  v_bed_children uuid; -- the children's own room
  v_bed_adult uuid;    -- an adult's own room
  v_bath_up uuid;
  v_landing uuid;
  v_living uuid;
  v_dining uuid;
  v_kitchen uuid;
  v_bath_down uuid;
  v_entry uuid;
  v_stairs uuid;

  v_child record;
  v_cleaning_group uuid;
  v_morning_group uuid;
  v_games uuid;
  v_tv uuid;
  v_def uuid;
  v_space uuid;
  v_day smallint;
begin
  insert into households (name, timezone, morning_window_start, morning_window_end)
  values ('Example Household', 'America/Vancouver', '06:30', '08:30')
  returning id into v_household;

  -- Members. Two parents, three children, placeholder names.
  insert into family_members (household_id, display_name, role, avatar_emoji, accent_color)
  values
    (v_household, 'Parent One', 'parent', '🧑', '#6D4FB0'),
    (v_household, 'Parent Two', 'parent', '🧑', '#2E7D52'),
    (v_household, 'Child One',  'child',  '🙂', '#B4700E'),
    (v_household, 'Child Two',  'child',  '🙂', '#2E7D52'),
    (v_household, 'Child Three','child',  '🙂', '#6D4FB0');

  insert into pets (household_id, name, species, avatar_emoji)
  values (v_household, 'Dog', 'dog', '🐕')
  returning id into v_pet;

  -- Floors are spaces with no parent.
  insert into household_spaces (household_id, name, icon, display_order)
  values (v_household, 'Upstairs', '⬆️', 1) returning id into v_upstairs;
  insert into household_spaces (household_id, name, icon, display_order)
  values (v_household, 'Downstairs', '⬇️', 2) returning id into v_downstairs;

  insert into household_spaces (household_id, parent_space_id, name, icon, display_order)
  values
    (v_household, v_upstairs,  'Shared Bedroom',      '🛏️', 1),
    (v_household, v_upstairs,  'Children''s Bedroom', '🛏️', 2),
    (v_household, v_upstairs,  'Adult Bedroom',       '🛏️', 3),
    (v_household, v_upstairs,  'Upstairs Bathroom',   '🛁', 4),
    (v_household, v_upstairs,  'Upstairs Landing',    '🪟', 5),
    (v_household, v_downstairs,'Living Room',         '🛋️', 1),
    (v_household, v_downstairs,'Dining Room',         '🍽️', 2),
    (v_household, v_downstairs,'Kitchen',             '🍳', 3),
    (v_household, v_downstairs,'Downstairs Bathroom', '🚿', 4),
    (v_household, v_downstairs,'Entry Area',          '🚪', 5),
    (v_household, v_downstairs,'Stairs',              '🪜', 6);

  select id into v_bed_shared   from household_spaces where household_id = v_household and name = 'Shared Bedroom';
  select id into v_bed_children from household_spaces where household_id = v_household and name = 'Children''s Bedroom';
  select id into v_bed_adult    from household_spaces where household_id = v_household and name = 'Adult Bedroom';
  select id into v_bath_up      from household_spaces where household_id = v_household and name = 'Upstairs Bathroom';
  select id into v_landing      from household_spaces where household_id = v_household and name = 'Upstairs Landing';
  select id into v_living       from household_spaces where household_id = v_household and name = 'Living Room';
  select id into v_dining       from household_spaces where household_id = v_household and name = 'Dining Room';
  select id into v_kitchen      from household_spaces where household_id = v_household and name = 'Kitchen';
  select id into v_bath_down    from household_spaces where household_id = v_household and name = 'Downstairs Bathroom';
  select id into v_entry        from household_spaces where household_id = v_household and name = 'Entry Area';
  select id into v_stairs       from household_spaces where household_id = v_household and name = 'Stairs';

  -- ---------------------------------------------------------------------
  -- Daily cleaning. Shared occurrence: one instance per date for the house,
  -- which anyone may complete. The criteria are the brief's, verbatim, so a
  -- child always sees what "tidy" actually means.
  -- ---------------------------------------------------------------------
  foreach v_space in array array[v_bed_shared, v_bed_children, v_bed_adult] loop
    perform pg_temp.add_task(v_household, v_space, null, 'shared', 'daily', 'Tidy the bedroom', array[
      'Dirty clothes in the hamper',
      'Clean clothes put away, including any left on the dresser',
      'Toys and books put away properly',
      'Beds made',
      'Floor clear, except furniture and things meant to be there'
    ]);
  end loop;

  foreach v_space in array array[v_bath_up, v_bath_down] loop
    perform pg_temp.add_task(v_household, v_space, null, 'shared', 'daily', 'Tidy the bathroom', array[
      'Toothbrushes, toothpaste and personal items put away',
      'No dirty clothes on the floor',
      'Floor clear of anything that does not belong there'
    ]);
  end loop;

  perform pg_temp.add_task(v_household, v_living, null, 'shared', 'daily', 'Tidy the living room', array[
    'No clothes, toys or other misplaced things on the floor',
    'Chairs back where they belong',
    'Everything put away in its proper place'
  ]);

  perform pg_temp.add_task(v_household, v_dining, null, 'shared', 'daily', 'Clear the dining room', array[
    'Table cleared of toys, food, wrappers and dishes',
    'Chairs pushed in',
    'Other belongings put away'
  ]);

  -- The dishwasher is a decision tree, not a checkbox. v1 does not model its
  -- contents (HAL-1538 requirement 4); the actor confirms what they did.
  perform pg_temp.add_task(v_household, v_kitchen, null, 'shared', 'daily', 'Dishes and dishwasher', array[
    'Countertops clear, except things that belong there',
    'No dirty dishes in the sink or anywhere else in the house',
    'If the dishwasher holds clean dishes, unload it',
    'If it holds dirty dishes and is not full enough yet, leave them in ready for more',
    'If it is full enough, run it',
    'Food and stray items put away'
  ]);

  foreach v_space in array array[v_landing, v_stairs, v_entry] loop
    perform pg_temp.add_task(v_household, v_space, null, 'shared', 'daily', 'Clear the walkway', array[
      'Toys, clothing and misplaced belongings removed',
      'Walkways and stairs clear',
      'Shoes, coats and bags in their proper places'
    ]);
  end loop;

  -- ---------------------------------------------------------------------
  -- Pet care. Shared, so any eligible member may record it and it counts for
  -- everyone — and the dashboard shows who did it and when, so nobody feeds
  -- the dog twice (HAL-1538 requirement 6).
  -- ---------------------------------------------------------------------
  perform pg_temp.add_task(v_household, null, v_pet, 'shared', 'daily', 'Feed the dog', array[
    'Food given'
  ]);
  perform pg_temp.add_task(v_household, null, v_pet, 'shared', 'daily', 'Fresh water for the dog', array[
    'Water bowl checked and refilled'
  ]);
  perform pg_temp.add_task(v_household, null, v_pet, 'shared', 'daily', 'Take the dog outside', array[
    'Taken into the backyard to pee and poop'
  ]);
  -- The one seeded definition where "Not Needed" is allowed: some mornings
  -- there is nothing to pick up.
  perform pg_temp.add_task(v_household, null, v_pet, 'shared', 'daily', 'Pick up after the dog', array[
    'Poop picked up and the bag disposed of properly'
  ], true);

  -- ---------------------------------------------------------------------
  -- School morning. Per-member: one instance per child per school day, so one
  -- child packing a lunch never satisfies another's (HAL-1538 requirement 5).
  -- ---------------------------------------------------------------------
  v_def := pg_temp.add_task(v_household, null, null, 'per_member', 'school_day', 'Eat breakfast', array[
    'Breakfast eaten',
    'Breakfast dishes dealt with'
  ]);
  for v_child in select id from family_members where household_id = v_household and role = 'child' loop
    insert into task_assignments (definition_id, member_id, household_id)
    values (v_def, v_child.id, v_household);
  end loop;

  v_def := pg_temp.add_task(v_household, null, null, 'per_member', 'school_day', 'Pack a proper lunch', array[
    'Something with protein',
    'Something with carbohydrate',
    'A fruit',
    'A vegetable',
    'Real food, not a single token item'
  ]);
  for v_child in select id from family_members where household_id = v_household and role = 'child' loop
    insert into task_assignments (definition_id, member_id, household_id)
    values (v_def, v_child.id, v_household);
  end loop;

  v_def := pg_temp.add_task(v_household, null, null, 'per_member', 'school_day', 'Fill your water bottle', array[
    'Water bottle filled and packed'
  ]);
  for v_child in select id from family_members where household_id = v_household and role = 'child' loop
    insert into task_assignments (definition_id, member_id, household_id)
    values (v_def, v_child.id, v_household);
  end loop;

  v_def := pg_temp.add_task(v_household, null, null, 'per_member', 'school_day', 'Ready to go', array[
    'Dressed',
    'Shoes on',
    'Coat and backpack ready by the door'
  ]);
  for v_child in select id from family_members where household_id = v_household and role = 'child' loop
    insert into task_assignments (definition_id, member_id, household_id)
    values (v_def, v_child.id, v_household);
  end loop;

  -- ---------------------------------------------------------------------
  -- Requirement groups.
  -- ---------------------------------------------------------------------
  insert into requirement_groups (household_id, name, description)
  values (v_household, 'Daily Household Cleaning',
          'The whole house, every day — not only school days.')
  returning id into v_cleaning_group;

  insert into requirement_groups (household_id, name, description)
  values (v_household, 'School Morning Readiness',
          'Applies only inside the school-day morning window.')
  returning id into v_morning_group;

  -- D1 (Cameron, 2026-11-13): every shared space and the children's bedroom.
  -- The two adult-shared bedrooms are real spaces with their own daily tasks,
  -- but they do NOT gate the children's activities — an adult's tidying must
  -- never be the reason a child cannot watch TV.
  foreach v_space in array array[
    v_bed_children,
    v_bath_up, v_landing,
    v_living, v_dining, v_kitchen, v_bath_down, v_entry, v_stairs
  ] loop
    insert into requirement_group_items (
      group_id, household_id, target_kind, target_space_id, scope
    )
    values (v_cleaning_group, v_household, 'space', v_space, 'household');
  end loop;

  -- School-morning: each child's own tasks (requester scope) plus the shared
  -- pet care that belongs to the morning routine (household scope).
  for v_def in
    select td.id
      from task_definitions td
      join task_definition_revisions r on r.id = td.current_revision_id
     where td.household_id = v_household and td.occurrence_mode = 'per_member'
  loop
    insert into requirement_group_items (
      group_id, household_id, target_kind, target_definition_id, occurrence_mode, scope
    )
    values (v_morning_group, v_household, 'task_definition', v_def, 'per_member', 'requester');
  end loop;

  for v_def in
    select td.id from task_definitions td
     where td.household_id = v_household and td.pet_id is not null
  loop
    insert into requirement_group_items (
      group_id, household_id, target_kind, target_definition_id, occurrence_mode, scope
    )
    values (v_morning_group, v_household, 'task_definition', v_def, 'shared', 'household');
  end loop;

  -- ---------------------------------------------------------------------
  -- Activities. Both start with the same prerequisites; a parent can add
  -- another in settings and attach these same groups, with no code change.
  -- ---------------------------------------------------------------------
  insert into activities (household_id, name, icon, display_order)
  values (v_household, 'Play Video Games', '🎮', 1) returning id into v_games;
  insert into activities (household_id, name, icon, display_order)
  values (v_household, 'Watch TV', '📺', 2) returning id into v_tv;

  insert into activity_requirements (activity_id, group_id, household_id)
  values
    (v_games, v_cleaning_group, v_household),
    (v_games, v_morning_group,  v_household),
    (v_tv,    v_cleaning_group, v_household),
    (v_tv,    v_morning_group,  v_household);

  -- ---------------------------------------------------------------------
  -- School calendar: weekdays are school days, weekends are not. Holidays and
  -- Pro-D days are date overrides a parent adds in settings.
  -- ---------------------------------------------------------------------
  for v_day in 1..7 loop
    insert into schedule_rules (household_id, rule_kind, day_of_week, is_school_day)
    values (v_household, 'weekly', v_day, v_day <= 5);
  end loop;
end
$$;
