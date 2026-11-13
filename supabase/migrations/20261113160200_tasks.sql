-- Our Family Hub — task definitions, revisions, criteria, assignments,
-- instances, events and photos.
--
-- Two cross-table invariants are enforced here, and neither can be a CHECK:
-- a Postgres CHECK constraint cannot reference another table. Both use the
-- composite-foreign-key pattern from HAL-1538 §2.2 — the child carries a copy
-- of the parent's column and a composite FK holds the copy true — with an
-- ordinary in-row CHECK then relating that copy to the rest of the row.

create table task_definitions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  location_space_id uuid references household_spaces (id) on delete restrict,
  pet_id uuid references pets (id) on delete restrict,
  -- HAL-1538 I2. Copied onto task_instances and held true by a composite FK.
  -- Because instances reference (id, occurrence_mode) and there is no
  -- ON UPDATE CASCADE, the database refuses to change a definition's mode
  -- while any instance exists — which is the correct guard, not an oversight.
  occurrence_mode occurrence_mode not null,
  current_revision_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  unique (id, household_id),
  unique (id, occurrence_mode),
  foreign key (location_space_id, household_id) references household_spaces (id, household_id),
  foreign key (pet_id, household_id) references pets (id, household_id)
);

-- HAL-1538 requirement 1 and S04: editing a definition must never retroactively
-- change whether yesterday's instance was satisfied. Edits create a new
-- immutable revision; each instance pins the revision it was created under.
-- Append-only is enforced by grants in the RLS migration, not by convention.
create table task_definition_revisions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references task_definitions (id) on delete restrict,
  household_id uuid not null references households (id) on delete restrict,
  revision_number integer not null,
  title text not null,
  details text,
  recurrence recurrence_kind not null,
  one_off_date date,
  -- A child may complete directly only where approval is not required
  -- (HAL-1538 requirement 7).
  requires_approval boolean not null default false,
  photo_required boolean not null default false,
  -- "Not Needed" is not a universal escape hatch: only definitions whose
  -- revision permits it may be marked that way (HAL-1538 requirement 7).
  -- Seeded true for exactly one definition, Lucy's poop pickup.
  not_needed_permitted boolean not null default false,
  occurrence_mode occurrence_mode not null,
  created_at timestamptz not null default now(),

  constraint task_definition_revisions_title_not_blank check (length(trim(title)) > 0),
  constraint task_definition_revisions_revision_number_positive check (revision_number > 0),
  constraint task_definition_revisions_one_off_has_date check (
    (recurrence = 'one_off') = (one_off_date is not null)
  ),
  unique (definition_id, revision_number),
  unique (id, definition_id),
  unique (id, household_id),
  foreign key (definition_id, household_id) references task_definitions (id, household_id),
  foreign key (definition_id, occurrence_mode) references task_definitions (id, occurrence_mode)
);

alter table task_definitions
  add constraint task_definitions_current_revision_fk
  foreign key (current_revision_id, id) references task_definition_revisions (id, definition_id)
  deferrable initially deferred;

-- The specific completion criteria a child reads before ticking the task.
-- HAL-1538 requirement 3: never an opaque "clean house" checkbox.
create table task_definition_criteria (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references task_definition_revisions (id) on delete cascade,
  household_id uuid not null references households (id) on delete restrict,
  display_order integer not null,
  text text not null,

  constraint task_definition_criteria_text_not_blank check (length(trim(text)) > 0),
  unique (revision_id, display_order),
  foreign key (revision_id, household_id) references task_definition_revisions (id, household_id)
);

