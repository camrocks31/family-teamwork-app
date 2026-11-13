-- Our Family Hub — shared-device enrollment and member actor sessions.
--
-- These tables exist in slice 1 so RLS can be written once with the device and
-- actor principals in mind. The functions that use them — enrollment, PIN
-- verification, actor-token issuance — are slice 5.

create table devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  label text not null,
  status device_status not null default 'active',
  -- The device's own Supabase Auth user. Its JWT carries household_id and
  -- role: 'device' in app_metadata, which is server-set and not user-editable.
  auth_user_id uuid unique references auth.users (id) on delete set null,
  enrolled_by uuid not null references family_members (id) on delete restrict,
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,

  constraint devices_label_not_blank check (length(trim(label)) > 0),
  -- A revoked device must carry the moment it was revoked, and an active one
  -- must not: every device read re-checks this row, so an ambiguous status
  -- would be an ambiguous authorization.
  constraint devices_revoked_has_timestamp check (
    (status = 'revoked') = (revoked_at is not null)
  ),
  unique (id, household_id),
  foreign key (enrolled_by, household_id) references family_members (id, household_id)
);

-- A parent creates a code; it expires, and it is consumed atomically once.
-- Only the hash is stored, so a leaked table does not enroll a device.
create table device_enrollment_codes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  code_hash text not null unique,
  created_by uuid not null references family_members (id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_device_id uuid references devices (id) on delete set null,

  constraint device_enrollment_codes_expiry_future check (expires_at > created_at),
  constraint device_enrollment_codes_consumed_together check (
    (consumed_at is null) = (consumed_device_id is null)
  ),
  foreign key (created_by, household_id) references family_members (id, household_id),
  foreign key (consumed_device_id, household_id) references devices (id, household_id)
);

-- An actor token proves "this member, on this device, recently entered their
-- PIN". Only a digest is stored. The token is bound to both the member and the
-- device, and every actor operation re-checks household, device status,
-- revocation and the server-tracked idle expiry.
--
-- An actor token never confers parent authority, not even one minted from a
-- parent's own PIN — which is why nothing here records a role.
create table member_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete restrict,
  member_id uuid not null references family_members (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  token_digest text not null unique,
  issued_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  -- Idle expiry is tracked server-side by advancing last_used_at; this column
  -- is the hard ceiling.
  expires_at timestamptz not null,
  revoked_at timestamptz,

  constraint member_sessions_expiry_future check (expires_at > issued_at),
  foreign key (member_id, household_id) references family_members (id, household_id),
  foreign key (device_id, household_id) references devices (id, household_id)
);

create index member_sessions_live_idx
  on member_sessions (member_id, device_id)
  where revoked_at is null;
