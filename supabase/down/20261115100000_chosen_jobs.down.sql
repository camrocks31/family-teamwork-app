-- Reverse 20261115100000_chosen_jobs.sql.
--
-- Same convention as every other down in this folder: the SCHEMA objects
-- created by the migration are removed here, and the function bodies it
-- replaced are restored by re-running the migrations that defined them
-- previously. A down on its own therefore leaves save_task, list_my_jobs and
-- evaluate_rewards referencing columns that no longer exist; the rollback
-- round trip runs every down and then every up, which puts the earlier
-- definitions back, and scripts/verify.sh runs exactly that pair.
--
-- The enum has to go too. Postgres has no `create type ... if not exists`, so
-- leaving it behind would make re-applying the up migration fail with 42710.

drop function if exists release_job(uuid, uuid, text);
drop function if exists choose_job(uuid, uuid, text);
drop function if exists app_lock_open_job(uuid, uuid);
drop function if exists app_choice_principal(text);
drop function if exists save_task(uuid, text, text[], uuid, uuid, occurrence_mode, recurrence_kind, date, text, boolean, boolean, boolean, uuid[], text, assignment_mode, boolean);

alter table family_members drop constraint if exists family_members_min_chosen_jobs_non_negative;
alter table family_members drop column if exists min_chosen_jobs;

alter table task_definitions drop constraint if exists task_definitions_open_is_per_member;
alter table task_definitions drop column if exists assignment_mode;

alter table task_definition_revisions drop column if exists counts_toward_rewards;
alter table task_definition_revisions drop column if exists reason;

drop type if exists assignment_mode;
