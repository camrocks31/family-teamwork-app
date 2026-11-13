-- Reverse of 20261113230000_readiness.sql.
drop function if exists evaluate_space_status(uuid, timestamptz);
drop function if exists evaluate_activity_readiness(uuid, uuid, uuid, timestamptz);
drop function if exists app_requirement_rows(uuid, uuid, date);
drop function if exists app_instance_satisfaction(uuid);
