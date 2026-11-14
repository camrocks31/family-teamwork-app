-- Reverse 20261114040000_enroll_this_device.sql.
--
-- Dropping these makes it impossible to enrol a device from the app again,
-- and therefore impossible for a child to sign in with a PIN. That is the
-- state this migration was written to end, so reversing it is a real
-- regression — intended only for the rollback round trip, which rebuilds
-- immediately afterwards.
drop function if exists list_devices();
drop function if exists enroll_this_device(text);
