-- Our Family Hub — stop showing a child jobs that do not apply today.
--
-- Found by walking the app on a Saturday morning. Two separate things were
-- wrong, and both told the family something untrue:
--
--   1. MY JOBS LISTED SCHOOL-MORNING TASKS ON A SATURDAY. The page read
--      task_instances directly and showed everything dated today. The engine
--      had it right — app_instance_applies_at returned false for every one of
--      them — but nothing asked. So Hazel was told to pack a school lunch on
--      the weekend.
--
--      Instances exist for every active task every day ON PURPOSE:
--      applicability is decided at call time and never written down, so a snow
--      day declared at 07:30 takes effect at 07:30. The cost of that choice is
--      that any screen listing instances MUST ask whether they apply. The
--      answer has one implementation, in the database, and list_my_jobs is how
--      a client reaches it.
--
--   2. THE BANNER SAID "SCHOOL MORNING" ON A SATURDAY. app_in_morning_window
--      is a clock window and nothing more — it never asks whether today is a
--      school day — and the dashboard labelled it as though it did.
--      app_today_is_school_day() lets the banner tell the truth.
--
-- app_is_school_day takes a household and a member, so it stays private: a
-- caller could name somebody else's. This wrapper takes no arguments and
-- answers only for the caller's own household, which is what makes it safe to
-- expose — the same line drawn for app_current_household_id and app_is_parent.

create or replace function app_today_is_school_day()
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select app_is_school_day(
    app_current_household_id(),
    app_current_member_id(),
    app_household_today(app_current_household_id())
  );
$$;

revoke all on function app_today_is_school_day() from public, anon, authenticated;
grant execute on function app_today_is_school_day() to authenticated;


-- Today's jobs for one child, with the ones that do not apply left out.
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
begin
  v_household := app_current_household_id();
  if v_household is null then
    raise exception 'no household for this session' using errcode = 'insufficient_privilege';
  end if;
  -- DEFINER bypasses row level security, so the member is checked against the
  -- caller's household rather than taken on trust.
  if not exists (
    select 1 from family_members
     where id = p_member_id and household_id = v_household and is_active
  ) then
    raise exception 'no such family member in your household' using errcode = 'no_data_found';
  end if;

  v_today := app_household_today(v_household);

  return (
    select coalesce(jsonb_agg(j order by j->>'title'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'instance_id', ti.id,
          'title', r.title,
          'state', ti.state,
          'version', ti.version,
          'correction_note', ti.correction_note,
          -- Whose it is. A shared job belongs to the house, and the
          -- difference matters to a child who has done their own.
          --
          -- coalesce, because a shared instance has a NULL subject and
          -- `null = uuid` is null, not false — so this field came back null
          -- and only worked by accident, javascript treating it as falsy.
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
           -- Theirs, or the whole house's.
           and (ti.subject_member_id = p_member_id or ti.subject_member_id is null)
           -- The point of this function.
           and app_instance_applies_at(ti.id, p_at)
      ) rows
  );
end;
$$;

revoke all on function list_my_jobs(uuid, timestamptz) from public, anon, authenticated;
grant execute on function list_my_jobs(uuid, timestamptz) to authenticated;
