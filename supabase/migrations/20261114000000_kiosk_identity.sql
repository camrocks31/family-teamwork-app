-- Our Family Hub — slice 5: three children, one iPad, nobody becomes a parent.
--
-- HAL-1538 requirement 17. The hard part is not letting a child act; it is
-- letting a child act WITHOUT the device they are holding becoming an
-- authority. Everything below exists to keep those two apart.

-- Idle lifetime for an actor token, and how many wrong PINs before a lockout.
-- Household settings in a later slice; sensible defaults until then.
create table app_settings (
  id boolean primary key default true,
  actor_idle_minutes integer not null default 15,
  actor_max_lifetime_hours integer not null default 12,
  pin_max_failures integer not null default 5,
  pin_lockout_minutes integer not null default 15,
  constraint app_settings_single_row check (id),
  constraint app_settings_sane check (
    actor_idle_minutes > 0 and actor_max_lifetime_hours > 0
    and pin_max_failures > 0 and pin_lockout_minutes > 0
  )
);
insert into app_settings default values;

alter table app_settings enable row level security;
create policy app_settings_read on app_settings for select to authenticated using (true);
revoke insert, update, delete on app_settings from authenticated, anon;

-- ---------------------------------------------------------------------------
-- PINs
-- ---------------------------------------------------------------------------

