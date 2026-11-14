-- Our Family Hub — tell a blocker apart when it is the dog.
--
-- Every requirement row came back as link_kind 'space' or 'task', and the
-- dashboard sent anything that was not a space to /tasks/ — a route that does
-- not exist. So every blocker naming one of Lucy's four jobs, which is most
-- of a school morning, was a dead link on the main screen. Found by a test
-- that tried to click "The dog" and matched eighteen of them.
--
-- A pet task now says 'pet', so the dashboard can send someone to the dog's
-- page. link_id stays the task definition id in both cases; only the kind
-- changes, so nothing that reads link_id has to care.

create or replace function app_requirement_rows(
  p_activity_id uuid,
  p_member_id uuid,
  p_local_date date
)
returns table (
  group_id uuid,
  group_name text,
  item_id uuid,
  scope evaluation_scope,
  link_kind text,
  link_id uuid,
  link_name text,
  title text,
  instance_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A household item: the target's single shared instance. One satisfaction
  -- counts for everyone.
  select g.id, g.name, i.id, i.scope,
         (case when td.pet_id is not null then 'pet' else 'task' end)::text,
         td.id, coalesce(sp.name, r.title), r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join task_definitions td on td.id = i.target_definition_id and td.is_active
    join task_definition_revisions r on r.id = td.current_revision_id
    left join household_spaces sp on sp.id = td.location_space_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id is null
   where ar.activity_id = p_activity_id
     and i.target_kind = 'task_definition'
     and i.scope = 'household'

  union all

  -- A requester item: the evaluating member's OWN instance. Joining through
  -- task_assignments is what makes "not assigned to you" mean "does not apply
  -- to you" rather than "blocked forever on someone else's lunch".
  select g.id, g.name, i.id, i.scope,
         (case when td.pet_id is not null then 'pet' else 'task' end)::text,
         td.id, r.title, r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join task_definitions td on td.id = i.target_definition_id and td.is_active
    join task_definition_revisions r on r.id = td.current_revision_id
    join task_assignments ta on ta.definition_id = td.id and ta.member_id = p_member_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id = p_member_id
   where ar.activity_id = p_activity_id
     and i.target_kind = 'task_definition'
     and i.scope = 'requester'

  union all

  -- A space item: every SHARED definition in that room. Per-member
  -- definitions in the same room are deliberately not reached this way —
  -- they need their own requester item — so a space can never pull one
  -- child's personal task into another child's evaluation.
  select g.id, g.name, i.id, i.scope,
         'space'::text, sp.id, sp.name, r.title, ti.id
    from activity_requirements ar
    join requirement_groups g on g.id = ar.group_id and g.is_active
    join requirement_group_items i on i.group_id = g.id
    join household_spaces sp on sp.id = i.target_space_id and sp.is_active
    join task_definitions td on td.location_space_id = sp.id
                            and td.is_active
                            and td.occurrence_mode = 'shared'
    join task_definition_revisions r on r.id = td.current_revision_id
    left join task_instances ti
           on ti.definition_id = td.id
          and ti.occurrence_date = p_local_date
          and ti.subject_member_id is null
   where ar.activity_id = p_activity_id
     and i.target_kind = 'space';
$$;
