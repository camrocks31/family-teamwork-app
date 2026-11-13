-- Reverse of 20261113220000_applicability.sql.
drop function if exists app_instance_applies_at(uuid, timestamptz);
drop function if exists applicable_at(uuid, uuid, timestamptz);
drop function if exists app_recurrence_applies_at(uuid, uuid, recurrence_kind, date, timestamptz);
drop function if exists app_in_morning_window(uuid, timestamptz);
drop function if exists app_is_school_day(uuid, uuid, date);
