-- Our Family Hub — a job can say why it matters, and some jobs are chosen
-- rather than given.
--
-- The app had become a well-built instrument for the wrong half of the
-- problem. The readiness engine answers "is the house ready" precisely, and
-- rewards answer "have you done enough", and between them a child's own list
-- was something that simply arrived: titled, unexplained, and assigned.
-- Self-determination theory is unambiguous that a wholly assigned list with
-- no stated rationale sits at EXTERNAL REGULATION, the least internalized
-- form of extrinsic motivation, and that three specific conditions move a
-- genuinely dull task toward identified regulation — a meaningful rationale,
-- honest acknowledgement that it is dull, and the absence of controlling
-- language (Deci, Eghrari, Patrick & Leone, 1994).
--
-- Nobody will ever enjoy cleaning a toilet. That is not the target. The
-- target is the next two rungs up: "I see why this matters" and "this is who
-- I am". Those are reachable, and this migration is the mechanism.
--
-- WHY. A reason lives on the REVISION, not the definition, for the same
-- reason title and details do: an edit this afternoon must not rewrite what
-- this morning's instance said.
--
-- CHOICE. A definition is either 'assigned' — a parent says who — or 'open',
-- and a child takes it. Both write the SAME table, task_assignments, so
-- "whose job is this" gains a writer and no second source of truth; the
-- materializer and the readiness engine are untouched and keep reading the
-- one place. A parent sets how many open jobs each person is ASKED to hold;
-- the shortfall is reported and never enforced, because locking a release
-- traps a child who wants to swap one job for another, and because a number
-- the app enforces is not a choice.
--
-- POINTS. counts_toward_rewards also lives on the revision, and that
-- placement is load-bearing rather than tidy. evaluate_rewards counts over a
-- whole week. On the definition, a parent unticking a job on Friday would
-- remove Monday's completed work from that week's total and un-earn a reward
-- a child had already been told they had. The schema's own rule, stated at
-- the head of the tasks migration, is that editing a definition must never
-- retroactively change whether yesterday's instance was satisfied — which is
-- why requires_approval, photo_required and not_needed_permitted all live on
-- the revision too. This is the same fact about the same kind of flag.
--
-- The point of the flag: never attach points to the things you want them to
-- love. Toilets and bins can be paid for cheaply, because there was no
-- intrinsic motivation there to crowd out. Cooking, reading and helping a
-- sibling must not be, and this is the switch that keeps them out.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table task_definition_revisions add column reason text;

comment on column task_definition_revisions.reason is
  'One honest sentence a child reads: why this job exists. On the revision, '
  'not the definition, so editing it never rewrites what an earlier day said.';

alter table task_definition_revisions
  add column counts_toward_rewards boolean not null default true;

comment on column task_definition_revisions.counts_toward_rewards is
  'Whether a completed instance pinned to this revision counts toward a '
  'reward. Pinned, because evaluate_rewards counts over a week and a flag on '
  'the definition would let a Friday edit un-earn Monday''s work.';

-- A definition is either assigned by a parent or open for a child to take.
-- Two values, like occurrence_mode, and an enum for the same reason: it is a
-- closed set owned by the application's rules, not household-editable data.
create type assignment_mode as enum ('assigned', 'open');

alter table task_definitions
  add column assignment_mode assignment_mode not null default 'assigned';

comment on column task_definitions.assignment_mode is
  'assigned: a parent says who does it. open: a child takes it. Default '
  'assigned, so every job that existed before this migration is unchanged.';

-- An open job must be per-member: a shared job has no subject to hold it, so
-- "taking" one would record an assignment the materializer ignores. Both
-- columns live natively on this row, so an ordinary in-row CHECK is enough
-- and no composite foreign key is involved.
alter table task_definitions
  add constraint task_definitions_open_is_per_member
  check (assignment_mode = 'assigned' or occurrence_mode = 'per_member');

alter table family_members
  add column min_chosen_jobs integer not null default 0;

alter table family_members
  add constraint family_members_min_chosen_jobs_non_negative
  check (min_chosen_jobs >= 0);

comment on column family_members.min_chosen_jobs is
  'How many open jobs this person is ASKED to hold. Reported, never '
  'enforced. Set by a parent, like simple_view — not derived from age, '
  'because this schema stores no birth date and would not use one here.';


