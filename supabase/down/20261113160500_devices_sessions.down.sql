-- Reverse of 20261113160500_devices_sessions.sql.
-- Dropped in reverse dependency order: sessions and codes both reference
-- devices.

drop table if exists member_sessions;
drop table if exists device_enrollment_codes;
drop table if exists devices;
