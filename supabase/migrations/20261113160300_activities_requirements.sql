-- Our Family Hub — configurable activities and reusable requirement groups.
--
-- HAL-1538 requirement 12: a parent adds "Watch YouTube" in settings, attaches
-- an existing group, and the engine evaluates it with no source change. That is
-- only true if nothing about an activity lives in application code, so every
-- rule below is a row.

create table activities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  name text not null,
  icon text,
  -- When false, satisfying prerequisites yields ready_to_ask and that is the
  -- end of it. When true, an activity_grants row is additionally required
  -- before the engine reports 'approved' (HAL-1538 requirement 11).
  requires_parent_approval boolean not null default false,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),

  constraint activities_name_not_blank check (length(trim(name)) > 0),
  unique (household_id, name),
  unique (id, household_id)
);

-- Availability windows are rows, not an inline list on activities: a set of
-- windows is multi-valued, and storing it inline would be the same 1NF defect
-- as an inline attendee list. An activity with no window row is always
-- available; a window restricts it to those times.
create table activity_availability_windows (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities (id) on delete cascade,
  household_id uuid not null references households (id) on delete restrict,
  -- ISO day of week, 1 = Monday .. 7 = Sunday. Null means every day.
  day_of_week smallint,
  -- Start-inclusive, end-exclusive, in household local time — the same
  -- convention as the school-morning window (HAL-1538 requirement 5).
  start_time time not null,
  end_time time not null,

  constraint activity_windows_day_of_week_valid check (
    day_of_week is null or day_of_week between 1 and 7
  ),
  constraint activity_windows_ordered check (start_time < end_time),
  foreign key (activity_id, household_id) references activities (id, household_id)
);

-- A parent's authorization of an activity for one member. This is the only
-- thing that can make the engine report 'approved' (HAL-1538 requirement 11),
-- which is why readiness computed on the client grants nothing.
create table activity_grants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  activity_id uuid not null references activities (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete restrict,
  granted_by uuid not null references family_members (id) on delete restrict,
  granted_by_role member_role not null default 'parent',
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),

  constraint activity_grants_window_ordered check (
    valid_until is null or valid_from < valid_until
  ),
  -- Only a parent can grant. Enforced relationally, not only in the function
  -- that writes it.
  constraint activity_grants_granted_by_is_parent check (granted_by_role = 'parent'),
  foreign key (granted_by, granted_by_role) references family_members (id, role),
  foreign key (activity_id, household_id) references activities (id, household_id),
  foreign key (member_id, household_id) references family_members (id, household_id),
  foreign key (granted_by, household_id) references family_members (id, household_id)
);

create index activity_grants_lookup_idx
  on activity_grants (activity_id, member_id, valid_from);

create table requirement_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint requirement_groups_name_not_blank check (length(trim(name)) > 0),
  unique (household_id, name),
  unique (id, household_id)
);

-- The row shape that carries HAL-1538 I2.
--
-- A task_definition item copies its target's occurrence_mode and a composite FK
-- holds that copy true, so the in-row CHECK can safely relate mode to scope:
-- household items may target only shared definitions, requester items only
-- per-member ones.
--
-- A space item has no target definition, so its occurrence_mode is null and the
-- composite FK does not constrain it (MATCH SIMPLE ignores a row with a null in
-- the key). Its own CHECK branch is therefore what fixes space items at
-- household scope — which is what stops a space item pulling one child's
-- personal task into another child's evaluation.
create table requirement_group_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references requirement_groups (id) on delete cascade,
  household_id uuid not null references households (id) on delete restrict,
  target_kind requirement_target_kind not null,
  target_definition_id uuid references task_definitions (id) on delete restrict,
  target_space_id uuid references household_spaces (id) on delete restrict,
  occurrence_mode occurrence_mode,
  scope evaluation_scope not null,

  constraint requirement_group_items_shape check (
    case target_kind
      when 'task_definition' then
        target_definition_id is not null
        and target_space_id is null
        and occurrence_mode is not null
        and (
          (scope = 'household' and occurrence_mode = 'shared')
          or (scope = 'requester' and occurrence_mode = 'per_member')
        )
      when 'space' then
        target_space_id is not null
        and target_definition_id is null
        and occurrence_mode is null
        and scope = 'household'
    end
  ),
  foreign key (group_id, household_id) references requirement_groups (id, household_id),
  foreign key (target_definition_id, occurrence_mode)
    references task_definitions (id, occurrence_mode),
  foreign key (target_definition_id, household_id)
    references task_definitions (id, household_id),
  foreign key (target_space_id, household_id)
    references household_spaces (id, household_id)
);

-- A group cannot contain the same target twice: a duplicate item would
-- double-count one blocker in the readiness result. Two partial indexes rather
-- than one key over nullable columns, for the same reason as task_instances.
create unique index requirement_group_items_definition_key
  on requirement_group_items (group_id, target_definition_id)
  where target_definition_id is not null;

create unique index requirement_group_items_space_key
  on requirement_group_items (group_id, target_space_id)
  where target_space_id is not null;

create table activity_requirements (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities (id) on delete cascade,
  group_id uuid not null references requirement_groups (id) on delete restrict,
  household_id uuid not null references households (id) on delete restrict,

  unique (activity_id, group_id),
  foreign key (activity_id, household_id) references activities (id, household_id),
  foreign key (group_id, household_id) references requirement_groups (id, household_id)
);
