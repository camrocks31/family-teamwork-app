-- Reverse 20261114110000_catalogues_and_teams.sql.
--
-- Same convention as the other downs in this folder: the SCHEMA objects are
-- removed here, and the function bodies that referenced them are restored by
-- re-running the migration that defined them previously. A down on its own
-- therefore leaves evaluate_activity_readiness and evaluate_household_dashboard
-- referencing columns that no longer exist; the rollback round trip runs every
-- down and then every up, which puts the earlier definitions back.

drop function if exists set_activity_active(uuid, boolean);
drop function if exists save_activity(uuid, text, text, activity_participation, boolean, uuid[], uuid[], integer);
drop function if exists app_activity_audience(uuid);

drop table if exists activity_audience;

alter table activities drop column if exists participation;
alter table family_members drop column if exists display_order;

drop type if exists activity_participation;
