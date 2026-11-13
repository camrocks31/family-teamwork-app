-- Reverse of 20261114000000_kiosk_identity.sql.
drop function if exists revoke_device(uuid);
drop function if exists app_consume_enrollment_code(text, text, uuid);
drop function if exists create_device_enrollment_code(integer);
drop function if exists revoke_member_session(uuid);
drop function if exists app_resolve_actor(text);
drop function if exists verify_member_pin(uuid, text, uuid);
drop function if exists set_member_pin(uuid, text);
drop policy if exists app_settings_read on app_settings;
drop table if exists app_settings;
