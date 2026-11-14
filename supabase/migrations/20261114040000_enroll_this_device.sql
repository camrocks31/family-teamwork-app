-- Our Family Hub — let a signed-in parent enrol the device in their hands.
--
-- Device enrolment already existed as a two-step dance: a parent generates a
-- code with create_device_enrollment_code, and the device redeems it with
-- app_consume_enrollment_code. That second function is granted to no client
-- role, deliberately — it takes an auth_user_id as an argument, so exposing it
-- to the browser would let any caller name somebody else.
--
-- The result was that no device could ever be enrolled from the app, and
-- without an enrolled device verify_member_pin refuses, so there was no way
-- for a child to say "I'm Desmond" at all. The code flow is the right answer
-- for enrolling a device the parent is NOT holding; it is a poor answer for
-- the ordinary case, which is a parent standing at the kitchen iPad with the
-- app open in front of them.
--
-- So: one function, parent-only, that enrols the caller's own session. It
-- takes no identity argument — everything comes from the session — which is
-- exactly why it is safe to expose when app_consume_enrollment_code is not.

create or replace function enroll_this_device(p_label text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_member uuid;
  v_household uuid;
  v_device uuid;
begin
  if not app_is_parent() then
    raise exception 'only a parent can set up a device'
      using errcode = 'insufficient_privilege';
  end if;

  v_member := app_current_member_id();
  v_household := app_current_household_id();
  if v_member is null or v_household is null then
    raise exception 'no acting family member for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if p_label is null or btrim(p_label) = '' then
    raise exception 'a device needs a name, so it can be recognised later'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into devices (household_id, label, status, enrolled_by)
  values (v_household, btrim(p_label), 'active', v_member)
  returning id into v_device;

  return v_device;
end;
$$;

revoke all on function enroll_this_device(text) from public, anon, authenticated;
grant execute on function enroll_this_device(text) to authenticated;

-- Which devices are enrolled here, so Settings can list and revoke them.
-- Read-only, household-scoped, and it deliberately returns no token material:
-- member_sessions stays unreadable by any client.
create or replace function list_devices()
returns table (
  id uuid,
  label text,
  status device_status,
  enrolled_at timestamptz,
  revoked_at timestamptz,
  active_profiles bigint
)
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select d.id, d.label, d.status, d.enrolled_at, d.revoked_at,
         (select count(*) from member_sessions s
           where s.device_id = d.id
             and s.revoked_at is null
             and s.expires_at > now())
    from devices d
   where d.household_id = app_current_household_id()
   order by d.enrolled_at;
$$;

revoke all on function list_devices() from public, anon, authenticated;
grant execute on function list_devices() to authenticated;
