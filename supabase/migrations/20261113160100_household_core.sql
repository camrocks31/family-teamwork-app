-- Our Family Hub — household, members, credentials, spaces, pets.
--
-- The denormalization guard used throughout this schema (HAL-1538 §2.2):
-- every table carries household_id so each RLS policy is a single-column
-- comparison rather than a multi-hop join. That copy is never trusted to a
-- trigger or to application code. Each parent table carries
--   unique (id, household_id)
-- and each child carries
--   foreign key (<parent_id>, household_id) references <parent> (id, household_id)
-- so the database itself refuses a row whose copy disagrees with its parent,
-- and two independently valid ids from different households cannot combine.

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- IANA zone. HAL-1538 §3.1 Absent: a missing timezone must refuse to
  -- materialize a day rather than fall back to UTC, so it is NOT NULL here
  -- and the absent case is unrepresentable.
  timezone text not null,
  -- School-morning window, start-inclusive and end-exclusive, in household
  -- local time (HAL-1538 requirement 5). Null means no window configured,
  -- which makes the school-morning group inapplicable and is flagged in
  -- settings rather than guessed.
  morning_window_start time,
  morning_window_end time,
  created_at timestamptz not null default now(),

  constraint households_timezone_not_blank check (length(trim(timezone)) > 0),
  constraint households_morning_window_together check (
    (morning_window_start is null) = (morning_window_end is null)
  ),
  constraint households_morning_window_ordered check (
    morning_window_start is null or morning_window_start < morning_window_end
  )
);

create table family_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  -- HAL-1538 I4: the configured display name is the only name stored. There is
  -- deliberately no legal-name or relationship-status column anywhere in this
  -- schema; a parent's sign-in email lives in auth.users and is never rendered.
  display_name text not null,
  role member_role not null,
  avatar_emoji text,
  avatar_photo_path text,
  accent_color text,
  is_active boolean not null default true,
  -- Parents link to a Supabase Auth user. Children never have logins: they are
  -- reached by profile selection plus a PIN on an enrolled device (slice 5).
  auth_user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint family_members_display_name_not_blank check (length(trim(display_name)) > 0),
  constraint family_members_child_has_no_login check (
    role = 'parent' or auth_user_id is null
  ),
  unique (household_id, display_name),
  -- Composite-FK target, so children of this table prove same-household.
  unique (id, household_id),
  -- Composite-FK target for "this member is a parent", used where only a
  -- parent may be recorded as the actor.
  unique (id, role)
);

-- HAL-1538 §2.2 and AC9: the PIN hash is NOT a column on family_members.
-- Postgres RLS filters rows, not columns, and a device session must read member
-- rows to render profile tiles — so a hash stored there would be readable by
-- the very principal it defends against. It lives in its own table with no
-- client grant at all; only SECURITY DEFINER functions reach it.
create table member_credentials (
  member_id uuid primary key references family_members (id) on delete cascade,
  household_id uuid not null references households (id) on delete restrict,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),

  constraint member_credentials_failed_attempts_non_negative check (failed_attempts >= 0),
  foreign key (member_id, household_id) references family_members (id, household_id)
);

-- A floor is a space with a null parent (HAL-1538 §2.2). This keeps floors
-- editable data rather than a hard-coded vocabulary: adding a basement is a
-- row, not a migration.
create table household_spaces (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  parent_space_id uuid references household_spaces (id) on delete restrict,
  name text not null,
  icon text,
  display_order integer not null default 0,
  photo_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint household_spaces_name_not_blank check (length(trim(name)) > 0),
  constraint household_spaces_not_own_parent check (parent_space_id is distinct from id),
  unique (household_id, name),
  unique (id, household_id),
  foreign key (parent_space_id, household_id) references household_spaces (id, household_id)
);

create index household_spaces_parent_idx on household_spaces (parent_space_id);

create table pets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  name text not null,
  species text,
  avatar_emoji text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint pets_name_not_blank check (length(trim(name)) > 0),
  unique (household_id, name),
  unique (id, household_id)
);
