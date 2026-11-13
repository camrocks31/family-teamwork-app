-- Our Family Hub — constrained vocabularies.
-- HAL-1538 §2.2: "Role, state, not-applicable reason, scope, occurrence mode,
-- list kind and visibility are constrained vocabularies."
--
-- These are Postgres enums rather than lookup tables because they are closed
-- sets owned by the application's rules, not household-editable data. Anything
-- the family can edit (spaces, definitions, activities, requirement groups) is
-- a table, per HAL-1538 requirement 1.

create extension if not exists pgcrypto;

-- Parents administer; children act through a profile. Both are family members.
create type member_role as enum ('parent', 'child');

-- HAL-1538 requirement 7. No state beyond the brief's six.
create type task_state as enum (
  'pending',
  'in_progress',
  'submitted',
  'completed',
  'needs_attention',
  'not_applicable'
);

-- Why a task does not apply. 'schedule' is deliberately absent: applicability
-- is decided at call time by applicable_at and never by writing a row, so it
-- has exactly one owner (HAL-1538 requirement 7 and 9).
create type not_applicable_reason as enum ('parent_exemption', 'not_needed');

-- A definition produces either one household instance per date, or one per
-- assigned member (HAL-1538 I2).
create type occurrence_mode as enum ('shared', 'per_member');

-- How a requirement is satisfied: once for everyone, or by the evaluating
-- member's own instance (HAL-1538 I2).
create type evaluation_scope as enum ('household', 'requester');

-- A requirement group item points at one definition or at a whole space.
create type requirement_target_kind as enum ('task_definition', 'space');

-- How often a definition recurs. Whether a recurring instance actually applies
-- at a given moment is a separate question answered by applicable_at over
-- schedule_rules (HAL-1538 requirement 9), so this enum says only how often an
-- occurrence is created, never whether it counts today.
create type recurrence_kind as enum ('daily', 'school_day', 'one_off');

-- HAL-1538 requirement 15.
create type shopping_list_kind as enum ('out_of', 'would_like');

create type calendar_visibility as enum ('household', 'parents');

-- A weekly rule says which weekdays are school days; a date override marks one
-- date (a holiday, a Pro-D day, a closure). HAL-1538 requirement 5 sets the
-- precedence: a date override outranks a weekly rule, and a member-specific row
-- outranks a null-member row at the same grain.
create type schedule_rule_kind as enum ('weekly', 'date_override');

-- A shared device is enrolled, then possibly revoked. A revoked device fails
-- its next request (HAL-1538 requirement 17).
create type device_status as enum ('active', 'revoked');