-- Stored as a bcrypt hash in member_credentials, which no client role can
-- read at all. A PIN is four digits: short enough that the rate limit below
-- is doing as much work as the hash is.
create or replace function set_member_pin(p_member_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_household uuid;
begin
  if not app_is_parent() then
    raise exception 'only a parent can set a PIN' using errcode = 'insufficient_privilege';
  end if;
  if p_pin is null or length(p_pin) < 4 then
    raise exception 'a PIN must be at least 4 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  select household_id into v_household from family_members
   where id = p_member_id and household_id = app_current_household_id();
  if v_household is null then
    raise exception 'no such family member in your household'
      using errcode = 'no_data_found';
  end if;

  insert into member_credentials (member_id, household_id, pin_hash, failed_attempts, locked_until)
  values (p_member_id, v_household, crypt(p_pin, gen_salt('bf')), 0, null)
  on conflict (member_id) do update
    set pin_hash = excluded.pin_hash,
        failed_attempts = 0,
        locked_until = null,
        updated_at = now();
end;
$$;

revoke all on function set_member_pin(uuid, text) from public;
grant execute on function set_member_pin(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Actor tokens
-- ---------------------------------------------------------------------------

-- Returns the token ONCE. Only its digest is stored, so a leaked
-- member_sessions table cannot be replayed into anyone's identity.
--
-- The token is bound to the member AND the device. Carrying it to another
-- device is refused, which is what stops a child reading a token out of one
-- iPad and using it from a phone.
-- Returns a RESULT rather than raising on a wrong PIN.
--
-- This is not a style choice. The first version raised an exception after
-- incrementing failed_attempts, and a raised exception rolls back the whole
-- function — including the increment. The counter never persisted, so the
-- lockout never triggered and a sibling's four digits could be guessed
-- indefinitely. Caught by the test that walks the whole sequence.
--
-- Structural problems (unknown device, unknown member) still raise: there is
-- nothing to persist in those cases.
create or replace function verify_member_pin(
  p_member_id uuid,
  p_pin text,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  s app_settings%rowtype;
  cred member_credentials%rowtype;
  fm family_members%rowtype;
  dev devices%rowtype;
  v_token text;
begin
  select * into s from app_settings limit 1;

  select * into dev from devices where id = p_device_id;
  if not found or dev.status <> 'active' then
    -- A revoked or unknown device cannot mint an identity, whatever PIN it has.
    raise exception 'this device is not enrolled' using errcode = 'insufficient_privilege';
  end if;

  select * into fm from family_members
   where id = p_member_id and household_id = dev.household_id and is_active;
  if not found then
    raise exception 'no such family member on this device'
      using errcode = 'no_data_found';
  end if;

  select * into cred from member_credentials where member_id = p_member_id for update;
  if not found then
    raise exception 'no PIN has been set for this profile yet'
      using errcode = 'no_data_found';
  end if;

  if cred.locked_until is not null and cred.locked_until > now() then
    return jsonb_build_object(
      'ok', false, 'reason', 'locked', 'locked_until', cred.locked_until
    );
  end if;

  if cred.pin_hash <> crypt(p_pin, cred.pin_hash) then
    update member_credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = case
             when failed_attempts + 1 >= s.pin_max_failures
               then now() + make_interval(mins => s.pin_lockout_minutes)
             else null end,
           updated_at = now()
     where member_id = p_member_id;
    -- Committed, not rolled back: this is the counter the lockout depends on.
    select * into cred from member_credentials where member_id = p_member_id;
    return jsonb_build_object(
      'ok', false,
      'reason', 'wrong_pin',
      'attempts_left', greatest(s.pin_max_failures - cred.failed_attempts, 0),
      'locked_until', cred.locked_until
    );
  end if;

  -- A good PIN clears the counter, so a child who mistypes twice and then
  -- gets it right is not one slip away from a lockout all morning.
  update member_credentials
     set failed_attempts = 0, locked_until = null, updated_at = now()
   where member_id = p_member_id;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into member_sessions (
    household_id, member_id, device_id, token_digest, expires_at
  )
  values (
    dev.household_id, p_member_id, p_device_id,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + make_interval(hours => s.actor_max_lifetime_hours)
  );

  return jsonb_build_object('ok', true, 'token', v_token);
end;
$$;

revoke all on function verify_member_pin(uuid, text, uuid) from public, anon;
grant execute on function verify_member_pin(uuid, text, uuid) to authenticated;

-- Resolve an actor token to a member, enforcing every condition that can have
-- changed since it was issued, and refresh the idle clock.
--
-- Returns null rather than raising when there is no token, so callers can use
-- it to mean "a parent session is acting instead".
create or replace function app_resolve_actor(p_actor_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  s app_settings%rowtype;
  sess member_sessions%rowtype;
  dev devices%rowtype;
begin
  if p_actor_token is null then
    return null;
  end if;
  select * into s from app_settings limit 1;

  select * into sess from member_sessions
   where token_digest = encode(digest(p_actor_token, 'sha256'), 'hex')
   for update;
  if not found then
    raise exception 'this profile is no longer signed in'
      using errcode = 'insufficient_privilege';
  end if;
  if sess.revoked_at is not null then
    raise exception 'this profile was signed out' using errcode = 'insufficient_privilege';
  end if;
  if sess.expires_at <= now() then
    raise exception 'this profile has been idle too long — enter the PIN again'
      using errcode = 'insufficient_privilege';
  end if;
  if sess.last_used_at + make_interval(mins => s.actor_idle_minutes) <= now() then
    raise exception 'this profile has been idle too long — enter the PIN again'
      using errcode = 'insufficient_privilege';
  end if;

  -- The device is re-checked on every single operation, so revoking a lost
  -- iPad takes effect on its next request rather than whenever its token
  -- happens to expire.
  select * into dev from devices where id = sess.device_id;
  if not found or dev.status <> 'active' then
    raise exception 'this device is no longer enrolled'
      using errcode = 'insufficient_privilege';
  end if;
  if dev.household_id is distinct from sess.household_id then
    raise exception 'device and session do not belong together'
      using errcode = 'insufficient_privilege';
  end if;

  update member_sessions set last_used_at = now() where id = sess.id;
  return sess.member_id;
end;
$$;

revoke all on function app_resolve_actor(text) from public;
grant execute on function app_resolve_actor(text) to authenticated;

create or replace function revoke_member_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not app_is_parent() then
    raise exception 'only a parent can sign a profile out'
      using errcode = 'insufficient_privilege';
  end if;
  update member_sessions set revoked_at = now()
   where id = p_session_id and household_id = app_current_household_id();
end;
$$;

revoke all on function revoke_member_session(uuid) from public;
grant execute on function revoke_member_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

-- Returns the code ONCE; only its hash is stored.
create or replace function create_device_enrollment_code(p_valid_minutes integer default 30)
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_code text;
  v_member uuid;
begin
  if not app_is_parent() then
    raise exception 'only a parent can add a device' using errcode = 'insufficient_privilege';
  end if;
  v_member := app_current_member_id();

  -- Short enough to type off a screen onto an iPad, long enough that guessing
  -- it inside the expiry window is not worth attempting.
  v_code := upper(encode(gen_random_bytes(5), 'hex'));

  insert into device_enrollment_codes (
    household_id, code_hash, created_by, expires_at
  )
  values (
    app_current_household_id(),
    encode(digest(v_code, 'sha256'), 'hex'),
    v_member,
    now() + make_interval(mins => greatest(p_valid_minutes, 1))
  );

  return v_code;
end;
$$;

revoke all on function create_device_enrollment_code(integer) from public;
grant execute on function create_device_enrollment_code(integer) to authenticated;

-- Consumed by the enrollment Edge Function, which holds the service role and
-- creates the device's auth user. Atomic: the row is locked and the consumed
-- columns are set in the same statement that claims it, so two iPads racing
-- the same code produce exactly one device.
create or replace function app_consume_enrollment_code(
  p_code text,
  p_label text,
  p_auth_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  code device_enrollment_codes%rowtype;
  v_device uuid;
begin
  select * into code from device_enrollment_codes
   where code_hash = encode(digest(p_code, 'sha256'), 'hex')
   for update;

  if not found then
    raise exception 'that code is not valid' using errcode = 'invalid_parameter_value';
  end if;
  if code.consumed_at is not null then
    raise exception 'that code has already been used'
      using errcode = 'invalid_parameter_value';
  end if;
  if code.expires_at <= now() then
    raise exception 'that code has expired' using errcode = 'invalid_parameter_value';
  end if;

  insert into devices (household_id, label, status, auth_user_id, enrolled_by)
  values (code.household_id, p_label, 'active', p_auth_user_id, code.created_by)
  returning id into v_device;

  update device_enrollment_codes
     set consumed_at = now(), consumed_device_id = v_device
   where id = code.id;

  return v_device;
end;
$$;

-- Revoked from the client roles BY NAME, not just from PUBLIC. Supabase grants
-- execute on public-schema functions to anon and authenticated by default, so
-- `revoke ... from public` alone left this callable by any signed-in client —
-- which would have let a client enroll a device for itself. Found by the test
-- that tries exactly that.
revoke all on function app_consume_enrollment_code(text, text, uuid)
  from public, anon, authenticated;

create or replace function revoke_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not app_is_parent() then
    raise exception 'only a parent can remove a device'
      using errcode = 'insufficient_privilege';
  end if;
  update devices
     set status = 'revoked', revoked_at = now()
   where id = p_device_id and household_id = app_current_household_id();

  -- Sign out everyone who was using it. Leaving their tokens alive would mean
  -- a removed iPad still had working identities on it until they timed out.
  update member_sessions set revoked_at = now()
   where device_id = p_device_id and revoked_at is null;
end;
$$;

revoke all on function revoke_device(uuid) from public;
grant execute on function revoke_device(uuid) to authenticated;
