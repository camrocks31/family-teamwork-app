-- Our Family Hub — one job at a time, for the youngest.
--
-- A list of four cards is a task list to an eleven-year-old and a wall to a
-- seven-year-old who is still reading slowly. Desmond does not need to
-- triage; he needs to know the next thing.
--
-- A flag rather than an age, for two reasons. There is no birth date in this
-- schema and adding one to drive a layout would be storing a child's date of
-- birth to answer a question about font size. And the real signal isn't age
-- anyway — it's reading confidence, which a parent can judge and a number
-- cannot.
alter table family_members
  add column simple_view boolean not null default false;

comment on column family_members.simple_view is
  'Show this person one job at a time instead of a list. For young or '
  'early readers; set by a parent, not derived from age.';


-- The flag has to reach the client, and list_my_jobs is already the one call
-- that page makes. Returning an object rather than a bare array so the page
-- does not need a second round trip just to decide how to draw itself.
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

  return jsonb_build_object(
    'simple_view', v_member.simple_view,
    'display_name', v_member.display_name,
    'accent_color', v_member.accent_color,
    'avatar_emoji', v_member.avatar_emoji,
    'jobs', v_jobs
  );
end;
$$;

revoke all on function list_my_jobs(uuid, timestamptz) from public, anon, authenticated;
grant execute on function list_my_jobs(uuid, timestamptz) to authenticated;