create table task_assignments (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references task_definitions (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete restrict,
  household_id uuid not null references households (id) on delete restrict,

  unique (definition_id, member_id),
  foreign key (definition_id, household_id) references task_definitions (id, household_id),
  foreign key (member_id, household_id) references family_members (id, household_id)
);

create table task_instances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  definition_id uuid not null references task_definitions (id) on delete restrict,
  -- The revision this occurrence was created under. Pinned, so a later policy
  -- edit cannot move this instance between satisfied and blocking.
  definition_revision_id uuid not null references task_definition_revisions (id) on delete restrict,
  -- Copy of the definition's mode, held true by the composite FK below.
  occurrence_mode occurrence_mode not null,
  -- The household-LOCAL date. Never the server's date: the household timezone
  -- decides which day a row belongs to (HAL-1538 §3.1 Absent).
  occurrence_date date not null,
  -- Null means a shared, household-scoped occurrence.
  subject_member_id uuid references family_members (id) on delete restrict,
  state task_state not null default 'pending',

  submitted_by uuid references family_members (id) on delete restrict,
  submitted_at timestamptz,
  completed_by uuid references family_members (id) on delete restrict,
  completed_at timestamptz,
  not_applicable_reason not_applicable_reason,
  not_applicable_by uuid references family_members (id) on delete restrict,
  not_applicable_at timestamptz,
  exemption_note text,
  correction_note text,

  -- Optimistic-concurrency counter, distinct from definition_revision_id.
  -- Callers send the version they expect; see HAL-1538 requirement 10.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The invariant that stops one child's bedroom counting for another's.
  foreign key (definition_id, occurrence_mode) references task_definitions (id, occurrence_mode),
  foreign key (definition_id, household_id) references task_definitions (id, household_id),
  foreign key (subject_member_id, household_id) references family_members (id, household_id),
  foreign key (definition_revision_id, definition_id)
    references task_definition_revisions (id, definition_id),

  -- A shared definition has no subject; a per-member one must have exactly one.
  constraint task_instances_subject_matches_mode check (
    (occurrence_mode = 'shared' and subject_member_id is null)
    or (occurrence_mode = 'per_member' and subject_member_id is not null)
  ),
  -- HAL-1538 §3.1 Null: a completed row with no credited actor is a data defect.
  constraint task_instances_completed_has_actor check (
    state <> 'completed' or (completed_by is not null and completed_at is not null)
  ),
  -- An exemption with no parent, or a "Not Needed" with no actor, is a data
  -- defect — and both satisfy a requirement, so an unattributed one would be a
  -- silent hole in readiness.
  constraint task_instances_not_applicable_has_actor check (
    state <> 'not_applicable'
    or (not_applicable_reason is not null
        and not_applicable_by is not null
        and not_applicable_at is not null)
  ),
  constraint task_instances_not_applicable_fields_only_when_applicable check (
    state = 'not_applicable'
    or (not_applicable_reason is null
        and not_applicable_by is null
        and not_applicable_at is null
        and exemption_note is null)
  ),
  constraint task_instances_version_positive check (version > 0),

  -- Composite-FK target for task_events and task_photos.
  unique (id, household_id)
);

-- HAL-1538 §3.1 Null and requirement 9. Two partial indexes, not one coalesced
-- index: COALESCE(subject_member_id, nil) yields distinct keys for a null and a
-- non-null subject, so a single index would permit a shared row and per-member
-- rows to coexist for one definition and date, and the nil sentinel is itself a
-- legal member id. Each grain gets its own index; the mode check above closes
-- the mixed pair.
create unique index task_instances_shared_grain_key
  on task_instances (definition_id, occurrence_date)
  where subject_member_id is null;

create unique index task_instances_per_member_grain_key
  on task_instances (definition_id, occurrence_date, subject_member_id)
  where subject_member_id is not null;

create index task_instances_household_date_idx
  on task_instances (household_id, occurrence_date);

-- Immutable audit. Insert-only by grant (see the RLS migration).
create table task_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  task_instance_id uuid not null references task_instances (id) on delete restrict,
  actor_member_id uuid references family_members (id) on delete restrict,
  from_state task_state,
  to_state task_state not null,
  note text,
  created_at timestamptz not null default now(),

  foreign key (task_instance_id, household_id) references task_instances (id, household_id),
  foreign key (actor_member_id, household_id) references family_members (id, household_id)
);

create index task_events_instance_idx on task_events (task_instance_id, created_at);

create table task_photos (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  -- Exactly one subject: a dated task instance or a space. A space photo has
  -- no task instance, and a task photo has no space.
  task_instance_id uuid references task_instances (id) on delete restrict,
  space_id uuid references household_spaces (id) on delete restrict,
  storage_path text not null,
  uploaded_by uuid not null references family_members (id) on delete restrict,
  byte_size integer not null,
  content_type text not null,
  created_at timestamptz not null default now(),

  constraint task_photos_exactly_one_subject check (
    (task_instance_id is not null)::int + (space_id is not null)::int = 1
  ),
  constraint task_photos_byte_size_positive check (byte_size > 0),
  foreign key (task_instance_id, household_id) references task_instances (id, household_id),
  foreign key (space_id, household_id) references household_spaces (id, household_id),
  foreign key (uploaded_by, household_id) references family_members (id, household_id)
);
