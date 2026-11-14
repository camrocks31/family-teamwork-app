-- Our Family Hub — rewards.
--
-- New ground: the brief has a readiness engine ("can I play video games yet")
-- but nothing about earning things. Cameron asked for "what the rewards can
-- be given a certain number of tasks", so a reward here is:
--
--   a named thing a child earns by completing N jobs over a day or a week.
--
-- That is deliberately NOT a points-and-spend economy. Points need a balance,
-- a ledger, spending, refunds and a story for what happens when a parent
-- reverses a task — a lot of machinery for a house with three children.
-- Counting completions over a period needs none of it: the answer is derived
-- from task_instances at call time, exactly like readiness, so it cannot drift
-- out of step with the work actually recorded, and un-completing a job
-- correctly takes the progress back down.
--
-- Rewards are also kept separate from the readiness engine on purpose. "Is
-- the house tidy enough to watch TV right now" and "have you done twenty jobs
-- this week" are different questions, and collapsing them would make the
-- first one unpredictable.

create type reward_period as enum ('day', 'week');

create table rewards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  name text not null,
  icon text,
  -- How many completed jobs it takes.
  threshold_count integer not null,
  period reward_period not null default 'week',
  -- Null means every child. A reward can also be aimed at one of them, which
  -- is how "Desmond gets a comic if he manages five" works without inventing
  -- a second concept.
  member_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint rewards_name_not_blank check (length(trim(name)) > 0),
  constraint rewards_threshold_positive check (threshold_count > 0),
  -- The composite reference is what keeps the member in the same household as
  -- the reward. A plain foreign key would allow a reward here that points at
  -- a child elsewhere, and no CHECK can reach another table to say otherwise.
  constraint rewards_member_in_household
    foreign key (member_id, household_id)
    references family_members (id, household_id) on delete cascade
);

create index rewards_household_idx on rewards (household_id) where is_active;

alter table rewards enable row level security;

create policy rewards_select on rewards for select to authenticated
  using (household_id = app_current_household_id());

create policy rewards_insert on rewards for insert to authenticated
  with check (household_id = app_current_household_id() and app_is_parent());

create policy rewards_update on rewards for update to authenticated
  using (household_id = app_current_household_id() and app_is_parent())
  with check (household_id = app_current_household_id() and app_is_parent());

create policy rewards_delete on rewards for delete to authenticated
  using (household_id = app_current_household_id() and app_is_parent());


-- How far along is each child, right now.
--
-- Derived, never stored. The count comes from task_instances, so it is always
-- the truth about work actually recorded: a job sent back by a parent stops
-- counting the moment it leaves 'completed', with nothing to reconcile.
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

revoke all on function evaluate_rewards(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function evaluate_rewards(uuid, uuid, timestamptz) to authenticated;