-- ---------------------------------------------------------------------------
-- The editor
-- ---------------------------------------------------------------------------

-- The old signature goes first, so no overload can be resolved by accident —
-- the same reason and the same wording as the transitions migration. This is
-- not housekeeping: the database tests call save_task POSITIONALLY with three
-- and four arguments, and two candidates differing only in trailing defaults
-- would make every one of those calls ambiguous (42725). The grants allowlist
-- would not catch it either, because it selects distinct function NAMES.
drop function if exists save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[]);

create or replace function save_task(
  p_definition_id uuid,
  p_title text,
  p_criteria text[],
  p_space_id uuid default null,
  p_pet_id uuid default null,
  p_occurrence_mode occurrence_mode default 'shared',
  p_recurrence recurrence_kind default 'daily',
  p_one_off_date date default null,
  p_details text default null,
  p_requires_approval boolean default false,
  p_photo_required boolean default false,
  p_not_needed_permitted boolean default false,
  p_subject_member_ids uuid[] default null,
  p_reason text default null,
  p_assignment_mode assignment_mode default 'assigned',
  p_counts_toward_rewards boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_definition uuid;
  v_revision uuid;
  v_next_number integer;
  v_member uuid;
  v_text text;
  v_order integer := 0;
  v_reason text;
begin
  if not app_is_parent() then
    raise exception 'only a parent can change tasks'
      using errcode = 'insufficient_privilege';
  end if;
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;

  if p_title is null or btrim(p_title) = '' then
    raise exception 'a task needs a name' using errcode = 'invalid_parameter_value';
  end if;
  if p_criteria is null or array_length(p_criteria, 1) is null then
    raise exception 'a task needs at least one thing to check off'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_space_id is not null and p_pet_id is not null then
    raise exception 'a task belongs to a room or to a pet, not both'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_recurrence = 'one_off' and p_one_off_date is null then
    raise exception 'a one-off task needs a date' using errcode = 'invalid_parameter_value';
  end if;

  -- A blank reason is no reason, so the page never renders an empty line.
  --
  -- The character set is given explicitly. Bare btrim() strips SPACES only, so
  -- a reason of a single tab or newline survived it and was stored — caught by
  -- the test for this, not by reading the code.
  v_reason := nullif(btrim(coalesce(p_reason, ''), E' \t\n\r\f'), '');

  if p_space_id is not null and not exists (
    select 1 from household_spaces where id = p_space_id and household_id = v_household
  ) then
    raise exception 'no such room in your household' using errcode = 'no_data_found';
  end if;
  if p_pet_id is not null and not exists (
    select 1 from pets where id = p_pet_id and household_id = v_household
  ) then
    raise exception 'no such pet in your household' using errcode = 'no_data_found';
  end if;

  if p_definition_id is null then
    insert into task_definitions (
      household_id, location_space_id, pet_id, occurrence_mode,
      assignment_mode
    )
    values (v_household, p_space_id, p_pet_id, p_occurrence_mode,
            p_assignment_mode)
    returning id into v_definition;
  else
    -- The occurrence mode is written on every save, which is why the editor
    -- has to send the one the row already has: a save that omitted it would
    -- default to 'shared' and, on an open job, fail the new CHECK.
    update task_definitions
       set location_space_id = p_space_id,
           pet_id = p_pet_id,
           occurrence_mode = p_occurrence_mode,
           assignment_mode = p_assignment_mode
     where id = p_definition_id and household_id = v_household
    returning id into v_definition;
    if v_definition is null then
      raise exception 'no such task in your household' using errcode = 'no_data_found';
    end if;
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next_number
    from task_definition_revisions where definition_id = v_definition;

  insert into task_definition_revisions (
    definition_id, household_id, revision_number, title, details,
    recurrence, one_off_date, requires_approval, photo_required,
    not_needed_permitted, occurrence_mode, reason, counts_toward_rewards
  )
  values (
    v_definition, v_household, v_next_number, btrim(p_title), p_details,
    p_recurrence, p_one_off_date, p_requires_approval, p_photo_required,
    p_not_needed_permitted, p_occurrence_mode, v_reason,
    p_counts_toward_rewards
  )
  returning id into v_revision;

  foreach v_text in array p_criteria loop
    if btrim(v_text) <> '' then
      v_order := v_order + 1;
      insert into task_definition_criteria (revision_id, household_id, display_order, text)
      values (v_revision, v_household, v_order, btrim(v_text));
    end if;
  end loop;
  if v_order = 0 then
    raise exception 'a task needs at least one thing to check off'
      using errcode = 'invalid_parameter_value';
  end if;

  update task_definitions
     set current_revision_id = v_revision
   where id = v_definition;

  -- Who it is for — and NOT for an open job.
  --
  -- The replace is wholesale: the caller sends the list it wants and a
  -- half-applied change is the kind of thing nobody notices until a child's
  -- task stops appearing. That is right for an assigned job and catastrophic
  -- for an open one, because the editor always sends an array, pre-filled
  -- when the form was opened. A parent saving nothing but a new reason would
  -- delete every choice the children had made since — so for a job that is
  -- open AFTER this save, their choices are left alone.
  --
  -- Switching a job back to 'assigned' therefore reasserts the parent's list,
  -- which is the only way to take back a job the children had been choosing.
  if p_subject_member_ids is not null and p_assignment_mode <> 'open' then
    delete from task_assignments where definition_id = v_definition;
    foreach v_member in array p_subject_member_ids loop
      if not exists (
        select 1 from family_members
         where id = v_member and household_id = v_household and is_active
      ) then
        raise exception 'no such family member in your household'
          using errcode = 'no_data_found';
      end if;
      insert into task_assignments (definition_id, member_id, household_id)
      values (v_definition, v_member, v_household);
    end loop;
  end if;

  return v_definition;
end;
$$;


-- ---------------------------------------------------------------------------
-- Taking a job, and giving it back
-- ---------------------------------------------------------------------------

-- Who is acting, and with what authority. ONE value, derived in ONE place,
-- because an authority re-derived at a second check is an authority that can
-- disagree with itself — and here the two answers differ.
--
-- The order is the entire safeguard. /me runs a CHILD's actor token on top of
-- a PARENT's authenticated browser session: that is what the kiosk identity
-- is for, and it means app_is_parent() is true while a seven-year-old is
-- standing at the iPad. So the token is resolved FIRST, and a resolved token
-- is never a parent call whatever sits underneath it. Only a session with no
-- token at all may act as a parent.
--
-- A draft of this function checked app_is_parent() again at the target
-- comparison. It read true on the kitchen tablet, and a child could have
-- assigned a job to a sibling. Hence: resolve once, return both values
-- together, and never call app_is_parent() downstream.
--
-- Granted to NOBODY. It is only safe inside a definer function that has
-- already established the household.
create or replace function app_choice_principal(p_actor_token text)
returns table (actor_id uuid, is_parent boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid;
  v_is_parent boolean;
begin
  v_actor := app_resolve_actor(p_actor_token);
  if v_actor is not null then
    v_is_parent := false;
  else
    v_actor := app_current_member_id();
    v_is_parent := app_is_parent();
  end if;
  if v_actor is null then
    raise exception 'no acting family member for this session'
      using errcode = 'insufficient_privilege';
  end if;
  return query select v_actor, v_is_parent;
end;
$$;

revoke all on function app_choice_principal(text) from public, anon, authenticated;


-- Lock an open job and refuse everything it is not. Shared by both callers so
-- "which jobs may be chosen" has one implementation: giving back a job a
-- PARENT assigned would take its blocker out of readiness with it, which is
-- the hole this check closes on the release side.
--
-- The lock is the same definition row save_task takes through its UPDATE, so
-- choose, release and a parent's edit serialize instead of racing a mode
-- change between the check and the write.
--
-- Granted to NOBODY.
create or replace function app_lock_open_job(
  p_definition_id uuid,
  p_household_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_def task_definitions%rowtype;
begin
  select * into v_def from task_definitions
   where id = p_definition_id and household_id = p_household_id
   for update;
  -- Deliberately the same message for a job in another household and a job
  -- that does not exist: neither answer may tell a caller which it was.
  if not found then
    raise exception 'no such job in your household' using errcode = 'no_data_found';
  end if;
  if not v_def.is_active then
    raise exception 'that job is stopped' using errcode = 'invalid_parameter_value';
  end if;
  -- The materializer skips a definition with no current revision, so an
  -- assignment here would be a job taken that never appears.
  if v_def.current_revision_id is null then
    raise exception 'that job has nothing set up yet'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_def.assignment_mode <> 'open' then
    raise exception 'that job is not one anyone can take'
      using errcode = 'insufficient_privilege';
  end if;
  return v_def.id;
end;
$$;

revoke all on function app_lock_open_job(uuid, uuid) from public, anon, authenticated;


-- I'll take that one.
create or replace function choose_job(
  p_definition_id uuid,
  p_member_id uuid default null,
  p_actor_token text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_actor uuid;
  v_actor_is_parent boolean;
  v_target uuid;
begin
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;

  select actor_id, is_parent into v_actor, v_actor_is_parent
    from app_choice_principal(p_actor_token);

  v_target := coalesce(p_member_id, v_actor);
  -- The authority established above, never a fresh app_is_parent().
  if v_target is distinct from v_actor and not v_actor_is_parent then
    raise exception 'only a parent can choose a job for somebody else'
      using errcode = 'insufficient_privilege';
  end if;

  -- DEFINER bypasses row level security, so BOTH principals are checked
  -- against this household. app_resolve_actor validates the token, the
  -- session, its expiry and the device, but never the member's household.
  if not exists (
    select 1 from family_members
     where id = v_actor and household_id = v_household and is_active
  ) then
    raise exception 'that profile is not part of this household'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from family_members
     where id = v_target and household_id = v_household and is_active
  ) then
    raise exception 'no such family member in your household'
      using errcode = 'no_data_found';
  end if;

  perform app_lock_open_job(p_definition_id, v_household);

  -- A double tap is not an error.
  insert into task_assignments (definition_id, member_id, household_id)
  values (p_definition_id, v_target, v_household)
  on conflict (definition_id, member_id) do nothing;

  -- So it appears now rather than tomorrow. Materialization is reused, not
  -- reimplemented: it is idempotent and it is the only thing that knows how
  -- an instance is built.
  perform ensure_day_materialized(v_household, app_household_today(v_household));
end;
$$;

revoke all on function choose_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function choose_job(uuid, uuid, text) to authenticated;


-- Actually, somebody else can have it.
create or replace function release_job(
  p_definition_id uuid,
  p_member_id uuid default null,
  p_actor_token text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_actor uuid;
  v_actor_is_parent boolean;
  v_target uuid;
  v_today date;
begin
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;

  select actor_id, is_parent into v_actor, v_actor_is_parent
    from app_choice_principal(p_actor_token);

  v_target := coalesce(p_member_id, v_actor);
  if v_target is distinct from v_actor and not v_actor_is_parent then
    raise exception 'only a parent can give back a job for somebody else'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from family_members
     where id = v_actor and household_id = v_household and is_active
  ) then
    raise exception 'that profile is not part of this household'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from family_members
     where id = v_target and household_id = v_household and is_active
  ) then
    raise exception 'no such family member in your household'
      using errcode = 'no_data_found';
  end if;

  -- The same eligibility as taking one. "Same authority rule" would NOT have
  -- implied this, and without it a child could give back a job a parent
  -- assigned and delete its instance.
  perform app_lock_open_job(p_definition_id, v_household);

  v_today := app_household_today(v_household);

  delete from task_assignments
   where definition_id = p_definition_id
     and member_id = v_target
     and household_id = v_household;

  -- Only a PRISTINE instance is removed — one that records nothing.
  --
  -- "pending with no events" is not enough, and the two ways it fails pull in
  -- opposite directions. A photo is attached while the instance is still
  -- pending, because photo_required is only enforced at submit and complete,
  -- and task_photos is ON DELETE RESTRICT — so that delete would raise 23503
  -- and roll back the whole release, leaving the assignment behind. Meanwhile
  -- task_operations is ON DELETE CASCADE, so the replay ledger would vanish
  -- without a sound. And because a parent writes task_instances directly
  -- under row level security, a pending row can carry a correction note with
  -- no event at all.
  --
  -- Anything that is not pristine is simply left where it is. The assignment
  -- still goes; today's work stays on the child's list until it is finished
  -- or the day turns over, and it still counts for them, because the work was
  -- genuinely theirs when they did it.
  delete from task_instances ti
   where ti.definition_id = p_definition_id
     and ti.subject_member_id = v_target
     and ti.household_id = v_household
     and ti.occurrence_date >= v_today
     and ti.state = 'pending'
     and ti.version = 1
     and ti.submitted_by is null
     and ti.submitted_at is null
     and ti.completed_by is null
     and ti.completed_at is null
     and ti.correction_note is null
     and ti.not_applicable_reason is null
     and ti.not_applicable_by is null
     and ti.not_applicable_at is null
     and ti.exemption_note is null
     and not exists (select 1 from task_events e where e.task_instance_id = ti.id)
     and not exists (select 1 from task_photos ph where ph.task_instance_id = ti.id)
     and not exists (select 1 from task_operations o where o.task_instance_id = ti.id);
end;
$$;

revoke all on function release_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function release_job(uuid, uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- What a child sees
-- ---------------------------------------------------------------------------

-- Today's jobs, with the reason on each, plus the jobs going spare and the
-- ones this person has taken.
--
-- `held` is returned independently of today's applicability and completion
-- state, and that is not an oversight. The job rows cannot serve as the list
-- of what you hold: they carry an instance_id and no definition_id, they are
-- filtered through app_instance_applies_at, and the page hides anything
-- completed. Without `held`, a child could not give back a job they had
-- already finished, or one that does not apply today.
--
-- `available` and `held` read the CURRENT revision, because no instance pins
-- one for a job nobody has taken yet. That is deliberately the opposite of
-- the rule for a job already materialized, where the pinned revision wins.
create or replace function list_my_jobs(
  p_member_id uuid,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
  v_today date;
  v_member family_members%rowtype;
  v_jobs jsonb;
  v_available jsonb;
  v_held jsonb;
  v_chosen integer;
begin
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;

  select * into v_member from family_members
   where id = p_member_id and household_id = v_household and is_active;
  if not found then
    raise exception 'no such family member in your household' using errcode = 'no_data_found';
  end if;

  v_today := app_household_today(v_household);

  select coalesce(jsonb_agg(j order by j->>'title'), '[]'::jsonb) into v_jobs
    from (
      select jsonb_build_object(
        'instance_id', ti.id,
        'title', r.title,
        -- From the PINNED revision, so a reason edited this afternoon does
        -- not rewrite what this morning's job said.
        'reason', r.reason,
        'state', ti.state,
        'version', ti.version,
        'correction_note', ti.correction_note,
        'mine', coalesce(ti.subject_member_id = p_member_id, false),
        'where', sp.name,
        'criteria', (
          select coalesce(jsonb_agg(c.text order by c.display_order), '[]'::jsonb)
            from task_definition_criteria c
           where c.revision_id = ti.definition_revision_id
        )
      ) as j
        from task_instances ti
        join task_definition_revisions r on r.id = ti.definition_revision_id
        join task_definitions td on td.id = ti.definition_id
        left join household_spaces sp on sp.id = td.location_space_id
       where ti.household_id = v_household
         and ti.occurrence_date = v_today
         and (ti.subject_member_id = p_member_id or ti.subject_member_id is null)
         and app_instance_applies_at(ti.id, p_at)
    ) rows;

  select count(*)::integer into v_chosen
    from task_assignments ta
    join task_definitions td on td.id = ta.definition_id
   where ta.member_id = p_member_id
     and ta.household_id = v_household
     and td.is_active
     and td.assignment_mode = 'open';

  select coalesce(jsonb_agg(d order by d->>'title'), '[]'::jsonb) into v_held
    from (
      select jsonb_build_object(
        'definition_id', td.id,
        'title', r.title,
        'reason', r.reason,
        'where', sp.name,
        'criteria', (
          select coalesce(jsonb_agg(c.text order by c.display_order), '[]'::jsonb)
            from task_definition_criteria c
           where c.revision_id = td.current_revision_id
        )
      ) as d
        from task_definitions td
        join task_assignments ta
          on ta.definition_id = td.id and ta.member_id = p_member_id
        join task_definition_revisions r on r.id = td.current_revision_id
        left join household_spaces sp on sp.id = td.location_space_id
       where td.household_id = v_household
         and td.is_active
         and td.assignment_mode = 'open'
    ) rows;

  select coalesce(jsonb_agg(d order by d->>'title'), '[]'::jsonb) into v_available
    from (
      select jsonb_build_object(
        'definition_id', td.id,
        'title', r.title,
        'reason', r.reason,
        'where', sp.name,
        'criteria', (
          select coalesce(jsonb_agg(c.text order by c.display_order), '[]'::jsonb)
            from task_definition_criteria c
           where c.revision_id = td.current_revision_id
        )
      ) as d
        from task_definitions td
        join task_definition_revisions r on r.id = td.current_revision_id
        left join household_spaces sp on sp.id = td.location_space_id
       where td.household_id = v_household
         and td.is_active
         and td.assignment_mode = 'open'
         and not exists (
           select 1 from task_assignments ta
            where ta.definition_id = td.id and ta.member_id = p_member_id
         )
    ) rows;

  return jsonb_build_object(
    'simple_view', v_member.simple_view,
    'display_name', v_member.display_name,
    'accent_color', v_member.accent_color,
    'avatar_emoji', v_member.avatar_emoji,
    'min_chosen_jobs', v_member.min_chosen_jobs,
    'chosen_count', v_chosen,
    'available', v_available,
    'held', v_held,
    'jobs', v_jobs
  );
end;
$$;

revoke all on function list_my_jobs(uuid, timestamptz) from public, anon, authenticated;
grant execute on function list_my_jobs(uuid, timestamptz) to authenticated;


-- ---------------------------------------------------------------------------
-- Rewards count only the jobs points are meant for
-- ---------------------------------------------------------------------------

-- The join is onto the instance's PINNED revision, not the definition's
-- current one. That is the whole point of the change: a reward period is a
-- week, so reading the current flag would let Friday's edit reach back and
-- un-earn Monday's work.
--
-- No is_active filter is added. The evaluator deliberately counts completed
-- instances of retired definitions: the child did the work, and stopping a
-- job later does not undo it.
create or replace function evaluate_rewards(
  p_household_id uuid,
  p_member_id uuid default null,
  p_evaluated_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_today date;
  v_result jsonb;
begin
  if p_household_id is distinct from app_current_household_id() then
    raise exception 'not your household' using errcode = 'insufficient_privilege';
  end if;

  v_today := (p_evaluated_at at time zone (
    select timezone from households where id = p_household_id
  ))::date;

  select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.name, r.display_name), '[]'::jsonb)
    into v_result
  from (
    select
      rw.id,
      rw.name,
      rw.icon,
      rw.period,
      rw.threshold_count,
      fm.id as member_id,
      fm.display_name,
      counted.done,
      counted.done >= rw.threshold_count as earned,
      greatest(rw.threshold_count - counted.done, 0) as still_needed
    from rewards rw
    join family_members fm
      on fm.household_id = rw.household_id
     and fm.is_active
     and fm.role = 'child'
     and (rw.member_id is null or rw.member_id = fm.id)
    cross join lateral (
      select count(*)::integer as done
        from task_instances ti
        join task_definition_revisions rev on rev.id = ti.definition_revision_id
       where ti.household_id = rw.household_id
         and ti.subject_member_id = fm.id
         and ti.state = 'completed'
         and rev.counts_toward_rewards
         and case rw.period
               when 'day' then ti.occurrence_date = v_today
               when 'week' then date_trunc('week', ti.occurrence_date)
                              = date_trunc('week', v_today)
             end
    ) counted
    where rw.household_id = p_household_id
      and rw.is_active
      and (p_member_id is null or fm.id = p_member_id)
  ) r;

  return v_result;
end;
$$;

revoke all on function evaluate_rewards(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function evaluate_rewards(uuid, uuid, timestamptz) to authenticated;


-- The new signature, granted by name as the default-deny migration requires.
revoke all on function save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[], text, assignment_mode, boolean) from public, anon, authenticated;
grant execute on function save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[], text, assignment_mode, boolean) to authenticated;
