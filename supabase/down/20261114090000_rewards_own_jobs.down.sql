-- Reverse 20261114090000_rewards_own_jobs.sql: rewards go back to
-- counting whoever pressed the button, which makes shared jobs a race.

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
  -- DEFINER bypasses row level security, so the caller's own household is
  -- checked here rather than assumed from the argument.
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
     -- A reward aimed at one child belongs to that child only.
     and (rw.member_id is null or rw.member_id = fm.id)
    cross join lateral (
      select count(*)::integer as done
        from task_instances ti
       where ti.household_id = rw.household_id
         and ti.completed_by = fm.id
         and ti.state = 'completed'
         and case rw.period
               when 'day' then ti.occurrence_date = v_today
               -- date_trunc('week') is Monday-based in PostgreSQL, which is
               -- what a school week means here.
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
