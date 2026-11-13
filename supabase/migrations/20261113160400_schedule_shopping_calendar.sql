-- Our Family Hub — school calendar, shopping lists, calendar events.

-- HAL-1538 requirement 5. A null member_id applies to every member; a row
-- naming a member overrides it at the same grain; a date override outranks a
-- weekly rule. The precedence itself is applied by applicable_at in slice 3 —
-- this table only has to make the rules expressible and non-duplicable.
create table schedule_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  member_id uuid references family_members (id) on delete cascade,
  rule_kind schedule_rule_kind not null,
  -- ISO day of week, 1 = Monday .. 7 = Sunday, for weekly rules.
  day_of_week smallint,
  -- The single local date a date override applies to.
  override_date date,
  is_school_day boolean not null,
  note text,
  created_at timestamptz not null default now(),

  constraint schedule_rules_shape check (
    case rule_kind
      when 'weekly' then day_of_week between 1 and 7 and override_date is null
      when 'date_override' then override_date is not null and day_of_week is null
    end
  ),
  foreign key (member_id, household_id) references family_members (id, household_id)
);

-- One rule per grain. Partial indexes rather than a key over nullable columns,
-- so a household-wide rule and a member-specific rule can coexist (that is the
-- override) while duplicates at the same grain cannot.
create unique index schedule_rules_weekly_household_key
  on schedule_rules (household_id, day_of_week)
  where rule_kind = 'weekly' and member_id is null;

create unique index schedule_rules_weekly_member_key
  on schedule_rules (household_id, member_id, day_of_week)
  where rule_kind = 'weekly' and member_id is not null;

create unique index schedule_rules_override_household_key
  on schedule_rules (household_id, override_date)
  where rule_kind = 'date_override' and member_id is null;

create unique index schedule_rules_override_member_key
  on schedule_rules (household_id, member_id, override_date)
  where rule_kind = 'date_override' and member_id is not null;

-- HAL-1538 requirement 15.
create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  list_kind shopping_list_kind not null,
  name text not null,
  category text,
  quantity integer,
  notes text,
  created_by uuid not null references family_members (id) on delete restrict,
  created_at timestamptz not null default now(),

  -- The three purchase facts are one fact. All present or all absent: a row
  -- cannot be purchased with no purchaser, or unpurchased with one.
  purchased boolean not null default false,
  purchased_by uuid references family_members (id) on delete restrict,
  purchased_at timestamptz,

  constraint shopping_items_name_not_blank check (length(trim(name)) > 0),
  constraint shopping_items_quantity_positive check (quantity is null or quantity > 0),
  constraint shopping_items_purchase_all_or_nothing check (
    (purchased and purchased_by is not null and purchased_at is not null)
    or (not purchased and purchased_by is null and purchased_at is null)
  ),
  foreign key (created_by, household_id) references family_members (id, household_id),
  foreign key (purchased_by, household_id) references family_members (id, household_id)
);

create index shopping_items_open_idx
  on shopping_items (household_id, list_kind)
  where not purchased;

create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  description text,
  location text,
  visibility calendar_visibility not null default 'household',
  created_by uuid not null references family_members (id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint calendar_events_title_not_blank check (length(trim(title)) > 0),
  constraint calendar_events_ordered check (ends_at is null or starts_at <= ends_at),
  unique (id, household_id),
  foreign key (created_by, household_id) references family_members (id, household_id)
);

create index calendar_events_upcoming_idx on calendar_events (household_id, starts_at);

-- Attendees are rows, never an inline list on the event: an inline set breaks
-- 1NF, gives no foreign key to family_members, and cannot be queried per member
-- for the dashboard read. Splitting it later would be a destructive migration,
-- so it is split now while the table is empty.
create table calendar_event_attendees (
  event_id uuid not null references calendar_events (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete cascade,
  household_id uuid not null references households (id) on delete restrict,

  primary key (event_id, member_id),
  foreign key (event_id, household_id) references calendar_events (id, household_id),
  foreign key (member_id, household_id) references family_members (id, household_id)
);
