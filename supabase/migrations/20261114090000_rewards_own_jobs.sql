-- Our Family Hub — a reward counts only your OWN jobs.
--
-- The original version counted `completed_by`, which credits whoever pressed
-- the button. On a shared job that is a race: Roland reaches the dishwasher
-- first, his counter ticks, and Desmond learns that the way to win is to be
-- faster rather than useful. Worse, if Desmond sees Roland struggling and
-- helps, the credit goes to Roland — so helping your brother is a losing
-- move in the only system keeping score.
--
-- The defect is narrower than it looks. The app already has a scoreboard —
-- the gate — and it measures whether the HOUSE is ready: binary, daily,
-- shared. The reward added a second one measuring how many jobs a child
-- personally pressed done on. The two disagree. A morning where Hazel does
-- her three, Roland five and Desmond three is a perfect morning by the gate
-- and a defeat for Hazel by the reward, though she did exactly what was
-- asked. And once the house is finished the count has nothing left to
-- measure, so it goes quiet exactly when things are going well.
--
-- So the fix is not to delete rewards. It is to count the right thing:
--
--   subject_member_id = fm.id   -- this job BELONGS to this child
--   rather than
--   completed_by = fm.id        -- this child pressed the button
--
-- A shared job has no subject, so it counts toward nobody and cannot be
-- raced. A child's own jobs cannot be taken by a sibling, so the number is a
-- record of keeping up with your own share rather than of beating anyone.
-- Shared work still shows who did it — attribution is useful and it is how
-- the dog avoids being fed twice — it simply is not scored.

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
       where ti.household_id = rw.household_id
         -- THE CHANGE. The job has to be this child's own, not merely one
         -- they pressed the button on. A shared job has a null subject and
         -- therefore counts toward nobody.
         and ti.subject_member_id = fm.id
         and ti.state = 'completed'
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
